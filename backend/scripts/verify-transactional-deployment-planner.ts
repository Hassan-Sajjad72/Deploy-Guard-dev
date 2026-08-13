import { strict as assert } from "node:assert";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import {
  canonicalPlannerIdempotencyKey,
  changedCanonicalPaths,
  classifyDeployment,
  destructiveInfrastructurePaths,
  infrastructureCategories,
  plannerRequestFingerprint,
} from "../src/orchestration-contracts/planner/transactional-deployment-planner.pure";

const sha = "a".repeat(64);

assert.equal(
  canonicalPlannerIdempotencyKey(
    "11111111-1111-4111-8111-111111111111",
    "production",
    "user:1",
    "request-1",
  ),
  canonicalPlannerIdempotencyKey(
    "11111111-1111-4111-8111-111111111111",
    "production",
    "user:1",
    "request-1",
  ),
);
assert.notEqual(
  canonicalPlannerIdempotencyKey(
    "11111111-1111-4111-8111-111111111111",
    "production",
    "user:1",
    "request-1",
  ),
  canonicalPlannerIdempotencyKey(
    "11111111-1111-4111-8111-111111111111",
    "production",
    "user:1",
    "request-2",
  ),
);

assert.equal(classifyDeployment({
  blockers: [{ code: "STALE", message: "stale", source: "contract" }],
  hasAppliedInfrastructure: true,
  appliedInfrastructureSpecHash: sha,
  desiredInfrastructureSpecHash: sha,
  stableReleaseSpecHash: sha,
  desiredReleaseSpecHash: sha,
}), "unsafe_or_unknown");
assert.equal(classifyDeployment({
  blockers: [],
  hasAppliedInfrastructure: false,
  appliedInfrastructureSpecHash: null,
  desiredInfrastructureSpecHash: sha,
  stableReleaseSpecHash: null,
  desiredReleaseSpecHash: sha,
}), "infrastructure_change");
assert.equal(classifyDeployment({
  blockers: [],
  hasAppliedInfrastructure: true,
  appliedInfrastructureSpecHash: sha,
  desiredInfrastructureSpecHash: sha,
  stableReleaseSpecHash: "b".repeat(64),
  desiredReleaseSpecHash: sha,
}), "release_only");
assert.equal(classifyDeployment({
  blockers: [],
  hasAppliedInfrastructure: true,
  appliedInfrastructureSpecHash: sha,
  desiredInfrastructureSpecHash: sha,
  stableReleaseSpecHash: sha,
  desiredReleaseSpecHash: sha,
}), "no_op");

const previous = {
  network: { natMode: "single" },
  database: { mode: "managed" },
  storage: { efsRequired: true },
};
const desired = {
  network: { natMode: "none" },
  database: { mode: "none" },
  storage: { efsRequired: false },
};
const paths = changedCanonicalPaths(previous, desired);
assert.deepEqual(paths, [
  "database.mode",
  "network.natMode",
  "storage.efsRequired",
]);
assert.deepEqual(infrastructureCategories(paths), ["database", "network", "storage"]);
assert.deepEqual(
  destructiveInfrastructurePaths(previous, desired, paths),
  ["database.mode", "network.natMode", "storage.efsRequired"],
);
assert.equal(
  plannerRequestFingerprint({
    kind: "deploy",
    requestedCommitSha: "c".repeat(40),
    deploymentContractHash: sha,
    configurationFingerprint: sha,
    desiredInfrastructureSpecHash: sha,
    desiredReleaseSpecHash: sha,
    sourcePipelineRunId: null,
    recoveryCode: null,
  }),
  canonicalSha256({
    kind: "deploy",
    requestedCommitSha: "c".repeat(40),
    deploymentContractHash: sha,
    configurationFingerprint: sha,
    desiredInfrastructureSpecHash: sha,
    desiredReleaseSpecHash: sha,
    sourcePipelineRunId: null,
    recoveryCode: null,
  }),
);

console.log("Transactional deployment planner pure contract verification passed");
