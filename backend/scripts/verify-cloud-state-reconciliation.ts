import { strict as assert } from "node:assert";
import { CloudStateInput, reconcileCloudState } from "../src/infrastructure-lifecycle/cloud-state-reconciliation.logic";

const base: CloudStateInput = {
  storedDeploymentStatus: "healthy", hasStoredDeploymentUrl: true, pipelineStatus: "completed", pipelineProgress: 100, pipelineFailedStage: null,
  environmentStatus: "provisioned", environmentCleanupStatus: "not_started", destroyStatus: null, destroyCleanupStatus: null,
  inventoryStatus: "scanned", inventorySuccessful: true, activeResourceCount: 0, protectedResourceCount: 0, safeLeftoverCount: 0,
  manualReviewCount: 0, terraformResourceCount: 0, runtimeResourceCount: 0, highCostResourceCount: 0,
  ecsExists: false, ecsHealthy: null, targetGroupExists: false, targetHealthy: null, httpHealthy: null,
};

const albMissing = reconcileCloudState(base);
assert.equal(albMissing.deploymentStatus, "stale_live_record");
assert.equal(albMissing.healthStatus, "unreachable");

const httpFailed = reconcileCloudState({ ...base, activeResourceCount: 2, runtimeResourceCount: 2, httpHealthy: false });
assert.equal(httpFailed.deploymentStatus, "unhealthy");
assert.equal(httpFailed.healthStatus, "unreachable");

const destroyed = reconcileCloudState({ ...base, environmentStatus: "destroyed", destroyStatus: "completed", destroyCleanupStatus: "completed" });
assert.equal(destroyed.deploymentStatus, "destroyed");
assert.equal(destroyed.resourceStatus, "no_cloud_resources_found");
assert.equal(destroyed.cleanupStatus, "cleanup_completed");

const destroyedWithResidue = reconcileCloudState({ ...base, environmentStatus: "destroy_needs_cleanup", destroyStatus: "completed", activeResourceCount: 2, safeLeftoverCount: 2 });
assert.ok(["destroyed", "stale_live_record"].includes(destroyedWithResidue.deploymentStatus));
assert.equal(destroyedWithResidue.resourceStatus, "cleanup_required");
assert.equal(destroyedWithResidue.nextAction, "clean_safe_leftovers");

const authRequired = reconcileCloudState({ ...base, inventoryStatus: "unavailable_auth_required", inventorySuccessful: false });
assert.equal(authRequired.cloudVerificationStatus, "auth_required");
assert.equal(authRequired.resourceStatus, "inventory_unavailable");

const liveWithResidue = reconcileCloudState({ ...base, activeResourceCount: 4, runtimeResourceCount: 3, safeLeftoverCount: 1, ecsExists: true, ecsHealthy: true });
assert.equal(liveWithResidue.deploymentStatus, "live");
assert.equal(liveWithResidue.resourceStatus, "active_resources");
assert.equal(liveWithResidue.cleanupStatus, "not_requested");

const residueAfterDestroy = reconcileCloudState({ ...base, environmentStatus: "destroy_needs_cleanup", destroyStatus: "completed", activeResourceCount: 1, safeLeftoverCount: 1 });
assert.equal(residueAfterDestroy.resourceStatus, "cleanup_required");
assert.equal(residueAfterDestroy.cleanupStatus, "cleanup_required");

const failedEcsAtHundred = reconcileCloudState({ ...base, storedDeploymentStatus: "failed", pipelineStatus: "failed", pipelineFailedStage: "ecs_deploy", pipelineProgress: 100 });
assert.equal(failedEcsAtHundred.deploymentStatus, "unhealthy");

const staleUrlNoResources = reconcileCloudState({ ...base, activeResourceCount: 0, runtimeResourceCount: 0 });
assert.notEqual(staleUrlNoResources.deploymentStatus, "live");

console.log("Cloud-state reconciliation verification passed (9 trust cases).\n");
