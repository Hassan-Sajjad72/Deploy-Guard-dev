import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { getFinopsConfig } from "../../finops/finops.config";
import {
  CostEstimateStatus,
  ProjectCostEstimate,
} from "../../finops/project-cost-estimate.entity";
import { getInfrastructureConfig } from "../../infrastructure/infrastructure.config";
import {
  InfrastructureEnvironmentStatus,
  ProjectInfrastructureEnvironment,
} from "../../infrastructure/project-infrastructure-environment.entity";
import { ProjectInfrastructureEvent } from "../../infrastructure/project-infrastructure-event.entity";
import { getObservabilityConfig } from "../../observability/observability.config";
import { LogSanitizerService } from "../../observability/log-sanitizer.service";
import { ProjectRuntimeMetricSnapshot } from "../../observability/project-runtime-metric-snapshot.entity";
import {
  ProjectDeployment,
  ProjectDeploymentStatus,
} from "../../orchestration/project-deployment.entity";
import { ProjectStableRelease } from "../../orchestration/project-stable-release.entity";
import { getStateManagementConfig } from "../../state-management/state-management.config";
import { envBoolean, externalCiRequired } from "../../config/env-parsing";
import {
  ProjectTerraformLock,
  TerraformLockStatus,
} from "../../state-management/project-terraform-lock.entity";
import {
  PersistentStorageStatus,
  ProjectPersistentStorage,
} from "../../storage/project-persistent-storage.entity";
import { User, UserRole } from "../../users/user.entity";
import {
  DetectionStatus,
  ProjectDetectionProfile,
} from "../project-detection-profile.entity";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";
import { ProjectDatabaseTier } from "../project-database-tier.entity";
import { ProjectDeploymentRequirements } from "../project-deployment-requirements.entity";
import { ProjectServiceBinding } from "../project-service-binding.entity";
import { ProjectConfigurationSnapshot } from "../project-configuration-snapshot.entity";
import { ProjectPipelineEvent } from "../project-pipeline-event.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../project-pipeline-run.entity";
import {
  PreflightValidationStatus,
  ProjectPreflightReport,
} from "../project-preflight-report.entity";
import {
  ProjectSecurityScan,
  SecurityPolicyDecision,
  SecurityScanStatus,
} from "../project-security-scan.entity";
import { Project } from "../project.entity";
import { ProjectsService } from "../projects.service";
import {
  NextAction,
  ProjectModuleState,
  ResolvedPipelineStage,
} from "./project-current-state.types";
import { PipelineStageResolverService } from "./pipeline-stage-resolver.service";
import { normalizePipelineFailureClass, presentPipelineStage } from "../pipeline/pipeline-stage-presenter";
import {
  isPipelineActive,
  isPipelineCancelable,
  isPipelineFailed,
  isPipelinePaused,
  isPipelineRetryable,
} from "../pipeline/pipeline-status";
import { AuthoritativeProjectCloudState, CloudStateReconciliationService } from "../../infrastructure-lifecycle/cloud-state-reconciliation.service";
import { PipelineActivityService, PipelineActivitySnapshot } from "../pipeline/pipeline-activity.service";
import { DeploymentRecoveryPlanner } from "../recovery/deployment-recovery-planner.service";
import { TerraformStateSafetySnapshot, TerraformStateSafetySnapshotService } from "../../state-management/terraform-state-safety-snapshot.service";
import { ProjectActivityService } from "../project-activity.service";
import { deriveCurrentRunState, previousDeploymentIssue, selectCurrentRecoveryIssue } from "./current-run-state";
import { TerraformApprovalState, TerraformApprovalStateService } from "../../infrastructure/terraform-approval-state.service";
import { DatabaseServiceBindingService } from "../../infrastructure/database-service-binding.service";

type Modules = {
  repository: ProjectModuleState;
  detection: ProjectModuleState;
  preflight: ProjectModuleState;
  security: ProjectModuleState;
  finops: ProjectModuleState;
  infrastructure: ProjectModuleState;
  state: ProjectModuleState;
  storage: ProjectModuleState;
  orchestration: ProjectModuleState;
  observability: ProjectModuleState;
};

