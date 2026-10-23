import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectInfrastructureEnvironment } from "../infrastructure/project-infrastructure-environment.entity";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { PipelineActivityService } from "../projects/pipeline/pipeline-activity.service";
import { Project } from "../projects/project.entity";
import { AwsCliService } from "../state-management/aws-cli.service";
import { User } from "../users/user.entity";
import { CentralCloudResource } from "./central-cloud-resource.entity";
import { CloudInventoryScan } from "./cloud-inventory-scan.entity";
import { isDestroyOperationRelevant, reconcileCloudState, ReconciledCloudState } from "./cloud-state-reconciliation.logic";
import { DestroyOperation } from "./destroy-operation.entity";
import { ProjectCloudInventoryService } from "./project-cloud-inventory.service";
import { ProjectCloudState } from "./project-cloud-state.entity";

export type AuthoritativeProjectCloudState = ReconciledCloudState & {
  lastCloudVerifiedAt: Date | null;
  lastInventoryScanId: string | null;
  verificationTtlSeconds: number;
  evidence: Record<string, unknown>;
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
    if (existing && (!refreshIfStale || !stale)) return this.fromEntity(existing);
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
    const [project, deployment, environment, release, run, projectScan, accountScan, resources, destroy] = await Promise.all([
      this.projects.findOne({ where: { id: projectId } }),
      this.deployments.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
      this.environments.findOne({ where: { projectId }, order: { updatedAt: "DESC" } }),
      this.releases.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
      this.runs.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
      this.scans.findOne({ where: { scope: "project", projectId }, order: { completedAt: "DESC" } }),
      this.scans.findOne({ where: { scope: "account" }, order: { completedAt: "DESC" } }),
      this.resources.find({ where: { projectId } }),
      this.destroys.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
    ]);
    if (!project) throw new Error("Project not found during cloud-state reconciliation.");
    const deploymentActivity = await this.pipelineActivity.inspect(projectId, run);
    const destroyRelevant = Boolean(destroy && isDestroyOperationRelevant({
      destroyCreatedAt: destroy.createdAt,
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
      effectiveDestroyOperationId: destroyRelevant ? destroy?.id : null,
      destroyOperationRelevant: destroyRelevant,
      runtimeChecks: runtime.checks,
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
    return { ...resolved, lastCloudVerifiedAt: verifiedAt, lastInventoryScanId: scan?.id || null, verificationTtlSeconds: Math.round(this.ttlMs / 1000), evidence };
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
      evidence: row.evidence || {},
    };
  }
  private safeError(error: unknown) { return this.aws.sanitize(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 180); }
  private get ttlMs() { const seconds = Number(this.config.get<string>("CLOUD_VERIFICATION_TTL_SECONDS", "180")); return (Number.isFinite(seconds) && seconds >= 30 ? seconds : 180) * 1000; }
}
