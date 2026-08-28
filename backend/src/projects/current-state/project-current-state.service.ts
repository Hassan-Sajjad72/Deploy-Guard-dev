import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DescribeImagesCommand, DescribeRepositoriesCommand, ECRClient, ListTagsForResourceCommand as EcrListTagsForResourceCommand } from "@aws-sdk/client-ecr";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, ListTagsForResourceCommand as EcsListTagsForResourceCommand } from "@aws-sdk/client-ecs";
import { DescribeTagsCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { CostEstimateSource, CostEstimateStatus, ProjectCostEstimate } from "../../finops/project-cost-estimate.entity";
import { getObservabilityConfig } from "../../observability/observability.config";
import { ProjectStableRelease, StableReleaseStatus } from "../../orchestration/project-stable-release.entity";
import { User } from "../../users/user.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../project-pipeline-run.entity";
import { Project } from "../project.entity";
import { ProjectEnvironmentRoute } from "../project-environment-route.entity";
import { ProjectsService } from "../projects.service";
import { DeveloperProjectCurrentState, ProjectStateAuthority } from "./project-current-state.types";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "../project-deployment-generation.entity";
import { canonicalEnvironmentName } from "../canonical-environment";
import { githubActionsFailureLifecyclePhase, githubActionsFailureMessage } from "../pipeline/github-actions-stage-presentation";

function retryOperationEligible(operation: Pick<ProjectPipelineRun, "metadata" | "commitSha">) {
  return operation.metadata?.executionEngine === "railpack"
    && ["deploy", "rollback", "destroy"].includes(String(operation.metadata?.deploymentAction || "deploy"));
}


type LiveAwsEvidence = {
  observedAt: string;
  ecr: { repository: string; imageTag: string | null; imageDigest: string | null };
  ecs: { cluster: string; service: string; taskDefinitionRevision: number | null; desiredCount: number; runningCount: number; pendingCount: number };
  alb: { name: string; status: string; targetHealth: string[]; endpoint: string | null };
};

@Injectable()
export class ProjectCurrentStateService {
  constructor(
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectCostEstimate)
    private readonly estimateRepository: Repository<ProjectCostEstimate>,
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
    options: { refreshCloudState?: boolean } = {},
  ): Promise<DeveloperProjectCurrentState> {
    // GitHub Actions release records are the deployment authority.  Railpack
    // interprets source only inside the build, never in this read model.
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const environmentName = canonicalEnvironmentName(project);
    const route = await this.dataSource.getRepository(ProjectEnvironmentRoute).findOne({ where: { projectId, environmentName } });
    const projected = await this.withGithubActionsState(
      projectId,
      environmentName,
      this.githubActionsReadinessState(project),
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
      && !projectedWithCost.destroyCleanupIncomplete
      && !["destroying", "destroyed"].includes(projectedWithCost.developerState);
    // The product read-model must be sufficient to paint Overview and
    // Pipeline. Live AWS inspection is deliberately opt-in: it can require
    // multiple remote SDK calls and must never sit on the initial page path.
    const awsEvidence = options.refreshCloudState && hasAuthoritativeLiveRelease && route?.liveGenerationId
      ? await this.liveAwsEvidence(project, route.liveGenerationId, projectedWithCost.stableUrl!)
      : null;
    const generations = await this.generationRepository.find({ where: { projectId, environmentName }, order: { ordinal: "ASC" } });
    return {
      ...this.withStateAuthority(projectId, environmentName, projectedWithCost, awsEvidence),
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
  ): DeveloperProjectCurrentState {
    const base = {
      repository: project.repositoryFullName || null,
      branch: project.targetBranch || null,
      commit: null,
      latestAttempt: null,
      stableRelease: null,
      stableUrl: null,
      estimatedCost: null,
      missingConfiguration: [],
      advisories: [],
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
    return {
      ...base,
      developerState: "ready",
      developerAction: "deploy",
      developerMessage: "Repository and branch are ready to deploy.",
      progress: { percentage: 0, phase: null, label: "Ready to Deploy" },
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
      .andWhere("run.metadata ->> 'executionEngine' = 'railpack'")
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
    const verifiedDestroyAncestor = action === "destroy"
      ? await this.verifiedDestroyAncestor(latest, projectId, environmentName)
      : null;
    const verifiedAwsDeletion = Boolean(verifiedDestroyAncestor);
    const destroyCleanupIncomplete = verifiedAwsDeletion
      && latest.status !== PipelineRunStatus.COMPLETED;
    if (destroyCleanupIncomplete) {
      return {
        ...projected,
        destroyCleanupIncomplete: true,
        developerState: "platform_attention",
        developerAction: "none",
        developerMessage: "AWS project deletion was verified, but DeployGuard control-plane cleanup is incomplete. Retry Failed Destroy to resume cleanup.",
        progress: { percentage: 90, phase: "verify", label: "Destroy cleanup needs attention" },
        latestAttempt: {
          ...latestAttempt,
          status: "platform_attention",
          outcome: "blocked",
          message: latest.errorMessage || "Project deletion control-plane cleanup is incomplete.",
        },
        // These are historical records only after the destroy evidence proves
        // their AWS runtime is absent. They must not revive LIVE authority.
        stableRelease: null,
        stableUrl: null,
        applicationError: { category: "runtime", message: "AWS runtime deletion was verified; remaining DeployGuard cleanup is retryable." },
        canRetry: retryOperationEligible(latest),
      };
    }
    if (latest.status === PipelineRunStatus.COMPLETED) {
      if (action === "destroy") {
        if (!verifiedAwsDeletion) {
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
      const dispatchFailed = latestMetadata.dispatchState === "failed" && !latest.githubWorkflowRunId;
      if (dispatchFailed) {
        const message = latest.errorMessage || "DeployGuard failed before a GitHub Actions run was created.";
        return {
          ...projected,
          developerState: "failed_application",
          developerAction: "deploy",
          developerMessage: `Deployment could not start. ${message}`,
          progress: { percentage: 0, phase: "source", label: "Dispatch failed" },
          latestAttempt: { ...latestAttempt, status: "failed_application", outcome: "blocked", message },
          stableRelease,
          stableUrl,
          applicationError: { category: "configuration", message },
          canRetry: retryOperationEligible(latest),
        };
      }
      const failedStage = String(latestMetadata.failedStage || latest.currentStage || "github_actions");
      const failureMessage = githubActionsFailureMessage(latest.errorMessage, failedStage, action);
      const failurePhase = githubActionsFailureLifecyclePhase(failedStage);
      const category = failurePhase === "build" ? "build"
        : failurePhase === "verify" ? "health"
          : "runtime";
      const failedLatestAttempt = {
        ...latestAttempt,
        status: "failed_application" as const,
        outcome: "blocked" as const,
        message: failureMessage,
      };
      if (stableRelease && stableUrl) {
        return {
          ...projected,
          developerState: "live",
          developerAction: "open_application",
          developerMessage: `The latest ${action} operation failed. The verified stable release remains live.`,
          progress: {
            percentage: this.githubLifecycleProgress(failurePhase),
            phase: failurePhase,
            label: "Failed",
          },
          latestAttempt: failedLatestAttempt,
          stableRelease,
          stableUrl,
          applicationError: null,
          canRetry: latest.status === PipelineRunStatus.FAILED && retryOperationEligible(latest),
        };
      }
      return {
        ...projected,
        developerState: "failed_application",
        developerAction: stableRelease ? "redeploy" : "deploy",
        developerMessage: failureMessage,
        progress: { percentage: this.githubLifecycleProgress(failurePhase), phase: failurePhase, label: "Failed" },
        latestAttempt: failedLatestAttempt,
        stableRelease,
        stableUrl,
        applicationError: { category, message: failureMessage },
        canRetry: latest.status === PipelineRunStatus.FAILED && retryOperationEligible(latest),
      };
    }

    const stage = String(latest.currentStage || "github_actions");
    const phase = this.githubLifecyclePhase(stage, latestMetadata);
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
      // Percentages represent evidence-backed Railpack lifecycle milestones,
      // never elapsed time or retired repository analysis.
      progress: { percentage: this.githubLifecycleProgress(phase), phase, label: "Deploying" },
      latestAttempt: { ...latestAttempt, status: state },
      stableRelease,
      stableUrl,
      applicationError: null,
      canRetry: false,
    };
  }

  private githubLifecycleProgress(phase: "prepare" | "build" | "deploy" | "verify") {
    return { prepare: 20, build: 40, deploy: 60, verify: 80 }[phase];
  }

  /**
   * A rollback operation can dispatch a promotion/compensation workflow after
   * its candidate has already completed Terraform. The execution stage then
   * briefly becomes `promotion_dispatch` or `github_actions`; neither is an
   * earlier lifecycle milestone. Preserve the highest confirmed phase from
   * persisted workflow evidence so a single operation never paints Deploy and
   * then regresses to Prepare while it converges on LIVE.
   */
  private githubLifecyclePhase(
    currentStage: string,
    metadata: Record<string, unknown>,
  ): "prepare" | "build" | "deploy" | "verify" {
    const phaseForStage = (stage: unknown, recognizePromotion = false) => {
      const value = String(stage || "").toLowerCase();
      if (value.includes("build")) return "build" as const;
      if (value.includes("terraform") || (recognizePromotion && value.startsWith("promotion_"))) return "deploy" as const;
      if (value.includes("health") || value.includes("verify")) return "verify" as const;
      return "prepare" as const;
    };
    if (metadata.deploymentAction !== "rollback") return phaseForStage(currentStage);
    const rank = { prepare: 0, build: 1, deploy: 2, verify: 3 } as const;
    const workflowStages = Array.isArray(metadata.workflowStages) ? metadata.workflowStages : [];
    const confirmedWorkflowPhase = workflowStages.reduce<"prepare" | "build" | "deploy" | "verify">((highest, item) => {
      if (!item || typeof item !== "object") return highest;
      const stage = item as Record<string, unknown>;
      if (!["passed", "running"].includes(String(stage.status || "").toLowerCase())) return highest;
      const candidate = phaseForStage(stage.key, true);
      return rank[candidate] > rank[highest] ? candidate : highest;
    }, "prepare");
    const workflowPhase = String(metadata.workflowPhase || "").toLowerCase();
    const promotionHandoff = ["promotion", "compensation"].includes(workflowPhase)
      || String(currentStage || "").toLowerCase().startsWith("promotion_");
    const currentPhase = phaseForStage(currentStage, true);
    const minimumPhase = promotionHandoff ? "deploy" as const : "prepare" as const;
    return [currentPhase, confirmedWorkflowPhase, minimumPhase].reduce<"prepare" | "build" | "deploy" | "verify">(
      (highest, candidate) => rank[candidate] > rank[highest] ? candidate : highest,
      "prepare",
    );
  }

  /** A retry may carry an ancestor's immutable deletion proof, never its own. */
  private async verifiedDestroyAncestor(source: ProjectPipelineRun, projectId: string, environmentName: string) {
    const generationId = source.generationId;
    if (!generationId) return null;
    let current: ProjectPipelineRun | null = source;
    const visited = new Set<string>();
    for (let depth = 0; current && depth < 32; depth += 1) {
      if (visited.has(current.id)
        || current.projectId !== projectId
        || current.generationId !== generationId
        || current.metadata?.deploymentAction !== "destroy") return null;
      visited.add(current.id);
      const evidence = current.metadata?.destroyVerification as Record<string, unknown> | undefined;
      const finalizedAfterAwsDeletion = current.status === PipelineRunStatus.COMPLETED
        || (current.status === PipelineRunStatus.FAILED
          && current.currentStage === "project_delete_cleanup"
          && current.metadata?.failureCategory === "project_delete_incomplete");
      if (
        finalizedAfterAwsDeletion
        && evidence?.contractVersion === "deployguard.destroy-result/v2"
        && evidence.deploymentOperationId === current.id
        && evidence.projectId === projectId
        && evidence.environmentName === environmentName
        && evidence.status === "project_delete_ready"
        && evidence.generationResourcesRemoved === true
        && evidence.projectResourcesRemoved === true
        && evidence.terraformStateArtifactsRemoved === true
        && evidence.sharedPlatformUntouched === true
        && Array.isArray(evidence.generationIds)
        && evidence.generationIds.includes(generationId)
      ) return current;
      const parentId = current.metadata?.retryOfOperationId;
      if (typeof parentId !== "string" || !parentId) return null;
      current = await this.runRepository.findOne({ where: { id: parentId, projectId } });
    }
    return null;
  }

  /**
   * Attach the evidence envelope after GitHub Actions has won state
   * precedence. Retired infrastructure/storage records are not queried and
   * cannot override a newer destroy.
   */
  private withStateAuthority(
    projectId: string,
    environmentName: string,
    projected: DeveloperProjectCurrentState,
    awsEvidence: LiveAwsEvidence | null,
  ): DeveloperProjectCurrentState {
    const latest = projected.latestAttempt;
    // Runtime state and operation state are deliberately independent. A
    // candidate may be progressing while a prior generation remains LIVE.
    const isActive = Boolean(latest && latest.outcome === null);
    const operationType = latest?.operationType || "deploy";
    const observedAt = latest?.occurredAt
      || null;
    const observedMs = observedAt ? Date.parse(observedAt) : Number.NaN;
    const freshness = !observedAt
      ? "unavailable" as const
      : Number.isFinite(observedMs) && Date.now() - observedMs <= 10 * 60 * 1_000
        ? "current" as const
        : "stale" as const;
    const destroyed = projected.developerState === "destroyed";
    const destroyCleanupIncomplete = projected.destroyCleanupIncomplete === true;
    const runtimeDeleted = destroyed || destroyCleanupIncomplete;
    const authoritativeLiveRelease = Boolean(projected.stableRelease && projected.stableUrl) && !runtimeDeleted;
    const stoppedBeforeProvisioning = projected.developerState === "failed_application"
      && projected.applicationError?.category === "configuration"
      && !authoritativeLiveRelease;
    const liveReleaseObservedAt = projected.stableRelease?.promotedAt || observedAt;
    const infrastructureStatus = runtimeDeleted
      ? { exists: false, status: "destroyed" as const, source: "github_actions" as const }
      : authoritativeLiveRelease
        ? { exists: true, status: "active" as const, source: "github_actions" as const }
        : stoppedBeforeProvisioning
          ? { exists: false, status: "not_provisioned" as const, source: "unavailable" as const }
        : { exists: null, status: "unknown" as const, source: "unavailable" as const };
    const canonical = projected.developerState === "ready"
      ? "READY" as const
      : projected.developerState === "destroyed"
          ? "DESTROYED" as const
          : destroyCleanupIncomplete
            ? "BLOCKED" as const
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
        // The run id is intentionally the public operation identity; internal
        // queue detail never leaks to the UI.
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
        source: latest ? "github_actions" : "unavailable",
      },
    };
    const resourceStatus = authority.infrastructure.status === "active"
      ? "active" as const
      : authority.infrastructure.status === "destroyed"
        ? "destroyed" as const
        : "unavailable" as const;
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
          lastDestroyAt: runtimeDeleted ? observedAt : null,
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
        persistentStorage: null,
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
  ) {
    // Detailed infrastructure inspection is an explicit, privileged surface.
    // It may enrich the persisted projection with read-only AWS evidence.
    return this.getCurrentState(user, projectId, { refreshCloudState: true });
  }
}
