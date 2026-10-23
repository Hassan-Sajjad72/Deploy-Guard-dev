import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { deploymentPhasePresentation } from "../src/utils/developerDeploymentPresentation.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const canonical = read("../src/components/projects/CanonicalDeploymentView.jsx");
const sidebar = read("../src/components/layout/Sidebar.jsx");
const layout = read("../src/components/layout/AppLayout.jsx");
const currentState = read("../../backend/src/projects/current-state/project-current-state.service.ts");

assert.match(canonical, /lastReconciledOperation/);
assert.match(canonical, /signature !== lastReconciledOperation\.current\) void onRefresh\(\)/, "a reconciled operation refreshes the authoritative state projection");
assert.match(canonical, /View Pipeline Logs/);
assert.doesNotMatch(canonical, /safeLog/, "raw failure evidence belongs to Pipeline, not the canonical overview");
assert.match(currentState, /latest\.currentStage === "healthy" && Boolean\(stableUrl\)/, "LIVE needs workflow health verification and a discoverable endpoint");
assert.match(currentState, /Verification needs attention/, "unverified completed workflows remain truthful");
assert.match(currentState, /this\.githubLifecycleProgress\(phase\)/, "active progress derives from lifecycle milestones");
assert.match(sidebar, /getProjectCurrentState/);
assert.match(layout, /<Sidebar projectId=\{selectedProjectId\} \/>/, "the shell passes the selected project to navigation");
assert.match(sidebar, /state\?\.state === "LIVE"/);
assert.match(sidebar, /\["DEPLOYING", "FAILED", "LIVE", "DESTROYING"\]/);
assert.doesNotMatch(sidebar, /"DESTROYED"\]\.?includes\(state\?\.state\)/, "destroyed projects retain Pipeline history but not active Infrastructure navigation");

assert.deepEqual(
  deploymentPhasePresentation({ developerState: "building", progress: { phase: "build" } }).map((item) => [item.key, item.status]),
  [["analyze", "passed"], ["prepare", "passed"], ["build", "running"], ["deploy", "waiting"], ["verify", "waiting"]],
);
assert.deepEqual(
  deploymentPhasePresentation({ developerState: "failed_application", progress: { phase: "verify" } }).map((item) => [item.key, item.status]),
  [["analyze", "passed"], ["prepare", "passed"], ["build", "passed"], ["deploy", "passed"], ["verify", "failed"]],
);
console.log("Unified lifecycle projection, refresh, rail, navigation, and failure-boundary verification passed.");
