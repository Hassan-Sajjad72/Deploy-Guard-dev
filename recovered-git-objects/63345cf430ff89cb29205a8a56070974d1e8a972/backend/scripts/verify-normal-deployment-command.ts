import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decideAutomaticInfrastructurePolicy,
  isApprovedInfrastructurePolicy,
} from "../src/projects/normal-deployment-cost-policy";

const planHash = "a".repeat(64);
const safe = { create: 4, update: 1, replace: 0, delete: 0 };
const base = {
  planHash,
  resourceSummary: safe,
  costEstimate: { state: "real" as const, currency: "USD", monthlyCost: 24 },
  thresholdMonthlyCost: 25,
  maxResourceChanges: 100,
};

const automatic = decideAutomaticInfrastructurePolicy(base);
assert.equal(automatic.state, "auto_approved");
assert.equal(automatic.approvalRequired, false);
assert.equal(isApprovedInfrastructurePolicy(automatic), true);
assert.deepEqual(decideAutomaticInfrastructurePolicy(base), automatic, "policy must be deterministic");

const owner = decideAutomaticInfrastructurePolicy({
  ...base,
  costEstimate: { ...base.costEstimate, monthlyCost: 25.01 },
});
assert.equal(owner.state, "owner_required");
assert.equal(owner.approvalRequired, true);

for (const summary of [
  { ...safe, replace: 1 },
  { ...safe, delete: 1 },
  { create: 101, update: 0, replace: 0, delete: 0 },
]) {
  assert.equal(decideAutomaticInfrastructurePolicy({ ...base, resourceSummary: summary }).state, "operator_required");
}
for (const costEstimate of [
  { state: "deferred" as const, currency: null, monthlyCost: null },
  { state: "unavailable" as const, currency: null, monthlyCost: null },
  { state: "mismatch" as const, currency: null, monthlyCost: null },
]) {
  assert.equal(decideAutomaticInfrastructurePolicy({ ...base, costEstimate }).state, "platform_attention");
}
assert.equal(decideAutomaticInfrastructurePolicy({ ...base, planHash: null }).state, "platform_attention");
assert.equal(decideAutomaticInfrastructurePolicy({ ...base, resourceSummary: null }).state, "platform_attention");

const command = readFileSync(resolve(__dirname, "../src/projects/normal-deployment-command.service.ts"), "utf8");
const controller = readFileSync(resolve(__dirname, "../src/projects/projects.controller.ts"), "utf8");
const frontend = readFileSync(resolve(__dirname, "../../frontend/src/utils/normalReleaseAction.js"), "utf8");
assert.match(command, /TWO_LANE_NORMAL_AUTOMATIC_DEPLOY_ENABLED/);
assert.match(command, /dispatchApprovedContinuation/);
assert.match(command, /NormalFirstReleaseInfrastructurePlanExecutionService/);
assert.match(command, /NormalReleaseLaneExecutionService/);
assert.match(command, /pg_advisory_xact_lock/);
assert.doesNotMatch(command, /NestFactory|child_process|spawn\(|Worker\(|TerraformRunnerService|ECSClient|Docker/);
assert.match(controller, /@Post\(":projectId\/deploy"\)[\s\S]*?UserRole\.DEVELOPER/);
assert.match(controller, /@Post\(":projectId\/deploy\/approve-cost"\)/);
for (const route of ["release-lane/prepare", "release-lane/dispatch", "release-lane/infrastructure-plan/dispatch", "release-lane/infrastructure-apply/dispatch"]) {
  const escaped = route.replaceAll("/", "\\/");
  assert.match(controller, new RegExp(`@Post\\(\":projectId\\/${escaped}\"\\)[\\s\\S]{0,120}@UseGuards\\(requireRole\\(\\[UserRole\\.ADMIN\\]\\)\\)`));
}
assert.match(frontend, /deployNormalV1/);
assert.match(frontend, /approveNormalV1Cost/);
assert.doesNotMatch(frontend, /prepareNormalReleaseLane|dispatchNormalReleaseLane|dispatchNormalFirstReleaseInfrastructurePlan|dispatchNormalFirstReleaseInfrastructureApply/);

console.log("Normal-v1 automatic deployment command and cost-policy verification passed.");
