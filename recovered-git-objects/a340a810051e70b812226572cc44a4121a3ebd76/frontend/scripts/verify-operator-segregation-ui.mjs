import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";

const routes = readFileSync(new URL("../src/routes/AppRoutes.jsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("../src/components/layout/Sidebar.jsx", import.meta.url), "utf8");
const projectApi = readFileSync(new URL("../src/api/projectApi.js", import.meta.url), "utf8");

const developerBlock = routes.slice(
  routes.indexOf("<Route element={<ProtectedRoute />}>"),
  routes.indexOf('<Route element={<RoleProtectedRoute roles={["admin", "developer"]} />}>'),
);
const deploymentBlock = routes.slice(
  routes.indexOf('<Route element={<RoleProtectedRoute roles={["admin", "developer"]} />}>'),
  routes.indexOf('<Route element={<RoleProtectedRoute roles={["admin"]} />}>'),
);
const adminBlock = routes.slice(routes.indexOf('<Route element={<RoleProtectedRoute roles={["admin"]} />}>'));

assert.match(developerBlock, /ProjectDetails/);
assert.match(developerBlock, /ProjectPipeline/);
assert.match(developerBlock, /ProjectInfrastructure/);
assert.match(developerBlock, /ProjectMetrics/);
assert.doesNotMatch(developerBlock, /AdminUsers|AuditLogs/);
assert.match(deploymentBlock, /NewProject[\s\S]*path="\/deploy"/);
assert.doesNotMatch(deploymentBlock, /ProjectTroubleshooting|ProjectSettings|ProjectDetection/);
assert.match(adminBlock, /AdminUsers/);
assert.match(adminBlock, /path="\/admin"/);
assert.match(adminBlock, /Navigate replace to="\/admin".*path="\/activity"/);
assert.match(adminBlock, /Navigate replace to="\/admin".*path="\/audit-logs"/);

assert.match(sidebar, /user\?\.role === "admin"[\s\S]*to="\/admin"[\s\S]*Admin/);
assert.doesNotMatch(sidebar.match(/const projectNavigation = \[[\s\S]*?\];/)?.[0] || "", /Environment|Settings|Detection|Pre-flight/);

for (const retired of [
  "getRecoveryResumePreview", "resumeProjectRecovery", "prepareNormalReleaseLane",
  "dispatchNormalReleaseLane", "dispatchNormalFirstReleaseInfrastructurePlan",
  "dispatchNormalFirstReleaseInfrastructureApply", "getNormalReleaseLaneStatus",
  "approveTerraformApply", "deployApprovalErrorMessage", "startPipelineRun",
  "cancelPipelineRun", "retryPipelineRun",
]) assert.doesNotMatch(projectApi, new RegExp(`export (?:async )?function ${retired}\\b`));

assert.equal(existsSync(new URL("../src/routes/DeveloperModeOnly.jsx", import.meta.url)), false);
console.log("Canonical normal-user, deployment, and admin routing verification passed.");
