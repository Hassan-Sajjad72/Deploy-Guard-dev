import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { PipelineActivityService } from "../projects/pipeline/pipeline-activity.service";
import { Project } from "../projects/project.entity";
import { AwsCliService } from "../state-management/aws-cli.service";
import { ProjectTerraformState } from "../state-management/project-terraform-state.entity";
import { User } from "../users/user.entity";
import { CentralCloudResource } from "./central-cloud-resource.entity";
import { CloudInventoryScan } from "./cloud-inventory-scan.entity";
import {
  hasTerraformMutationEvidence,
  isDestroyOperationRelevant,
  reconcileCloudState,
  ReconciledCloudState,
} from "./cloud-state-reconciliation.logic";
import { DestroyOperation } from "./destroy-operation.entity";
import { ProjectCloudInventoryService } from "./project-cloud-inventory.service";
import { ProjectCloudState } from "./project-cloud-state.entity";

export type AuthoritativeProjectCloudState = ReconciledCloudState & {
  lastCloudVerifiedAt: Date | null;
  lastInventoryScanId: string | null;
  verificationTtlSeconds: number;
  evidence: Record<string, unknown>;
  terraformStatePresent: boolean;
  terraformStateSerial: number | null;
  terraformResourceCount: number;
  terraformApplyStarted: boolean;
  terraformApplyCompleted: boolean;
  currentRunCreatedResources: boolean;
  currentRunModifiedResources: boolean;
  existingDeploymentPresent: boolean;
  existingDeploymentRunId: string | null;
  existingDeploymentReachable: boolean | null;
  orphanCandidates: Array<Record<string, unknown>>;
  verifiedResidue: Array<Record<string, unknown>>;
  unknownResources: Array<Record<string, unknown>>;
  resourceOwnership: Array<Record<string, unknown>>;
  cleanupRequiredForCurrentRun: boolean;
  projectCleanupRecommended: boolean;
  nextSafeAction: string;
  reconciliationReason: string;
};

