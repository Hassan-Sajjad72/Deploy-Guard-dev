import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractGithubActionsDestroyProgress } from "../src/projects/github-actions-destroy-evidence";

const root = resolve(__dirname, "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const lifecycle = readFileSync(resolve(root, "backend/src/projects/destroy-lifecycle.service.ts"), "utf8");
const entity = readFileSync(resolve(root, "backend/src/projects/project-destroy-lifecycle.entity.ts"), "utf8");
const migration = readFileSync(resolve(root, "backend/src/migrations/1760000071000-PersistentDestroyLifecycle.ts"), "utf8");
const deployment = readFileSync(resolve(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");

const destroyTerraform = workflow.match(/- name: Terraform state-only destroy[\s\S]*?- name: Run generation-scoped AWS scavenger/)?.[0] || "";
assert.ok(destroyTerraform, "Destroy has a separate state-only Terraform executor");
assert.doesNotMatch(destroyTerraform, /terraform import/, "Destroy never imports or adopts resources");
assert.match(destroyTerraform, /continue-on-error: true/);
assert.match(destroyTerraform, /if: always\(\) && inputs\.deployment_action == 'destroy'/);
assert.match(workflow, /name: Generate deployment Terraform[\s\S]*?continue-on-error: \$\{\{ inputs\.deployment_action == 'destroy' \}\}/);
assert.match(workflow, /name: Drain targeted generation runtime[\s\S]*?if: always\(\) && inputs\.deployment_action == 'destroy'/);
assert.match(workflow, /operation-contract\.valid/, "Destroy mutations require the validated immutable contract");
assert.match(destroyTerraform, /terraform plan -destroy/);
assert.match(destroyTerraform, /create" or \. == "update"/);
assert.match(destroyTerraform, /importAttempted:false/);

const scavenger = workflow.match(/- name: Run generation-scoped AWS scavenger[\s\S]*?- name: Verify ALB health/)?.[0] || "";
const verifier = workflow.match(/- name: Verify destroyed infrastructure and write result[\s\S]*?- name: Upload DeployGuard result/)?.[0] || "";
assert.match(scavenger, /if: always\(\) && inputs\.deployment_action == 'destroy'/);
assert.match(verifier, /if: always\(\) && inputs\.deployment_action == 'destroy'/);
assert.match(verifier, /aws_retry\(\)/);
assert.match(verifier, /DESTROY_INCOMPLETE/);
assert.match(verifier, /DEPLOYGUARD_DESTROY_PROGRESS/);
assert.match(verifier, /destroy-remaining\.json/);
assert.match(verifier, /project_state_versions_absent/);
assert.match(verifier, /DELETE_IN_PROGRESS/);
assert.match(workflow, /RESOURCE_NAME="dg-\$PROJECT_PREFIX-\$GENERATION_PREFIX"/, "mutable names are generation-qualified");

for (const field of ["lease_owner", "lease_expires_at", "heartbeat_at", "remaining", "resource_manifest", "retry_count", "next_retry_at", "escalation"]) {
  assert.match(migration, new RegExp(`"${field}"`), `${field} is durable`);
}
for (const phase of ["AWS_CLEANUP", "AWS_VERIFIED", "TERRAFORM_STATE_CLEANUP", "EXTERNAL_METADATA_CLEANUP", "DATABASE_EXTINCTION", "FINAL_404_VERIFY", "EXTINCT"]) {
  assert.match(entity, new RegExp(phase));
}
assert.match(lifecycle, /leaseExpiresAt > now/);
assert.match(lifecycle, /leaseExpiresAt: new Date\(now\.getTime\(\) \+ this\.leaseTtlMs\(\)\)/);
assert.match(lifecycle, /2 \*\* Math\.min/);
assert.match(lifecycle, /ProjectDestroyStatus\.DESTROYED/, "post-AWS extinction remains resumable after a crash");
assert.match(deployment, /remaining\.some\(\(item\) => item\.retryable === false/);
assert.match(deployment, /assertNoDestroyLifecycle/);
assert.match(deployment, /resumeDestroyLifecycle/);
assert.match(deployment, /recordIncomplete/);
assert.match(deployment, /recordAwsVerified/);
assert.match(deployment, /control_plane_extinction/);

const operationId = "99999999-8888-4777-8666-555555555555";
const marker = { deploymentOperationId: operationId, status: "DESTROY_INCOMPLETE", phase: "AWS_CLEANUP", remaining: [{ resourceType: "efs", resourceId: "fs-123", ownershipScope: "generation", reason: "DependencyViolation", errorCode: "DependencyViolation", errorMessage: "mount target deleting", retryable: true, attemptCount: 2, firstSeenAt: "2026-08-12T00:00:00Z", lastSeenAt: "2026-08-12T00:01:00Z" }], terraform: { status: "init_failed", exitCode: 1, importAttempted: false }, verifiedAt: "2026-08-12T00:01:00Z" };
assert.deepEqual(extractGithubActionsDestroyProgress(`DEPLOYGUARD_DESTROY_PROGRESS=${JSON.stringify(marker)}`), marker);
assert.equal(extractGithubActionsDestroyProgress(`DEPLOYGUARD_DESTROY_PROGRESS=${JSON.stringify({ ...marker, remaining: [] })}`), null, "an incomplete result must name residue");

console.log("Production Destroy lifecycle checks passed: lease, phases, no-import Terraform, always-running scavenger, persisted residue, bounded retry, generation isolation, and fail-closed evidence.");
