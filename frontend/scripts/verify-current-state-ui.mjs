import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { deploymentPhasePresentation, deploymentProgressPercentage, failureTroubleshootingProjection } from "../src/utils/developerDeploymentPresentation.js";
import { PROJECT_DELETION_NOTICE, redirectDeletedProject } from "../src/utils/projectStateSync.js";

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

const deletionNavigation = [];
assert.equal(redirectDeletedProject({ status: 404 }, (...args) => deletionNavigation.push(args)), true);
assert.deepEqual(deletionNavigation, [["/projects", { replace: true, state: { notice: PROJECT_DELETION_NOTICE } }]]);
assert.equal(PROJECT_DELETION_NOTICE, "Project deletion completed.");
assert.equal(redirectDeletedProject({ status: 500 }, (...args) => deletionNavigation.push(args)), false);
assert.equal(deletionNavigation.length, 1, "non-404 failures preserve normal page error handling");

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
for (const source of [overview, pipeline, infrastructure, monitoring, settings, troubleshooting]) {
  assert.match(source, /redirectDeletedProject\(caught, navigate\)/);
}
assert.match(projects, /location\.state\?\.notice/);
assert.match(execution, /retryGithubActionsDeployment\(projectId\)[\s\S]{0,240}await onRefresh\(\)/);

const active = deploymentPhasePresentation({ developerState: "deploying", progress: { phase: "deploy" } });
assert.equal(active.filter(({ status }) => status === "running").length, 1);
assert.deepEqual(active.map(({ status }) => status), ["passed", "passed", "passed", "running", "waiting", "waiting"], "active deployment phases are strictly sequential");
assert.equal(deploymentProgressPercentage(active), 60, "the progress bar is derived from the same active stage as the rail");
const outOfOrderEvidence = deploymentPhasePresentation({
  developerState: "building",
  progress: { phase: "build" },
  latestAttempt: { workflowStages: [{ key: "publish_immutable_images_to_ecr", status: "passed" }] },
});
assert.deepEqual(outOfOrderEvidence.map(({ status }) => status), ["passed", "passed", "running", "waiting", "waiting", "waiting"], "later evidence advances one ordered stage without leaving an earlier phase pending");
assert.equal(outOfOrderEvidence.filter(({ status }) => status === "running").length, 1, "only one lifecycle stage is active");
assert.equal(deploymentProgressPercentage(outOfOrderEvidence), 40, "publish-stage rail and yellow progress share one projection");
const terminal = deploymentPhasePresentation({ developerState: "live", latestAttempt: { outcome: "completed" } });
assert.equal(terminal.some(({ status }) => status === "running"), false, "terminal operations never retain an active stage");
const destroyed = deploymentPhasePresentation({ developerState: "destroyed", deploymentAction: "destroy", latestAttempt: { outcome: "completed" } });
assert.deepEqual(destroyed.map(({ status }) => status), ["passed", "passed", "passed", "passed"]);

const history = [
  { id: "attempt-3", attempt: "3", status: "completed", aiAnalysisEligible: false, aiRuntimeAnalysisCandidate: true },
  { id: "attempt-2", attempt: "2", status: "failed", aiAnalysisEligible: true },
  { id: "attempt-1", attempt: "1", status: "dispatch_failed", aiAnalysisEligible: true },
];
const troubleshootingProjection = failureTroubleshootingProjection(history, [
  { id: "session-3", pipelineRunId: "attempt-3" },
  { id: "session-2", pipelineRunId: "attempt-2" },
  { id: "session-1", pipelineRunId: "attempt-1" },
]);
assert.deepEqual(troubleshootingProjection.candidates.map(({ id }) => id), ["attempt-2", "attempt-1"], "successful Attempt 3 is excluded from failure troubleshooting candidates");
assert.deepEqual(troubleshootingProjection.sessions.map(({ pipelineRunId }) => pipelineRunId), ["attempt-2", "attempt-1"], "troubleshooting history remains scoped to failed attempts and their evidence");
assert.match(troubleshooting, /failureTroubleshootingProjection/);

console.log("Canonical cross-page current-state and terminal lifecycle presentation verification passed.");
