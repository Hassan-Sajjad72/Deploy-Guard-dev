import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DescribeImagesCommand, DescribeRepositoriesCommand, ECRClient } from "@aws-sdk/client-ecr";
import { DescribeServicesCommand, DescribeTaskDefinitionCommand, ECSClient, ListTagsForResourceCommand as EcsListTagsForResourceCommand } from "@aws-sdk/client-ecs";
import { DescribeTagsCommand, DescribeTargetGroupsCommand, DescribeTargetHealthCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
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
import { RailpackDeploymentService } from "../railpack-deployment.service";
import { LiveRuntimeIdentityRecoveryService } from "./live-runtime-identity-recovery.service";

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

type RuntimeObservation = {
  observedAt: string;
  runtime: "present" | "absent" | "unknown";
  resources: { ecs: "present" | "absent" | "unknown"; alb: "present" | "absent" | "unknown"; cloudWatch: "present" | "absent" | "unknown" };
  evidence: LiveAwsEvidence | null;
};

@Injectable()
export class ProjectCurrentStateService {
  private runtimeObservationCache = new Map<string, { expiresAt: number; value: RuntimeObservation }>();
  private runtimeObservationInFlight = new Map<string, Promise<RuntimeObservation>>();

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
    private readonly deploymentReconciliation: RailpackDeploymentService,
    private readonly runtimeIdentityRecovery: LiveRuntimeIdentityRecoveryService,
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
  ) {}

  async getCurrentState(
    user: User,
    projectId: string,
    options: { refreshCloudState?: boolean; skipReconciliation?: boolean } = {},
  ): Promise<DeveloperProjectCurrentState> {
    // GitHub Actions release records are the deployment authority.  Railpack
    // interprets source only inside the build, never in this read model.
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    if (!options.skipReconciliation) await this.deploymentReconciliation.reconcileActive(user, projectId);
    const environmentName = canonicalEnvironmentName(project);
    const route = await this.dataSource.getRepository(ProjectEnvironmentRoute).findOne({ where: { projectId, environmentName } });
    const authoritativeGenerationId = route?.liveGenerationId || null;
    const authoritativeRelease = authoritativeGenerationId
      ? await this.releaseRepository.findOne({
        where: { projectId, environmentName, generationId: authoritativeGenerationId, status: StableReleaseStatus.STABLE },
      })
      : null;
    const projected = await this.withGithubActionsState(
      projectId,
      environmentName,
      this.githubActionsReadinessState(project),
      authoritativeGenerationId,
      authoritativeRelease,
    );
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
        monthly: estimate && [CostEstimateStatus.NO_APPROVAL_REQUIRED, CostEstimateStatus.APPROVAL_REQUIRED].includes(estimate.status) ? Number(estimate.totalMonthlyCost) : null,
        generationId: authoritativeGenerationId,
        releaseId: authoritativeRelease.id,
        operationId: authoritativeRelease.deployedByPipelineRunId || null,
        estimatedAt: estimate?.updatedAt?.toISOString() || null,
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
    // A failed Destroy is destructive: historical release records are not
    // sufficient evidence that the old runtime still exists. Reconcile one
    // bounded observation here so every page receives the same authority.
    const failedDestroy = projectedWithCost.latestAttempt?.operationType === "destroy"
      && projectedWithCost.latestAttempt?.outcome === "blocked";
    const activeDestroy = projectedWithCost.latestAttempt?.operationType === "destroy"
      && projectedWithCost.latestAttempt?.outcome === null;
    const runtimeObservation = hasAuthoritativeLiveRelease && route?.liveGenerationId
      && (options.refreshCloudState || failedDestroy || activeDestroy)
      ? await this.runtimeObservation(project, route.liveGenerationId, projectedWithCost.stableUrl!)
      : null;
    const awsEvidence = runtimeObservation?.evidence || null;
    const generations = await this.generationRepository.find({ where: { projectId, environmentName }, order: { ordinal: "ASC" } });
    return {
      ...this.withStateAuthority(projectId, environmentName, projectedWithCost, awsEvidence, runtimeObservation),
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
    authoritativeRelease: ProjectStableRelease | null = null,
  ): Promise<DeveloperProjectCurrentState> {
    const githubRuns = this.runRepository.createQueryBuilder("run")
      .where("run.projectId = :projectId", { projectId })
      .andWhere("run.metadata ->> 'executionEngine' = 'railpack'")
      // Maintenance is evidence about a retired generation, never the latest
      // developer operation or authoritative runtime state.
      .andWhere("COALESCE(run.metadata ->> 'internalMaintenance', 'false') != 'true'");
    const latest = await githubRuns.clone().orderBy("run.createdAt", "DESC").getOne();
    if (!latest) return projected;
    const stable = liveGenerationId && authoritativeRelease?.deployedByPipelineRunId ? await githubRuns.clone()
        .andWhere("run.id = :operationId", { operationId: authoritativeRelease.deployedByPipelineRunId })
        .andWhere("run.generationId = :generationId", { generationId: liveGenerationId })
        .andWhere("run.status = :completed", { completed: PipelineRunStatus.COMPLETED })
        .getOne() : null;

    const latestMetadata = (latest.metadata || {}) as Record<string, unknown>;
    const stableMetadata = (stable?.metadata || {}) as Record<string, unknown>;
    const attempt = String(latestMetadata.attempt || 1);
    const latestCommit = latest.commitSha || projected.commit;
    const stableReleaseMetadata = (authoritativeRelease?.metadata || {}) as Record<string, unknown>;
    const rollbackTarget = authoritativeRelease ? await this.releaseRepository.findOne({
      where: { projectId, environmentName, status: StableReleaseStatus.ROLLBACK_TARGET },
      order: { deployedAt: "DESC" },
    }) : null;
    const stableUrl = typeof stableReleaseMetadata.deployedUrl === "string"
      ? stableReleaseMetadata.deployedUrl
      : null;
    const stableRelease = stable && authoritativeRelease && stableUrl
      ? {
          id: authoritativeRelease.id,
          operationId: authoritativeRelease.deployedByPipelineRunId,
          revision: String(stableMetadata.attempt || 1),
          generationId: authoritativeRelease.generationId || null,
          commit: stable.commitSha || latestCommit || "unknown",
          promotedAt: authoritativeRelease.deployedAt.toISOString(),
          rollbackAvailable: Boolean(rollbackTarget),
          runtimeIdentity: typeof stableReleaseMetadata.runtimeIdentity === "object" && stableReleaseMetadata.runtimeIdentity ? stableReleaseMetadata.runtimeIdentity as Record<string, unknown> : null,
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
      startedAt: (latest.startedAt || latest.createdAt).toISOString(),
      completedAt: latest.completedAt ? latest.completedAt.toISOString() : latest.failedAt ? latest.failedAt.toISOString() : null,
      workflowStages: Array.isArray(latestMetadata.workflowStages) ? latestMetadata.workflowStages
        .filter((stage): stage is Record<string, unknown> => Boolean(stage) && typeof stage === "object")
        .map((stage) => ({ key: String(stage.key || ""), status: ["passed", "failed", "running", "skipped"].includes(String(stage.status)) ? String(stage.status) as "passed" | "failed" | "running" | "skipped" : "skipped" })) : [],
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
        progress: { percentage: 95, phase: "finalize", label: "Destroy cleanup needs attention" },
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
      // GitHub success alone is never enough. `release_complete` is written
      // only after validated evidence from the workflow's ECS/ALB/public curl
      // verification atomically established this generation, route, and
      // stable release.
      const healthVerified = latest.currentStage === "release_complete"
        && latest.generationId === liveGenerationId
        && latestMetadata.releaseEvidenceVerified === true
        && Boolean(stableRelease && stableUrl);
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
      const failureMessage = githubActionsFailureMessage(this.conciseFailureMessage(latest.errorMessage), failedStage, action);
      const failurePhase = githubActionsFailureLifecyclePhase(failedStage, action);
      const category = failurePhase === "source" ? "configuration"
        : failurePhase === "build" ? "build"
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
        ? this.destroyProgress(stage)
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
        progress: this.destroyProgress(stage),
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

  private destroyProgress(stage: string): DeveloperProjectCurrentState["progress"] {
    const key = String(stage || "").toLowerCase();
    if (key.includes("cleanup") || key.includes("finalization")) return { percentage: 95, phase: "finalize", label: "Finalizing cleanup" };
    if (key.includes("evidence") || key.includes("verify") || key === "publish_verified_release_result") return { percentage: 85, phase: "verify", label: "Verifying deletion" };
    if (key.includes("terraform") || key === "materialize_release_runtime") return { percentage: 60, phase: "deploy", label: "Destroying infrastructure" };
    return { percentage: 20, phase: "prepare", label: "Preparing Destroy" };
  }

  private githubLifecycleProgress(phase: "source" | "prepare" | "build" | "deploy" | "verify") {
    return { source: 0, prepare: 20, build: 40, deploy: 60, verify: 80 }[phase];
  }

  private conciseFailureMessage(errorMessage: unknown) {
    const lines = String(errorMessage || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const diagnosticIndex = lines.findIndex((line) => /buildkit|mkdir\s+\/tmp\/railpack|failed to create cache|unable to resolve|\berror\b/i.test(line));
    if (diagnosticIndex >= 0) return lines.slice(diagnosticIndex, diagnosticIndex + 2).join(" ").slice(0, 320);
    const railpackIndex = lines.findIndex((line) => /railpack/i.test(line));
    return (railpackIndex >= 0 ? lines[railpackIndex] : lines[0] || "GitHub Actions concluded failure.").slice(0, 320);
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
      if (value.includes("build") || value === "install_pinned_railpack" || value === "publish_immutable_image_to_ecr") return "build" as const;
      if (value.includes("terraform") || value === "materialize_release_runtime" || (recognizePromotion && value.startsWith("promotion_"))) return "deploy" as const;
      if (value.includes("health") || value.includes("verify") || value === "publish_verified_release_result") return "verify" as const;
      return "prepare" as const;
    };
    const rank = { prepare: 0, build: 1, deploy: 2, verify: 3 } as const;
    const workflowStages = Array.isArray(metadata.workflowStages) ? metadata.workflowStages : [];
    const confirmedWorkflowPhase = workflowStages.reduce<"prepare" | "build" | "deploy" | "verify">((highest, item) => {
      if (!item || typeof item !== "object") return highest;
      const stage = item as Record<string, unknown>;
      if (!["passed", "running"].includes(String(stage.status || "").toLowerCase())) return highest;
      const candidate = phaseForStage(stage.key, true);
      return rank[candidate] > rank[highest] ? candidate : highest;
    }, "prepare");
    if (metadata.deploymentAction !== "rollback") {
      const currentPhase = phaseForStage(currentStage);
      return rank[confirmedWorkflowPhase] > rank[currentPhase] ? confirmedWorkflowPhase : currentPhase;
    }
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
    runtimeObservation: RuntimeObservation | null = null,
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
    const failedDestroy = !isActive && operationType === "destroy" && latest?.outcome === "blocked";
    const activeDestroy = isActive && operationType === "destroy";
    const destroyed = projected.developerState === "destroyed";
    const destroyCleanupIncomplete = projected.destroyCleanupIncomplete === true;
    const runtimeRemovedByObservation = (failedDestroy || activeDestroy) && runtimeObservation?.runtime === "absent";
    const runtimeUnverifiedAfterDestroy = (failedDestroy || activeDestroy) && runtimeObservation?.runtime === "unknown";
    const runtimeDeleted = destroyed || destroyCleanupIncomplete || runtimeRemovedByObservation;
    const authoritativeLiveRelease = Boolean(projected.stableRelease && projected.stableUrl) && !runtimeDeleted && !runtimeUnverifiedAfterDestroy;
    const stoppedBeforeProvisioning = projected.developerState === "failed_application"
      && ["configuration", "build"].includes(String(projected.applicationError?.category || ""))
      && !authoritativeLiveRelease;
    const failedDuringProvisioning = projected.developerState === "failed_application"
      && ["runtime", "deployment"].includes(String(projected.applicationError?.category || ""))
      && !authoritativeLiveRelease;
    const liveReleaseObservedAt = projected.stableRelease?.promotedAt || observedAt;
    const infrastructureStatus = runtimeDeleted
      ? { exists: false, status: "destroyed" as const, source: runtimeRemovedByObservation ? "aws_observation" as const : "github_actions" as const }
      : runtimeUnverifiedAfterDestroy
        ? { exists: null, status: "unknown" as const, source: "aws_observation" as const }
      : authoritativeLiveRelease
        ? { exists: true, status: "active" as const, source: "github_actions" as const }
        : stoppedBeforeProvisioning
          ? { exists: false, status: "not_provisioned" as const, source: "unavailable" as const }
          : failedDuringProvisioning
            ? { exists: null, status: "provisioning_failed" as const, source: "github_actions" as const }
        : { exists: null, status: "unknown" as const, source: "unavailable" as const };
    const canonical = projected.developerState === "ready"
      ? "READY" as const
      : projected.developerState === "destroyed"
          ? "DESTROYED" as const
            : destroyCleanupIncomplete || runtimeUnverifiedAfterDestroy
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
    const runtimeIdentity = projected.stableRelease?.runtimeIdentity || null;
    const identityString = (key: string) => runtimeIdentity && typeof runtimeIdentity[key] === "string"
      ? runtimeIdentity[key] as string
      : "";
    // Configuration merely permits a CloudWatch read.  It is not evidence
    // that this release has a resolvable runtime provider.  The metrics/log
    // endpoint resolves that evidence from this same persisted identity.
    const monitoringIdentityComplete = Boolean(
      identityString("ecsClusterArn")
      && identityString("ecsServiceArn")
      && identityString("targetGroupArn")
      && identityString("cloudWatchLogGroupName")
      && identityString("applicationContainerName"),
    );
    const awsRuntimeMonitoringEnabled = getObservabilityConfig(this.config).awsRuntimeMonitoringEnabled;
    const destroyFailureMessage = runtimeRemovedByObservation
      ? "Destroy failed after the authoritative runtime was removed. Cleanup is required before this project can continue."
      : runtimeUnverifiedAfterDestroy
        ? "Destroy failed and the previous runtime is not currently verified. DeployGuard will not present historical release evidence as LIVE."
        : projected.developerMessage;
    const authority: ProjectStateAuthority = {
      state: canonical,
      reason: destroyFailureMessage,
      runtime: runtimeRemovedByObservation || destroyed || destroyCleanupIncomplete
        ? { state: "removed", observedAt: runtimeObservation?.observedAt || observedAt, source: runtimeObservation ? "aws_observation" : "github_actions" }
        : runtimeUnverifiedAfterDestroy
          ? { state: "unknown", observedAt: runtimeObservation?.observedAt || null, source: "aws_observation" }
          : authoritativeLiveRelease
            ? { state: "present", observedAt: runtimeObservation?.observedAt || liveReleaseObservedAt, source: runtimeObservation ? "aws_observation" : "verified_release" }
            : { state: "not_deployed", observedAt: null, source: "unavailable" },
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
      infrastructure: { ...infrastructureStatus, observedAt: runtimeObservation?.observedAt || (authoritativeLiveRelease ? awsEvidence?.observedAt || liveReleaseObservedAt : observedAt) },
      applicationHealth: authoritativeLiveRelease
        ? { status: "healthy", source: "github_actions_health_verification", observedAt: liveReleaseObservedAt }
        : runtimeUnverifiedAfterDestroy
          ? { status: "unavailable", source: "aws_observation", observedAt: runtimeObservation?.observedAt || null }
        : projected.developerState === "failed_application" && projected.applicationError?.category === "health"
          ? { status: "failed", source: "github_actions", observedAt }
          : isActive && !activeDestroy
            ? { status: "pending", source: "github_actions", observedAt }
            : { status: "unavailable", source: "unavailable", observedAt: null },
      monitoring: authoritativeLiveRelease
        ? !awsRuntimeMonitoringEnabled
          ? { available: false, status: "unavailable", reason: "AWS runtime monitoring is disabled." }
          : !monitoringIdentityComplete
            ? { available: false, status: "unavailable", reason: "The authoritative LIVE release does not yet contain a complete CloudWatch runtime identity." }
            : { available: true, status: "available", reason: "AWS runtime monitoring is bound to the authoritative LIVE generation." }
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
    const resourceStatusFor = (presence: "present" | "absent" | "unknown" | undefined) => presence === "present"
      ? "active" as const : presence === "absent" ? "destroyed" as const : "unavailable" as const;
    return {
      ...projected,
      ...(failedDestroy && (runtimeRemovedByObservation || runtimeUnverifiedAfterDestroy) ? {
        developerState: "platform_attention" as const,
        developerAction: "none" as const,
        developerMessage: destroyFailureMessage,
        stableRelease: null,
        stableUrl: null,
        estimatedCost: null,
        applicationError: { category: "runtime" as const, message: destroyFailureMessage },
        canRetry: projected.canRetry,
      } : activeDestroy && (runtimeRemovedByObservation || runtimeUnverifiedAfterDestroy) ? {
        developerState: "destroying" as const,
        developerAction: "none" as const,
        developerMessage: runtimeRemovedByObservation
          ? "Destroy is in progress and the authoritative runtime is now removed. DeployGuard is verifying deletion and finalizing cleanup."
          : "Destroy is in progress and the authoritative runtime is temporarily unverified.",
        stableRelease: null,
        stableUrl: null,
        estimatedCost: null,
        applicationError: null,
        canRetry: false,
      } : {}),
      stateAuthority: authority,
      infrastructureEvidence: {
        source: authority.infrastructure.source,
        lastUpdatedAt: awsEvidence?.observedAt || observedAt,
        freshness: awsEvidence ? "current" : freshness,
        region: typeof runtimeIdentity?.region === "string" ? runtimeIdentity.region : this.config.get<string>("AWS_REGION", "us-east-1"),
        executionEngine: "github_actions",
        resources: (["ECR", "ECS Fargate", "ALB"] as const).map((type) => ({
          type,
          status: type === "ECS Fargate" ? resourceStatusFor(runtimeObservation?.resources.ecs)
            : type === "ALB" ? resourceStatusFor(runtimeObservation?.resources.alb)
              : resourceStatus === "active" && !awsEvidence ? "unavailable" : resourceStatus,
        })),
        ecr: awsEvidence?.ecr || null,
        ecs: awsEvidence?.ecs || null,
        alb: awsEvidence?.alb || null,
        cloudWatch: { status: resourceStatusFor(runtimeObservation?.resources.cloudWatch) },
        terraformState: {
          status: runtimeRemovedByObservation ? "destroyed" : resourceStatus,
          storage: this.config.get<string>("DEPLOYGUARD_TERRAFORM_STATE_BUCKET") ? "encrypted_s3" : "unavailable",
          key: typeof runtimeIdentity?.terraformStateKey === "string" ? runtimeIdentity.terraformStateKey : null,
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
        runtimeIdentity: projected.stableRelease?.runtimeIdentity || null,
      },
    };
  }

  private async runtimeObservation(project: Project, generationId: string, stableUrl: string): Promise<RuntimeObservation> {
    this.runtimeObservationCache ||= new Map();
    this.runtimeObservationInFlight ||= new Map();
    const key = `${project.id}:${generationId}`;
    const cached = this.runtimeObservationCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const inFlight = this.runtimeObservationInFlight.get(key);
    if (inFlight) return inFlight;
    const task = this.readRuntimeObservation(project, generationId, stableUrl);
    this.runtimeObservationInFlight.set(key, task);
    try {
      const value = await task;
      this.runtimeObservationCache.set(key, { expiresAt: Date.now() + 15_000, value });
      return value;
    } finally {
      if (this.runtimeObservationInFlight.get(key) === task) this.runtimeObservationInFlight.delete(key);
    }
  }

  private async readRuntimeObservation(project: Project, generationId: string, stableUrl: string): Promise<RuntimeObservation> {
    const present = await this.liveAwsEvidence(project, generationId, stableUrl);
    if (present) return {
      observedAt: present.observedAt,
      runtime: "present",
      resources: { ecs: "present", alb: "present", cloudWatch: "present" },
      evidence: present,
    };
    const observedAt = new Date().toISOString();
    const environmentName = canonicalEnvironmentName(project);
    const [generation, release] = await Promise.all([
      this.generationRepository.findOne({ where: { id: generationId, projectId: project.id, environmentName } }),
      this.releaseRepository.findOne({ where: { projectId: project.id, environmentName, generationId, status: StableReleaseStatus.STABLE }, order: { deployedAt: "DESC" } }),
    ]);
    const identity = generation?.resourceManifest || {};
    const value = (key: string) => typeof identity[key] === "string" ? identity[key] as string : "";
    const region = value("region") || this.config.get<string>("AWS_REGION", "us-east-1");
    const cluster = value("ecsClusterArn") || value("ecsClusterName");
    const serviceArn = release?.ecsServiceArn || value("ecsServiceArn");
    const targetGroupArn = value("targetGroupArn");
    const logGroup = value("cloudWatchLogGroupName");
    const unavailable = { runtime: "unknown" as const, resources: { ecs: "unknown" as const, alb: "unknown" as const, cloudWatch: "unknown" as const }, evidence: null };
    if (!generation || !cluster || !serviceArn || !targetGroupArn) return { observedAt, ...unavailable };
    const absentError = (error: unknown) => /notfound|not found|does not exist|missing/i.test(`${(error as { name?: string })?.name || ""} ${error instanceof Error ? error.message : ""}`);
    const ecs = new ECSClient({ region });
    const elb = new ElasticLoadBalancingV2Client({ region });
    const logs = new CloudWatchLogsClient({ region });
    const [ecsResult, albResult, logsResult] = await Promise.all([
      ecs.send(new DescribeServicesCommand({ cluster, services: [serviceArn] })).then((result) => result.services?.[0] ? "present" as const : "absent" as const).catch((error) => absentError(error) ? "absent" as const : "unknown" as const),
      elb.send(new DescribeTargetGroupsCommand({ TargetGroupArns: [targetGroupArn] })).then((result) => result.TargetGroups?.[0] ? "present" as const : "absent" as const).catch((error) => absentError(error) ? "absent" as const : "unknown" as const),
      logGroup
        ? logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: logGroup })).then((result) => result.logGroups?.some((group) => group.logGroupName === logGroup) ? "present" as const : "absent" as const).catch((error) => absentError(error) ? "absent" as const : "unknown" as const)
        : Promise.resolve("unknown" as const),
    ]);
    ecs.destroy(); elb.destroy(); logs.destroy();
    const runtime = ecsResult === "absent" || albResult === "absent" ? "absent" as const : "unknown" as const;
    return { observedAt, runtime, resources: { ecs: ecsResult, alb: albResult, cloudWatch: logsResult }, evidence: null };
  }

  private async liveAwsEvidence(project: Project, generationId: string, stableUrl: string): Promise<LiveAwsEvidence | null> {
    const projectId = project.id;
    const environment = canonicalEnvironmentName(project);
    const generation = await this.generationRepository.findOne({ where: { id: generationId, projectId, environmentName: environment, status: DeploymentGenerationStatus.LIVE } });
    const release = await this.releaseRepository.findOne({
      where: { projectId, environmentName: environment, generationId, status: StableReleaseStatus.STABLE },
      order: { deployedAt: "DESC" },
    });
    const identity = generation?.resourceManifest || {};
    const string = (key: string) => typeof identity[key] === "string" ? identity[key] : "";
    const region = string("region") || this.config.get<string>("AWS_REGION", "us-east-1");
    const cluster = string("ecsClusterArn") || string("ecsClusterName");
    const targetGroupArn = string("targetGroupArn");
    const repository = string("imageUri").replace(/^\d+\.dkr\.ecr\.[^.]+\.amazonaws\.com\//, "").split("@")[0];
    if (!generation || !release?.imageUri || !release.taskDefinitionArn || !cluster || !targetGroupArn || !repository) return null;
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
      const imageDigest = string("imageDigest");
      if (!/^sha256:[0-9a-f]{64}$/.test(imageDigest) || repositoryEvidence.repositoryUri !== string("imageUri")) return null;
      const [taskDefinitionResult, imageResult, serviceTags, targetGroupTags, targetHealth] = await Promise.all([
        ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: release.taskDefinitionArn, include: ["TAGS"] })),
        ecr.send(new DescribeImagesCommand({ repositoryName: repository, imageIds: [{ imageDigest }] })),
        ecs.send(new EcsListTagsForResourceCommand({ resourceArn: service.serviceArn! })),
        elb.send(new DescribeTagsCommand({ ResourceArns: [targetGroupArn] })),
        elb.send(new DescribeTargetHealthCommand({ TargetGroupArn: targetGroupArn })),
      ]);
      const tags = (input: Array<{ Key?: string; Value?: string; key?: string; value?: string }> | undefined) =>
        Object.fromEntries((input || []).map((tag) => [tag.Key || tag.key || "", tag.Value || tag.value || ""]));
      const ownsProjectRuntime = (input: Array<{ Key?: string; Value?: string; key?: string; value?: string }> | undefined) => {
        const values = tags(input);
        return values.ManagedBy === "DeployGuard"
          && values.DeployGuardProjectId === projectId
          && values.DeployGuardOperationId === release.deployedByPipelineRunId;
      };
      if (!ownsProjectRuntime(serviceTags.tags) || !ownsProjectRuntime(taskDefinitionResult.tags) || !ownsProjectRuntime(targetGroupTags.TagDescriptions?.[0]?.Tags)) return null;
      const immutableImage = imageResult.imageDetails?.[0];
      if (!immutableImage || immutableImage.imageDigest !== imageDigest) return null;
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
          name: string("albName") || targetGroup.LoadBalancerArns?.[0] || "application-alb",
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
    // Detail is an enrichment of the canonical read model, never a second
    // reconciliation path that can change lifecycle or runtime authority.
    return this.getCurrentState(user, projectId, { refreshCloudState: true });
  }
}