@Injectable()
export class ProjectCurrentStateService {
  constructor(
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectDeploymentContract)
    private readonly contractRepository: Repository<ProjectDeploymentContract>,
    @InjectRepository(ProjectDatabaseTier)
    private readonly databaseTierRepository: Repository<ProjectDatabaseTier>,
    @InjectRepository(ProjectDeploymentRequirements)
    private readonly deploymentRequirementsRepository: Repository<ProjectDeploymentRequirements>,
    @InjectRepository(ProjectServiceBinding)
    private readonly serviceBindingRepository: Repository<ProjectServiceBinding>,
    @InjectRepository(ProjectConfigurationSnapshot)
    private readonly configurationSnapshotRepository: Repository<ProjectConfigurationSnapshot>,
    @InjectRepository(ProjectPreflightReport)
    private readonly preflightRepository: Repository<ProjectPreflightReport>,
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent)
    private readonly eventRepository: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectSecurityScan)
    private readonly scanRepository: Repository<ProjectSecurityScan>,
    @InjectRepository(ProjectCostEstimate)
    private readonly estimateRepository: Repository<ProjectCostEstimate>,
    @InjectRepository(ProjectInfrastructureEnvironment)
    private readonly environmentRepository: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(ProjectInfrastructureEvent)
    private readonly infrastructureEventRepository: Repository<ProjectInfrastructureEvent>,
    @InjectRepository(ProjectTerraformLock)
    private readonly lockRepository: Repository<ProjectTerraformLock>,
    @InjectRepository(ProjectPersistentStorage)
    private readonly storageRepository: Repository<ProjectPersistentStorage>,
    @InjectRepository(ProjectDeployment)
    private readonly deploymentRepository: Repository<ProjectDeployment>,
    @InjectRepository(ProjectStableRelease)
    private readonly releaseRepository: Repository<ProjectStableRelease>,
    @InjectRepository(ProjectRuntimeMetricSnapshot)
    private readonly metricRepository: Repository<ProjectRuntimeMetricSnapshot>,
    private readonly projectsService: ProjectsService,
    private readonly stageResolver: PipelineStageResolverService,
    private readonly pipelineActivity: PipelineActivityService,
    private readonly recoveryPlanner: DeploymentRecoveryPlanner,
    private readonly stateSafetySnapshots: TerraformStateSafetySnapshotService,
    private readonly projectActivity: ProjectActivityService,
    private readonly cloudStateReconciliation: CloudStateReconciliationService,
    private readonly terraformApprovalStates: TerraformApprovalStateService,
    private readonly effectiveConfiguration: DatabaseServiceBindingService,
    private readonly config: ConfigService,
    private readonly logSanitizer: LogSanitizerService
  ) {}

  async getCurrentState(
    user: User,
    projectId: string,
    options: { refreshCloudState?: boolean } = {},
  ) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    let cloudState = await this.cloudStateReconciliation.current(
      project.id,
      user,
      options.refreshCloudState !== false,
    );
    const [
      profile,
      contract,
      preflight,
      run,
      scan,
      estimate,
      environment,
      lock,
      storage,
      deployment,
      release,
      runtimeMetric,
      databaseTier,
      deploymentRequirements,
    ] = await Promise.all([
      this.latest(this.profileRepository, project.id),
      this.latest(this.contractRepository, project.id),
      this.latest(this.preflightRepository, project.id),
      this.latest(this.runRepository, project.id),
      this.latest(this.scanRepository, project.id),
      this.latest(this.estimateRepository, project.id),
      this.latest(this.environmentRepository, project.id),
      this.latest(this.lockRepository, project.id),
      this.latest(this.storageRepository, project.id),
      this.latest(this.deploymentRepository, project.id),
      this.latest(this.releaseRepository, project.id),
      this.latest(this.metricRepository, project.id),
      this.databaseTierRepository.findOne({ where: { projectId: project.id } }),
      this.deploymentRequirementsRepository.findOne({ where: { projectId: project.id } }),
    ]);
    const deploymentActivity = await this.pipelineActivity.inspect(project.id, run);
    const [runConfigurationSnapshot, desiredConfiguration] = await Promise.all([
      run ? this.configurationSnapshotRepository.findOne({ where: { projectId: project.id, pipelineRunId: run.id } }) : null,
      this.effectiveConfiguration.getSanitizedConfiguration(project.id, null, "production").catch(() => null),
    ]);
    const databaseServiceBinding = run
      ? await this.serviceBindingRepository.findOne({ where: { projectId: project.id, pipelineRunId: run.id, serviceType: "database" } })
      : null;
    const userActivity = (await this.projectActivity.forUser(user.id)).find((item) => item.projectId === project.id) || null;
    const stateSafety = await this.stateSafetySnapshots.get(project.id, deploymentActivity);
    if (
      typeof cloudState.evidence.isDeploymentJobActive !== "boolean" ||
      cloudState.evidence.isDeploymentJobActive !== deploymentActivity.isDeploymentJobActive
    ) {
      cloudState = await this.cloudStateReconciliation.reconcile(project.id);
    }
    const activeRun = deploymentActivity.activePipelineRunId
      ? deploymentActivity.activePipelineRunId === run?.id
        ? run
        : await this.runRepository.findOne({ where: { id: deploymentActivity.activePipelineRunId, projectId: project.id } })
      : null;
    const activeRunCount = deploymentActivity.isDeploymentJobActive ? 1 : 0;
    const pipelineEvents = run
      ? await this.eventRepository.find({
          where: { projectId: project.id, pipelineRunId: run.id },
          order: { occurredAt: "ASC", sequenceNumber: "ASC" },
        })
      : [];
    const infrastructureEvents = run
      ? await this.infrastructureEventRepository.find({
          where: { projectId: project.id, pipelineRunId: run.id },
          order: { occurredAt: "ASC", sequenceNumber: "ASC" },
        })
      : [];
    const events = this.filterSupersededStateEvents(
      this.withProjectedInfrastructureEvents(pipelineEvents, infrastructureEvents, run, lock),
      stateSafety,
    );
    const [stateScan, stateEstimate, stateEnvironment, stateLock, stateStorage, stateDeployment] = run
      ? await Promise.all([
          this.latestForRun(this.scanRepository, project.id, run.id),
          this.latestForRun(this.estimateRepository, project.id, run.id),
          this.latestForRun(this.environmentRepository, project.id, run.id),
          this.latestForRun(this.lockRepository, project.id, run.id),
          this.latestForRun(this.storageRepository, project.id, run.id),
          this.latestForRun(this.deploymentRepository, project.id, run.id),
        ])
      : [scan, estimate, environment, lock, storage, deployment];
    const infraConfig = getInfrastructureConfig(this.config);
    const finopsConfig = getFinopsConfig(this.config);
    const observabilityConfig = getObservabilityConfig(this.config);
    const stateConfig = getStateManagementConfig(this.config);
    const modes = {
      finopsMockMode: finopsConfig.mockMode,
      finopsTierEnforcement: finopsConfig.enforceTierLimits,
      stateMockMode: stateConfig.mockMode,
      prometheusEnabled: observabilityConfig.prometheusEnabled,
      cloudWatchLogsEnabled: observabilityConfig.cloudWatchLogsEnabled,
      cloudWatchMetricsEnabled: observabilityConfig.cloudWatchMetricsEnabled,
    };
    const applyEnabled = infraConfig.terraformApplyEnabled;
    const applyRequiresApproval = envBoolean(this.config, "TERRAFORM_APPLY_REQUIRES_APPROVAL", true);
    const trivyScanEnabled = envBoolean(
      this.config,
      "TRIVY_SCAN_ENABLED",
      envBoolean(this.config, "TRIVY_ENABLED", true)
    );
    const securityGateMode =
      this.config.get<string>("SECURITY_GATE_MODE", "enforce") === "bypass" ? "bypass" : "enforce";
    const aiAssistantEnabled = envBoolean(this.config, "AI_ASSISTANT_ENABLED", false);
    const safeMode = !applyEnabled;
    const costTierWarningOnly = Boolean(
      stateEstimate &&
        !finopsConfig.enforceTierLimits &&
        (stateEstimate.status === CostEstimateStatus.BLOCKED_BY_TIER_LIMIT ||
          stateEstimate.blockedByTierLimit)
    );
    const githubActionsRequired = externalCiRequired(this.config);
    const manualApprovalsEnabled =
      this.config.get<string>("AUTOMATION_MANUAL_APPROVALS_ENABLED", "false") ===
      "true";
    const runDeployment = stateDeployment;
    const resolverInput = {
      run,
      events,
      applyEnabled,
      githubActionsRequired,
      hasRuntimeSignals: Boolean(runDeployment && runtimeMetric),
      hasDeployment: Boolean(runDeployment),
      hasStableRelease: Boolean(release),
      costTierWarningOnly,
    };
    const stages = this.stageResolver.resolve(resolverInput).map((stage) => this.sanitizeStage(stage));
    const lifecycle = this.stageResolver
      .resolveLifecycle(stages)
      .map((stage) => this.sanitizeStage(stage));
    const externalCi = this.sanitizeStage(this.stageResolver.resolveExternalCi(resolverInput));
    const terraformApproval = await this.terraformApprovalStates.evaluate(project.id, run, {
      events: pipelineEvents,
      environment: stateEnvironment,
    });
    const modules = this.sanitizeModules(this.resolveModules({
      project,
      profile,
      contract,
      preflight,
      scan: stateScan,
      estimate: stateEstimate,
      environment: stateEnvironment,
      lock: stateLock,
      stateSafety,
      storage: stateStorage,
      deployment: runDeployment,
      runtimeMetric,
      applyEnabled,
      finopsTierEnforcement: finopsConfig.enforceTierLimits,
      securityDisabled: !trivyScanEnabled || securityGateMode === "bypass",
      finopsDisabledOrMock: finopsConfig.mockMode || !finopsConfig.infracostEnabled,
    }));
    const canManage =
      user.role === UserRole.ADMIN ||
      (user.role === UserRole.DEVELOPER && project.ownerUserId === user.id);
    const baseProductState = this.productState({
      project,
      profile,
      contract,
      preflight,
      run,
      deployment: runDeployment,
      environment: stateEnvironment,
      modules,
      stages,
      applyEnabled,
      applyRequiresApproval,
      canManage,
      manualApprovalsEnabled,
      isDeploymentJobActive: deploymentActivity.isDeploymentJobActive,
      latestRunIsStale: deploymentActivity.latestRunIsStale,
      stateSafety,
      terraformApproval,
    });
    const cloudRelevant = Boolean(
      deployment ||
      cloudState.evidence.latestDestroyOperationId ||
      (stateEnvironment && stateEnvironment.status !== InfrastructureEnvironmentStatus.NOT_PROVISIONED)
    );
    const productState = this.withAuthoritativeCloudState(
      baseProductState,
      cloudState,
      project.id,
      canManage,
      cloudRelevant,
      deploymentActivity.isDeploymentJobActive,
    );
    const deployDisabledReasons = this.deployDisabledReasons(
      modules,
      canManage,
      applyEnabled
    );
    const rawProfile = (profile?.rawProfile || {}) as Record<string, unknown>;
    const hasTerraformPlan = stages.some(
      (stage) => stage.stage === "terraform_plan" && stage.status === "passed"
    );
    const setupRequired = !contract || !contract.deployable || !preflight ||
      preflight.inputFingerprint !== contract.contractHash ||
      ![PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(
        preflight.validationStatus as PreflightValidationStatus
      );
    const latestPipeline = this.latestPipelineSnapshot(
      run,
      productState.failedStage,
      terraformApproval.required || (productState.applyGateReached && !applyEnabled),
      deploymentActivity.isDeploymentJobActive,
      deploymentActivity.latestRunIsStale,
    );
    const progress = this.lifecycleProgress(profile, preflight, run, lifecycle, runDeployment);
    const environmentModes = {
      terraformApplyEnabled: applyEnabled,
      terraformApplyRequiresApproval: applyRequiresApproval,
      trivyScanEnabled,
      securityGateMode,
      infracostEnabled: finopsConfig.infracostEnabled,
      aiAssistantEnabled,
      finopsMockMode: finopsConfig.mockMode,
      finopsTierEnforcement: finopsConfig.enforceTierLimits,
      stateMockMode: stateConfig.mockMode,
      githubActionsRequired,
      prometheusEnabled: observabilityConfig.prometheusEnabled,
      cloudWatchLogsEnabled: observabilityConfig.cloudWatchLogsEnabled,
      cloudWatchMetricsEnabled: observabilityConfig.cloudWatchMetricsEnabled,
    };
    const plannedRecoveryIssue = this.recoveryPlanner.plan({
      projectId: project.id,
      repositoryFullName: project.repositoryFullName,
      branch: project.targetBranch,
      contract,
      preflight,
      run,
      events,
      scan: stateScan,
      cost: stateEstimate,
      environment: stateEnvironment,
      lock: stateLock,
      storage: stateStorage,
      deployment: runDeployment,
      databaseTier,
      databaseServiceBinding,
      cloudState,
      isDeploymentJobActive: deploymentActivity.isDeploymentJobActive,
      stateSafety,
    });
    const preliminaryCurrentRunState = deriveCurrentRunState(run, stages, deploymentActivity.isDeploymentJobActive, productState.nextAction as unknown as Record<string, unknown>);
    const currentRecoveryIssue = selectCurrentRecoveryIssue(plannedRecoveryIssue, preliminaryCurrentRunState, runDeployment);
    const finalProductState = this.withRecoveryDecision(productState, currentRecoveryIssue, project.id, canManage);
    const currentRunState = preliminaryCurrentRunState
      ? { ...preliminaryCurrentRunState, primaryAction: finalProductState.nextAction }
      : null;
    const historicalDeploymentIssue = previousDeploymentIssue(currentRunState, deployment, cloudState.healthStatus);
    const lastSuccessfulCheckpoint = [...lifecycle].reverse().find((stage) => ["passed", "skipped"].includes(stage.status)) || null;
    const resourcesMayCost = ["active_resources", "cleanup_required", "manual_review_required"].includes(cloudState.resourceStatus);
    const activitySnapshot = this.canonicalActivitySnapshot(deploymentActivity, stateSafety, cloudState);

    return {
      projectId: project.id,
      projectName: project.name,
      repositoryFullName: project.repositoryFullName,
      branch: project.targetBranch,
      phase: finalProductState.phase,
      overallStatus: finalProductState.overallStatus,
      userFacingStatus: finalProductState.userFacingStatus,
      currentStep: finalProductState.currentStep,
      currentStepLabel: finalProductState.currentStepLabel,
      currentStage: finalProductState.currentStep,
      failedStage: finalProductState.failedStage,
      blockedBy: finalProductState.blockedBy,
      blockedByStage: finalProductState.blockedBy?.stage || null,
      nextAction: finalProductState.nextAction,
      continueAction: finalProductState.nextAction,
      currentRunState,
      runId: run?.id || null,
      lifecycleStatus: terraformApproval.required ? "approval_required" : currentRunState?.status || "not_started",
      currentStageStatus: stages.find((stage) => stage.stage === finalProductState.currentStep)?.status
        || (terraformApproval.required ? "requires_approval" : null),
      approvalRequired: terraformApproval.required,
      approvalEligible: terraformApproval.eligible,
      approvalBlockedReason: terraformApproval.blockedReason,
      terraformApproval,
      currentRecoveryIssue: currentRecoveryIssue ? {
        ...currentRecoveryIssue,
        rootCause: this.logSanitizer.sanitize(currentRecoveryIssue.rootCause),
        simpleExplanation: this.logSanitizer.sanitize(currentRecoveryIssue.simpleExplanation),
        detectedEvidence: currentRecoveryIssue.detectedEvidence.map((evidence) => ({
          ...evidence,
          message: this.logSanitizer.sanitize(evidence.message),
        })),
        requiredAction: this.logSanitizer.sanitize(currentRecoveryIssue.requiredAction),
        developerDetails: this.sanitizeDeveloperDetails(currentRecoveryIssue.developerDetails),
      } : null,
      previousDeploymentIssue: historicalDeploymentIssue,
      recoveryIssue: currentRecoveryIssue ? {
        ...currentRecoveryIssue,
        rootCause: this.logSanitizer.sanitize(currentRecoveryIssue.rootCause),
        simpleExplanation: this.logSanitizer.sanitize(currentRecoveryIssue.simpleExplanation),
        detectedEvidence: currentRecoveryIssue.detectedEvidence.map((evidence) => ({
          ...evidence,
          message: this.logSanitizer.sanitize(evidence.message),
        })),
        requiredAction: this.logSanitizer.sanitize(currentRecoveryIssue.requiredAction),
        developerDetails: this.sanitizeDeveloperDetails(currentRecoveryIssue.developerDetails),
      } : null,
      deploymentRequirements: deploymentRequirements ? {
        status: deploymentRequirements.status,
        applicationStatus: deploymentRequirements.applicationStatus,
        readyToResume: deploymentRequirements.readyToResume,
        resumeFromStage: deploymentRequirements.resumeFromStage,
        unresolvedInputKeys: deploymentRequirements.requiredInputs
          .filter((item) => item.configured !== true)
          .map((item) => String(item.key || ""))
          .filter(Boolean),
        savedAt: deploymentRequirements.savedAt,
        appliedAt: deploymentRequirements.appliedAt,
        verifiedAt: deploymentRequirements.verifiedAt,
      } : null,
      databaseServiceBinding: databaseServiceBinding ? {
        id: databaseServiceBinding.id,
        pipelineRunId: databaseServiceBinding.pipelineRunId,
        provider: databaseServiceBinding.provider,
        engine: databaseServiceBinding.engine,
        status: databaseServiceBinding.status,
        databaseName: databaseServiceBinding.databaseName,
        hostReference: databaseServiceBinding.hostReference,
        port: databaseServiceBinding.port,
        configurationFingerprint: databaseServiceBinding.configurationFingerprint,
        passwordSecretConfigured: Boolean(databaseServiceBinding.passwordSecretReference),
        databaseUrlSecretConfigured: Boolean(databaseServiceBinding.databaseUrlSecretReference),
        cloudMapServiceConfigured: Boolean(databaseServiceBinding.cloudMapServiceArn),
        efsConfigured: Boolean(databaseServiceBinding.efsFileSystemId && databaseServiceBinding.efsAccessPointId),
        readyAt: databaseServiceBinding.readyAt,
        appliedAt: databaseServiceBinding.appliedAt,
        verifiedAt: databaseServiceBinding.verifiedAt,
      } : null,
      setupRequired,
      terraformStateSafety: stateSafety,
      activitySnapshot,
      time: {
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        lastViewedAt: userActivity?.lastViewedAt || null,
        lastUserActionAt: userActivity?.lastUserActionAt || null,
        lastMeaningfulActivityAt: userActivity?.lastMeaningfulActivityAt || project.createdAt,
        lastPipelineActivityAt: userActivity?.lastPipelineActivityAt || run?.updatedAt || null,
        lastFailureAt: run?.failedAt || null,
        lastRecoveryAt: stateSafety.stateStatus === "recovered" ? stateSafety.authoritativeTimestamp : null,
        lastCloudVerificationAt: cloudState.lastCloudVerifiedAt,
        currentStageStartedAt: deploymentActivity.isActive ? run?.currentStageStartedAt || run?.startedAt || null : null,
      },
      lastFailureAt: run?.failedAt || null,
      lastMeaningfulActivityAt: userActivity?.lastMeaningfulActivityAt || project.createdAt,
      continueHref: userActivity?.lastRoute || `/projects/${project.id}`,
      failedProjectContinuity: {
        latestFailedRunId: run && (run.failedAt || isPipelineFailed(run.status)) ? run.id : null,
        failedStage: finalProductState.failedStage || run?.currentStage || null,
        recoveryIssue: currentRecoveryIssue?.code || null,
        awsResourcesExist: resourcesMayCost || cloudState.infrastructureStatus === "provisioned",
        costRiskCategory: resourcesMayCost ? "potential_cloud_cost" : "none_verified",
        lastSuccessfulCheckpoint: lastSuccessfulCheckpoint ? { stage: lastSuccessfulCheckpoint.stage, label: lastSuccessfulCheckpoint.userFacingStageName } : null,
        recommendedNextAction: finalProductState.nextAction,
        canSafelyLeaveUnresolved: !resourcesMayCost,
        warning: resourcesMayCost ? "Cloud resources still exist and may incur cost. Review verified project inventory before leaving this project unresolved." : null,
      },
      stateStatus: stateSafety.stateStatus,
      lockStatus: stateSafety.lockStatus,
      hasStackDetection: Boolean(profile),
      hasPreflight: Boolean(preflight),
      hasPipelineRun: Boolean(run),
      hasTerraformPlan,
      hasRealDeployment: cloudState.deploymentStatus === "live" || cloudState.deploymentStatus === "unhealthy",
      showFullLifecycle: Boolean(run),
      progressPercentage: progress.percentage,
      progress,
      automationStatus: {
        mode: "fully_automated",
        engine: "deployguard_worker",
        externalCiRequired: githubActionsRequired,
        manualApprovalsEnabled,
      },
      approvalState: manualApprovalsEnabled && modules.security.status === "requires_approval"
        ? { required: true, gate: "security_gate", message: modules.security.message }
        : manualApprovalsEnabled && modules.finops.status === "requires_approval"
          ? { required: true, gate: "cost_gate", message: modules.finops.message }
          : terraformApproval.required
            ? {
                required: true,
                eligible: terraformApproval.eligible,
                blockedReason: terraformApproval.blockedReason,
                gate: "terraform_apply_gate",
                message: terraformApproval.eligible
                  ? "Explicit approval is required before Terraform apply."
                  : terraformApproval.blockedMessage,
              }
            : { required: false, gate: null, message: null },
      runControls: {
        canCancel: Boolean(
          activeRun &&
          canManage &&
          deploymentActivity.isDeploymentJobActive &&
          isPipelineCancelable(activeRun.status)
        ),
        canRetry: Boolean(
          run &&
            canManage &&
            isPipelineRetryable(run.status) &&
            !(
              runDeployment &&
              [
                ProjectDeploymentStatus.HEALTHY,
                ProjectDeploymentStatus.ROLLBACK_SUCCEEDED,
                ].includes(runDeployment.status as ProjectDeploymentStatus)
            )
        ),
        canApproveApply: Boolean(run && canManage && terraformApproval.required && terraformApproval.eligible),
        approvalRequired: terraformApproval.required,
        approvalEligible: terraformApproval.eligible,
        approvalBlockedReason: terraformApproval.blockedReason,
        approvalBlockedMessage: terraformApproval.blockedMessage,
        approveApplyHref: run && terraformApproval.required
          ? `/api/projects/${project.id}/pipeline/runs/${run.id}/approve-apply`
          : null,
        cancelHref: activeRun
          ? `/api/projects/${project.id}/pipeline/runs/${activeRun.id}/cancel`
          : null,
        retryHref: run
          ? `/api/projects/${project.id}/pipeline/runs/${run.id}/retry`
          : null,
      },
      deploymentStatus: cloudState.deploymentStatus,
      healthStatus: cloudState.healthStatus,
      infrastructureStatus: cloudState.infrastructureStatus,
      resourceStatus: cloudState.resourceStatus,
      cleanupStatus: cloudState.cleanupStatus,
      cloudVerificationStatus: cloudState.cloudVerificationStatus,
      inventoryStatus: cloudState.inventoryStatus,
      adminActionRequired: cloudState.adminActionRequired,
      statusExplanation: currentRunState && ["running", "paused", "inactive"].includes(currentRunState.status)
        ? finalProductState.userFacingStatus
        : cloudRelevant
          ? cloudState.statusExplanation
          : finalProductState.userFacingStatus,
      cloudNextAction: cloudState.nextAction,
      lastCloudVerifiedAt: cloudState.lastCloudVerifiedAt,
      cloudState,
      deploymentReconciliation: {
        desiredStateRevision: deploymentRequirements?.configurationRevision || 1,
        desiredConfigurationFingerprint: desiredConfiguration?.configurationFingerprint || null,
        runConfigurationFingerprint: runConfigurationSnapshot?.configurationFingerprint || (typeof run?.metadata?.configurationFingerprint === "string" ? run.metadata.configurationFingerprint : null),
        configurationChanged: Boolean(
          desiredConfiguration?.configurationFingerprint &&
          runConfigurationSnapshot?.configurationFingerprint &&
          desiredConfiguration.configurationFingerprint !== runConfigurationSnapshot.configurationFingerprint
        ),
        terraformStatePresent: cloudState.terraformStatePresent,
        terraformStateSerial: cloudState.terraformStateSerial,
        terraformResourceCount: cloudState.terraformResourceCount,
        terraformApplyStarted: cloudState.terraformApplyStarted,
        terraformApplyCompleted: cloudState.terraformApplyCompleted,
        currentRunCreatedResources: cloudState.currentRunCreatedResources,
        currentRunModifiedResources: cloudState.currentRunModifiedResources,
        existingDeploymentPresent: cloudState.existingDeploymentPresent,
        existingDeploymentRunId: cloudState.existingDeploymentRunId,
        existingDeploymentReachable: cloudState.existingDeploymentReachable,
        infrastructureStatus: cloudState.infrastructureStatus,
        applicationHealth: cloudState.healthStatus,
        dependencyHealth: databaseServiceBinding?.status || "unknown",
        bindingStatus: databaseServiceBinding?.status || "not_configured",
        orphanCandidates: cloudState.orphanCandidates,
        verifiedResidue: cloudState.verifiedResidue,
        unknownResources: cloudState.unknownResources,
        resourceOwnership: cloudState.resourceOwnership,
        cleanupRequiredForCurrentRun: cloudState.cleanupRequiredForCurrentRun,
        projectCleanupRecommended: cloudState.projectCleanupRecommended,
        nextSafeAction: cloudState.nextSafeAction,
        reusableCheckpoints: currentRecoveryIssue?.canResume ? currentRecoveryIssue.affectedStages.filter((stage) => stage !== currentRecoveryIssue.resumeFromStage) : [],
        invalidatedCheckpoints: currentRecoveryIssue?.affectedStages || [],
        reconciliationReason: cloudState.reconciliationReason,
      },
      liveDeployment: deployment?.albDnsName && cloudState.deploymentStatus === "live" && cloudState.cloudVerificationStatus === "verified"
        ? {
            available: true,
            url: `http://${deployment.albDnsName}`,
            hostname: deployment.albDnsName,
            status: deployment.status,
            deploymentId: deployment.id,
          }
        : {
            available: false,
            url: null,
            hostname: null,
            historicalUrl: deployment?.albDnsName ? `http://${deployment.albDnsName}` : null,
            historicalHostname: deployment?.albDnsName || null,
            stale: Boolean(deployment?.albDnsName),
            status: deployment?.status || "not_deployed",
            deploymentId: deployment?.id || null,
          },
      currentDeployment: runDeployment ? {
        id: runDeployment.id,
        pipelineRunId: runDeployment.pipelineRunId,
        status: runDeployment.status,
        healthStatus: runDeployment.status === ProjectDeploymentStatus.HEALTHY ? "healthy" : runDeployment.status,
        url: runDeployment.albDnsName ? `http://${runDeployment.albDnsName}` : null,
      } : null,
      existingStableDeployment: deployment && deployment.pipelineRunId !== run?.id ? {
        id: deployment.id,
        pipelineRunId: deployment.pipelineRunId || null,
        releaseId: release?.id || null,
        status: deployment.status,
        healthStatus: deployment.status === ProjectDeploymentStatus.HEALTHY ? "healthy" : deployment.status,
        url: deployment.albDnsName ? `http://${deployment.albDnsName}` : null,
        verified: cloudState.cloudVerificationStatus === "verified",
      } : null,
      historicalHealthIssue: historicalDeploymentIssue,
      deployButtonEnabled: deployDisabledReasons.length === 0,
      deployDisabledReasons,
      latestPipelineRunId: run?.id || null,
      latestPipelineStatus: latestPipeline.status,
      isDeploymentJobActive: deploymentActivity.isDeploymentJobActive,
      activePipelineRunId: deploymentActivity.activePipelineRunId,
      latestRunStatus: deploymentActivity.latestRunStatus,
      latestRunIsStale: deploymentActivity.latestRunIsStale,
      infrastructureProvisioned:
        cloudState.infrastructureStatus === "provisioned" ||
        [InfrastructureEnvironmentStatus.PROVISIONED, InfrastructureEnvironmentStatus.PARTIALLY_PROVISIONED].includes(
          stateEnvironment?.status as InfrastructureEnvironmentStatus,
        ),
      appLiveVerified:
        cloudState.deploymentStatus === "live" &&
        cloudState.healthStatus === "healthy" &&
        cloudState.cloudVerificationStatus === "verified",
      latestPipeline,
      failureClass: latestPipeline.failureClass,
      activeRunCount,
      activeRun: activeRun
        ? {
            ...this.latestPipelineSnapshot(activeRun, null, false, true, false),
            currentStep: activeRun.currentStage,
            currentStepLabel: presentPipelineStage(activeRun.currentStage).label,
          }
        : null,
      safeMode,
      applyEnabled,
      modes,
      environmentModes,
      repository: {
        status: project.repositoryFullName && project.targetBranch ? "connected" : project.repositoryUrl ? "invalid" : "missing",
        fullName: project.repositoryFullName || null,
        branch: project.targetBranch || null,
        appDirectory: project.appDirectory || null,
      },
      deploymentContract: contract
        ? {
            id: contract.id,
            contractHash: contract.contractHash,
            commitSha: contract.commitSha,
            detectionSourceCommit: contract.detectionSourceCommit,
            appRoot: contract.appRoot,
            language: contract.language,
            framework: contract.framework,
            runtimeType: contract.runtimeType,
            packageManager: contract.packageManager,
            installCommand: contract.installCommand,
            buildCommand: contract.buildCommand,
            startCommand: contract.startCommand,
            outputDirectory: contract.outputDirectory,
            port: contract.port,
            portSource: contract.portSource,
            bindsToPortEnv: contract.bindsToPortEnv,
            bindHost: contract.bindHost,
            healthPath: contract.healthPath,
            requiredEnvVars: contract.requiredEnvVars,
            optionalEnvVars: contract.optionalEnvVars,
            buildTimeEnvVars: contract.buildTimeEnvVars,
            runtimeEnvVars: contract.runtimeEnvVars,
            missingEnvVars: contract.missingEnvVars,
            databaseRequired: contract.databaseRequired,
            databaseEngine: contract.databaseEngine,
            persistentStorageRequired: contract.persistentStorageRequired,
            privateRegistryRequired: contract.privateRegistryRequired,
            dockerStrategy: contract.dockerStrategy,
            dockerTemplate: contract.dockerTemplate,
            ecsPlan: contract.ecsPlan,
            deployable: contract.deployable,
            blockers: contract.blockers,
            warnings: contract.warnings,
            confidence: contract.confidence,
            generatedAt: contract.generatedAt,
            invalidatedReason: contract.invalidatedReason,
          }
        : null,
      database: databaseTier ? {
        required: databaseTier.requiredByDetection,
        provider: databaseTier.provider,
        engine: databaseTier.engine,
        status: databaseTier.status,
        host: databaseTier.provider === "managed" ? databaseTier.internalHost : databaseTier.externalHost,
        port: databaseTier.provider === "external" ? databaseTier.externalPort : databaseTier.engine === "mysql" ? 3306 : 5432,
        persistenceEnabled: databaseTier.persistenceEnabled,
        backupEnabled: databaseTier.backupEnabled,
        credentialsConfigured: Boolean(databaseTier.credentialsSecretArn),
      } : contract?.databaseRequired ? { required: true, provider: null, engine: contract.databaseEngine, status: "setup_required", host: null, port: null, persistenceEnabled: null, backupEnabled: null, credentialsConfigured: false } : { required: false, provider: "none", engine: null, status: "not_required", host: null, port: null, persistenceEnabled: false, backupEnabled: false, credentialsConfigured: false },
      stackDetection: {
        status: !profile ? "not_started" : !contract || [DetectionStatus.FAILED, DetectionStatus.NEEDS_MANUAL_DOCKERFILE].includes(profile.detectionStatus as DetectionStatus) ? "failed" : "passed",
        language: contract?.language || profile?.language || profile?.ecosystem || null,
        framework: contract?.framework || profile?.framework || null,
        packageManager: contract?.packageManager || profile?.packageManager || null,
        buildCommand: contract?.buildCommand || profile?.buildCommand || null,
        startCommand: contract?.startCommand || profile?.startCommand || null,
        port: contract?.port || profile?.expectedPort || null,
        appDirectory: contract?.appRoot || (typeof rawProfile.appDirectory === "string" ? rawProfile.appDirectory : null),
        confidence: contract?.confidence || profile?.confidence || null,
        warnings: contract?.warnings || profile?.warnings || [],
      },
      preflight: {
        status: !preflight ? "not_started" : contract && preflight.inputFingerprint === contract.contractHash && contract.deployable && [PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(preflight.validationStatus as PreflightValidationStatus) ? "passed" : "failed",
        template: preflight?.templateDisplayName || preflight?.templateKey || null,
        dockerfileGenerated: Boolean(preflight?.generatedDockerfile),
        warnings: contract?.warnings || preflight?.warnings || [],
        errors: contract?.blockers || preflight?.errors || [],
      },
      modules,
      stages,
      lifecycle,
      lifecycleVersion: "2026-07-version-14",
      externalCi,
      recentActivity: this.recentActivity({ project, profile, preflight, scan: stateScan, estimate: stateEstimate, deployment: runDeployment, events }),
    };
  }

  private withAuthoritativeCloudState<T extends {
    phase: string;
    overallStatus: string;
    userFacingStatus: string;
    currentStep: string;
    currentStepLabel: string;
    nextAction: NextAction;
    blockedBy: { stage: string; reason: string; userMessage: string } | null;
  }>(
    state: T,
    cloud: AuthoritativeProjectCloudState,
    projectId: string,
    canManage: boolean,
    relevant: boolean,
    isDeploymentJobActive: boolean,
  ): T {
    if (!relevant) return state;
    const base = `/projects/${projectId}`;
    if (cloud.deploymentStatus === "destroyed") {
      return { ...state, phase: "deployment", overallStatus: "destroyed", userFacingStatus: cloud.statusExplanation, currentStep: "cloud_state", currentStepLabel: "Infrastructure Destroyed", nextAction: this.cloudAction(cloud.nextAction, base, canManage), blockedBy: null };
    }
    if (
      ["stale_live_record", "unhealthy", "failed"].includes(cloud.deploymentStatus) &&
      !isDeploymentJobActive &&
      !["paused", "destroying"].includes(state.overallStatus)
    ) {
      const label = cloud.deploymentStatus === "stale_live_record" ? "Deployment Not Verified" : cloud.deploymentStatus === "unhealthy" ? "Deployment Unhealthy" : "Deployment Failed";
      return { ...state, phase: "failed", overallStatus: "failed", userFacingStatus: cloud.statusExplanation, currentStep: "cloud_verification", currentStepLabel: label, nextAction: this.cloudAction(cloud.nextAction, base, canManage), blockedBy: { stage: "cloud_verification", reason: cloud.statusExplanation, userMessage: cloud.statusExplanation } };
    }
    if (cloud.infrastructureStatus === "destroy_running") {
      return { ...state, phase: "deployment", overallStatus: "destroying", userFacingStatus: cloud.statusExplanation, currentStep: "terraform_destroy", currentStepLabel: "Destroying AWS Resources", nextAction: this.cloudAction("no_action", base, canManage), blockedBy: null };
    }
    if (cloud.adminActionRequired && cloud.nextAction !== "no_action" && !["running", "paused"].includes(state.overallStatus)) {
      return { ...state, userFacingStatus: cloud.statusExplanation, nextAction: this.cloudAction(cloud.nextAction, base, canManage) };
    }
    return state;
  }

  private withRecoveryDecision<T extends {
    phase: string;
    overallStatus: string;
    userFacingStatus: string;
    currentStep: string;
    currentStepLabel: string;
    nextAction: NextAction;
    blockedBy: { stage: string; reason: string; userMessage: string } | null;
  }>(state: T, recovery: ReturnType<DeploymentRecoveryPlanner["plan"]>, projectId: string, canManage: boolean): T {
    if (!recovery) return state;
    const blocking = ["blocker", "critical"].includes(recovery.severity);
    const disabledReasons = canManage ? [] : ["You do not have permission to change this project."];
    return {
      ...state,
      phase: "failed",
      overallStatus: blocking ? "blocked" : "failed",
      userFacingStatus: recovery.simpleExplanation,
      currentStep: recovery.resumeFromStage || recovery.code,
      currentStepLabel: recovery.title,
      nextAction: action(
        ["terraform_recovery_completed_resume", "project_configuration_changed"].includes(recovery.code) ? "resume_from_terraform_plan" : "fix_failure",
        recovery.primaryActionLabel,
        recovery.requiredAction,
        recovery.primaryActionRoute || `/projects/${projectId}/recovery`,
        "GET",
        canManage,
        disabledReasons,
      ),
      blockedBy: blocking
        ? { stage: recovery.resumeFromStage || recovery.code, reason: recovery.rootCause, userMessage: recovery.simpleExplanation }
        : null,
    };
  }

  private cloudAction(type: string, base: string, canManage: boolean): NextAction {
    const map: Record<string, [string, string, string]> = {
      refresh_inventory: ["Refresh Cloud Inventory", "Refresh AWS inventory before trusting stored deployment status.", `${base}/settings`],
      verify_cloud_state: ["Verify Cloud State", "Refresh cloud evidence to confirm whether this deployment still exists.", `${base}/settings`],
      run_terraform_destroy: ["Run Terraform Destroy", "Remove resources through this project's Terraform state scope.", `${base}/settings`],
      clean_safe_leftovers: ["Open Resource Cleanup", "Clean only verified project-scoped leftovers.", `${base}/settings`],
      review_manual_resources: ["Review Cloud Resources", "Review resources that cannot be cleaned automatically.", `${base}/settings`],
      view_ecs_diagnostics: ["View ECS Diagnostics", "Inspect ECS tasks and load balancer target health.", `${base}/orchestration`],
      retry_deployment: ["Open Pipeline", "Review the failure before starting a new deployment.", `${base}/pipeline`],
      mark_destroyed_after_verification: ["Verify Destroyed State", "Confirm that no active project resources remain.", `${base}/settings`],
      no_action: ["No Action Required", "Cloud state does not require an action.", base],
    };
    const [label, description, href] = map[type] || map.verify_cloud_state;
    const enabled = type !== "no_action" && canManage;
    return action(type, label, description, href, "GET", enabled, enabled ? [] : type === "no_action" ? ["No action is required."] : ["You do not have permission to change this project."]);
  }

  private canonicalActivitySnapshot(deployment: PipelineActivitySnapshot, state: TerraformStateSafetySnapshot, cloud: AuthoritativeProjectCloudState) {
    if (deployment.isActive) return deployment;
    if (state.recoveryActive) return { isActive: true, activityType: "recovery", pipelineRunId: state.activePipelineRunId, stage: "state_recovery", startedAt: state.recoveryStartedAt, lastHeartbeatAt: state.authoritativeTimestamp, source: "state_recovery", stale: false, displayMessage: "Terraform state recovery is active." };
    if (state.queueActive) return { isActive: true, activityType: "terraform", pipelineRunId: state.activePipelineRunId, stage: "state_lock", startedAt: null, lastHeartbeatAt: state.authoritativeTimestamp, source: "terraform", stale: false, displayMessage: "A Terraform operation is active." };
    const destroyStatus = String(cloud.evidence.latestDestroyStatus || "");
    if (["queued", "running", "processing"].includes(destroyStatus)) return { isActive: true, activityType: "cleanup", pipelineRunId: null, stage: "terraform_destroy", startedAt: cloud.evidence.latestDestroyStartedAt || null, lastHeartbeatAt: cloud.evidence.latestDestroyUpdatedAt || null, source: "cleanup", stale: false, displayMessage: "Project infrastructure cleanup is active." };
    return { isActive: false, activityType: null, pipelineRunId: null, stage: null, startedAt: null, lastHeartbeatAt: null, source: "none", stale: deployment.latestRunIsStale, displayMessage: deployment.displayMessage };
  }

  private recentActivity(input: {
    project: Project;
    profile: ProjectDetectionProfile | null;
    preflight: ProjectPreflightReport | null;
    scan: ProjectSecurityScan | null;
    estimate: ProjectCostEstimate | null;
    deployment: ProjectDeployment | null;
    events: ProjectPipelineEvent[];
  }) {
    const activity = input.events.map((event) => ({
      id: event.id,
      stage: event.stage,
      status: event.status,
      message: this.safeMessage(event.message, "Pipeline activity was recorded."),
      createdAt: event.occurredAt || event.createdAt,
    }));
    activity.push({ id: `project-${input.project.id}`, stage: "workspace_created", status: "success", message: "Project workspace created and repository connected.", createdAt: input.project.createdAt });
    if (input.profile) activity.push({ id: `detection-${input.profile.id}`, stage: "stack_detection", status: input.profile.detectionStatus === DetectionStatus.FAILED ? "failed" : "success", message: input.profile.detectionStatus === DetectionStatus.FAILED ? "Stack detection needs attention." : `${input.profile.framework || input.profile.ecosystem} stack detected.`, createdAt: input.profile.updatedAt });
    if (input.preflight) activity.push({ id: `preflight-${input.preflight.id}`, stage: "preflight", status: [PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(input.preflight.validationStatus as PreflightValidationStatus) ? "success" : "failed", message: `Pre-flight validation ${input.preflight.validationStatus.replaceAll("_", " ")}.`, createdAt: input.preflight.updatedAt });
    if (input.scan) activity.push({ id: `scan-${input.scan.id}`, stage: "security_scan", status: input.scan.scanStatus === SecurityScanStatus.FAILED ? "failed" : "success", message: "Latest Trivy security result recorded.", createdAt: input.scan.updatedAt });
    if (input.estimate) activity.push({ id: `cost-${input.estimate.id}`, stage: "finops_estimate", status: input.estimate.status === CostEstimateStatus.FAILED ? "failed" : "success", message: `${input.estimate.source === "mock" ? "Mock" : "Real"} cost estimate recorded.`, createdAt: input.estimate.updatedAt });
    if (input.deployment) activity.push({ id: `deployment-${input.deployment.id}`, stage: "ecs_deployment", status: [ProjectDeploymentStatus.FAILED, ProjectDeploymentStatus.UNHEALTHY].includes(input.deployment.status as ProjectDeploymentStatus) ? "failed" : "success", message: `ECS deployment status: ${input.deployment.status.replaceAll("_", " ")}.`, createdAt: input.deployment.updatedAt });
    return activity.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 5);
  }

  private lifecycleProgress(
    profile: ProjectDetectionProfile | null,
    preflight: ProjectPreflightReport | null,
    run: ProjectPipelineRun | null,
    stages: ResolvedPipelineStage[],
    deployment: ProjectDeployment | null
  ) {
    const setupCompleted = 1 + (profile ? 1 : 0) + (preflight ? 1 : 0);
    const completedPipelineStages = run
      ? stages.filter((stage) => ["passed", "skipped", "disabled_by_config"].includes(stage.status)).length
      : 0;
    const totalStages = 3 + stages.length;
    const deploymentSucceeded = Boolean(deployment && [ProjectDeploymentStatus.HEALTHY, ProjectDeploymentStatus.ROLLBACK_SUCCEEDED, ProjectDeploymentStatus.SCALED].includes(deployment.status as ProjectDeploymentStatus));
    const completedStages = deploymentSucceeded ? totalStages : setupCompleted + completedPipelineStages;
    const activeIndex = run
      ? stages.findIndex((stage) => ["running", "requires_approval", "failed", "disabled_by_config", "pending"].includes(stage.status))
      : -1;
    return {
      completedStages,
      totalStages,
      currentStageNumber: deploymentSucceeded
        ? totalStages
        : activeIndex >= 0
          ? Math.min(totalStages, 4 + activeIndex)
          : Math.min(totalStages, setupCompleted + 1),
      percentage: deploymentSucceeded
        ? 100
        : Math.min(99, Math.round((completedStages / totalStages) * 100)),
    };
  }

  private resolveModules(input: {
    project: Project;
    profile: ProjectDetectionProfile | null;
    contract: ProjectDeploymentContract | null;
    preflight: ProjectPreflightReport | null;
    scan: ProjectSecurityScan | null;
    estimate: ProjectCostEstimate | null;
    environment: ProjectInfrastructureEnvironment | null;
    lock: ProjectTerraformLock | null;
    stateSafety: TerraformStateSafetySnapshot;
    storage: ProjectPersistentStorage | null;
    deployment: ProjectDeployment | null;
    runtimeMetric: ProjectRuntimeMetricSnapshot | null;
    applyEnabled: boolean;
    finopsTierEnforcement: boolean;
    securityDisabled: boolean;
    finopsDisabledOrMock: boolean;
  }): Modules {
    const base = `/projects/${input.project.id}`;
    return {
      repository: this.repositoryModule(input.project, base),
      detection: this.detectionModule(input.profile, input.contract, base),
      preflight: this.preflightModule(input.preflight, input.contract, base),
      security: this.securityModule(input.scan, input.securityDisabled, base),
      finops: this.finopsModule(
        input.estimate,
        input.finopsTierEnforcement,
        input.finopsDisabledOrMock,
        base
      ),
      infrastructure: this.infrastructureModule(
        input.environment,
        input.applyEnabled,
        base
      ),
      state: this.stateModule(input.stateSafety, base),
      storage: this.storageModule(input.storage, input.contract, base),
      orchestration: this.orchestrationModule(input.deployment, base),
      observability: this.observabilityModule(input.runtimeMetric, input.deployment, base),
    };
  }

  private repositoryModule(project: Project, base: string): ProjectModuleState {
    const repositoryReady = Boolean(project.repositoryUrl && project.repositoryFullName);
    const branchReady = Boolean(project.targetBranch);
    if (!repositoryReady) {
      return moduleState("not_started", "Repository", "Connect a GitHub repository.", "connect_repository", "Connect Repository", `${base}/settings`, true, project.updatedAt);
    }
    if (!branchReady) {
      return moduleState("waiting", "Repository", "Select the branch DeployGuard should release.", "select_branch", "Select Branch", `${base}/settings`, true, project.updatedAt);
    }
    return moduleState("passed", "Repository", `${project.repositoryFullName} · ${project.targetBranch}`, null, null, `${base}/settings`, true, project.updatedAt);
  }

  private detectionModule(profile: ProjectDetectionProfile | null, contract: ProjectDeploymentContract | null, base: string): ProjectModuleState {
    if (!profile) return moduleState("not_started", "Stack Detection", "Stack detection has not run.", "run_detection", "Run Stack Detection", `${base}/detection`, true, null);
    if (!contract) return moduleState("failed", "Stack Detection", "Deployment contract is missing. Run stack detection again.", "run_detection", "Run Stack Detection Again", `${base}/detection`, true, profile.updatedAt);
    if (contract?.invalidatedReason) return moduleState("failed", "Stack Detection", contract.invalidatedReason, "run_detection", "Run Stack Detection Again", `${base}/detection`, true, contract.updatedAt);
    if (profile.detectionStatus === DetectionStatus.FAILED) return moduleState("failed", "Stack Detection", this.safeMessage(profile.errors?.[0], "Stack detection failed."), "run_detection", "Retry Detection", `${base}/detection`, true, profile.updatedAt);
    if (profile.detectionStatus === DetectionStatus.NEEDS_MANUAL_DOCKERFILE) {
      const unsupportedReason = (profile.rawProfile as Record<string, unknown> | null)?.unsupportedReason;
      return moduleState(
        "blocked",
        "Stack Detection",
        this.safeMessage(
          typeof unsupportedReason === "string" ? unsupportedReason : profile.warnings?.[0],
          "A manual Dockerfile or supported web target is required before continuing."
        ),
        "run_detection",
        "Review Detection",
        `${base}/detection`,
        true,
        profile.updatedAt
      );
    }
    return moduleState("passed", "Stack Detection", `${profile.framework || profile.ecosystem} detected.`, null, null, `${base}/detection`, true, profile.updatedAt);
  }

  private preflightModule(report: ProjectPreflightReport | null, contract: ProjectDeploymentContract | null, base: string): ProjectModuleState {
    if (contract && !contract.deployable) return moduleState("failed", "Pre-flight", this.safeMessage(contract.blockers[0], "Deployment contract has blocking findings."), "generate_preflight", "Review Pre-flight", `${base}/preflight`, true, contract.updatedAt);
    if (!report) return moduleState("not_started", "Pre-flight", "Generate a pre-flight report.", "generate_preflight", "Generate Pre-flight Report", `${base}/preflight`, true, null);
    if (!contract || report.inputFingerprint !== contract.contractHash) return moduleState("failed", "Pre-flight", "Deployment contract changed. Regenerate pre-flight before starting a pipeline.", "generate_preflight", "Regenerate Pre-flight", `${base}/preflight`, true, report.updatedAt);
    if (report.validationStatus === PreflightValidationStatus.FAILED || report.validationStatus === PreflightValidationStatus.MANUAL_DOCKERFILE_REQUIRED) return moduleState("failed", "Pre-flight", this.safeMessage(report.errors?.[0], "Pre-flight validation must be resolved."), "generate_preflight", "Review Pre-flight", `${base}/preflight`, true, report.updatedAt);
    if (report.validationStatus === PreflightValidationStatus.PASSED_WITH_WARNINGS) return moduleState("warning", "Pre-flight", "Validation passed with warnings.", null, null, `${base}/preflight`, true, report.updatedAt);
    return moduleState("passed", "Pre-flight", "Pre-flight validation passed.", null, null, `${base}/preflight`, true, report.updatedAt);
  }

  private securityModule(scan: ProjectSecurityScan | null, disabled: boolean, base: string): ProjectModuleState {
    if (disabled) return moduleState("skipped", "Security", "Trivy/security enforcement is disabled; no production security pass is claimed.", null, "Open Security", `${base}/security`, false, scan?.updatedAt || null);
    if (!scan) return moduleState("not_started", "Security", "Dockerfile checks run before build and the built image is scanned afterward.", null, null, `${base}/security`, true, null);
    if (scan.scanStatus === SecurityScanStatus.QUEUED) return moduleState("waiting", "Security", "The image scan is queued.", null, null, `${base}/security`, true, scan.updatedAt);
    if (scan.scanStatus === SecurityScanStatus.RUNNING) return moduleState("running", "Security", "The built image is being scanned.", null, null, `${base}/security`, true, scan.updatedAt);
    if (scan.scanStatus === SecurityScanStatus.FAILED) return moduleState("warning", "Security", this.safeMessage(scan.policyReason, "The image scan did not complete."), null, "Review Security", `${base}/security`, true, scan.updatedAt);
    if (scan.policyDecision === SecurityPolicyDecision.BLOCKED) return moduleState("blocked", "Security", this.safeMessage(scan.policyReason, "The configured security policy blocked this image."), null, "Review Security", `${base}/security`, true, scan.updatedAt);
    if (scan.policyDecision === SecurityPolicyDecision.REQUIRES_APPROVAL) return moduleState("requires_approval", "Security", this.safeMessage(scan.policyReason, "Security approval is required."), "approve_security", "Review Security", `${base}/security`, true, scan.updatedAt);
    if (![SecurityPolicyDecision.ALLOWED, SecurityPolicyDecision.APPROVED_OVERRIDE].includes(scan.policyDecision as SecurityPolicyDecision)) return moduleState("warning", "Security", "The image scan completed without a persisted policy decision.", null, "Review Security", `${base}/security`, true, scan.updatedAt);
    return moduleState("passed", "Security", `Image scan completed · ${scan.criticalCount} critical · ${scan.highCount} high.`, null, null, `${base}/security`, true, scan.updatedAt);
  }

  private finopsModule(estimate: ProjectCostEstimate | null, enforceTierLimits: boolean, disabledOrMock: boolean, base: string): ProjectModuleState {
    if (disabledOrMock) return moduleState("skipped", "FinOps", estimate ? "Mock/local cost estimate available; no real Infracost result is claimed." : "FinOps/Infracost is disabled or mock for this deployment.", null, "Open FinOps", `${base}/costs`, false, estimate?.updatedAt || null);
    if (!estimate) return moduleState("not_started", "FinOps", "A cost estimate will be generated after Terraform plan.", null, "Open FinOps", `${base}/costs`, true, null);
    const overTier = Boolean(estimate.blockedByTierLimit || estimate.status === CostEstimateStatus.BLOCKED_BY_TIER_LIMIT || estimate.status === CostEstimateStatus.WARNING_OVER_TIER);
    if (overTier && !enforceTierLimits) return moduleState("warning", "FinOps", "Estimate is over the configured tier; Tier Enforcement Off.", null, "Review Cost Estimate", `${base}/costs`, true, estimate.updatedAt);
    if (estimate.status === CostEstimateStatus.APPROVAL_REQUIRED) return moduleState("requires_approval", "FinOps", "Cost approval is required before apply.", "approve_cost_gate", "Approve Cost Gate", `${base}/costs`, true, estimate.updatedAt);
    if (estimate.status === CostEstimateStatus.BLOCKED_BY_TIER_LIMIT) return moduleState("blocked", "FinOps", "Estimate exceeds the enforced subscription tier limit.", null, "Review Cost Estimate", `${base}/costs`, true, estimate.updatedAt);
    if (estimate.status === CostEstimateStatus.REJECTED || estimate.status === CostEstimateStatus.FAILED) return moduleState("failed", "FinOps", this.safeMessage(estimate.errorMessage || estimate.rejectionReason, "The latest cost gate failed."), null, "Review Cost Estimate", `${base}/costs`, true, estimate.updatedAt);
    if ([CostEstimateStatus.PENDING, CostEstimateStatus.CALCULATING].includes(estimate.status)) return moduleState("running", "FinOps", "Cost analysis is running.", null, null, `${base}/costs`, true, estimate.updatedAt);
    return moduleState("passed", "FinOps", `${estimate.source === "mock" ? "Mock" : "Real"} estimate · ${estimate.currency} ${estimate.totalMonthlyCost}/month.`, null, null, `${base}/costs`, true, estimate.updatedAt);
  }

  private infrastructureModule(environment: ProjectInfrastructureEnvironment | null, applyEnabled: boolean, base: string): ProjectModuleState {
    if (!environment) return moduleState("not_started", "Infrastructure", applyEnabled ? "Terraform plan has not run." : "Safe Mode active; Terraform plan remains available.", null, "Open Infrastructure", `${base}/infrastructure`, true, null);
    const status = environment.status as InfrastructureEnvironmentStatus;
    if (status === InfrastructureEnvironmentStatus.DESTROYING) return moduleState("running", "Infrastructure", "Terraform destroy is removing project-scoped AWS resources.", null, "View Pipeline Events", `${base}/logs`, true, environment.updatedAt);
    if (status === InfrastructureEnvironmentStatus.DESTROY_NEEDS_CLEANUP) return moduleState("failed", "Infrastructure", "Terraform destroy completed, but project cloud residue remains or verification was incomplete.", null, "Open Admin Cleanup", `${base}/settings`, true, environment.updatedAt);
    if (status === InfrastructureEnvironmentStatus.DESTROYED) return moduleState("passed", "Infrastructure", "Project-scoped AWS resources were destroyed; protected shared resources were preserved.", null, null, `${base}/infrastructure`, true, environment.updatedAt);
    if (status === InfrastructureEnvironmentStatus.DESTROY_FAILED) return moduleState("failed", "Infrastructure", this.safeMessage(environment.errorMessage, "Terraform destroy failed."), null, "Review Project Settings", `${base}/settings`, true, environment.updatedAt);
    if (status === InfrastructureEnvironmentStatus.DISABLED_BY_CONFIG || (!applyEnabled && status === InfrastructureEnvironmentStatus.FAILED && /apply is disabled/i.test(environment.errorMessage || ""))) return moduleState("disabled_by_config", "Infrastructure", "Terraform apply is disabled by configuration; plan-only validation remains available.", "enable_apply", "Review Apply Gate", `${base}/infrastructure`, true, environment.updatedAt);
    if ([InfrastructureEnvironmentStatus.QUEUED, InfrastructureEnvironmentStatus.PLANNING, InfrastructureEnvironmentStatus.PROVISIONING].includes(status)) return moduleState("running", "Infrastructure", `Infrastructure is ${status.replaceAll("_", " ")}.`, null, null, `${base}/infrastructure`, true, environment.updatedAt);
    if ([InfrastructureEnvironmentStatus.FAILED, InfrastructureEnvironmentStatus.PLAN_FAILED, InfrastructureEnvironmentStatus.READINESS_FAILED, InfrastructureEnvironmentStatus.PARTIALLY_PROVISIONED].includes(status)) return moduleState("failed", "Infrastructure", this.safeMessage(environment.errorMessage, "Infrastructure provisioning failed."), null, "Review Infrastructure", `${base}/infrastructure`, true, environment.updatedAt);
    if (status === InfrastructureEnvironmentStatus.PROVISIONED) return moduleState("passed", "Infrastructure", "Terraform infrastructure is provisioned.", null, null, `${base}/infrastructure`, true, environment.updatedAt);
    if ([InfrastructureEnvironmentStatus.COST_CHECK_REQUIRED, InfrastructureEnvironmentStatus.WAITING_FOR_COST_APPROVAL].includes(status)) return moduleState(status === InfrastructureEnvironmentStatus.WAITING_FOR_COST_APPROVAL ? "requires_approval" : "waiting", "Infrastructure", "Terraform plan is ready at the cost/apply gate.", null, "Review Infrastructure", `${base}/infrastructure`, true, environment.updatedAt);
    return moduleState("not_started", "Infrastructure", "Infrastructure has not been provisioned.", null, "Open Infrastructure", `${base}/infrastructure`, true, environment.updatedAt);
  }

  private stateModule(snapshot: TerraformStateSafetySnapshot, base: string): ProjectModuleState {
    const updatedAt = snapshot.authoritativeTimestamp ? new Date(snapshot.authoritativeTimestamp) : null;
    if (snapshot.recoveryRequired) return moduleState("failed", "Terraform State", "Terraform state safety needs attention.", null, "Review State", `${base}/state`, true, updatedAt);
    if (snapshot.queueActive) return moduleState("running", "Terraform State", "A Terraform operation is active or waiting for state access.", "wait_for_state_lock", "View State Activity", `${base}/state`, true, updatedAt);
    if (snapshot.lockStatus === "none" && snapshot.stateStatus === "missing") return moduleState("not_started", "Terraform State", "No state lock has been requested.", null, "Open State Management", `${base}/state`, true, updatedAt);
    return moduleState("passed", "Terraform State", snapshot.stateStatus === "recovered" ? "Terraform state is recovered, validated, and unlocked." : "Terraform state is healthy and the latest lock is released.", null, null, `${base}/state`, true, updatedAt);
  }

  private storageModule(storage: ProjectPersistentStorage | null, contract: ProjectDeploymentContract | null, base: string): ProjectModuleState {
    if (!contract) return moduleState("not_started", "Persistent Storage", "Storage requirements will be evaluated after stack detection.", null, null, `${base}/storage`, false, null);
    if (!contract.persistentStorageRequired || storage?.status === PersistentStorageStatus.NOT_REQUIRED) return moduleState("skipped", "Persistent Storage", "Persistent storage is not required for the detected app.", null, null, `${base}/storage`, false, storage?.updatedAt || contract.updatedAt);
    if (!storage) return moduleState("waiting", "Persistent Storage", "Persistent storage is required and will be configured during deployment.", null, "Review Storage", `${base}/storage`, false, contract.updatedAt);
    if ([PersistentStorageStatus.PENDING, PersistentStorageStatus.RECOMMENDED].includes(storage.status as PersistentStorageStatus)) return moduleState("waiting", "Persistent Storage", "Persistent storage is recommended and not provisioned.", null, "Review Storage", `${base}/storage`, false, storage.updatedAt);
    if (storage.status === PersistentStorageStatus.PROVISIONING) return moduleState("running", "Persistent Storage", "EFS provisioning is running.", null, null, `${base}/storage`, false, storage.updatedAt);
    if (storage.status === PersistentStorageStatus.FAILED) return moduleState("failed", "Persistent Storage", this.safeMessage(storage.errorMessage, "EFS provisioning failed."), null, "Review Storage", `${base}/storage`, false, storage.updatedAt);
    return moduleState("passed", "Persistent Storage", "Persistent storage is provisioned.", null, null, `${base}/storage`, false, storage.updatedAt);
  }

  private orchestrationModule(deployment: ProjectDeployment | null, base: string): ProjectModuleState {
    if (!deployment) return moduleState("not_started", "Orchestration", "No ECS deployment has been requested.", null, "Open Orchestration", `${base}/orchestration`, true, null);
    if ([ProjectDeploymentStatus.QUEUED, ProjectDeploymentStatus.DEPLOYING, ProjectDeploymentStatus.WAITING_FOR_SERVICE_STABILITY, ProjectDeploymentStatus.ROLLBACK_STARTED].includes(deployment.status as ProjectDeploymentStatus)) return moduleState("running", "Orchestration", `Deployment is ${deployment.status.replaceAll("_", " ")}.`, null, null, `${base}/orchestration`, true, deployment.updatedAt);
    if ([ProjectDeploymentStatus.FAILED, ProjectDeploymentStatus.UNHEALTHY, ProjectDeploymentStatus.ROLLBACK_FAILED].includes(deployment.status as ProjectDeploymentStatus)) return moduleState("failed", "Orchestration", this.safeMessage(deployment.errorMessage, "The latest ECS deployment is unhealthy."), "rollback_available", "Review Deployment", `${base}/orchestration`, true, deployment.updatedAt);
    if ([ProjectDeploymentStatus.HEALTHY, ProjectDeploymentStatus.ROLLBACK_SUCCEEDED].includes(deployment.status as ProjectDeploymentStatus)) return moduleState("passed", "Orchestration", "ECS service and ALB targets are healthy.", null, null, `${base}/orchestration`, true, deployment.updatedAt);
    return moduleState("warning", "Orchestration", `Latest deployment status: ${deployment.status.replaceAll("_", " ")}.`, null, "Review Deployment", `${base}/orchestration`, true, deployment.updatedAt);
  }

  private observabilityModule(metric: ProjectRuntimeMetricSnapshot | null, deployment: ProjectDeployment | null, base: string): ProjectModuleState {
    if (!deployment) return moduleState("unavailable", "Observability", "Runtime observability will be available after ECS deployment.", null, "Open Observability", `${base}/observability`, false, null);
    if (!metric) return moduleState("unavailable", "Observability", "Deployment exists; waiting for runtime signals.", null, "Open Observability", `${base}/observability`, false, deployment.updatedAt);
    return moduleState("passed", "Observability", `Runtime signals available from ${metric.source}.`, null, null, `${base}/observability`, false, metric.createdAt);
  }

  private deployDisabledReasons(modules: Modules, canManage: boolean, applyEnabled: boolean) {
    const reasons: string[] = [];
    if (!canManage) reasons.push("You do not have permission to deploy this project.");
    if (!applyEnabled) reasons.push("Terraform apply is disabled by configuration.");
    for (const module of [modules.repository, modules.detection, modules.preflight, modules.security, modules.finops]) {
      if (module.required && ["not_started", "waiting", "running", "failed", "blocked", "requires_approval", "unavailable"].includes(module.status)) reasons.push(module.message);
    }
    return [...new Set(reasons)];
  }

  private productState(input: {
    project: Project;
    profile: ProjectDetectionProfile | null;
    contract: ProjectDeploymentContract | null;
    preflight: ProjectPreflightReport | null;
    modules: Modules;
    stages: ResolvedPipelineStage[];
    run: ProjectPipelineRun | null;
    deployment: ProjectDeployment | null;
    environment: ProjectInfrastructureEnvironment | null;
    applyEnabled: boolean;
    applyRequiresApproval: boolean;
    canManage: boolean;
    manualApprovalsEnabled: boolean;
    isDeploymentJobActive: boolean;
    latestRunIsStale: boolean;
    stateSafety: TerraformStateSafetySnapshot;
    terraformApproval: TerraformApprovalState;
  }) {
    const base = `/projects/${input.project.id}`;
    const disabled = input.canManage ? [] : ["You do not have permission to change this project."];
    const failedStage = input.run
      ? input.stages.find((stage) => stage.status === "failed" && stage.required) || null
      : null;
    const requiredExternalCiFailure = input.run
      ? input.stages.find((stage) => stage.blockedByStage === "external_ci_validation")
      : null;
    const applyGate = input.stages.find((stage) => stage.stage === "terraform_apply_gate") || null;
    const applyGateReached = Boolean(
      input.run && applyGate && ["disabled_by_config", "requires_approval", "passed", "failed", "running"].includes(applyGate.status)
    );
    const applyApprovalRequired = input.terraformApproval.required;
    const detectionFailed = Boolean(
      input.profile &&
        ([DetectionStatus.FAILED, DetectionStatus.NEEDS_MANUAL_DOCKERFILE].includes(
          input.profile.detectionStatus as DetectionStatus
        ) || !input.contract || Boolean(input.contract.invalidatedReason))
    );
    const preflightPassed = Boolean(
      input.contract?.deployable &&
      input.preflight &&
        input.preflight.inputFingerprint === input.contract.contractHash &&
        [PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(
          input.preflight.validationStatus as PreflightValidationStatus
        )
    );
    const preflightFailed = Boolean(input.preflight && !preflightPassed);
    const databaseSetupRequired = Boolean(input.contract?.blockers.some((item) => /database (?:setup|tier) required|database host cannot be localhost|local database configuration detected/i.test(item)));
    const deploymentRequirementsMissing = Boolean(input.contract?.missingEnvVars?.length);
    const advisorySecurityFailure = Boolean(
      input.run && isPipelineFailed(input.run.status) &&
      /security|trivy|vulnerab/.test(String(input.run.currentStage || "").toLowerCase()) &&
      !failedStage
    );
    const runFailed = Boolean(
      input.run &&
        (failedStage ||
          requiredExternalCiFailure ||
          (isPipelineFailed(input.run.status) && !advisorySecurityFailure))
    );
    const activeStage = input.run
      ? input.stages.find((stage) => stage.status === "running") ||
        input.stages.find((stage) => stage.status === "requires_approval") ||
        input.stages.find((stage) => stage.status === "pending") ||
        failedStage
      : null;

    let phase = "setup";
    let overallStatus = "setup_required";
    let userFacingStatus = "Repository setup is required.";
    let currentStep = "repository_setup";
    let currentStepLabel = "Connect Repository";
    let nextAction = action("edit_project_settings", "Review Project Settings", "Connect a valid repository and release branch before automation starts.", `${base}/settings`, "GET", input.canManage, disabled);
    let blockedBy: { stage: string; reason: string; userMessage: string } | null = null;

    if (input.environment?.status === InfrastructureEnvironmentStatus.DESTROYING) {
      phase = "deployment";
      overallStatus = "destroying";
      userFacingStatus = "Terraform destroy is removing this project's AWS resources.";
      currentStep = "terraform_destroy";
      currentStepLabel = "Destroying AWS Resources";
      nextAction = action("none", "Destroy Running", "Open Pipeline Events to follow the sanitized destroy lifecycle.", `${base}/logs`, "GET", false, ["A destroy operation is already running."]);
    } else if (input.environment?.status === InfrastructureEnvironmentStatus.DESTROY_NEEDS_CLEANUP) {
      phase = "failed";
      overallStatus = "blocked";
      userFacingStatus = "Some project cloud resources remain after Terraform destroy.";
      currentStep = "cloud_residue_cleanup";
      currentStepLabel = "Admin Cleanup Required";
      nextAction = action("fix_failure", "Open Admin Cleanup", "An administrator must review and clean only verified project-scoped residue.", `${base}/settings`, "GET", input.canManage, disabled);
      blockedBy = { stage: "cloud_residue_cleanup", reason: "Cloud residue remains or inventory verification was incomplete.", userMessage: "Open Project Settings and ask an administrator to review Cloud Cleanup." };
    } else if (input.environment?.status === InfrastructureEnvironmentStatus.DESTROYED) {
      phase = "deployment";
      overallStatus = "destroyed";
      userFacingStatus = "AWS resources tracked by this project's Terraform state were destroyed.";
      currentStep = "terraform_destroy";
      currentStepLabel = "Infrastructure Destroyed";
      nextAction = action("none", "View Project Settings", "Review the completed destroy operation and preserved resources.", `${base}/settings`, "GET", true, []);
    } else if (input.environment?.status === InfrastructureEnvironmentStatus.DESTROY_FAILED) {
      phase = "failed";
      overallStatus = "failed";
      userFacingStatus = "Terraform destroy needs attention.";
      currentStep = "terraform_destroy";
      currentStepLabel = "Destroy Failed";
      nextAction = action("fix_failure", "Review Destroy Failure", "Review the sanitized failure and retry only after resolving it.", `${base}/settings`, "GET", input.canManage, disabled);
      blockedBy = { stage: "terraform_destroy", reason: "Terraform destroy failed.", userMessage: "Review the destroy operation before retrying." };
    } else if (input.project.repositoryFullName && input.project.targetBranch && !input.profile) {
      phase = "detection";
      overallStatus = "ready_for_detection";
      userFacingStatus = "Repository connected. Stack detection is the next step.";
      currentStep = "stack_detection";
      currentStepLabel = "Run Stack Detection";
      nextAction = action("run_stack_detection", "Run Stack Detection", "DeployGuard will inspect the connected repository and identify its runtime and deployment requirements.", `${base}/detection`, "GET", input.canManage, disabled);
    } else if (detectionFailed) {
      phase = "failed";
      overallStatus = "failed";
      userFacingStatus = "Stack detection needs attention before deployment can continue.";
      currentStep = "stack_detection";
      currentStepLabel = "Fix Stack Detection";
      nextAction = action("run_stack_detection", "Run Stack Detection Again", input.modules.detection.message, `${base}/detection`, "GET", input.canManage, disabled);
      blockedBy = { stage: "stack_detection", reason: input.modules.detection.message, userMessage: "Pre-flight and pipeline stages wait until stack detection succeeds." };
    } else if (input.profile && !input.preflight) {
      phase = "preflight";
      overallStatus = "ready_for_preflight";
      userFacingStatus = "Stack detected. Generate the deployment pre-flight report.";
      currentStep = "preflight";
      currentStepLabel = "Generate Pre-flight Report";
      nextAction = action("generate_preflight", "Generate Pre-flight Report", "DeployGuard will select the deployment template, validate commands and ports, and prepare the generated Dockerfile.", `${base}/preflight`, "GET", input.canManage, disabled);
    } else if (preflightFailed && databaseSetupRequired) {
      phase = "preflight";
      overallStatus = "setup_required";
      userFacingStatus = "Database setup required. Choose a DeployGuard managed database or configure a reachable external database.";
      currentStep = "database_setup";
      currentStepLabel = "Configure Database";
      nextAction = action("fix_failure", "Complete Requirements", "Choose a managed database or reachable external database, then save the canonical deployment requirements.", `${base}/requirements?focus=database`, "GET", input.canManage, disabled);
      blockedBy = { stage: "preflight", reason: "A required database tier has not been configured safely.", userMessage: "Choose a managed database or a reachable external endpoint before deployment." };
    } else if (preflightFailed && deploymentRequirementsMissing) {
      phase = "preflight";
      overallStatus = "setup_required";
      userFacingStatus = "Application configuration is required before deployment can continue.";
      currentStep = "deployment_requirements";
      currentStepLabel = "Complete Deployment Requirements";
      nextAction = action("fix_failure", "Complete Requirements", "Supply only the unresolved application-owned values.", `${base}/requirements?focus=secrets`, "GET", input.canManage, disabled);
      blockedBy = { stage: "preflight", reason: "Required application configuration is unresolved.", userMessage: "Complete deployment requirements before starting the pipeline." };
    } else if (preflightFailed) {
      phase = "preflight";
      overallStatus = "setup_required";
      userFacingStatus = "Setup required before this repository can be deployed.";
      currentStep = "preflight";
      currentStepLabel = "Fix Deployment Setup";
      nextAction = action("generate_preflight", "Fix Deployment Setup", input.modules.preflight.message, `${base}/preflight`, "GET", input.canManage, disabled);
      blockedBy = { stage: "preflight", reason: input.modules.preflight.message, userMessage: "The pipeline cannot start until pre-flight validation passes." };
    } else if (preflightPassed && !input.run) {
      phase = "pipeline";
      overallStatus = "ready_to_start_pipeline";
      userFacingStatus = "Pre-flight passed. The project is ready to start its deployment pipeline.";
      currentStep = "start_pipeline";
      currentStepLabel = "Start Pipeline";
      nextAction = action("start_pipeline", input.applyEnabled ? "Start Pipeline" : "Start Safe Pipeline", input.applyEnabled ? "DeployGuard will build, scan, estimate, plan, and continue through enabled deployment stages." : "DeployGuard will build, scan, push, estimate, and plan, then pause safely at the Terraform Apply Gate.", `${base}/pipeline`, "GET", input.canManage, disabled);
    } else if (input.deployment) {
      const deploymentFailed = [ProjectDeploymentStatus.FAILED, ProjectDeploymentStatus.UNHEALTHY, ProjectDeploymentStatus.ROLLBACK_FAILED].includes(input.deployment.status as ProjectDeploymentStatus);
      const deploymentActive = [ProjectDeploymentStatus.QUEUED, ProjectDeploymentStatus.DEPLOYING, ProjectDeploymentStatus.WAITING_FOR_SERVICE_STABILITY, ProjectDeploymentStatus.ROLLBACK_STARTED].includes(input.deployment.status as ProjectDeploymentStatus);
      if (deploymentFailed) {
        phase = "failed";
        overallStatus = "failed";
        const databaseLocalhostFailure = /ECONNREFUSED[^\n]*(?:127\.0\.0\.1|localhost)(?::(?:5432|3306))?|database at localhost/i.test(String(input.deployment.errorMessage || ""));
        if (databaseLocalhostFailure) {
          userFacingStatus = "Infrastructure is ready, but the app cannot start because it is trying to connect to PostgreSQL at 127.0.0.1:5432.";
          currentStep = "database_setup";
          currentStepLabel = "Configure Database";
          nextAction = action("fix_failure", "Complete Database Requirements", "Inside ECS, localhost is the application container itself.", `${base}/requirements?focus=database`, "GET", input.canManage, disabled);
          blockedBy = { stage: "ecs_deployment", reason: "Database connection points to localhost.", userMessage: "Configure a DeployGuard managed database or reachable external database, then deploy again." };
        } else {
          userFacingStatus = "The latest ECS deployment needs attention.";
          currentStep = "deployment_failure";
          currentStepLabel = "Review Deployment";
          nextAction = action("fix_failure", "Review Deployment", "Inspect ECS and ALB health, then use the stable rollback option if needed.", `${base}/orchestration`, "GET", true, []);
        }
      } else if (deploymentActive && input.isDeploymentJobActive) {
        phase = "deployment";
        overallStatus = "running";
        userFacingStatus = `ECS deployment is ${input.deployment.status.replaceAll("_", " ")}.`;
        currentStep = "ecs_deployment";
        currentStepLabel = "ECS Deployment";
        nextAction = action("none", "Deployment Running", "Wait for ECS service stability and ALB target health.", `${base}/orchestration`, "GET", false, ["Deployment is already running."]);
      } else if (deploymentActive) {
        phase = "failed";
        overallStatus = "failed";
        userFacingStatus = "The stored deployment activity is stale and no active deployment job was found.";
        currentStep = "cloud_verification";
        currentStepLabel = "Deployment Not Verified";
        nextAction = action("view_ecs_diagnostics", "View ECS Diagnostics", "Inspect ECS tasks and load balancer target health.", `${base}/orchestration`, "GET", input.canManage, disabled);
      } else {
        phase = "runtime";
        overallStatus = "deployed";
        userFacingStatus = "The application has a real ECS deployment.";
        currentStep = "runtime_observability";
        currentStepLabel = "View Runtime";
        nextAction = action("view_logs", "View Runtime Observability", "Open logs, metrics, health, and deployment events for the running service.", `${base}/observability`, "GET", true, []);
      }
    } else if (applyApprovalRequired && input.applyEnabled && input.applyRequiresApproval) {
      phase = "apply_gate";
      overallStatus = "paused";
      userFacingStatus = "Terraform plan and cost policy completed. Infrastructure changes are waiting for your approval.";
      currentStep = "terraform_apply_gate";
      currentStepLabel = "Terraform Apply Approval Required";
      const approvalDisabled = [
        ...disabled,
        ...(!input.terraformApproval.eligible && input.terraformApproval.blockedMessage
          ? [input.terraformApproval.blockedMessage]
          : []),
      ];
      nextAction = action(
        "approve_apply",
        "Approve infrastructure changes",
        "Approve this reviewed Terraform plan. Terraform apply will create or update AWS resources and may incur cost.",
        `${base}/pipeline`,
        "POST",
        input.canManage && input.terraformApproval.eligible,
        approvalDisabled
      );
      blockedBy = null;
    } else if (applyGateReached && !input.applyEnabled) {
      phase = "apply_gate";
      overallStatus = "paused";
      userFacingStatus = "Deployment paused safely at the Terraform Apply Gate.";
      currentStep = "terraform_apply_gate";
      currentStepLabel = "Terraform Apply Gate";
      nextAction = action("enable_apply", "Enable Terraform Apply", "Set TERRAFORM_APPLY_ENABLED=true only after reviewing the Terraform plan, cost estimate, and AWS configuration.", `${base}/infrastructure`, "GET", false, ["Terraform Apply is controlled by backend environment configuration."]);
      blockedBy = { stage: "terraform_apply_gate", reason: "TERRAFORM_APPLY_ENABLED=false", userMessage: "Build, scan, ECR push, Terraform plan, and cost estimation completed; AWS provisioning is paused safely." };
    } else if (input.modules.security.status === "requires_approval") {
      phase = input.manualApprovalsEnabled ? "pipeline" : "failed";
      overallStatus = input.manualApprovalsEnabled ? "paused" : "failed";
      userFacingStatus = input.manualApprovalsEnabled
        ? "Automation paused for security approval."
        : "Security findings must be remediated before automation can continue.";
      currentStep = "security_gate";
      currentStepLabel = input.manualApprovalsEnabled
        ? "Review Security Approval"
        : "Fix Security Findings";
      nextAction = action("fix_failure", currentStepLabel, input.modules.security.message, `${base}/pipeline`, "GET", input.canManage, disabled);
      blockedBy = { stage: "security_gate", reason: input.modules.security.message, userMessage: input.manualApprovalsEnabled ? "Review the scan policy and approval requirements before image release." : "Fix the reported findings, then retry automation from the pipeline page." };
    } else if (input.modules.finops.status === "requires_approval") {
      phase = input.manualApprovalsEnabled ? "pipeline" : "failed";
      overallStatus = input.manualApprovalsEnabled ? "paused" : "blocked";
      userFacingStatus = input.manualApprovalsEnabled
        ? "Pipeline paused for cost approval."
        : "The cost policy must be adjusted before automation can continue.";
      currentStep = "cost_gate";
      currentStepLabel = input.manualApprovalsEnabled ? "Approve Cost Gate" : "Review Cost Policy";
      nextAction = action(input.manualApprovalsEnabled ? "approve_cost" : "fix_failure", currentStepLabel, input.modules.finops.message, input.manualApprovalsEnabled ? `${base}/costs` : `${base}/pipeline`, "GET", input.canManage, disabled);
      blockedBy = { stage: "cost_gate", reason: input.modules.finops.message, userMessage: input.manualApprovalsEnabled ? "Approve or reject the estimate before infrastructure can continue." : "Adjust the project cost policy, then retry automation." };
    } else if (input.modules.finops.status === "blocked" || input.run?.status === PipelineRunStatus.BLOCKED_BY_COST_LIMIT) {
      phase = "failed";
      overallStatus = "blocked";
      userFacingStatus = input.modules.finops.message;
      currentStep = "cost_gate";
      currentStepLabel = "Review Cost Gate";
      nextAction = action("fix_failure", "Review Cost Gate", input.modules.finops.message, `${base}/costs`, "GET", true, []);
      blockedBy = { stage: "cost_gate", reason: input.modules.finops.message, userMessage: "The cost policy must be resolved before infrastructure can continue." };
    } else if (runFailed) {
      const failure = failedStage || input.stages.find((stage) => stage.status === "blocked") || null;
      phase = "failed";
      overallStatus = "failed";
      userFacingStatus = this.safeMessage(failure?.message || input.run?.errorMessage, "The latest pipeline failed.");
      currentStep = failure?.stage || input.run?.currentStage || "pipeline_failure";
      currentStepLabel = `Fix ${failure?.label || "Pipeline Failure"}`;
      nextAction = action("fix_failure", currentStepLabel, userFacingStatus, `${base}/pipeline`, "GET", true, []);
      blockedBy = { stage: currentStep, reason: userFacingStatus, userMessage: "Later required pipeline stages wait until this failure is resolved." };
    } else if (input.run && isPipelineActive(input.run.status) && input.isDeploymentJobActive && !input.latestRunIsStale) {
      phase = "pipeline";
      overallStatus = "running";
      userFacingStatus = activeStage?.message || "The deployment pipeline is running.";
      currentStep = activeStage?.stage || input.run.currentStage || "pipeline";
      currentStepLabel = activeStage?.label || "Pipeline Running";
      nextAction = action("none", "Pipeline Running", "Wait for the current worker stage to finish. You can inspect live pipeline events in the meantime.", `${base}/pipeline`, "GET", false, ["The pipeline is already running."]);
    } else if (input.run) {
      phase = "pipeline";
      overallStatus = "ready_to_start_pipeline";
      userFacingStatus = "The previous pipeline finished without a real deployment. Start a new run to continue with the current configuration.";
      currentStep = "start_pipeline";
      currentStepLabel = "Start Pipeline";
      nextAction = action("start_pipeline", input.applyEnabled ? "Start Pipeline" : "Start Safe Pipeline", "Start a new integrated DeployGuard worker run.", `${base}/pipeline`, "GET", input.canManage, disabled);
    }

    return {
      phase,
      overallStatus,
      userFacingStatus,
      currentStep,
      currentStepLabel,
      nextAction,
      blockedBy,
      failedStage: failedStage?.stage || (detectionFailed ? "stack_detection" : preflightFailed ? "preflight" : null),
      applyGateReached,
      applyApprovalRequired,
    };
  }

  private latestPipelineSnapshot(
    run: ProjectPipelineRun | null,
    failedStage: string | null,
    applyPaused: boolean,
    isActuallyActive: boolean,
    isStale: boolean,
  ) {
    if (!run) return { id: null, status: "not_started", startedAt: null, finishedAt: null, failedStage: null, failureMessage: null, failureClass: null, isActive: false, isPaused: false };
    const status = run.status === PipelineRunStatus.CANCELLED
      ? "cancelled"
      : applyPaused || isPipelinePaused(run.status)
      ? "paused"
      : isPipelineActive(run.status) && isStale
        ? "stale"
      : isPipelineActive(run.status) && isActuallyActive
        ? run.status === PipelineRunStatus.QUEUED ? "queued" : "running"
        : failedStage || run.failedAt || isPipelineFailed(run.status)
          ? "failed"
          : "passed";
    return {
      id: run.id,
      triggeredByUserId: run.triggeredByUserId,
      status,
      startedAt: run.startedAt || null,
      currentStageStartedAt: run.currentStageStartedAt || null,
      finishedAt: run.completedAt || run.failedAt || null,
      failedStage,
      failureMessage: run.errorMessage ? this.logSanitizer.sanitize(run.errorMessage) : null,
      failureClass: normalizePipelineFailureClass(run.metadata?.failureClass, failedStage || run.currentStage, run.errorMessage),
      isActive: isActuallyActive,
      isStale,
      isPaused: isPipelinePaused(run.status),
    };
  }

  private overallStatus(stages: ResolvedPipelineStage[], deployment: ProjectDeployment | null, modules: Modules) {
    if (deployment?.status === ProjectDeploymentStatus.HEALTHY && modules.observability.status === "passed") return "passed";
    const requiredModules = Object.values(modules).filter((module) => module.required);
    if (stages.some((stage) => stage.status === "failed" && stage.required)) return "failed";
    if (stages.some((stage) => stage.status === "running")) return "running";
    if (stages.some((stage) => stage.status === "pending")) return "waiting";
    if (requiredModules.some((module) => module.status === "failed")) return "failed";
    if (requiredModules.some((module) => ["blocked", "requires_approval"].includes(module.status))) return "blocked";
    if (stages.some((stage) => ["blocked", "requires_approval", "disabled_by_config"].includes(stage.status))) return "blocked";
    if (modules.repository.status !== "passed" || modules.detection.status === "not_started" || modules.preflight.status === "not_started") return "not_started";
    return "ready";
  }

  private latestPipelineStatus(run: ProjectPipelineRun | null, costTierWarningOnly: boolean, applyEnabled: boolean, stages: ResolvedPipelineStage[]) {
    if (!run) return null;
    if (costTierWarningOnly) return "warning_over_tier";
    if (isPipelineActive(run.status)) return run.status;
    const apply = stages.find((stage) => stage.stage === "terraform_apply");
    if (!applyEnabled && apply?.status === "disabled_by_config") return "disabled_by_config";
    return run.status;
  }

  private withProjectedInfrastructureEvents(
    pipelineEvents: ProjectPipelineEvent[],
    infrastructureEvents: ProjectInfrastructureEvent[],
    run: ProjectPipelineRun | null,
    lock: ProjectTerraformLock | null
  ) {
    let operation: "plan" | "apply" = "plan";
    const projected: ProjectPipelineEvent[] = [];

    for (const event of infrastructureEvents) {
      if (/apply/.test(event.eventType)) operation = "apply";
      else if (/plan/.test(event.eventType)) operation = "plan";
      const metadataOperation = event.metadata?.operation;
      if (metadataOperation === "apply" || metadataOperation === "plan") operation = metadataOperation;
      if (!/^state_(?:lock|heartbeat|corruption|recovery)/.test(event.eventType)) continue;
      if (pipelineEvents.some((existing) => existing.metadata?.infrastructureEventId === event.id)) continue;

      projected.push(Object.assign(new ProjectPipelineEvent(), {
        id: `infrastructure:${event.id}`,
        projectId: event.projectId,
        pipelineRunId: event.pipelineRunId,
        stage: `terraform_${operation}_lock_${event.eventType}`,
        status: event.status,
        message: event.message,
        metadata: { ...(event.metadata || {}), operation, infrastructureEventId: event.id, projected: true },
        occurredAt: event.createdAt,
        ingestedAt: event.createdAt,
        source: "terraform",
        sequenceNumber: 0,
        createdAt: event.createdAt,
      }));
    }

    if (run && lock?.pipelineRunId === run.id) {
      const lockOperation = lock.metadata?.operation === "apply" ? "apply" : "plan";
      const heartbeat = lock.heartbeatAt || lock.acquiredAt;
      const activeLock = [TerraformLockStatus.ACQUIRED, TerraformLockStatus.HEARTBEAT_ACTIVE, TerraformLockStatus.QUEUED].includes(lock.status as TerraformLockStatus);
      const stale = activeLock && heartbeat && Date.now() - new Date(heartbeat).getTime() > (lock.staleAfterSeconds || 300) * 1000;
      if (lock.status === TerraformLockStatus.ORPHANED || stale) {
        projected.push(Object.assign(new ProjectPipelineEvent(), {
          id: `lock:${lock.lockId}:${lock.updatedAt?.toISOString() || "current"}`,
          projectId: run.projectId,
          pipelineRunId: run.id,
          stage: `terraform_${lockOperation}_lock_state_lock_${lock.status === TerraformLockStatus.ORPHANED ? "orphaned" : "stale"}`,
          status: "failed",
          message: lock.status === TerraformLockStatus.ORPHANED
            ? "Terraform state lock is orphaned and requires recovery."
            : "Terraform state lock heartbeat is stale and requires recovery.",
          metadata: { operation: lockOperation, projected: true, lockStatus: lock.status },
          occurredAt: lock.updatedAt || heartbeat || new Date(),
          ingestedAt: new Date(),
          source: "state_recovery",
          sequenceNumber: 0,
          createdAt: lock.updatedAt || heartbeat || new Date(),
        }));
      }
    }

    return [...pipelineEvents, ...projected].sort(
      (left, right) => new Date(left.occurredAt || left.createdAt).getTime() - new Date(right.occurredAt || right.createdAt).getTime() || (left.sequenceNumber || 0) - (right.sequenceNumber || 0)
    );
  }

  private filterSupersededStateEvents(events: ProjectPipelineEvent[], snapshot: TerraformStateSafetySnapshot) {
    if (snapshot.recoveryRequired || !snapshot.supersedesHistoricalFailuresAt) return events;
    const cutoff = new Date(snapshot.supersedesHistoricalFailuresAt).getTime();
    return events.filter((event) => {
      if (!/state lock|lock heartbeat|state corrupt|state recovery|terraform state/i.test(event.message || "")) return true;
      const occurredAt = event.occurredAt || event.createdAt;
      return !occurredAt || new Date(occurredAt).getTime() > cutoff;
    });
  }

  private async latest<T extends { projectId: string; createdAt: Date }>(repository: Repository<T>, projectId: string): Promise<T | null> {
    return repository.findOne({ where: { projectId } as never, order: { createdAt: "DESC" } as never });
  }

  private async latestForRun<T extends { projectId: string; createdAt: Date }>(repository: Repository<T>, projectId: string, pipelineRunId: string): Promise<T | null> {
    return repository.findOne({
      where: { projectId, pipelineRunId } as never,
      order: { createdAt: "DESC" } as never,
    });
  }

  private safeMessage(value: unknown, fallback: string) {
    if (typeof value !== "string" || !value.trim()) return fallback;
    return this.logSanitizer.sanitize(value).slice(0, 500) || fallback;
  }

  private sanitizeStage(stage: ResolvedPipelineStage): ResolvedPipelineStage {
    const presented = presentPipelineStage(stage.stage);
    return {
      ...stage,
      internalStageKey: stage.stage,
      userFacingStageKey: presented.key,
      userFacingStageName: presented.label,
      message: this.safeMessage(stage.message, "Pipeline stage status was recorded."),
      error: stage.error ? this.safeMessage(stage.error, "This stage failed.") : null,
      blockedReason: stage.blockedReason
        ? this.safeMessage(stage.blockedReason, "A required earlier stage did not complete.")
        : null,
    };
  }

  private sanitizeModules(modules: Modules): Modules {
    return Object.fromEntries(
      Object.entries(modules).map(([key, module]) => [
        key,
        { ...module, message: this.safeMessage(module.message, `${module.label} status is unavailable.`) },
      ])
    ) as Modules;
  }

  private sanitizeDeveloperDetails(value: Record<string, unknown>) {
    const sanitize = (entry: unknown): unknown => {
      if (typeof entry === "string") return this.logSanitizer.sanitize(entry).slice(0, 1000);
      if (Array.isArray(entry)) return entry.slice(0, 50).map(sanitize);
      if (!entry || typeof entry !== "object") return entry;
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([key]) => !/secret|password|token|credential|cookie|authorization|environmentvalue/i.test(key))
          .map(([key, nested]) => [key, sanitize(nested)])
      );
    };
    return sanitize(value) as Record<string, unknown>;
  }
}

function moduleState(status: ProjectModuleState["status"], label: string, message: string, actionName: string | null, actionLabel: string | null, href: string, required: boolean, lastUpdatedAt: Date | null): ProjectModuleState {
  return { status, label, message, action: actionName, actionLabel, href, required, lastUpdatedAt };
}

function action(type: string, label: string, message: string, href: string, method: NextAction["method"], enabled: boolean, disabledReasons: string[]): NextAction {
  return { type, label, message, description: message, href, method, enabled, disabledReasons, disabledReason: disabledReasons[0] || null };
}
