import "reflect-metadata";
import { strict as assert } from "node:assert";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { DetectionStatus } from "../src/projects/project-detection-profile.entity";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { PreflightValidationStatus } from "../src/projects/project-preflight-report.entity";

const project: any = { id: "project-1", repositoryFullName: "owner/application", targetBranch: "main" };
const profile: any = { commitSha: "a".repeat(40), detectionStatus: DetectionStatus.SUCCESS };
const preflight: any = { validationStatus: PreflightValidationStatus.PASSED };
const liveGenerationId = "11111111-1111-4111-8111-111111111111";
const candidateGenerationId = "22222222-2222-4222-822222222222";

function operation(status: PipelineRunStatus, currentStage: string, metadata: Record<string, unknown>, generationId = candidateGenerationId): any {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    projectId: project.id,
    generationId,
    status,
    currentStage,
    githubWorkflowRunId: "123456789",
    metadata: { executionEngine: "github_actions", attempt: 3, deploymentAction: "rollback", ...metadata },
    repositoryFullName: project.repositoryFullName,
    targetBranch: project.targetBranch,
    commitSha: "b".repeat(40),
    createdAt: new Date("2026-08-26T21:19:15.866Z"),
    updatedAt: new Date("2026-08-26T21:21:06.000Z"),
    completedAt: status === PipelineRunStatus.COMPLETED ? new Date("2026-08-26T21:22:23.902Z") : null,
    failedAt: null,
    errorMessage: null,
  };
}

function serviceWith(latest: any, stable: any, routedLiveGenerationId: string) {
  const service: any = Object.create(ProjectCurrentStateService.prototype);
  const builder = (): any => ({
    where() { return this; },
    andWhere() { return this; },
    clone() { return builder(); },
    orderBy() { return this; },
    async getOne() { return this.stable ? stable : latest; },
  });
  // A clone becomes the stable-release query after its first additional filter.
  const queryBuilder = (): any => {
    const query = builder();
    const originalAndWhere = query.andWhere;
    let additionalFilters = 0;
    query.andWhere = function andWhere() {
      additionalFilters += 1;
      if (additionalFilters >= 3) this.stable = true;
      return originalAndWhere.call(this);
    };
    query.clone = () => queryBuilder();
    return query;
  };
  service.runRepository = { createQueryBuilder: queryBuilder, findOne: async () => null };
  service.config = { get: (_key: string, fallback?: string) => fallback };
  return { service, routedLiveGenerationId };
}

async function projectState(latest: any, stable: any, routedLiveGenerationId: string) {
  const { service } = serviceWith(latest, stable, routedLiveGenerationId);
  const base = service.githubActionsReadinessState(project, profile, preflight);
  return service.withGithubActionsState(project.id, "dev", base, routedLiveGenerationId);
}

async function main() {
  const previousLive = operation(PipelineRunStatus.COMPLETED, "healthy", {
    deploymentAction: "deploy",
    deployedUrl: "https://app.example.test",
  }, liveGenerationId);
  const candidateEvidence = [{ key: "terraform_plan_and_apply", status: "passed" }];
  const deploy = await projectState(operation(PipelineRunStatus.RUNNING, "terraform_plan_and_apply", {
    workflowPhase: "candidate",
    workflowStages: candidateEvidence,
  }), previousLive, liveGenerationId);
  const promotionDispatch = await projectState(operation(PipelineRunStatus.QUEUED, "promotion_dispatch", {
    workflowPhase: "promotion",
    workflowStages: candidateEvidence,
  }), previousLive, liveGenerationId);
  const promotionWorkflow = await projectState(operation(PipelineRunStatus.RUNNING, "github_actions", {
    workflowPhase: "promotion",
    workflowStages: candidateEvidence,
  }), previousLive, liveGenerationId);
  const compensationDispatch = await projectState(operation(PipelineRunStatus.QUEUED, "promotion_compensation_dispatch", {
    workflowPhase: "compensation",
    workflowStages: candidateEvidence,
  }), previousLive, liveGenerationId);
  const compensationWorkflow = await projectState(operation(PipelineRunStatus.RUNNING, "github_actions", {
    workflowPhase: "compensation",
    workflowStages: candidateEvidence,
  }), previousLive, liveGenerationId);
  const compensated = await projectState(operation(PipelineRunStatus.FAILED, "promotion_compensated", {
    workflowPhase: "compensation",
    workflowStages: candidateEvidence,
    failedStage: "promotion_compensated",
  }), previousLive, liveGenerationId);
  const completedRollback = operation(PipelineRunStatus.COMPLETED, "healthy", {
    deployedUrl: "https://app.example.test",
    workflowPhase: "promotion",
    workflowStages: [...candidateEvidence, { key: "verify_alb_health_and_write_result", status: "passed" }],
  });
  const live = await projectState(completedRollback, completedRollback, candidateGenerationId);

  assert.deepEqual(
    [deploy.progress.phase, promotionDispatch.progress.phase, promotionWorkflow.progress.phase, compensationDispatch.progress.phase, compensationWorkflow.progress.phase, live.progress.phase],
    ["deploy", "deploy", "deploy", "deploy", "deploy", "verify"],
    "one rollback operation must not regress Deploy to Prepare during promotion or compensation before reaching LIVE",
  );
  assert.deepEqual(
    [deploy.latestAttempt.operationId, promotionDispatch.latestAttempt.operationId, promotionWorkflow.latestAttempt.operationId, compensationDispatch.latestAttempt.operationId, compensationWorkflow.latestAttempt.operationId, compensated.latestAttempt.operationId, live.latestAttempt.operationId],
    Array(7).fill(completedRollback.id),
    "the lifecycle projection must remain tied to the same rollback operation",
  );
  assert.deepEqual(
    [deploy.developerState, promotionDispatch.developerState, promotionWorkflow.developerState, live.developerState],
    ["live", "live", "live", "live"],
    "the verified prior release remains live throughout rollback promotion",
  );
  assert.deepEqual(
    [compensated.developerState, compensated.progress.phase, compensated.latestAttempt.status, compensated.latestAttempt.outcome],
    ["live", "deploy", "failed_application", "blocked"],
    "terminal rollback compensation retains the reached Deploy phase while preserving the verified live release",
  );

  const projection: any = Object.create(ProjectCurrentStateService.prototype);
  const persistedTerraformStage = [{ key: "terraform_plan_and_apply", status: "passed" }];
  assert.deepEqual(
    [
      projection.githubLifecyclePhase("github_actions", { deploymentAction: "deploy", workflowPhase: "candidate", workflowStages: persistedTerraformStage }),
      projection.githubLifecyclePhase("promotion_dispatch", { deploymentAction: "deploy", workflowPhase: "promotion", workflowStages: persistedTerraformStage, previousStableOperationId: previousLive.id }),
      projection.githubLifecyclePhase("github_actions", { deploymentAction: "destroy", workflowStages: persistedTerraformStage }),
    ],
    ["prepare", "prepare", "prepare"],
    "normal deploy, redeploy, and destroy retain their original direct stage projection without rollback high-water merging",
  );

  console.log("Rollback lifecycle projection monotonicity regression checks passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
