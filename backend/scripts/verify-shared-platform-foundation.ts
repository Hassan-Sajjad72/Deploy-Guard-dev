import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateSharedEcsCluster } from "../src/projects/shared-platform-foundation.service";

const arn = "arn:aws:ecs:us-east-1:563149050793:cluster/dg-shared-platform";
const foundation = { ecsClusterArn: arn, ecsClusterName: "dg-shared-platform" };
const active = {
  clusterArn: arn,
  clusterName: "dg-shared-platform",
  status: "ACTIVE",
  tags: [
    { key: "ManagedBy", value: "DeployGuard" },
    { key: "DeployGuardScope", value: "shared-platform" },
  ],
};

assert.equal(validateSharedEcsCluster(foundation, [active]), active);
assert.throws(() => validateSharedEcsCluster(foundation, [{ ...active, status: "INACTIVE" }]), /inactive/);
assert.throws(() => validateSharedEcsCluster(foundation, []), /does not exist/);
assert.throws(() => validateSharedEcsCluster(foundation, [{ ...active, clusterArn: `${arn}-other` }]), /does not exist/);
assert.throws(() => validateSharedEcsCluster(foundation, [{ ...active, tags: [{ key: "ManagedBy", value: "Other" }] }]), /not verified/);

const root = resolve(__dirname, "../..");
const deployment = readFileSync(resolve(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
const workflow = readFileSync(resolve(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const cleanup = readFileSync(resolve(root, "backend/src/projects/generation-cleanup-policy.ts"), "utf8");

assert.match(deployment, /async deploy[\s\S]{0,400}sharedPlatformFoundation\.assertActive/);
assert.match(deployment, /action !== "destroy"[\s\S]{0,120}sharedPlatformFoundation\.assertActive/);
assert.match(deployment, /async rollback[\s\S]{0,400}sharedPlatformFoundation\.assertActive/);
assert.match(workflow, /platformFoundation\.ecsClusterArn/);
assert.doesNotMatch(workflow, /resource "aws_ecs_cluster"/);
assert.match(cleanup, /"ecsClusterArn"/);

console.log("Shared platform foundation checks passed: exact ACTIVE identity is admitted early, inactive/missing/unowned clusters fail closed, and project cleanup cannot own the shared cluster.");
