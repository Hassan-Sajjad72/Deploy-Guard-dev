import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const api = readFileSync(new URL("../src/api/projectApi.js", import.meta.url), "utf8");
const details = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/pages/Dashboard.jsx", import.meta.url), "utf8");
const billing = readFileSync(new URL("../src/pages/Billing.jsx", import.meta.url), "utf8");
const normalAction = readFileSync(new URL("../src/utils/normalReleaseAction.js", import.meta.url), "utf8");
const releaseView = readFileSync(new URL("../src/utils/normalReleaseView.js", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/pages/ProjectSettings.jsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/layout/Sidebar.jsx", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/routes/AppRoutes.jsx", import.meta.url), "utf8");

assert.match(api, /release-lane\/prepare/);
assert.match(api, /release-lane\/dispatch/);
assert.match(api, /release-lane\/infrastructure-plan\/dispatch/);
assert.match(api, /current-state\/details/);

for (const source of [details, pipeline]) {
  assert.match(source, /executeNormalReleaseAction/);
  assert.match(source, /getProjectCurrentState/);
  assert.match(source, /developerState/);
  assert.match(source, /developerAction/);
  assert.match(source, /stableRelease/);
  assert.match(source, /latestAttempt/);
  assert.doesNotMatch(source, /getNormalReleaseLaneStatus|releaseLane|safeCodes|lifecycleCode|startProjectAutomation|automation\/start|infrastructure\/deploy|orchestration\/deploy/);
  assert.doesNotMatch(source, /approveTerraformApply|dispatchNormalFirstReleaseInfrastructureApply|retryPipelineRun|cancelPipelineRun|approve-apply|DestroyInfrastructurePanel|requestDestroy|requestCloudCleanup/);
}

assert.match(normalAction, /prepareNormalReleaseLane/);
assert.match(normalAction, /dispatchNormalReleaseLane/);
assert.match(normalAction, /dispatchNormalFirstReleaseInfrastructurePlan/);
assert.doesNotMatch(normalAction, /dispatchNormalFirstReleaseInfrastructureApply|confirmApply|automation\/start|pipeline\/runs|approve-apply/);
assert.match(releaseView, /currentState\?\.latestAttempt/);
assert.match(releaseView, /currentState\?\.stableRelease/);
assert.doesNotMatch(releaseView, /releaseLane|safeCodes|lifecycleCode/);

assert.match(settings, /role === "admin" && show\("resource_cleanup"\)/);
for (const label of ["Overview", "Deployments", "Environment", "Logs", "Metrics", "Settings"]) {
  assert.match(sidebar, new RegExp(`label: "${label}"`));
}
assert.match(sidebar, /user\?\.role === "admin"[\s\S]+Operator modules/);
assert.match(routes, /RoleProtectedRoute roles=\{\["admin"\]\}[\s\S]+ProjectStateManagement[\s\S]+ProjectStorage/);
assert.match(dashboard, /response\.releaseSummary/);
assert.match(dashboard, /usage\?\.activeRuns/);
assert.doesNotMatch(dashboard, /getNormalReleaseLaneStatus|release-lane\/status|safeCodes|lifecycleCode/);
assert.match(billing, /getWorkspaceSummary/);
assert.doesNotMatch(billing, /getNormalReleaseLaneStatus|release-lane\/status|lifecycleCode/);

console.log("Sanitized normal release-lane UI contract verification passed");
