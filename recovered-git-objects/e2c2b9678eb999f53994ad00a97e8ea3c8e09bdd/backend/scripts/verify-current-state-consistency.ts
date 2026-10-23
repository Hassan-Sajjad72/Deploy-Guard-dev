import { strict as assert } from "node:assert";
import { isDestroyOperationRelevant, reconcileCloudState, CloudStateInput } from "../src/infrastructure-lifecycle/cloud-state-reconciliation.logic";
import { resolvePipelineActivity } from "../src/projects/pipeline/pipeline-activity.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { projectDeveloperCurrentState } from "../src/projects/current-state/project-developer-current-state";

const now = Date.parse("2026-07-21T12:00:00.000Z");
const staleRun = {
  id: "run-stale",
  projectId: "project-1",
  status: PipelineRunStatus.RUNNING,
  createdAt: new Date(now - 3_600_000),
  updatedAt: new Date(now - 3_600_000),
  startedAt: new Date(now - 3_600_000),
};

const noActiveJob = resolvePipelineActivity({
  projectId: "project-1",
  latestRun: staleRun as any,
  queueJobs: [],
  queueCheckAvailable: true,
  staleAfterMs: 900_000,
  nowMs: now,
});
assert.equal(noActiveJob.isDeploymentJobActive, false);
assert.equal(noActiveJob.activePipelineRunId, null);
assert.equal(noActiveJob.latestRunIsStale, true);

const freshRunWithoutBullJob = resolvePipelineActivity({
  projectId: "project-1",
  latestRun: { ...staleRun, updatedAt: new Date(now - 5_000) } as any,
  queueJobs: [],
  queueCheckAvailable: true,
  staleAfterMs: 900_000,
  nowMs: now,
});
assert.equal(freshRunWithoutBullJob.isDeploymentJobActive, true);
assert.equal(freshRunWithoutBullJob.activePipelineRunId, "run-stale");
assert.equal(freshRunWithoutBullJob.latestRunIsStale, false);
assert.equal(freshRunWithoutBullJob.source, "github_actions");
assert.equal(freshRunWithoutBullJob.authority, "database_operation");

const bullJob = resolvePipelineActivity({
  projectId: "project-1",
  latestRun: staleRun as any,
  queueJobs: [{ projectId: "project-1", pipelineRunId: "run-stale", state: "active" }],
  queueCheckAvailable: true,
  staleAfterMs: 900_000,
  nowMs: now,
});
assert.equal(bullJob.isDeploymentJobActive, false);
assert.equal(bullJob.activePipelineRunId, null);
assert.equal(bullJob.latestRunIsStale, true);

assert.equal(isDestroyOperationRelevant({
  destroyCreatedAt: "2026-07-21T05:46:39.773Z",
  environmentProvisionedAt: "2026-07-21T08:59:46.255Z",
}), false);
assert.equal(isDestroyOperationRelevant({
  destroyCreatedAt: "2026-07-21T09:10:00.000Z",
  environmentProvisionedAt: "2026-07-21T08:59:46.255Z",
}), true);

const base: CloudStateInput = {
  storedDeploymentStatus: "healthy",
  hasStoredDeploymentUrl: true,
  pipelineStatus: "running",
  pipelineProgress: 100,
  pipelineFailedStage: null,
  deploymentActivityActive: false,
  environmentStatus: "provisioned",
  environmentCleanupStatus: "not_started",
  destroyStatus: null,
  destroyCleanupStatus: null,
  inventoryStatus: "scanned",
  inventorySuccessful: true,
  activeResourceCount: 8,
  protectedResourceCount: 1,
  safeLeftoverCount: 0,
  manualReviewCount: 0,
  terraformResourceCount: 8,
  runtimeResourceCount: 0,
  highCostResourceCount: 1,
  ecsExists: false,
  ecsHealthy: null,
  targetGroupExists: false,
  targetHealthy: null,
  httpHealthy: null,
};

const staleInfrastructure = reconcileCloudState(base);
assert.equal(staleInfrastructure.deploymentStatus, "stale_live_record");
assert.equal(staleInfrastructure.infrastructureStatus, "provisioned");
assert.equal(staleInfrastructure.healthStatus, "unreachable");
assert.notEqual(staleInfrastructure.nextAction, "no_action");
assert.equal(staleInfrastructure.nextAction, "view_ecs_diagnostics");
assert.equal(staleInfrastructure.statusExplanation, "Infrastructure provisioned, but app live verification failed.");

const unreachableRuntime = reconcileCloudState({
  ...base,
  runtimeResourceCount: 3,
  ecsExists: true,
  ecsHealthy: false,
  targetGroupExists: true,
  targetHealthy: false,
  httpHealthy: false,
});
assert.equal(unreachableRuntime.deploymentStatus, "unhealthy");
assert.equal(unreachableRuntime.infrastructureStatus, "provisioned");
assert.equal(unreachableRuntime.healthStatus, "unreachable");
assert.equal(unreachableRuntime.nextAction, "view_ecs_diagnostics");
assert.notEqual(unreachableRuntime.deploymentStatus, "live");

const activeResourcesAreNotResidue = reconcileCloudState({
  ...base,
  safeLeftoverCount: 3,
  pipelineStatus: "failed",
  pipelineFailedStage: "terraform_apply_approval_queued",
});
assert.equal(activeResourcesAreNotResidue.resourceStatus, "active_resources");
assert.equal(activeResourcesAreNotResidue.cleanupStatus, "not_requested");
assert.notEqual(activeResourcesAreNotResidue.nextAction, "run_terraform_destroy");

const readyWithoutAttempt = projectDeveloperCurrentState({
  canManage: true,
  repositoryFullName: "Hassan-Sajjad72/react-pomodoro",
  branch: "master",
  setupRequired: false,
  progressPercentage: 13,
  deploymentContract: {
    deployable: true,
    commitSha: "0520689a8a4c4146c1dfdb1b4878e282f20558b0",
    buildCommand: "npm run build",
    missingEnvVars: [],
  },
  deploymentRequirements: { unresolvedInputKeys: [] },
  normalV1Availability: { mode: "github_actions", state: "authorized" },
  releaseLane: { state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_DISABLED"] },
  approvalState: { required: false, gate: null },
});
assert.equal(readyWithoutAttempt.developerState, "ready", "retired legacy lane state cannot block an authorized GitHub Actions project");
assert.equal(readyWithoutAttempt.developerAction, "deploy");
assert.equal(readyWithoutAttempt.latestAttempt, null);
assert.deepEqual(readyWithoutAttempt.progress, { percentage: 40, phase: "prepare", label: "Ready to Deploy" });
assert.match(readyWithoutAttempt.developerMessage, /No deployment has started yet/i);

const unresolvedConfiguration = projectDeveloperCurrentState({
  ...readyWithoutAttempt,
  canManage: true,
  repositoryFullName: "owner/application",
  branch: "main",
  setupRequired: true,
  deploymentContract: { deployable: false, buildCommand: "npm run build", missingEnvVars: ["API_URL"] },
  deploymentRequirements: { unresolvedInputKeys: ["API_URL"] },
  normalV1Availability: { mode: "github_actions", state: "authorized" },
  releaseLane: { state: "missing" },
});
assert.equal(unresolvedConfiguration.developerState, "configuration_required");
assert.equal(unresolvedConfiguration.developerAction, "provide_configuration");

console.log("Current-state consistency verification passed (GitHub Actions readiness, queue, stale run, infrastructure, health, cleanup).\n");
