import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { deploymentPhasePresentation } from "../src/utils/developerDeploymentPresentation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const projects = read("../src/pages/Projects.jsx");
const dashboard = read("../src/pages/Dashboard.jsx");
const overview = read("../src/pages/ProjectDetails.jsx");
const pipeline = read("../src/pages/ProjectPipeline.jsx");
const infrastructure = read("../src/pages/ProjectInfrastructure.jsx");
const monitoring = read("../src/pages/ProjectMetrics.jsx");
const settings = read("../src/pages/ProjectSettings.jsx");
const troubleshooting = read("../src/pages/ProjectTroubleshooting.jsx");
const execution = read("../src/components/projects/PipelineExecution.jsx");
const lifecycle = read("../src/components/projects/ProjectOverviewLifecycle.jsx");
const routes = read("../src/routes/AppRoutes.jsx");
const api = read("../src/api/projectApi.js");
const statePresentation = read("../src/utils/projectStatePresentation.js");

for (const source of [projects, dashboard, overview, pipeline, infrastructure, monitoring]) {
  assert.match(source, /projectStatePresentation/);
  assert.doesNotMatch(source, /releaseLane|safeCodes|lifecycleCode|terraformStateSafety|recoveryIssue|outboxStatus|fencingToken|leaseId/);
}
assert.match(statePresentation, /stateAuthority/);
assert.match(statePresentation, /activeOperation/);
assert.match(statePresentation, /TERMINAL_OPERATION_STATUSES/);
assert.match(overview, /getProjectCurrentState/);
assert.match(overview, /ProjectOverviewLifecycle/);
assert.match(pipeline, /getProjectCurrentState/);
assert.match(pipeline, /PipelineExecution/);
assert.match(lifecycle, /overviewLifecycleActions\(currentState, canManage\)/);
assert.match(execution, /currentState\.canRetry/);
assert.match(troubleshooting, /failedStageLabel/);
assert.match(api, /current-state[\s\S]*cache:\s*"no-store"/);
assert.match(api, /detailedCurrentStateRequests/);
assert.doesNotMatch(settings, /getProjectDetailedCurrentState|role === "admin"/);
assert.doesNotMatch(overview, /getProjectDetailedCurrentState|Source:|reconciliation\.freshness/);
assert.doesNotMatch(pipeline, /getProjectDetailedCurrentState/);
for (const path of ["pipeline", "infrastructure", "monitoring", "settings", "troubleshooting"]) {
  assert.match(routes, new RegExp(`path="/projects/:projectId/${path}"`));
}
for (const source of [overview, pipeline]) assert.match(source, /subscribeProjectStateChanged/);
assert.match(execution, /retryGithubActionsDeployment\(projectId\)[\s\S]{0,240}await onRefresh\(\)/);

const active = deploymentPhasePresentation({ developerState: "deploying", progress: { phase: "deploy" } });
assert.equal(active.filter(({ status }) => status === "running").length, 1);
const terminal = deploymentPhasePresentation({ developerState: "live", latestAttempt: { outcome: "completed" } });
assert.equal(terminal.some(({ status }) => status === "running"), false, "terminal operations never retain an active stage");
const destroyed = deploymentPhasePresentation({ developerState: "destroyed", deploymentAction: "destroy", latestAttempt: { outcome: "completed" } });
assert.deepEqual(destroyed.map(({ status }) => status), ["passed", "passed", "passed", "passed"]);

console.log("Canonical cross-page current-state and terminal lifecycle presentation verification passed.");
