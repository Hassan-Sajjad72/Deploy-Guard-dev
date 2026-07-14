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
import { getObservabilityConfig } from "../../observability/observability.config";
import { LogSanitizerService } from "../../observability/log-sanitizer.service";
import { ProjectRuntimeMetricSnapshot } from "../../observability/project-runtime-metric-snapshot.entity";
import {
  ProjectDeployment,
  ProjectDeploymentStatus,
} from "../../orchestration/project-deployment.entity";
import { ProjectStableRelease } from "../../orchestration/project-stable-release.entity";
import { getStateManagementConfig } from "../../state-management/state-management.config";
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
import { presentPipelineStage } from "../pipeline/pipeline-stage-presenter";
import {
  isPipelineActive,
  isPipelineCancelable,
  isPipelineFailed,
  isPipelinePaused,
  isPipelineRetryable,
} from "../pipeline/pipeline-status";

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
    private readonly config: ConfigService,
    private readonly logSanitizer: LogSanitizerService
  ) {}

  async getCurrentState(user: User, projectId: string) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const [
      profile,
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
    ] = await Promise.all([
      this.latest(this.profileRepository, project.id),
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
    ]);
    const events = run
      ? await this.eventRepository.find({
          where: { projectId: project.id, pipelineRunId: run.id },
          order: { createdAt: "ASC" },
        })
      : [];
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
    const safeMode = !applyEnabled;
    const costTierWarningOnly = Boolean(
      stateEstimate &&
        !finopsConfig.enforceTierLimits &&
        (stateEstimate.status === CostEstimateStatus.BLOCKED_BY_TIER_LIMIT ||
          stateEstimate.blockedByTierLimit)
    );
    const githubActionsRequired =
      this.config.get<string>("GITHUB_ACTIONS_REQUIRED", "false") === "true";
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
    const externalCi = this.sanitizeStage(this.stageResolver.resolveExternalCi(resolverInput));
    const modules = this.sanitizeModules(this.resolveModules({
      project,
      profile,
      preflight,
      scan: stateScan,
      estimate: stateEstimate,
      environment: stateEnvironment,
      lock: stateLock,
      storage: stateStorage,
      deployment: runDeployment,
      runtimeMetric,
      applyEnabled,
      finopsTierEnforcement: finopsConfig.enforceTierLimits,
    }));
    const canManage =
      user.role === UserRole.ADMIN ||
      (user.role === UserRole.DEVELOPER && project.ownerUserId === user.id);
    const productState = this.productState({
      project,
      profile,
      preflight,
      run,
      deployment: runDeployment,
      modules,
      stages,
      applyEnabled,
      canManage,
      manualApprovalsEnabled,
    });
    const deployDisabledReasons = this.deployDisabledReasons(
      modules,
      canManage,
      applyEnabled
    );
    const rawProfile = (profile?.rawProfile || {}) as Record<string, unknown>;
    const hasTerraformPlan = stages.some(
      (stage) => stage.stage === "terraform_plan" && stage.status === "passed"
    );
    const latestPipeline = this.latestPipelineSnapshot(run, productState.failedStage, productState.applyGateReached && !applyEnabled);
    const progress = this.lifecycleProgress(profile, preflight, run, stages, runDeployment);
    const environmentModes = {
      terraformApplyEnabled: applyEnabled,
      finopsMockMode: finopsConfig.mockMode,
      finopsTierEnforcement: finopsConfig.enforceTierLimits,
      stateMockMode: stateConfig.mockMode,
      githubActionsRequired,
      prometheusEnabled: observabilityConfig.prometheusEnabled,
      cloudWatchLogsEnabled: observabilityConfig.cloudWatchLogsEnabled,
      cloudWatchMetricsEnabled: observabilityConfig.cloudWatchMetricsEnabled,
    };

    return {
      projectId: project.id,
      projectName: project.name,
      repositoryFullName: project.repositoryFullName,
      branch: project.targetBranch,
      phase: productState.phase,
      overallStatus: productState.overallStatus,
      userFacingStatus: productState.userFacingStatus,
      currentStep: productState.currentStep,
      currentStepLabel: productState.currentStepLabel,
      currentStage: productState.currentStep,
      failedStage: productState.failedStage,
      blockedBy: productState.blockedBy,
      blockedByStage: productState.blockedBy?.stage || null,
      nextAction: productState.nextAction,
      continueAction: productState.nextAction,
      hasStackDetection: Boolean(profile),
      hasPreflight: Boolean(preflight),
      hasPipelineRun: Boolean(run),
      hasTerraformPlan,
      hasRealDeployment: Boolean(deployment),
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
          : { required: false, gate: null, message: null },
      runControls: {
        canCancel: Boolean(run && canManage && isPipelineCancelable(run.status)),
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
        cancelHref: run
          ? `/api/projects/${project.id}/pipeline/runs/${run.id}/cancel`
          : null,
        retryHref: run
          ? `/api/projects/${project.id}/pipeline/runs/${run.id}/retry`
          : null,
      },
      liveDeployment: deployment?.albDnsName
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
            status: deployment?.status || "not_deployed",
            deploymentId: deployment?.id || null,
          },
      deployButtonEnabled: deployDisabledReasons.length === 0,
      deployDisabledReasons,
      latestPipelineRunId: run?.id || null,
      latestPipelineStatus: latestPipeline.status,
      latestPipeline,
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
      stackDetection: {
        status: !profile ? "not_started" : [DetectionStatus.FAILED, DetectionStatus.NEEDS_MANUAL_DOCKERFILE].includes(profile.detectionStatus as DetectionStatus) ? "failed" : "passed",
        language: profile?.language || profile?.ecosystem || null,
        framework: profile?.framework || null,
        packageManager: profile?.packageManager || null,
        buildCommand: profile?.buildCommand || null,
        startCommand: profile?.startCommand || null,
        port: profile?.expectedPort || null,
        appDirectory: typeof rawProfile.appDirectory === "string" ? rawProfile.appDirectory : null,
        confidence: profile?.confidence || null,
        warnings: profile?.warnings || [],
      },
      preflight: {
        status: !preflight ? "not_started" : [PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(preflight.validationStatus as PreflightValidationStatus) ? "passed" : "failed",
        template: preflight?.templateDisplayName || preflight?.templateKey || null,
        dockerfileGenerated: Boolean(preflight?.generatedDockerfile),
        warnings: preflight?.warnings || [],
        errors: preflight?.errors || [],
      },
      modules,
      stages,
      externalCi,
      recentActivity: this.recentActivity({ project, profile, preflight, scan: stateScan, estimate: stateEstimate, deployment: runDeployment, events }),
    };
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
      createdAt: event.createdAt,
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
    const completedStages = deployment ? totalStages : setupCompleted + completedPipelineStages;
    const activeIndex = run
      ? stages.findIndex((stage) => ["running", "requires_approval", "failed", "disabled_by_config", "pending"].includes(stage.status))
      : -1;
    return {
      completedStages,
      totalStages,
      currentStageNumber: deployment
        ? totalStages
        : activeIndex >= 0
          ? Math.min(totalStages, 4 + activeIndex)
          : Math.min(totalStages, setupCompleted + 1),
      percentage: deployment
        ? 100
        : Math.min(99, Math.round((completedStages / totalStages) * 100)),
    };
  }

  private resolveModules(input: {
    project: Project;
    profile: ProjectDetectionProfile | null;
    preflight: ProjectPreflightReport | null;
    scan: ProjectSecurityScan | null;
    estimate: ProjectCostEstimate | null;
    environment: ProjectInfrastructureEnvironment | null;
    lock: ProjectTerraformLock | null;
    storage: ProjectPersistentStorage | null;
    deployment: ProjectDeployment | null;
    runtimeMetric: ProjectRuntimeMetricSnapshot | null;
    applyEnabled: boolean;
    finopsTierEnforcement: boolean;
  }): Modules {
    const base = `/projects/${input.project.id}`;
    return {
      repository: this.repositoryModule(input.project, base),
      detection: this.detectionModule(input.profile, base),
      preflight: this.preflightModule(input.preflight, base),
      security: this.securityModule(input.scan, base),
      finops: this.finopsModule(
        input.estimate,
        input.finopsTierEnforcement,
        base
      ),
      infrastructure: this.infrastructureModule(
        input.environment,
        input.applyEnabled,
        base
      ),
      state: this.stateModule(input.lock, base),
      storage: this.storageModule(input.storage, input.profile, base),
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

  private detectionModule(profile: ProjectDetectionProfile | null, base: string): ProjectModuleState {
    if (!profile) return moduleState("not_started", "Stack Detection", "Stack detection has not run.", "run_detection", "Run Stack Detection", `${base}/detection`, true, null);
    if (profile.detectionStatus === DetectionStatus.FAILED) return moduleState("failed", "Stack Detection", this.safeMessage(profile.errors?.[0], "Stack detection failed."), "run_detection", "Retry Detection", `${base}/detection`, true, profile.updatedAt);
    if (profile.detectionStatus === DetectionStatus.NEEDS_MANUAL_DOCKERFILE) return moduleState("blocked", "Stack Detection", "A manual Dockerfile is required before continuing.", "run_detection", "Review Detection", `${base}/detection`, true, profile.updatedAt);
    return moduleState("passed", "Stack Detection", `${profile.framework || profile.ecosystem} detected.`, null, null, `${base}/detection`, true, profile.updatedAt);
  }

  private preflightModule(report: ProjectPreflightReport | null, base: string): ProjectModuleState {
    if (!report) return moduleState("not_started", "Pre-flight", "Generate a pre-flight report.", "generate_preflight", "Generate Pre-flight Report", `${base}/preflight`, true, null);
    if (report.validationStatus === PreflightValidationStatus.FAILED || report.validationStatus === PreflightValidationStatus.MANUAL_DOCKERFILE_REQUIRED) return moduleState("failed", "Pre-flight", this.safeMessage(report.errors?.[0], "Pre-flight validation must be resolved."), "generate_preflight", "Review Pre-flight", `${base}/preflight`, true, report.updatedAt);
    if (report.validationStatus === PreflightValidationStatus.PASSED_WITH_WARNINGS) return moduleState("warning", "Pre-flight", "Validation passed with warnings.", null, null, `${base}/preflight`, true, report.updatedAt);
    return moduleState("passed", "Pre-flight", "Pre-flight validation passed.", null, null, `${base}/preflight`, true, report.updatedAt);
  }

  private securityModule(scan: ProjectSecurityScan | null, base: string): ProjectModuleState {
    if (!scan) return moduleState("not_started", "Security", "Dockerfile configuration will be checked before build; image vulnerabilities are advisory.", null, null, `${base}/security`, true, null);
    if (scan.scanStatus === SecurityScanStatus.QUEUED) return moduleState("waiting", "Security", "Advisory image scan is queued.", null, null, `${base}/security`, true, scan.updatedAt);
    if (scan.scanStatus === SecurityScanStatus.RUNNING) return moduleState("running", "Security", "Advisory image scan is running.", null, null, `${base}/security`, true, scan.updatedAt);
    if (scan.scanStatus === SecurityScanStatus.FAILED) return moduleState("warning", "Security", "The advisory image scan did not complete; it does not block deployment.", null, null, `${base}/security`, true, scan.updatedAt);
    return moduleState("passed", "Security", `Advisory findings recorded · ${scan.criticalCount} critical · ${scan.highCount} high.`, null, null, `${base}/security`, true, scan.updatedAt);
  }

  private finopsModule(estimate: ProjectCostEstimate | null, enforceTierLimits: boolean, base: string): ProjectModuleState {
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
    if (status === InfrastructureEnvironmentStatus.DISABLED_BY_CONFIG || (!applyEnabled && status === InfrastructureEnvironmentStatus.FAILED && /apply is disabled/i.test(environment.errorMessage || ""))) return moduleState("disabled_by_config", "Infrastructure", "Terraform apply is disabled by configuration; plan-only validation remains available.", "enable_apply", "Review Apply Gate", `${base}/infrastructure`, true, environment.updatedAt);
    if ([InfrastructureEnvironmentStatus.QUEUED, InfrastructureEnvironmentStatus.PLANNING, InfrastructureEnvironmentStatus.PROVISIONING].includes(status)) return moduleState("running", "Infrastructure", `Infrastructure is ${status.replaceAll("_", " ")}.`, null, null, `${base}/infrastructure`, true, environment.updatedAt);
    if ([InfrastructureEnvironmentStatus.FAILED, InfrastructureEnvironmentStatus.PLAN_FAILED, InfrastructureEnvironmentStatus.READINESS_FAILED, InfrastructureEnvironmentStatus.PARTIALLY_PROVISIONED].includes(status)) return moduleState("failed", "Infrastructure", this.safeMessage(environment.errorMessage, "Infrastructure provisioning failed."), null, "Review Infrastructure", `${base}/infrastructure`, true, environment.updatedAt);
    if (status === InfrastructureEnvironmentStatus.PROVISIONED) return moduleState("passed", "Infrastructure", "Terraform infrastructure is provisioned.", null, null, `${base}/infrastructure`, true, environment.updatedAt);
    if ([InfrastructureEnvironmentStatus.COST_CHECK_REQUIRED, InfrastructureEnvironmentStatus.WAITING_FOR_COST_APPROVAL].includes(status)) return moduleState(status === InfrastructureEnvironmentStatus.WAITING_FOR_COST_APPROVAL ? "requires_approval" : "waiting", "Infrastructure", "Terraform plan is ready at the cost/apply gate.", null, "Review Infrastructure", `${base}/infrastructure`, true, environment.updatedAt);
    return moduleState("not_started", "Infrastructure", "Infrastructure has not been provisioned.", null, "Open Infrastructure", `${base}/infrastructure`, true, environment.updatedAt);
  }

  private stateModule(lock: ProjectTerraformLock | null, base: string): ProjectModuleState {
    if (!lock) return moduleState("not_started", "Terraform State", "No state lock has been requested.", null, "Open State Management", `${base}/state`, true, null);
    if ([TerraformLockStatus.ACQUIRED, TerraformLockStatus.HEARTBEAT_ACTIVE].includes(lock.status as TerraformLockStatus)) return moduleState("running", "Terraform State", "A Terraform state lock is active.", "wait_for_state_lock", "View Active Lock", `${base}/state`, true, lock.updatedAt);
    if (lock.status === TerraformLockStatus.QUEUED) return moduleState("waiting", "Terraform State", "Waiting for the current lock owner.", "wait_for_state_lock", "View Lock Queue", `${base}/state`, true, lock.updatedAt);
    if ([TerraformLockStatus.ORPHANED, TerraformLockStatus.FAILED].includes(lock.status as TerraformLockStatus)) return moduleState("failed", "Terraform State", "The latest Terraform lock needs attention.", null, "Review State", `${base}/state`, true, lock.updatedAt);
    return moduleState("passed", "Terraform State", "The latest Terraform state lock was released safely.", null, null, `${base}/state`, true, lock.updatedAt);
  }

  private storageModule(storage: ProjectPersistentStorage | null, profile: ProjectDetectionProfile | null, base: string): ProjectModuleState {
    if (!profile) return moduleState("not_started", "Persistent Storage", "Storage requirements will be evaluated after stack detection.", null, null, `${base}/storage`, false, null);
    if (!profile.requiresPersistentStorage || storage?.status === PersistentStorageStatus.NOT_REQUIRED) return moduleState("skipped", "Persistent Storage", "Persistent storage is not required for the detected app.", null, null, `${base}/storage`, false, storage?.updatedAt || profile.updatedAt);
    if (!storage) return moduleState("waiting", "Persistent Storage", "Persistent storage is required and will be configured during deployment.", null, "Review Storage", `${base}/storage`, false, profile.updatedAt);
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
    preflight: ProjectPreflightReport | null;
    modules: Modules;
    stages: ResolvedPipelineStage[];
    run: ProjectPipelineRun | null;
    deployment: ProjectDeployment | null;
    applyEnabled: boolean;
    canManage: boolean;
    manualApprovalsEnabled: boolean;
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
      input.run && applyGate && ["disabled_by_config", "passed", "failed", "running"].includes(applyGate.status)
    );
    const detectionFailed = Boolean(
      input.profile &&
        [DetectionStatus.FAILED, DetectionStatus.NEEDS_MANUAL_DOCKERFILE].includes(
          input.profile.detectionStatus as DetectionStatus
        )
    );
    const preflightPassed = Boolean(
      input.preflight &&
        [PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(
          input.preflight.validationStatus as PreflightValidationStatus
        )
    );
    const preflightFailed = Boolean(input.preflight && !preflightPassed);
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

    if (input.project.repositoryFullName && input.project.targetBranch && !input.profile) {
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
    } else if (preflightFailed) {
      phase = "failed";
      overallStatus = "failed";
      userFacingStatus = "Pre-flight validation needs attention.";
      currentStep = "preflight";
      currentStepLabel = "Fix Pre-flight Validation";
      nextAction = action("generate_preflight", "Regenerate Pre-flight Report", input.modules.preflight.message, `${base}/preflight`, "GET", input.canManage, disabled);
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
        userFacingStatus = "The latest ECS deployment needs attention.";
        currentStep = "deployment_failure";
        currentStepLabel = "Review Deployment";
        nextAction = action("fix_failure", "Review Deployment", "Inspect ECS and ALB health, then use the stable rollback option if needed.", `${base}/orchestration`, "GET", true, []);
      } else if (deploymentActive) {
        phase = "deployment";
        overallStatus = "running";
        userFacingStatus = `ECS deployment is ${input.deployment.status.replaceAll("_", " ")}.`;
        currentStep = "ecs_deployment";
        currentStepLabel = "ECS Deployment";
        nextAction = action("none", "Deployment Running", "Wait for ECS service stability and ALB target health.", `${base}/orchestration`, "GET", false, ["Deployment is already running."]);
      } else {
        phase = "runtime";
        overallStatus = "deployed";
        userFacingStatus = "The application has a real ECS deployment.";
        currentStep = "runtime_observability";
        currentStepLabel = "View Runtime";
        nextAction = action("view_logs", "View Runtime Observability", "Open logs, metrics, health, and deployment events for the running service.", `${base}/observability`, "GET", true, []);
      }
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
    } else if (input.run && isPipelineActive(input.run.status)) {
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
    };
  }

  private latestPipelineSnapshot(run: ProjectPipelineRun | null, failedStage: string | null, applyPaused: boolean) {
    if (!run) return { id: null, status: "not_started", startedAt: null, finishedAt: null, failedStage: null, failureMessage: null };
    const status = run.status === PipelineRunStatus.CANCELLED
      ? "cancelled"
      : applyPaused || isPipelinePaused(run.status)
      ? "paused"
      : isPipelineActive(run.status)
        ? run.status === PipelineRunStatus.QUEUED ? "queued" : "running"
        : failedStage || run.failedAt || isPipelineFailed(run.status)
          ? "failed"
          : "passed";
    return {
      id: run.id,
      status,
      startedAt: run.startedAt || null,
      finishedAt: run.completedAt || run.failedAt || null,
      failedStage,
      failureMessage: run.errorMessage ? this.logSanitizer.sanitize(run.errorMessage) : null,
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
}

function moduleState(status: ProjectModuleState["status"], label: string, message: string, actionName: string | null, actionLabel: string | null, href: string, required: boolean, lastUpdatedAt: Date | null): ProjectModuleState {
  return { status, label, message, action: actionName, actionLabel, href, required, lastUpdatedAt };
}

function action(type: string, label: string, message: string, href: string, method: NextAction["method"], enabled: boolean, disabledReasons: string[]): NextAction {
  return { type, label, message, description: message, href, method, enabled, disabledReasons, disabledReason: disabledReasons[0] || null };
}
