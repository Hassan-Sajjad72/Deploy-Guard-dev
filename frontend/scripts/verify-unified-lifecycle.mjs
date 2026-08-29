import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { deploymentPhasePresentation } from "../src/utils/developerDeploymentPresentation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pipeline = read("../src/pages/ProjectPipeline.jsx");
const execution = read("../src/components/projects/PipelineExecution.jsx");
const recovery = read("../src/components/projects/PipelineRecoveryPanel.jsx");
const sidebar = read("../src/components/layout/Sidebar.jsx");
const layout = read("../src/components/layout/AppLayout.jsx");
const currentState = read("../../backend/src/projects/current-state/project-current-state.service.ts");

assert.match(pipeline, /getGithubActionsDeploymentHistory/);
assert.match(pipeline, /setInterval\(load, 4000\)/, "an active operation refreshes canonical state and GitHub evidence together");
assert.match(execution, /workflowStages/);
assert.doesNotMatch(execution, /safeLog/, "sanitized failure logs stay in the focused recovery surface");
assert.match(recovery, /safeLog/);
assert.match(currentState, /latest\.currentStage === "release_complete"[\s\S]*latestMetadata\.releaseEvidenceVerified === true[\s\S]*Boolean\(stableRelease && stableUrl\)/, "LIVE needs validated release evidence plus an authoritative stable endpoint");
assert.match(currentState, /Verification needs attention/, "unverified completed workflows remain truthful");
assert.match(currentState, /this\.githubLifecycleProgress\(phase\)/, "active progress derives from lifecycle milestones");
assert.match(sidebar, /getProjectCurrentState/);
assert.match(layout, /<Sidebar isOpen=\{navigationOpen\} onClose=\{\(\) => setNavigationOpen\(false\)\} projectId=\{selectedProjectId\} \/>/, "the shell passes the selected project and responsive-drawer controls to navigation");
assert.match(sidebar, /state\?\.state === "LIVE"/);
assert.match(sidebar, /\["DEPLOYING", "FAILED", "LIVE", "DESTROYING"\]/);
assert.doesNotMatch(sidebar, /"DESTROYED"\]\.?includes\(state\?\.state\)/, "destroyed projects retain Pipeline history but not active Infrastructure navigation");

assert.deepEqual(
  deploymentPhasePresentation({ developerState: "building", progress: { phase: "build" } }).map((item) => [item.key, item.status]),
  [["source", "waiting"], ["build", "running"], ["publish", "waiting"], ["deploy", "waiting"], ["verify", "waiting"]],
);
assert.deepEqual(
  deploymentPhasePresentation({ developerState: "failed_application", progress: { phase: "verify" } }).map((item) => [item.key, item.status]),
  [["source", "waiting"], ["build", "waiting"], ["publish", "waiting"], ["deploy", "waiting"], ["verify", "failed"]],
);
console.log("Unified lifecycle projection, refresh, rail, navigation, and failure-boundary verification passed.");
