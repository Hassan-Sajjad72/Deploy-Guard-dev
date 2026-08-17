import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DescribeImagesCommand, DescribeRepositoriesCommand, ECRClient, ListTagsForResourceCommand as EcrListTagsForResourceCommand } from "@aws-sdk/client-ecr";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, ListTagsForResourceCommand as EcsListTagsForResourceCommand } from "@aws-sdk/client-ecs";
import { DescribeTagsCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { CostEstimateSource, CostEstimateStatus, ProjectCostEstimate } from "../../finops/project-cost-estimate.entity";
import { InfrastructureEnvironmentStatus, ProjectInfrastructureEnvironment } from "../../infrastructure/project-infrastructure-environment.entity";
import { getObservabilityConfig } from "../../observability/observability.config";
import { ProjectStableRelease, StableReleaseStatus } from "../../orchestration/project-stable-release.entity";
import { PersistentStorageStatus, ProjectPersistentStorage } from "../../storage/project-persistent-storage.entity";
import { User } from "../../users/user.entity";
import { DetectionStatus, ProjectDetectionProfile } from "../project-detection-profile.entity";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../project-pipeline-run.entity";
import { PreflightValidationStatus, ProjectPreflightReport } from "../project-preflight-report.entity";
import { Project } from "../project.entity";
import { ProjectEnvironmentRoute } from "../project-environment-route.entity";
import { ProjectsService } from "../projects.service";
import { DeveloperProjectCurrentState, ProjectStateAuthority } from "./project-current-state.types";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "../project-deployment-generation.entity";
import { canonicalEnvironmentName } from "../canonical-environment";
import { retryOperationEligibility } from "../github-actions-operation-contract";


type LiveAwsEvidence = {
  observedAt: string;
  ecr: { repository: string; imageTag: string | null; imageDigest: string | null };
  ecs: { cluster: string; service: string; taskDefinitionRevision: number | null; desiredCount: number; runningCount: number; pendingCount: number };
  alb: { name: string; status: string; targetHealth: string[]; endpoint: string | null };
};

@Injectable()
export class ProjectCurrentStateService {
  constructor(
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectDeploymentContract)
    private readonly contractRepository: Repository<ProjectDeploymentContract>,
    @InjectRepository(ProjectPreflightReport)
    private readonly preflightRepository: Repository<ProjectPreflightReport>,
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectCostEstimate)
    private readonly estimateRepository: Repository<ProjectCostEstimate>,
    @InjectRepository(ProjectInfrastructureEnvironment)
    private readonly environmentRepository: Repository<ProjectInfrastructureEnvironment>,
    @InjectRepository(ProjectPersistentStorage)
    private readonly storageRepository: Repository<ProjectPersistentStorage>,
    @InjectRepository(ProjectStableRelease)
    private readonly releaseRepository: Repository<ProjectStableRelease>,
    @InjectRepository(ProjectDeploymentGeneration)
    private readonly generationRepository: Repository<ProjectDeploymentGeneration>,
    private readonly projectsService: ProjectsService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async getCurrentState(
    user: User,
    projectId: string,
    _options: { refreshCloudState?: boolean } = {},
  ): Promise<DeveloperProjectCurrentState> {
    // The ordinary product surface is deliberately independent of the
    // retired release-lane/current-infrastructure graph. GitHub Actions runs,
    // repository detection and structural pre-flight are its only authority.
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const environmentName = canonicalEnvironmentName(project);
    const [profile, preflight, infrastructure, storage, route] = await Promise.all([
      this.profileRepository.findOne({ where: { projectId } }),
      this.preflightRepository.findOne({ where: { projectId } }),
      this.environmentRepository.findOne({
        where: { projectId },
        order: { updatedAt: "DESC" },
      }),
      this.storageRepository.findOne({ where: { projectId }, order: { updatedAt: "DESC" } }),
      this.dataSource.getRepository(ProjectEnvironmentRoute).findOne({ where: { projectId, environmentName } }),
    ]);
    const projected = await this.withGithubActionsState(
      projectId,
      environmentName,
      this.githubActionsReadinessState(project, profile, preflight),
      route?.liveGenerationId || null,
    );
    const authoritativeGenerationId = route?.liveGenerationId || null;
    const authoritativeRelease = authoritativeGenerationId
      ? await this.releaseRepository.findOne({
        where: { projectId, environmentName, generationId: authoritativeGenerationId, status: StableReleaseStatus.STABLE },
      })
      : null;
    const estimate = authoritativeRelease?.deployedByPipelineRunId
      ? await this.estimateRepository.findOne({
        where: {
          projectId,
          environmentName,
          generationId: authoritativeGenerationId,
          pipelineRunId: authoritativeRelease.deployedByPipelineRunId,
          source: CostEstimateSource.INFRACOST,
        },
        order: { updatedAt: "DESC" },
      })
      : null;
    const unavailableReason = !authoritativeRelease
      ? "No authoritative LIVE release exists."
      : !estimate
        ? "The current LIVE release has no persisted Infracost evidence."
        : estimate.status === CostEstimateStatus.FAILED
          ? estimate.errorMessage || "Infracost processing failed for the current LIVE release."
          : ![CostEstimateStatus.NO_APPROVAL_REQUIRED, CostEstimateStatus.APPROVAL_REQUIRED].includes(estimate.status)
            ? `Infracost evidence for the current LIVE release is ${String(estimate.status).replaceAll("_", " ")}.`
            : null;
    const projectedWithCost: DeveloperProjectCurrentState = {
      ...projected,
      estimatedCost: authoritativeRelease ? {
        status: estimate?.status === CostEstimateStatus.APPROVAL_REQUIRED
          ? "approval_required"
          : estimate?.status === CostEstimateStatus.NO_APPROVAL_REQUIRED
            ? "estimated"
            : "unavailable",
        source: estimate?.source === CostEstimateSource.INFRACOST ? "infracost" : "unavailable",
        currency: estimate?.currency || null,
        monthly: estimate?.status === CostEstimateStatus.NO_APPROVAL_REQUIRED ? Number(estimate.totalMonthlyCost) : null,
        generationId: authoritativeGenerationId,
        releaseId: authoritativeRelease.id,
        operationId: authoritativeRelease.deployedByPipelineRunId || null,
        estimatedAt: (estimate?.updatedAt || authoritativeRelease.deployedAt).toISOString(),
        unavailableReason,
        breakdown: Array.isArray((estimate?.normalizedBreakdown as Record<string, unknown> | null)?.resources)
          ? ((estimate.normalizedBreakdown as { resources: Array<Record<string, unknown>> }).resources).map((resource) => ({
              name: String(resource.resourceName || resource.name || "resource"),
              service: typeof resource.serviceName === "string" ? resource.serviceName : null,
              monthly: Number(resource.monthlyCost || 0),
            }))
          : [],
      } : null,
    };
    const hasAuthoritativeLiveRelease = Boolean(projectedWithCost.stableRelease && projectedWithCost.stableUrl)
      && !["destroying", "destroyed"].includes(projectedWithCost.developerState);
    const awsEvidence = hasAuthoritativeLiveRelease && route?.liveGenerationId
      ? await this.liveAwsEvidence(project, route.liveGenerationId, projectedWithCost.stableUrl!)
      : null;
    const generations = await this.generationRepository.find({ where: { projectId, environmentName }, order: { ordinal: "ASC" } });
    return {
      ...this.withStateAuthority(projectId, environmentName, projectedWithCost, profile, preflight, infrastructure, storage, awsEvidence),
      generationState: {
        liveGenerationId: route?.liveGenerationId || null,
        candidateGenerationId: route?.candidateGenerationId || null,
        generations: generations.map((generation) => ({
          id: generation.id,
          ordinal: generation.ordinal,
          status: generation.status,
          terraformStateKey: generation.terraformStateKey,
        })),
      },
    };
  }

  private githubActionsReadinessState(
    project: Project,
    profile: ProjectDetectionProfile | null,
    preflight: ProjectPreflightReport | null,
  ): DeveloperProjectCurrentState {
    const base = {
      repository: project.repositoryFullName || null,
      branch: project.targetBranch || null,
      commit: profile?.commitSha || null,
      latestAttempt: null,
      stableRelease: null,
      stableUrl: null,
      estimatedCost: null,
      missingConfiguration: [],
      advisories: preflight?.warnings || profile?.warnings || [],
      applicationError: null,
      canRetry: false,
      // Replaced before this response is returned. Keeping the readiness
      // constructor total makes every state branch use the same contract.
      stateAuthority: null as unknown as ProjectStateAuthority,
    } satisfies Omit<DeveloperProjectCurrentState, "developerState" | "developerAction" | "developerMessage" | "progress">;
    if (!base.repository || !base.branch) {
      return {
        ...base,
        developerState: "configuration_required",
        developerAction: "provide_configuration",
        developerMessage: "Choose an accessible repository and branch to continue.",
        progress: { percentage: 0, phase: null, label: "Choose repository" },
        applicationError: { category: "repository", message: "Choose an accessible repository and branch to continue." },
      };
    }
    if (!profile) {
      return {
        ...base,
        developerState: "configuration_required",
        developerAction: "none",
        developerMessage: "Repository analysis has not completed yet.",
        progress: { percentage: 0, phase: null, label: "Analyzing repository" },
      };
    }
    if (profile.detectionStatus !== DetectionStatus.SUCCESS || !preflight
      || ![PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(preflight.validationStatus as PreflightValidationStatus)) {
      const message = profile.detectionStatus !== DetectionStatus.SUCCESS
        ? "Repository analysis found a structural deployment blocker."
        : "Deployment pre-flight found a structural deployment blocker.";
      return {
        ...base,
        developerState: "unsupported",
        developerAction: "none",
        developerMessage: message,
        progress: { percentage: 20, phase: "analyze", label: "Repository needs attention" },
        applicationError: { category: "repository", message },
      };
    }
    return {
      ...base,
      developerState: "ready",
      developerAction: "deploy",
      developerMessage: "Repository analysis and deployment pre-flight are complete. No deployment has started yet.",
      // Analyze and Prepare are the only two completed lifecycle phases. This
      // is a five-phase product progress value, never a legacy stage count.
      progress: { percentage: 40, phase: "prepare", label: "Ready to Deploy" },
    };
  }

  private async withGithubActionsState(
    projectId: string,
    environmentName: string,
    projected: DeveloperProjectCurrentState,
    liveGenerationId: string | null,
  ): Promise<DeveloperProjectCurrentState> {
    const githubRuns = this.runRepository.createQueryBuilder("run")
      .where("run.projectId = :projectId", { projectId })
      .andWhere("run.metadata ->> 'executionEngine' = 'github_actions'")
      // Maintenance is evidence about a retired generation, never the latest
      // developer operation or authoritative runtime state.
      .andWhere("COALESCE(run.metadata ->> 'internalMaintenance', 'false') != 'true'");
    const latest = await githubRuns.clone().orderBy("run.createdAt", "DESC").getOne();
    if (!latest) return projected;
    const stable = liveGenerationId ? await githubRuns.clone()
        .andWhere("run.generationId = :generationId", { generationId: liveGenerationId })
        .andWhere("run.status = :completed", { completed: PipelineRunStatus.COMPLETED })
        .andWhere("run.metadata ->> 'deploymentAction' IN (:...releaseActions)", { releaseActions: ["deploy", "rollback"] })
        .andWhere("run.metadata ->> 'deployedUrl' IS NOT NULL")
        .orderBy("run.completedAt", "DESC")
        .getOne() : null;

    const latestMetadata = (latest.metadata || {}) as Record<string, unknown>;
    const stableMetadata = (stable?.metadata || {}) as Record<string, unknown>;
    const attempt = String(latestMetadata.attempt || 1);
    const latestCommit = latest.commitSha || projected.commit;
    const stableUrl = typeof stableMetadata.deployedUrl === "string"
      ? stableMetadata.deployedUrl
      : null;
    const stableRelease = stable && stableUrl
      ? {
          revision: String(stableMetadata.attempt || 1),
          generationId: stable.generationId || null,
          commit: stable.commitSha || latestCommit || "unknown",
          promotedAt: (stable.completedAt || stable.updatedAt).toISOString(),
          rollbackAvailable: stableMetadata.rollbackAvailable === true,
        }
      : null;
    const action = latestMetadata.deploymentAction === "destroy"
      ? "destroy" as const
      : latestMetadata.deploymentAction === "rollback"
        ? "rollback" as const
        : "deploy" as const;
    const latestAttempt: NonNullable<DeveloperProjectCurrentState["latestAttempt"]> = {
      operationId: latest.id,
      generationId: latest.generationId,
      workflowRunId: latest.githubWorkflowRunId || null,
      operationType: action,
      status: "preparing",
      outcome: null as "completed" | "cancelled" | "blocked" | null,
      attempt,
      message: null,
      releaseRevision: null,
      commit: latestCommit,
      occurredAt: (latest.completedAt || latest.failedAt || latest.updatedAt).toISOString(),
    };
    if (latest.status === PipelineRunStatus.COMPLETED) {
      if (action === "destroy") {
        const verification = latestMetadata.destroyVerification as Record<string, unknown> | undefined;
        const verifiedDestroyed = verification?.contractVersion === "deployguard.destroy-result/v2"
          && verification?.status === "project_delete_ready"
          && verification?.deploymentOperationId === latest.id
          && verification?.projectId === projectId
          && verification?.environmentName === environmentName
          && verification?.generationResourcesRemoved === true
          && verification?.projectResourcesRemoved === true
          && verification?.terraformStateArtifactsRemoved === true
          && verification?.sharedPlatformUntouched === true;
        if (!verifiedDestroyed) {
          return {
            ...projected,
            developerState: "platform_attention",
            developerAction: "none",
            developerMessage: "Project deletion cleanup did not produce matching exact-scope evidence.",
            progress: { percentage: 80, phase: "verify", label: "Destroy verification needs attention" },
            latestAttempt: { ...latestAttempt, status: "platform_attention", outcome: "blocked" },
            stableRelease,
            stableUrl,
            applicationError: { category: "runtime", message: "Exact project and generation cleanup has not been verified." },
            canRetry: false,
          };
        }
        return {
          ...projected,
          developerState: "destroyed",
          developerAction: "deploy_again",
          developerMessage: "Infrastructure was destroyed. This project is ready to deploy again.",
          progress: { percentage: 40, phase: "prepare", label: "Ready to Deploy" },
          latestAttempt: { ...latestAttempt, status: "destroyed", outcome: "completed" },
          stableRelease: null,
          stableUrl: null,
          applicationError: null,
          canRetry: false,
        };
      }
      // A completed workflow is not itself proof that a user can reach a
      // healthy application. `healthy` is written only after the reusable
      // workflow's ALB/endpoint verification step succeeds, and a public URL
      // must still be discoverable before this product projection can be LIVE.
      const healthVerified = latest.currentStage === "healthy" && Boolean(stableUrl);
      if (!healthVerified) {
        return {
          ...projected,
          developerState: "platform_attention",
          developerAction: "none",
          developerMessage: "GitHub Actions completed, but DeployGuard could not verify a healthy application endpoint.",
          progress: { percentage: 80, phase: "verify", label: "Verification needs attention" },
          latestAttempt: { ...latestAttempt, status: "platform_attention", outcome: "blocked" },
          stableRelease: null,
          stableUrl: null,
          applicationError: { category: "health", message: "GitHub Actions completed, but DeployGuard could not verify a healthy application endpoint." },
          canRetry: false,
        };
      }
      return {
        ...projected,
        developerState: "live",
        developerAction: stableUrl ? "open_application" : "none",
        developerMessage: stableUrl ? "The latest release is live." : "The latest release is stable.",
        progress: { percentage: 100, phase: "verify", label: "Live" },
        latestAttempt: { ...latestAttempt, status: "live", outcome: "completed" },
        stableRelease,
        stableUrl,
        applicationError: null,
        canRetry: false,
      };
    }

    if (latest.status === PipelineRunStatus.FAILED) {
      const failedStage = String(latestMetadata.failedStage || latest.currentStage || "github_actions");
      const category = failedStage.includes("build") ? "build"
        : failedStage.includes("health") ? "health"
          : "runtime";
      const failedLatestAttempt = {
        ...latestAttempt,
        status: "failed_application" as const,
        outcome: "blocked" as const,
        message: latest.errorMessage || "The GitHub Actions deployment failed.",
      };
      if (stableRelease && stableUrl) {
        return {
          ...projected,
          developerState: "live",
          developerAction: "open_application",
          developerMessage: `The latest ${action} operation failed. The verified stable release remains live.`,
          progress: {
            percentage: this.githubLifecycleProgress(category === "build" ? "build" : category === "health" ? "verify" : "deploy"),
            phase: category === "build" ? "build" : category === "health" ? "verify" : "deploy",
            label: "Failed",
          },
          latestAttempt: failedLatestAttempt,
          stableRelease,
          stableUrl,
          applicationError: null,
          canRetry: retryOperationEligibility(latest, {
            id: projectId,
            repositoryFullName: projected.repository || "",
            targetBranch: projected.branch || "",
          }) !== "ineligible",
        };
      }
      return {
        ...projected,
        developerState: "failed_application",
        developerAction: stableRelease ? "redeploy" : "deploy",
        developerMessage: latest.errorMessage || "The GitHub Actions deployment failed.",
        progress: { percentage: this.githubLifecycleProgress(category === "build" ? "build" : category === "health" ? "verify" : "deploy"), phase: category === "build" ? "build" : category === "health" ? "verify" : "deploy", label: "Failed" },
        latestAttempt: failedLatestAttempt,
        stableRelease,
        stableUrl,
        applicationError: { category, message: latest.errorMessage || "The GitHub Actions deployment failed." },
        canRetry: retryOperationEligibility(latest, {
          id: projectId,
          repositoryFullName: projected.repository || "",
          targetBranch: projected.branch || "",
        }) !== "ineligible",
      };
    }

    const stage = String(latest.currentStage || "github_actions");
    const phase = stage.includes("build") ? "build"
      : stage.includes("terraform") ? "deploy"
        : stage.includes("health") || stage.includes("verify") ? "verify"
          : "prepare";
    const state = phase === "build" ? "building"
      : phase === "deploy" ? "deploying"
        : phase === "verify" ? "verifying"
          : latest.status === PipelineRunStatus.QUEUED ? "queued" : "preparing";
    if (stableRelease && stableUrl) {
      const operationStatus = action === "destroy" ? "destroying" : state;
      const operationProgress: DeveloperProjectCurrentState["progress"] = action === "destroy"
        ? { percentage: 70, phase: "deploy", label: "Destroying application" }
        : { percentage: this.githubLifecycleProgress(phase), phase, label: action === "rollback" ? "Rolling back" : "Deploying" };
      return {
        ...projected,
        developerState: "live",
        developerAction: "none",
        developerMessage: `A ${action} operation is in progress. The verified stable release remains live.`,
        progress: operationProgress,
        latestAttempt: { ...latestAttempt, status: operationStatus, message: null },
        stableRelease,
        stableUrl,
        applicationError: null,
        canRetry: false,
      };
    }
    if (action === "destroy") {
      return {
        ...projected,
        developerState: "destroying",
        developerAction: "none",
        developerMessage: "DeployGuard is removing this project's infrastructure.",
        progress: { percentage: 70, phase: "deploy", label: "Destroying application" },
        latestAttempt: { ...latestAttempt, status: "destroying" },
        applicationError: null,
        canRetry: false,
      };
    }
    return {
      ...projected,
      developerState: state,
      developerAction: "none",
      developerMessage: "GitHub Actions deployment is in progress.",
      // Percentages represent completed lifecycle milestones, never elapsed
      // time or an animation. Detection/pre-flight already completed Analyze
      // and Prepare before GitHub Actions was dispatched.
      progress: { percentage: this.githubLifecycleProgress(phase), phase, label: "Deploying" },
      latestAttempt: { ...latestAttempt, status: state },
      stableRelease,
      stableUrl,
      applicationError: null,
      canRetry: false,
    };
  }

  private githubLifecycleProgress(phase: "prepare" | "build" | "deploy" | "verify") {
    return { prepare: 40, build: 40, deploy: 60, verify: 80 }[phase];
  }

  /**
   * Attach the evidence envelope after GitHub Actions has won state
   * precedence. Infrastructure records are evidence only here: they never
   * revive a historical release-lane state or override a newer destroy.
   */
  private withStateAuthority(
    projectId: string,
    environmentName: string,
    projected: DeveloperProjectCurrentState,
    profile: ProjectDetectionProfile | null,
    preflight: ProjectPreflightReport | null,
    infrastructure: ProjectInfrastructureEnvironment | null,
    storage: ProjectPersistentStorage | null,
    awsEvidence: LiveAwsEvidence | null,
  ): DeveloperProjectCurrentState {
    const latest = projected.latestAttempt;
    // Runtime state and operation state are deliberately independent. A
    // candidate may be progressing while a prior generation remains LIVE.
    const isActive = Boolean(latest && latest.outcome === null);
    const operationType = latest?.operationType || "deploy";
    const observedAt = latest?.occurredAt
      || profile?.updatedAt?.toISOString()
      || preflight?.updatedAt?.toISOString()
      || null;
    const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
    const freshness = !observedAt
      ? "unavailable" as const
      : Number.isFinite(observedMs) && Date.now() - observedMs <= 10 * 60 * 1_000
        ? "current" as const
        : "stale" as const;
    const destroyed = projected.developerState === "destroyed";
    const authoritativeLiveRelease = Boolean(projected.stableRelease && projected.stableUrl) && !destroyed;
    const liveReleaseObservedAt = projected.stableRelease?.promotedAt || observedAt;
    const infrastructureStatus = destroyed
      ? { exists: false, status: "destroyed" as const, source: "github_actions" as const }
      : authoritativeLiveRelease
        ? { exists: true, status: "active" as const, source: "github_actions" as const }
        : infrastructure?.status === InfrastructureEnvironmentStatus.PROVISIONED
          ? { exists: true, status: "active" as const, source: "infrastructure_record" as const }
          : infrastructure?.status === InfrastructureEnvironmentStatus.DESTROYED
            ? { exists: false, status: "destroyed" as const, source: "infrastructure_record" as const }
            : infrastructure
              ? { exists: false, status: "not_provisioned" as const, source: "infrastructure_record" as const }
              : { exists: null, status: "unknown" as const, source: "unavailable" as const };
    const canonical = projected.developerState === "ready"
      ? "READY" as const
      : projected.developerState === "destroyed"
          ? "DESTROYED" as const
          : isActive && operationType === "destroy"
            ? "DESTROYING" as const
            : isActive
              ? "DEPLOYING" as const
              : authoritativeLiveRelease
                ? "LIVE" as const
                : projected.developerState === "failed_application"
                  ? "FAILED" as const
                  : "BLOCKED" as const;
    const authority: ProjectStateAuthority = {
      state: canonical,
      reason: projected.developerMessage,
      activeOperation: isActive && latest ? {
        // The run id is intentionally the public operation identity; no
        // worker lease, queue id or release-lane detail leaks to the UI.
        id: latest.operationId || "active-github-actions-operation",
        type: operationType,
        status: latest.status,
        stage: projected.progress.phase,
        startedAt: latest.occurredAt,
        workflowRunId: latest.workflowRunId,
      } : null,
      latestCompletedOperation: !isActive && latest?.outcome === "completed" ? {
        id: latest.operationId || "completed-github-actions-operation",
        type: operationType,
        completedAt: latest.occurredAt,
        outcome: destroyed ? "destroyed" : "succeeded",
      } : !isActive && latest?.outcome === "blocked" ? {
        id: latest.operationId || "failed-github-actions-operation",
        type: operationType,
        completedAt: latest.occurredAt,
        outcome: "failed",
      } : null,
      infrastructure: { ...infrastructureStatus, observedAt: authoritativeLiveRelease ? awsEvidence?.observedAt || liveReleaseObservedAt : observedAt },
      applicationHealth: authoritativeLiveRelease
        ? { status: "healthy", source: "github_actions_health_verification", observedAt: liveReleaseObservedAt }
        : projected.developerState === "failed_application" && projected.applicationError?.category === "health"
          ? { status: "failed", source: "github_actions", observedAt }
          : isActive
            ? { status: "pending", source: "github_actions", observedAt }
            : { status: "unavailable", source: "unavailable", observedAt: null },
      monitoring: authoritativeLiveRelease
        ? { available: getObservabilityConfig(this.config).awsRuntimeMonitoringEnabled, status: getObservabilityConfig(this.config).awsRuntimeMonitoringEnabled ? "available" : "unavailable", reason: getObservabilityConfig(this.config).awsRuntimeMonitoringEnabled ? "AWS runtime monitoring follows the authoritative LIVE generation." : "AWS runtime monitoring is disabled." }
        : { available: false, status: "not_deployed", reason: "Monitoring is available only for an active live deployment." },
      reconciliation: {
        lastReconciledAt: observedAt,
        freshness,
        source: latest ? "github_actions" : profile || preflight ? "detection_preflight" : "unavailable",
      },
    };
    const resourceStatus = authority.infrastructure.status === "active"
      ? "active" as const
      : authority.infrastructure.status === "destroyed"
        ? "destroyed" as const
        : "unavailable" as const;
    const storageIsConfigured = Boolean(storage?.enabled && [
      PersistentStorageStatus.PROVISIONED,
      PersistentStorageStatus.BACKUP_CONFIGURED,
      PersistentStorageStatus.RESTORED,
    ].includes(storage.status as PersistentStorageStatus));
    return {
      ...projected,
      stateAuthority: authority,
      infrastructureEvidence: {
        source: authority.infrastructure.source,
        lastUpdatedAt: awsEvidence?.observedAt || observedAt,
        freshness: awsEvidence ? "current" : freshness,
        region: this.config.get<string>("AWS_REGION", "us-east-1"),
        executionEngine: "github_actions",
        resources: (["ECR", "ECS Fargate", "ALB"] as const).map((type) => ({ type, status: resourceStatus === "active" && !awsEvidence ? "unavailable" : resourceStatus })),
        ecr: awsEvidence?.ecr || null,
        ecs: awsEvidence?.ecs || null,
        alb: awsEvidence?.alb || null,
        terraformState: {
          status: resourceStatus,
          storage: this.config.get<string>("DEPLOYGUARD_TERRAFORM_STATE_BUCKET") ? "encrypted_s3" : "unavailable",
          key: this.config.get<string>("DEPLOYGUARD_TERRAFORM_STATE_BUCKET") && projected.stableRelease?.generationId
            ? `projects/${projectId}/${environmentName}/${projected.stableRelease.generationId}/terraform.tfstate`
            : null,
          lastApplyAt: authoritativeLiveRelease ? liveReleaseObservedAt : null,
          lastDestroyAt: destroyed ? observedAt : null,
        },
        cost: {
          status: projected.estimatedCost?.status || "unavailable",
          currency: projected.estimatedCost?.currency || null,
          monthly: projected.estimatedCost?.monthly ?? null,
          source: projected.estimatedCost?.source || "unavailable",
          generationId: projected.estimatedCost?.generationId || null,
          releaseId: projected.estimatedCost?.releaseId || null,
          operationId: projected.estimatedCost?.operationId || null,
          estimatedAt: projected.estimatedCost?.estimatedAt || null,
          unavailableReason: projected.estimatedCost?.unavailableReason || null,
          breakdown: projected.estimatedCost?.breakdown || [],
        },
        persistentStorage: storageIsConfigured ? {
          type: "EFS",
          status: String(storage!.status),
          encrypted: Boolean(storage!.encrypted),
          backupEnabled: Boolean(storage!.backupEnabled),
          region: storage!.awsRegion || null,
        } : null,
      },
    };
  }

  private async liveAwsEvidence(project: Project, generationId: string, stableUrl: string): Promise<LiveAwsEvidence | null> {
    const projectId = project.id;
    const environment = canonicalEnvironmentName(project);
    const generation = await this.generationRepository.findOne({ where: { id: generationId, projectId, environmentName: environment, status: DeploymentGenerationStatus.LIVE } });
    const release = await this.releaseRepository.findOne({
      where: { projectId, environmentName: environment, generationId, status: StableReleaseStatus.STABLE },
      order: { deployedAt: "DESC" },
    });
    if (!generation || !release?.imageUri || !release.taskDefinitionArn) return null;
    const region = this.config.get<string>("AWS_REGION", "us-east-1");
    const repository = `deployguard-${projectId.toLowerCase()}`;
    const cluster = this.config.get<string>("DEPLOYGUARD_SHARED_ECS_CLUSTER_ARN", "")
      || this.config.get<string>("DEPLOYGUARD_SHARED_ECS_CLUSTER_NAME", "");
    const sharedAlbArn = this.config.get<string>("DEPLOYGUARD_SHARED_ALB_ARN", "");
    const targetGroupArn = typeof release.metadata?.targetGroupArn === "string" ? release.metadata.targetGroupArn : "";
    if (!cluster || !release.ecsServiceArn || !targetGroupArn) return null;
    try {
      const ecs = new ECSClient({ region });
      const ecr = new ECRClient({ region });
      const elb = new ElasticLoadBalancingV2Client({ region });
      const [serviceResult, repositoryResult, targetGroupsResult] = await Promise.all([
        ecs.send(new DescribeServicesCommand({ cluster, services: [release.ecsServiceArn], include: ["TAGS"] })),
        ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repository] })),
        elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [targetGroupArn] })),
      ]);
      const service = serviceResult.services?.[0];
      const repositoryEvidence = repositoryResult.repositories?.[0];
      const targetGroup = targetGroupsResult.TargetGroups?.[0];
      if (!service?.serviceName || service.status !== "ACTIVE" || service.taskDefinition !== release.taskDefinitionArn || !repositoryEvidence?.repositoryArn || !targetGroup?.TargetGroupArn) return null;
      const imageId = release.imageUri.includes("@sha256:")
        ? { imageDigest: release.imageUri.slice(release.imageUri.indexOf("@") + 1) }
        : { imageTag: release.imageUri.slice(release.imageUri.lastIndexOf(":") + 1) };
      const [taskDefinitionResult, imageResult, repositoryTags, serviceTags, targetGroupTags, targetHealth] = await Promise.all([
        ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: release.taskDefinitionArn, include: ["TAGS"] })),
        ecr.send(new DescribeImagesCommand({ repositoryName: repository, imageIds: [imageId] })),
        ecr.send(new EcrListTagsForResourceCommand({ resourceArn: repositoryEvidence.repositoryArn })),
        ecs.send(new EcsListTagsForResourceCommand({ resourceArn: service.serviceArn! })),
        elb.send(new DescribeTagsCommand({ ResourceArns: [targetGroupArn] })),
        elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn })),
      ]);
      const tags = (input: Array<{ Key?: string; Value?: string; key?: string; value?: string }> | undefined) =>
        Object.fromEntries((input || []).map((tag) => [tag.Key || tag.key || "", tag.Value || tag.value || ""]));
      const ownsGeneration = (input: Array<{ Key?: string; Value?: string; key?: string; value?: string }> | undefined) => {
        const values = tags(input);
        return values.ManagedBy === "DeployGuard"
          && values.DeployGuardProjectId === projectId
          && values.Environment === environment
          && values.DeployGuardGenerationId === generationId;
      };
      const repositoryTagValues = tags(repositoryTags.tags);
      const ownsProjectRepository = repositoryTagValues.ManagedBy === "DeployGuard"
        && repositoryTagValues.DeployGuardProjectId === projectId
        && repositoryTagValues.DeployGuardScope === "project";
      if (!ownsProjectRepository || !ownsGeneration(serviceTags.tags) || !ownsGeneration(taskDefinitionResult.tags) || !ownsGeneration(targetGroupTags.TagDescriptions?.[0]?.Tags)) return null;
      const immutableImage = imageResult.imageDetails?.[0];
      if (!immutableImage) return null;
      return {
        observedAt: new Date().toISOString(),
        ecr: { repository, imageTag: immutableImage.imageTags?.[0] || null, imageDigest: immutableImage.imageDigest || null },
        ecs: {
          cluster,
          service: service.serviceName,
          taskDefinitionRevision: taskDefinitionResult?.taskDefinition?.revision ?? null,
          desiredCount: service.desiredCount || 0,
          runningCount: service.runningCount || 0,
          pendingCount: service.pendingCount || 0,
        },
        alb: {
          name: sharedAlbArn || "shared-deployguard-alb",
          status: "active",
          targetHealth: (targetHealth?.TargetHealthDescriptions || []).map((item) => item.TargetHealth?.State || "unknown"),
          endpoint: /^https?:\/\//i.test(stableUrl) ? stableUrl : null,
        },
      };
    } catch {
      return null;
    }
  }

  async getDetailedCurrentState(
    user: User,
    projectId: string,
    _options: { refreshCloudState?: boolean } = {},
  ) {
    const [currentState, deploymentContract] = await Promise.all([
      this.getCurrentState(user, projectId),
      this.contractRepository.findOne({ where: { projectId } }),
    ]);
    return {
      ...currentState,
      deploymentContract,
    };
  }
}
