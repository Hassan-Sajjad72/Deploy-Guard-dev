import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { deploymentPhasePresentation } from "../src/utils/developerDeploymentPresentation.js";

const projects = readFileSync(new URL("../src/pages/Projects.jsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/pages/Dashboard.jsx", import.meta.url), "utf8");
const overview = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
const infrastructure = readFileSync(new URL("../src/pages/ProjectInfrastructure.jsx", import.meta.url), "utf8");
const monitoring = readFileSync(new URL("../src/pages/ProjectMetrics.jsx", import.meta.url), "utf8");
const canonical = readFileSync(new URL("../src/components/projects/CanonicalDeploymentView.jsx", import.meta.url), "utf8");
const pipelineExecution = readFileSync(new URL("../src/components/projects/PipelineExecution.jsx", import.meta.url), "utf8");
const overviewLifecycle = readFileSync(new URL("../src/components/projects/ProjectOverviewLifecycle.jsx", import.meta.url), "utf8");
const overviewPresentation = readFileSync(new URL("../src/utils/overviewLifecyclePresentation.js", import.meta.url), "utf8");
const deploymentPresentation = readFileSync(new URL("../src/utils/developerDeploymentPresentation.js", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/pages/ProjectSettings.jsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/projectApi.js", import.meta.url), "utf8");
const sync = readFileSync(new URL("../src/utils/projectStateSync.js", import.meta.url), "utf8");
const detection = readFileSync(new URL("../src/pages/ProjectDetection.jsx", import.meta.url), "utf8");
const preflight = readFileSync(new URL("../src/pages/ProjectPreflight.jsx", import.meta.url), "utf8");
const troubleshooting = readFileSync(new URL("../src/pages/ProjectTroubleshooting.jsx", import.meta.url), "utf8");
const routes = readFileSync(new URL("../src/routes/AppRoutes.jsx", import.meta.url), "utf8");
const admin = readFileSync(new URL("../src/pages/AdminUsers.jsx", import.meta.url), "utf8");
const statePresentation = readFileSync(new URL("../src/utils/projectStatePresentation.js", import.meta.url), "utf8");
const frontendSource = [projects, dashboard, overview, pipeline, pipelineExecution, deploymentPresentation, settings, api, sync, detection, preflight, troubleshooting].join("\n");

for (const source of [dashboard, overview, pipeline]) {
  assert.match(source, /currentState/);
  assert.doesNotMatch(source, /releaseLane|safeCodes|lifecycleCode|terraformStateSafety|recoveryIssue|outboxStatus|fencingToken|leaseId/);
}
assert.match(projects, /projectStatePresentation\(currentState\)\.state/);
assert.doesNotMatch(projects, /releaseLane|safeCodes|lifecycleCode|terraformStateSafety|recoveryIssue|outboxStatus|fencingToken|leaseId/);
for (const source of [projects, dashboard, overview, pipeline, infrastructure, monitoring, admin]) assert.match(source, /projectStatePresentation/);
assert.match(statePresentation, /stateAuthority/);
assert.match(statePresentation, /activeOperation/);
assert.match(statePresentation, /TERMINAL_OPERATION_STATUSES/);
assert.match(statePresentation, /DESTROYED/);
for (const source of [infrastructure, monitoring]) {
  assert.match(source, /getProjectCurrentState/);
  assert.match(source, /projectStatePresentation/);
}
assert.match(overview, /getProjectCurrentState/);
assert.match(overview, /ProjectOverviewLifecycle/);
assert.doesNotMatch(overview, /CanonicalDeploymentView|getGithubActionsDeploymentHistory|getProjectDetailedCurrentState/);
assert.match(overviewLifecycle, /overviewLifecycleActions\(currentState, canManage\)/);
assert.doesNotMatch(overviewLifecycle, /getGithubActionsDeploymentHistory|developerAction/);
assert.match(pipeline, /getProjectCurrentState/);
assert.match(pipeline, /PipelineExecution/);
assert.doesNotMatch(pipeline, /CanonicalDeploymentView/);
assert.match(pipelineExecution, /currentState\.canRetry/);
assert.doesNotMatch(pipelineExecution, /Redeploy|destroyGithubActionsDeployment|deployGithubActionsDeployment/);
for (const source of [overview, pipeline]) {
  assert.doesNotMatch(source, /getNormalReleaseLaneStatus|approveTerraformApply|dispatchNormalFirstReleaseInfrastructureApply|retryPipelineRun|cancelPipelineRun|DeploymentRecoveryCard|NormalInfrastructurePlanningPanel|ReleaseLaneDeveloperDetails/);
}
for (const field of [/developerAction/, /latestAttempt/, /stableRelease/, /stableUrl/, /progress/, /estimatedCost/]) assert.match(`${canonical}\n${deploymentPresentation}`, field);
assert.match(api, /getProjectCurrentState/);
assert.match(api, /current-state[\s\S]*cache:\s*"no-store"/);
for (const source of [overview, pipeline]) assert.match(source, /subscribeProjectStateChanged/);
for (const source of [overview, pipeline]) assert.match(source, /stateAuthority\?\.activeOperation\?\.id/);
assert.match(dashboard, /!projectStatePresentation\(currentState\)\.active/);
assert.match(projects, /visibilitychange/);
for (const source of [detection, preflight]) assert.match(source, /publishProjectStateChanged/);
assert.match(sync, /visibilitychange/);
assert.match(api, /getProjectDetailedCurrentState/);
assert.match(api, /current-state\/details/);
assert.doesNotMatch(settings, /getProjectDetailedCurrentState|role === "admin"/);
assert.doesNotMatch(overview, /getProjectDetailedCurrentState/);
assert.doesNotMatch(pipeline, /getProjectDetailedCurrentState/);
assert.match(pipelineExecution, /retryGithubActionsDeployment\(projectId\)[\s\S]{0,180}await onRefresh\(\)/);
assert.match(troubleshooting, /failedStageLabel/);
assert.match(deploymentPresentation, /deploy_again/);
assert.match(routes, /path="\/projects\/:projectId\/pipeline"/);
assert.match(routes, /element=\{<ProjectPipeline \/>\} path="\/projects\/:projectId\/pipeline"/);
assert.match(routes, /element=\{<ProjectMetrics \/>\} path="\/projects\/:projectId\/monitoring"/);
assert.match(routes, /element=\{<AdminUsers \/>\} path="\/admin"/);
assert.match(admin, /getAdminProjects/);
assert.match(admin, /data-admin-project-state-source="current-state"/);
assert.match(routes, /path="\/projects\/:projectId\/troubleshooting"/);
assert.match(routes, /function LegacyProjectRedirect/);
assert.match(routes, /to=\{`\/projects\/\$\{projectId\}\$\{section\}`\}/);
assert.match(readFileSync(new URL("../src/components/layout/AppLayout.jsx", import.meta.url), "utf8"), /<Sidebar isOpen=\{navigationOpen\} onClose=\{\(\) => setNavigationOpen\(false\)\} projectId=\{selectedProjectId\} \/>/);
for (const route of ["logs/*", "requirements/*", "costs/*", "observability/*", "orchestration/*"]) {
  assert.match(routes, new RegExp(`path="\\/projects\\/:projectId\\/${route.replaceAll("*", "\\*")}"`));
}
assert.match(pipelineExecution, /GitHub Actions workflow stages/);
assert.doesNotMatch(frontendSource, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|paste[^\n]{0,40}(?:AWS|GitHub)|role ARN|workflow name/i);

const readyPhases = deploymentPhasePresentation({
  developerState: "ready",
  latestAttempt: null,
  progress: { percentage: 40, phase: "prepare", label: "Ready to Deploy" },
});
assert.deepEqual(readyPhases.map(({ key, status }) => [key, status]), [
  ["analyze", "passed"],
  ["prepare", "passed"],
  ["build", "waiting"],
  ["deploy", "waiting"],
  ["verify", "waiting"],
]);

const destroyedPhases = deploymentPhasePresentation({ developerState: "destroyed", progress: { percentage: 40, phase: "prepare" } });
assert.deepEqual(destroyedPhases.map(({ key, status }) => [key, status]), [
  ["prepare", "passed"],
  ["destroy", "passed"],
  ["verify", "passed"],
]);

console.log("Canonical sanitized current-state UI verification passed.");
