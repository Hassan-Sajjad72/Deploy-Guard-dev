import { strict as assert } from "node:assert";
import { isDestroyOperationRelevant, reconcileCloudState, CloudStateInput } from "../src/infrastructure-lifecycle/cloud-state-reconciliation.logic";
import { resolvePipelineActivity } from "../src/projects/pipeline/pipeline-activity.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";

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
assert.equal(freshRunWithoutBullJob.isDeploymentJobActive, false);
assert.equal(freshRunWithoutBullJob.activePipelineRunId, null);
assert.equal(freshRunWithoutBullJob.latestRunIsStale, true);

const bullJob = resolvePipelineActivity({
  projectId: "project-1",
  latestRun: staleRun as any,
  queueJobs: [{ projectId: "project-1", pipelineRunId: "run-stale", state: "active" }],
  queueCheckAvailable: true,
  staleAfterMs: 900_000,
  nowMs: now,
});
assert.equal(bullJob.isDeploymentJobActive, true);
assert.equal(bullJob.activePipelineRunId, "run-stale");
assert.equal(bullJob.latestRunIsStale, false);

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

console.log("Current-state consistency verification passed (queue, stale run, infrastructure, health, cleanup).\n");
