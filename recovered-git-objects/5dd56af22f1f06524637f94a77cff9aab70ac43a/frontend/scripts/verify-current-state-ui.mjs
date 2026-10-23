import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const projects = readFileSync(new URL("../src/pages/Projects.jsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/pages/Dashboard.jsx", import.meta.url), "utf8");
const overview = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/pages/ProjectSettings.jsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/projectApi.js", import.meta.url), "utf8");

for (const source of [projects, dashboard, overview, pipeline]) {
  assert.match(source, /developerState/);
  assert.doesNotMatch(source, /releaseLane|safeCodes|lifecycleCode|terraformStateSafety|recoveryIssue|outboxStatus|fencingToken|leaseId/);
}
for (const source of [overview, pipeline]) {
  assert.match(source, /getProjectCurrentState/);
  assert.match(source, /developerAction/);
  assert.match(source, /latestAttempt/);
  assert.match(source, /stableRelease/);
  assert.match(source, /stableUrl/);
  assert.match(source, /progress/);
  assert.doesNotMatch(source, /getNormalReleaseLaneStatus|approveTerraformApply|dispatchNormalFirstReleaseInfrastructureApply|retryPipelineRun|cancelPipelineRun|DeploymentRecoveryCard|NormalInfrastructurePlanningPanel|ReleaseLaneDeveloperDetails/);
}
assert.match(api, /getProjectCurrentState/);
assert.match(api, /getProjectDetailedCurrentState/);
assert.match(api, /current-state\/details/);
assert.match(settings, /getProjectDetailedCurrentState/);
assert.match(settings, /role === "admin"/);
assert.doesNotMatch(overview, /getProjectDetailedCurrentState/);
assert.doesNotMatch(pipeline, /getProjectDetailedCurrentState/);

console.log("Canonical sanitized current-state UI verification passed.");
