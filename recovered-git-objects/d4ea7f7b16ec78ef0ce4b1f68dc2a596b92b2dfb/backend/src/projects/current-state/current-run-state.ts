import { ProjectDeployment, ProjectDeploymentStatus } from "../../orchestration/project-deployment.entity";
import { ProjectPipelineRun } from "../project-pipeline-run.entity";
import { isPipelineFailed, isPipelinePaused, isPipelineTerminal } from "../pipeline/pipeline-status";
import { RecoveryIssue } from "../recovery/recovery-issue.types";
import { ResolvedPipelineStage } from "./project-current-state.types";

export type CurrentRunState = {
  id: string;
  status: "running" | "paused" | "failed" | "completed" | "inactive";
  rawStatus: string;
  currentStage: string | null;
  isActive: boolean;
  isPausedAtApplyGate: boolean;
  hasStartedTerraformApply: boolean;
  hasStartedEcsDeployment: boolean;
  hasReachedHealthVerification: boolean;
  primaryAction: Record<string, unknown> | null;
};

const attempted = (stage: ResolvedPipelineStage | undefined) =>
  Boolean(stage && ["running", "passed", "failed", "warning"].includes(stage.status));

export function deriveCurrentRunState(
  run: ProjectPipelineRun | null,
  stages: ResolvedPipelineStage[],
  isDeploymentJobActive: boolean,
  primaryAction: Record<string, unknown> | null = null,
): CurrentRunState | null {
  if (!run) return null;
  const stage = (name: string) => stages.find((item) => item.stage === name);
  const applyGate = stage("terraform_apply_gate");
  const failed = isPipelineFailed(run.status) || stages.some((item) => item.required && item.status === "failed");
  const isPausedAtApplyGate = !failed && (run.currentStage === "terraform_apply_approval_required" || applyGate?.status === "requires_approval");
  const status = failed
    ? "failed"
    : isPausedAtApplyGate || isPipelinePaused(run.status)
      ? "paused"
      : isDeploymentJobActive
        ? "running"
        : isPipelineTerminal(run.status)
          ? "completed"
          : "inactive";
  return {
    id: run.id,
    status,
    rawStatus: run.status,
    currentStage: run.currentStage || null,
    isActive: isDeploymentJobActive,
    isPausedAtApplyGate,
    hasStartedTerraformApply: attempted(stage("terraform_apply")),
    hasStartedEcsDeployment: attempted(stage("ecs_deploy")),
    hasReachedHealthVerification: attempted(stage("alb_health")),
    primaryAction,
  };
}

export function selectCurrentRecoveryIssue(
  issue: RecoveryIssue | null,
  currentRun: CurrentRunState | null,
  currentRunDeployment: ProjectDeployment | null,
): RecoveryIssue | null {
  if (!issue || !currentRun) return issue;
  if (currentRun.isPausedAtApplyGate) return null;
  const currentDeploymentFailed = Boolean(
    currentRunDeployment &&
    currentRunDeployment.pipelineRunId === currentRun.id &&
    [ProjectDeploymentStatus.FAILED, ProjectDeploymentStatus.UNHEALTHY, ProjectDeploymentStatus.ROLLBACK_FAILED].includes(currentRunDeployment.status as ProjectDeploymentStatus)
  );
  return currentRun.status === "failed" || currentDeploymentFailed ? issue : null;
}

export function previousDeploymentIssue(
  currentRun: CurrentRunState | null,
  latestDeployment: ProjectDeployment | null,
  healthStatus: string,
) {
  if (!currentRun || !latestDeployment || latestDeployment.pipelineRunId === currentRun.id) return null;
  const unhealthy = [ProjectDeploymentStatus.FAILED, ProjectDeploymentStatus.UNHEALTHY, ProjectDeploymentStatus.ROLLBACK_FAILED].includes(latestDeployment.status as ProjectDeploymentStatus) || healthStatus === "unreachable";
  if (!unhealthy) return null;
  return {
    historical: true,
    type: "health",
    title: "Previous deployment health failed",
    message: "Previous deployment health failed. It will be re-evaluated after this deployment.",
    deploymentId: latestDeployment.id,
    pipelineRunId: latestDeployment.pipelineRunId || null,
    healthPath: latestDeployment.healthCheckPath || null,
    occurredAt: latestDeployment.failedAt || latestDeployment.updatedAt || latestDeployment.createdAt,
  };
}
