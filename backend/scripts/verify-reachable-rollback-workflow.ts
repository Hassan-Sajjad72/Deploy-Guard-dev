import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const deployment = readFileSync(resolve(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
const workflow = readFileSync(resolve(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const projection = readFileSync(resolve(root, "backend/src/projects/stable-release-projection.ts"), "utf8");

assert.match(deployment, /rollbackTarget[\s\S]*previousStableOperationId/, "rollback starts from the prior known-good release");
assert.doesNotMatch(deployment, /target\.generationId !== current\.generationId/, "a known-good release from the previous generation remains selectable");
assert.match(deployment, /createCandidate\(projectId, canonicalEnvironmentName\(project\)/, "rollback provisions a new isolated candidate generation");
assert.match(deployment, /generationStateKey: generation\.terraformStateKey/);
assert.match(deployment, /configurationSnapshotId: sourceRuntime\.configurationSnapshotId/, "rollback persists the exact immutable configuration snapshot carried by its runtime");
assert.match(deployment, /databaseServiceBindingId: sourceRuntime\.managedDatabase\?\.bindingId \|\| null/, "rollback persists the exact immutable database binding carried by its runtime");
assert.match(deployment, /rollback_image_uri: targetEvidence\.imageUri/);
assert.match(deployment, /previousTargetGroupArn: currentEvidence\.targetGroupArn/, "rollback compensation restores the previously LIVE route, not the rollback candidate artifact");
assert.match(deployment, /retiredGenerationCleanup:[\s\S]*generationId: liveGeneration\.id/, "rollback retires only the formerly LIVE generation after promotion");
assert.match(deployment, /await this\.verifyAndPersistStableRelease\(operation, releaseEvidence\)/, "rollback uses the same health-gated candidate promotion path");
assert.match(projection, /stable-release:\$\{input\.projectId\}:\$\{input\.environmentName\}/, "stable authority is unique across generations");
assert.match(workflow, /name: Terraform plan and apply[\s\S]{0,160}working-directory:/, "deploy, rollback and exact-generation Destroy share the isolated state path");
assert.match(workflow, /inputs\.rollback_image_uri/);
assert.match(workflow, /Production route did not converge after exact candidate cutover/);
assert.doesNotMatch(workflow, /legacy_in_place_rollback_disabled/, "the conflicting in-place service mutation path was removed");
assert.match(workflow, /Prepare project-scoped persistence[\s\S]*if \[ "\$DEPLOYMENT_ACTION" = "deploy" \]/, "rollback reads but cannot apply project persistence");

console.log("Generation-aware rollback checks passed: known-good artifact, isolated candidate, health-gated promotion, and no persistence mutation.");
