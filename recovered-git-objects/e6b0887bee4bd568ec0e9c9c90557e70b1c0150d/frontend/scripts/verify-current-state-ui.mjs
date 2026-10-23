import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const projects = readFileSync(new URL("../src/pages/Projects.jsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/pages/Dashboard.jsx", import.meta.url), "utf8");
const overview = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
const canonical = readFileSync(new URL("../src/components/projects/CanonicalDeploymentView.jsx", import.meta.url), "utf8");
const deploymentPresentation = readFileSync(new URL("../src/utils/developerDeploymentPresentation.js", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/pages/ProjectSettings.jsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/projectApi.js", import.meta.url), "utf8");

for (const source of [projects, dashboard, overview, pipeline]) {
  assert.match(source, /developerState/);
  assert.doesNotMatch(source, /releaseLane|safeCodes|lifecycleCode|terraformStateSafety|recoveryIssue|outboxStatus|fencingToken|leaseId/);
}
for (const source of [overview, pipeline]) {
  assert.match(source, /getProjectCurrentState/);
  assert.match(source, /CanonicalDeploymentView/);
  assert.doesNotMatch(source, /getNormalReleaseLaneStatus|approveTerraformApply|dispatchNormalFirstReleaseInfrastructureApply|retryPipelineRun|cancelPipelineRun|DeploymentRecoveryCard|NormalInfrastructurePlanningPanel|ReleaseLaneDeveloperDetails/);
}
for (const field of [/developerAction/, /latestAttempt/, /stableRelease/, /stableUrl/, /progress/, /estimatedCost/]) assert.match(`${canonical}\n${deploymentPresentation}`, field);
assert.match(api, /getProjectCurrentState/);
assert.match(api, /getProjectDetailedCurrentState/);
assert.match(api, /current-state\/details/);
assert.doesNotMatch(settings, /getProjectDetailedCurrentState|role === "admin"/);
assert.doesNotMatch(overview, /getProjectDetailedCurrentState/);
assert.doesNotMatch(pipeline, /getProjectDetailedCurrentState/);

console.log("Canonical sanitized current-state UI verification passed.");