@Injectable()
export class CloudStateReconciliationService {
  private readonly logger = new Logger(CloudStateReconciliationService.name);
  private readonly inFlight = new Map<string, Promise<AuthoritativeProjectCloudState>>();

  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(ProjectCloudState) private readonly states: Repository<ProjectCloudState>,
    @InjectRepository(ProjectInfrastructureEnvironment) private readonly environments: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(ProjectDeployment) private readonly deployments: Repository<ProjectDeployment>,
    @InjectRepository(ProjectStableRelease) private readonly releases: Repository<ProjectStableRelease>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent) private readonly events: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectTerraformState) private readonly terraformStates: Repository<ProjectTerraformState>,
    @InjectRepository(CloudInventoryScan) private readonly scans: Repository<CloudInventoryScan>,
    @InjectRepository(CentralCloudResource) private readonly resources: Repository<CentralCloudResource>,
    @InjectRepository(DestroyOperation) private readonly destroys: Repository<DestroyOperation>,
    private readonly inventory: ProjectCloudInventoryService,
    private readonly pipelineActivity: PipelineActivityService,
    private readonly aws: AwsCliService,
    private readonly config: ConfigService,
  ) {}

  async current(projectId: string, actorUser?: User | null, refreshIfStale = true): Promise<AuthoritativeProjectCloudState> {
    const existing = await this.states.findOne({ where: { projectId } });
    const stale = !existing?.lastCloudVerifiedAt || Date.now() - existing.lastCloudVerifiedAt.getTime() > this.ttlMs;
    const needsReconciliationUpgrade = Boolean(existing && !("cleanupRequiredForCurrentRun" in (existing.evidence || {})));
    if (existing && needsReconciliationUpgrade) return this.reconcile(projectId, existing);
    if (existing && !needsReconciliationUpgrade && (!refreshIfStale || !stale)) return this.fromEntity(existing);
    if (!refreshIfStale) return this.reconcile(projectId, existing);
    const active = this.inFlight.get(projectId);
    if (active) return active;
    const task = this.refreshAndReconcile(projectId, actorUser, existing).finally(() => this.inFlight.delete(projectId));
    this.inFlight.set(projectId, task);
    return task;
  }

  async reconcile(projectId: string, existing?: ProjectCloudState | null): Promise<AuthoritativeProjectCloudState> {
    return this.computeAndPersist(projectId, existing ?? await this.states.findOne({ where: { projectId } }));
  }

  private async refreshAndReconcile(projectId: string, actorUser?: User | null, existing?: ProjectCloudState | null) {
    const [deployment, environment, destroy] = await Promise.all([
      this.deployments.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
      this.environments.findOne({ where: { projectId }, order: { updatedAt: "DESC" } }),
      this.destroys.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
    ]);
    if (deployment || environment || destroy) {
      try { await this.inventory.scan(projectId, actorUser || null); }
      catch (error) { this.logger.warn(`Project cloud verification failed project=${projectId}: ${this.safeError(error)}`); }
    }
    return this.computeAndPersist(projectId, existing ?? null);
  }

  private async computeAndPersist(projectId: string, existing: ProjectCloudState | null) {
    const [project, deployment, environment, release, run, terraformState, projectScan, accountScan, resources, destroy] = await Promise.all([
      this.projects.findOne({ where: { id: projectId } }),
      this.deployments.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
      this.environments.findOne({ where: { projectId }, order: { updatedAt: "DESC" } }),
      this.releases.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
      this.runs.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
      this.terraformStates.findOne({ where: { projectId }, order: { updatedAt: "DESC" } }),
      this.scans.findOne({ where: { scope: "project", projectId }, order: { completedAt: "DESC" } }),
      this.scans.findOne({ where: { scope: "account" }, order: { completedAt: "DESC" } }),
      this.resources.find({ where: { projectId } }),
      this.destroys.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
    ]);
    if (!project) throw new Error("Project not found during cloud-state reconciliation.");
    const runEvents = run ? await this.events.find({ where: { projectId, pipelineRunId: run.id }, order: { occurredAt: "ASC" } }) : [];
    const deploymentActivity = await this.pipelineActivity.inspect(projectId, run);
    const destroyRelevant = Boolean(destroy && isDestroyOperationRelevant({
      destroyCreatedAt: destroy.createdAt,
      destroyUpdatedAt: destroy.updatedAt,
      environmentProvisionedAt: environment?.provisionedAt,
      environmentUpdatedAt: environment?.updatedAt,
    }));
    const scan = projectScan || accountScan;
    const scanAge = scan?.completedAt ? Date.now() - scan.completedAt.getTime() : Number.POSITIVE_INFINITY;
    const scanErrors = scan?.errors || [];
    const authError = scanErrors.some((message) => /credential|accessdenied|forbidden|unauthorized|authentication|invalidaccesskey|signaturedoesnotmatch|unable to locate/i.test(message));
    const inventoryStatus = !scan ? "not_scanned" : authError ? "unavailable_auth_required" : scanErrors.length ? "error" : scanAge > this.ttlMs ? "stale" : "scanned";
    const inventorySuccessful = inventoryStatus === "scanned";
    const liveResources = resources.filter((resource) => resource.status !== "deleted");
    const activeResources = liveResources.filter((resource) => !resource.protected);
    const runtimeTypes = new Set(["load_balancer", "listener", "target_group", "ecs_cluster", "ecs_service", "ecs_task"]);
    const terraformTypes = new Set(["vpc", "subnet", "route_table", "internet_gateway", "nat_gateway", "elastic_ip", "security_group", "load_balancer", "listener", "target_group", "ecs_cluster", "ecs_service", "cloud_map_namespace", "cloud_map_service", "event_rule", "efs", "efs_access_point", "efs_mount_target"]);
    const hasTerraformStateProof = Boolean(
      environment?.terraformStateKey || Object.keys(environment?.terraformOutputs || {}).length,
    );
    const isTerraformManaged = (resource: CentralCloudResource) =>
      resource.cleanupEligibility === "terraform_destroy" ||
      (hasTerraformStateProof && terraformTypes.has(resource.resourceType));
    const runtime = inventorySuccessful && deployment ? await this.verifyRuntime(deployment) : { ecsExists: false, ecsHealthy: null, targetGroupExists: false, targetHealthy: null, httpHealthy: null, checks: [] as string[] };
    const pipelineProgress = Number((run?.metadata as Record<string, unknown> | null)?.progressPercentage || 0);
    const resolved = reconcileCloudState({
      storedDeploymentStatus: deployment?.status,
      hasStoredDeploymentUrl: Boolean(deployment?.albDnsName),
      pipelineStatus: run?.status,
      pipelineProgress,
      pipelineFailedStage: run?.currentStage,
      deploymentActivityActive: deploymentActivity.isDeploymentJobActive,
      environmentStatus: environment?.status,
      environmentCleanupStatus: environment?.cleanupStatus,
      destroyStatus: destroyRelevant ? destroy?.status : null,
      destroyCleanupStatus: destroyRelevant ? destroy?.cleanupStatus : null,
      inventoryStatus,
      inventorySuccessful,
      activeResourceCount: activeResources.length,
      protectedResourceCount: liveResources.filter((resource) => resource.protected).length,
      safeLeftoverCount: activeResources.filter((resource) => resource.safeToCleanup).length,
      manualReviewCount: activeResources.filter(
        (resource) =>
          !isTerraformManaged(resource) &&
          (resource.status === "manual_review" || resource.cleanupEligibility === "manual_review"),
      ).length,
      terraformResourceCount: activeResources.filter(isTerraformManaged).length,
      runtimeResourceCount: activeResources.filter((resource) => runtimeTypes.has(resource.resourceType)).length,
      highCostResourceCount: activeResources.filter((resource) => resource.costRisk === "high").length,
      ...runtime,
    });
    const applyStarted = runEvents.some((event) => /(?:terraform|infrastructure)_apply_(?:started|running)|terraform_apply_started/i.test(event.stage));
    const applyCompleted = runEvents.some((event) => /(?:terraform|infrastructure)_apply_(?:completed|succeeded)|terraform_apply_completed/i.test(event.stage) && ["success", "passed", "completed"].includes(event.status));
    const environmentMetadata = (environment?.metadata || {}) as Record<string, unknown>;
    const hasApplyMutationEvidence = hasTerraformMutationEvidence({
      applyCompleted,
      applyOperationId: environmentMetadata.applyOperationId,
      environmentPipelineRunId: environment?.pipelineRunId,
      currentPipelineRunId: run?.id,
      terraformOutputs: environment?.terraformOutputs,
    });
    const currentRunResources = run && hasApplyMutationEvidence
      ? activeResources.filter((resource) => resource.pipelineRunId === run.id)
      : [];
    const plan = environment?.terraformPlanSummary || {};
    const plannedCreates = Number(plan.create || plan.add || 0);
    const plannedUpdates = Number(plan.update || plan.change || 0);
    const currentRunCreatedResources = hasApplyMutationEvidence && plannedCreates > 0 && currentRunResources.length > 0;
    const currentRunModifiedResources = hasApplyMutationEvidence && plannedUpdates > 0;
    const destroyFinishedWithResources = destroyRelevant && destroy?.status === "completed" && activeResources.length > 0;
    const safeResource = (resource: CentralCloudResource) => ({
      id: resource.id,
      resourceType: resource.resourceType,
      resourceId: resource.arn || resource.resourceName,
      pipelineRunId: resource.pipelineRunId === run?.id && !applyStarted ? null : resource.pipelineRunId,
      source: resource.source,
    });
    const orphanCandidates = activeResources.filter((resource) => resource.status === "orphan" && resource.ownership === "orphan").map(safeResource);
    const verifiedResidue = destroyFinishedWithResources
      ? activeResources.filter((resource) => resource.status === "cleanup_required" || resource.safeToCleanup).map(safeResource)
      : [];
    const unknownResources = activeResources.filter((resource) => resource.ownership === "unknown" || resource.status === "manual_review").map(safeResource);
    const managedServiceTypes = new Set(["database", "secret", "efs", "efs_access_point", "efs_mount_target", "cloud_map_service"]);
    const existingDeploymentRunIds = new Set([
      release?.deployedByPipelineRunId,
      deployment?.pipelineRunId !== run?.id ? deployment?.pipelineRunId : null,
    ].filter((value): value is string => Boolean(value)));
    const resourceOwnership = liveResources.map((resource) => {
      let category = "unknown";
      if (resource.ownership === "shared" || resource.resourceType === "state_bucket") category = "shared_platform";
      else if (destroyFinishedWithResources && (resource.status === "cleanup_required" || resource.safeToCleanup)) category = "verified_residue";
      else if (resource.status === "orphan" && resource.ownership === "orphan") category = "orphan_candidate";
      else if (hasApplyMutationEvidence && resource.pipelineRunId === run?.id) category = "current_run";
      else if (resource.pipelineRunId && existingDeploymentRunIds.has(resource.pipelineRunId)) category = "existing_deployment";
      else if (managedServiceTypes.has(resource.resourceType)) category = "managed_service";
      else if (isTerraformManaged(resource) || ["terraform_state", "terraform_state_backup", "terraform_lockfile"].includes(resource.resourceType)) category = "project_stack";
      return { ...safeResource(resource), category };
    });
    const cleanupRequiredForCurrentRun = Boolean(
      hasApplyMutationEvidence && currentRunResources.some((resource) => resource.status === "cleanup_required" || resource.status === "orphan")
    );
    const projectCleanupRecommended = destroyFinishedWithResources;
    const configurationChangedBeforeApply = Boolean(
      run && !applyStarted && /configuration changed|stale configuration|plan (?:expired|stale)/i.test(run.errorMessage || "")
    );
    const nextSafeAction = configurationChangedBeforeApply
      ? "generate_new_terraform_plan"
      : applyStarted && !applyCompleted && run?.status === "failed"
        ? "reconcile_terraform_state"
        : cleanupRequiredForCurrentRun
          ? "review_current_run_resources"
          : projectCleanupRecommended
            ? (activeResources.some(isTerraformManaged) ? "run_terraform_destroy" : "clean_verified_residue")
            : ["unhealthy", "stale_live_record"].includes(resolved.deploymentStatus)
              ? "retry_runtime_stages"
              : resolved.nextAction;
    const terraformStateSerial = Number((terraformState?.metadata as Record<string, unknown> | null)?.serial);
    const reconciliation = {
      terraformStatePresent: Boolean(terraformState && !["missing", "failed"].includes(terraformState.status)),
      terraformStateSerial: Number.isFinite(terraformStateSerial) ? terraformStateSerial : null,
      terraformResourceCount: terraformState?.resourceCount ?? activeResources.filter(isTerraformManaged).length,
      terraformApplyStarted: applyStarted,
      terraformApplyCompleted: applyCompleted,
      currentRunCreatedResources,
      currentRunModifiedResources,
      existingDeploymentPresent: Boolean(release || (deployment && deployment.pipelineRunId !== run?.id)),
      existingDeploymentRunId: release?.deployedByPipelineRunId || (deployment?.pipelineRunId !== run?.id ? deployment?.pipelineRunId : null) || null,
      existingDeploymentReachable: runtime.httpHealthy,
      orphanCandidates,
      verifiedResidue,
      unknownResources,
      resourceOwnership,
      cleanupRequiredForCurrentRun,
      projectCleanupRecommended,
      nextSafeAction,
      reconciliationReason: configurationChangedBeforeApply
        ? "The current run failed before Terraform apply because its immutable configuration snapshot became stale. Existing project resources belong to the prior project stack."
        : projectCleanupRecommended
          ? "An intentional destroy completed and verified project-scoped resources remain."
          : resolved.statusExplanation,
    };
    const verifiedAt = inventorySuccessful ? scan?.completedAt || new Date() : existing?.lastCloudVerifiedAt || null;
    const evidence = {
      inventoryScanId: scan?.id || null,
      inventoryScope: scan?.scope || null,
      activeResourceCount: activeResources.length,
      protectedResourceCount: liveResources.length - activeResources.length,
      runtimeResourceCount: activeResources.filter((resource) => runtimeTypes.has(resource.resourceType)).length,
      highCostResourceCount: activeResources.filter((resource) => resource.costRisk === "high").length,
      storedDeploymentId: deployment?.id || null,
      storedDeploymentStatus: deployment?.status || null,
      stableReleaseId: release?.id || null,
      latestPipelineRunId: run?.id || null,
      isDeploymentJobActive: deploymentActivity.isDeploymentJobActive,
      activePipelineRunId: deploymentActivity.activePipelineRunId,
      latestRunStatus: deploymentActivity.latestRunStatus,
      latestRunIsStale: deploymentActivity.latestRunIsStale,
      latestDestroyOperationId: destroy?.id || null,
      latestDestroyStatus: destroy?.status || null,
      latestDestroyStartedAt: destroy?.startedAt || destroy?.createdAt || null,
      latestDestroyUpdatedAt: destroy?.updatedAt || null,
      effectiveDestroyOperationId: destroyRelevant ? destroy?.id : null,
      destroyOperationRelevant: destroyRelevant,
      runtimeChecks: runtime.checks,
      ...reconciliation,
    };
    const row = existing || this.states.create({ projectId });
    Object.assign(row, {
      lastCloudVerifiedAt: verifiedAt,
      cloudVerificationStatus: resolved.cloudVerificationStatus,
      lastVerifiedDeploymentStatus: resolved.deploymentStatus,
      lastVerifiedResourceStatus: resolved.resourceStatus,
      lastVerifiedHealthStatus: resolved.healthStatus,
      lastVerifiedInfrastructureStatus: resolved.infrastructureStatus,
      lastVerifiedCleanupStatus: resolved.cleanupStatus,
      inventoryStatus: resolved.inventoryStatus,
      adminActionRequired: resolved.adminActionRequired,
      nextAction: resolved.nextAction,
      lastVerificationReason: resolved.statusExplanation,
      lastInventoryScanId: scan?.id || null,
      evidence,
    });
    await this.states.save(row);
    return { ...resolved, ...reconciliation, lastCloudVerifiedAt: verifiedAt, lastInventoryScanId: scan?.id || null, verificationTtlSeconds: Math.round(this.ttlMs / 1000), evidence };
  }

  private async verifyRuntime(deployment: ProjectDeployment) {
    let ecsExists = false; let ecsHealthy: boolean | null = null;
    let targetGroupExists = false; let targetHealthy: boolean | null = null;
    let httpHealthy: boolean | null = null; const checks: string[] = [];
    if (deployment.ecsClusterArn && deployment.ecsServiceArn) {
      try {
        const output = await this.aws.run(["ecs", "describe-services", "--cluster", deployment.ecsClusterArn, "--services", deployment.ecsServiceArn, "--output", "json"]);
        const service = JSON.parse(output.stdout || "{}").services?.[0];
        ecsExists = Boolean(service && service.status !== "INACTIVE");
        ecsHealthy = ecsExists ? Number(service.desiredCount || 0) > 0 && Number(service.runningCount || 0) >= Number(service.desiredCount || 0) : false;
        checks.push(ecsHealthy ? "ecs_service_healthy" : ecsExists ? "ecs_service_unhealthy" : "ecs_service_missing");
      } catch (error) { checks.push(`ecs_check_failed:${this.safeError(error)}`); }
    }
    if (deployment.targetGroupArn) {
      try {
        const output = await this.aws.run(["elbv2", "describe-target-health", "--target-group-arn", deployment.targetGroupArn, "--output", "json"]);
        const targets = JSON.parse(output.stdout || "{}").TargetHealthDescriptions || [];
        targetGroupExists = true;
        targetHealthy = targets.length > 0 && targets.some((target: any) => target.TargetHealth?.State === "healthy");
        checks.push(targetHealthy ? "target_group_healthy" : "target_group_unhealthy");
      } catch (error) { checks.push(`target_group_check_failed:${this.safeError(error)}`); }
    }
    if (deployment.albDnsName && this.config.get<string>("CLOUD_HTTP_HEALTH_VERIFICATION_ENABLED", "true").toLowerCase() === "true" && this.safeAlbHostname(deployment.albDnsName)) {
      try {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(`http://${deployment.albDnsName}${deployment.healthCheckPath || "/"}`, { signal: controller.signal, redirect: "manual" });
        clearTimeout(timer); httpHealthy = response.status >= 200 && response.status < 400; checks.push(httpHealthy ? "http_health_passed" : `http_health_failed:${response.status}`);
      } catch { httpHealthy = false; checks.push("http_health_unreachable"); }
    }
    return { ecsExists, ecsHealthy, targetGroupExists, targetHealthy, httpHealthy, checks };
  }

  private safeAlbHostname(value: string) { return /^[a-z0-9.-]+\.elb\.amazonaws\.com$/i.test(value); }
  private fromEntity(row: ProjectCloudState): AuthoritativeProjectCloudState {
    const evidence = row.evidence || {};
    return {
      deploymentStatus: row.lastVerifiedDeploymentStatus as AuthoritativeProjectCloudState["deploymentStatus"],
      healthStatus: row.lastVerifiedHealthStatus as AuthoritativeProjectCloudState["healthStatus"],
      infrastructureStatus: row.lastVerifiedInfrastructureStatus as AuthoritativeProjectCloudState["infrastructureStatus"],
      resourceStatus: row.lastVerifiedResourceStatus as AuthoritativeProjectCloudState["resourceStatus"],
      cleanupStatus: row.lastVerifiedCleanupStatus as AuthoritativeProjectCloudState["cleanupStatus"],
      cloudVerificationStatus: row.cloudVerificationStatus as AuthoritativeProjectCloudState["cloudVerificationStatus"],
      inventoryStatus: row.inventoryStatus as AuthoritativeProjectCloudState["inventoryStatus"],
      adminActionRequired: row.adminActionRequired,
      nextAction: row.nextAction as AuthoritativeProjectCloudState["nextAction"],
      statusExplanation: row.lastVerificationReason,
      lastCloudVerifiedAt: row.lastCloudVerifiedAt,
      lastInventoryScanId: row.lastInventoryScanId,
      verificationTtlSeconds: Math.round(this.ttlMs / 1000),
      evidence,
      terraformStatePresent: Boolean(evidence.terraformStatePresent),
      terraformStateSerial: typeof evidence.terraformStateSerial === "number" ? evidence.terraformStateSerial : null,
      terraformResourceCount: Number(evidence.terraformResourceCount || 0),
      terraformApplyStarted: Boolean(evidence.terraformApplyStarted),
      terraformApplyCompleted: Boolean(evidence.terraformApplyCompleted),
      currentRunCreatedResources: Boolean(evidence.currentRunCreatedResources),
      currentRunModifiedResources: Boolean(evidence.currentRunModifiedResources),
      existingDeploymentPresent: Boolean(evidence.existingDeploymentPresent),
      existingDeploymentRunId: typeof evidence.existingDeploymentRunId === "string" ? evidence.existingDeploymentRunId : null,
      existingDeploymentReachable: typeof evidence.existingDeploymentReachable === "boolean" ? evidence.existingDeploymentReachable : null,
      orphanCandidates: Array.isArray(evidence.orphanCandidates) ? evidence.orphanCandidates as Array<Record<string, unknown>> : [],
      verifiedResidue: Array.isArray(evidence.verifiedResidue) ? evidence.verifiedResidue as Array<Record<string, unknown>> : [],
      unknownResources: Array.isArray(evidence.unknownResources) ? evidence.unknownResources as Array<Record<string, unknown>> : [],
      resourceOwnership: Array.isArray(evidence.resourceOwnership) ? evidence.resourceOwnership as Array<Record<string, unknown>> : [],
      cleanupRequiredForCurrentRun: Boolean(evidence.cleanupRequiredForCurrentRun),
      projectCleanupRecommended: Boolean(evidence.projectCleanupRecommended),
      nextSafeAction: typeof evidence.nextSafeAction === "string" ? evidence.nextSafeAction : row.nextAction,
      reconciliationReason: typeof evidence.reconciliationReason === "string" ? evidence.reconciliationReason : row.lastVerificationReason,
    };
  }
  private safeError(error: unknown) { return this.aws.sanitize(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 180); }
  private get ttlMs() { const seconds = Number(this.config.get<string>("CLOUD_VERIFICATION_TTL_SECONDS", "180")); return (Number.isFinite(seconds) && seconds >= 30 ? seconds : 180) * 1000; }
}
