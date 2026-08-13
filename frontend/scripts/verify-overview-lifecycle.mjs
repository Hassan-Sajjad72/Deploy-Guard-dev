import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { canonicalOverviewState, overviewLifecycleActions, overviewLifecycleCopy } from "../src/utils/overviewLifecyclePresentation.js";

const overview = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const lifecycle = readFileSync(new URL("../src/components/projects/ProjectOverviewLifecycle.jsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/projectApi.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

const actions = (state, canManage = true) => overviewLifecycleActions({ stateAuthority: { state }, canRetry: true, stableUrl: "https://example.test" }, canManage);
assert.equal(canonicalOverviewState({ stateAuthority: { state: "LIVE" }, developerState: "failed_application" }), "LIVE", "canonical state authority wins over historical state");
assert.deepEqual(actions("READY"), [{ kind: "command", command: "deploy", label: "Deploy" }]);
assert.deepEqual(actions("DEPLOYING"), [{ kind: "link", target: "pipeline", label: "View progress" }]);
assert.deepEqual(actions("FAILED"), [
  { kind: "link", target: "pipeline", label: "View Pipeline" },
  { kind: "command", command: "retry", label: "Retry Failed Deployment" },
]);
const failedDeploy = { stateAuthority: { state: "FAILED", latestCompletedOperation: { type: "deploy" } }, latestAttempt: { operationType: "deploy" }, canRetry: true };
const failedDestroy = { stateAuthority: { state: "FAILED", latestCompletedOperation: { type: "destroy" } }, latestAttempt: { operationType: "destroy" }, canRetry: true };
const failedRollback = { stateAuthority: { state: "FAILED", latestCompletedOperation: { type: "rollback" } }, latestAttempt: { operationType: "rollback" }, canRetry: true };
assert.equal(overviewLifecycleCopy(failedDeploy).title, "Deployment failed");
assert.equal(overviewLifecycleActions(failedDeploy, true)[1].label, "Retry Failed Deployment");
assert.equal(overviewLifecycleCopy(failedDestroy).title, "Destroy failed");
assert.equal(overviewLifecycleActions(failedDestroy, true)[1].label, "Retry Failed Destroy");
assert.equal(overviewLifecycleCopy(failedRollback).title, "Rollback failed");
assert.equal(overviewLifecycleActions(failedRollback, true)[1].label, "Retry Failed Rollback");
assert.deepEqual(actions("LIVE"), [
  { kind: "external", href: "https://example.test", label: "Open Application" },
  { kind: "command", command: "redeploy", label: "Redeploy" },
  { kind: "disabled", command: "rollback", label: "Rollback application", reason: "No previous successful release is available." },
  { kind: "command", command: "destroy", label: "Destroy Infrastructure" },
]);
assert.deepEqual(
  overviewLifecycleActions({ stateAuthority: { state: "LIVE" }, stableUrl: "https://example.test", stableRelease: { rollbackAvailable: true } }, true)[2],
  { kind: "command", command: "rollback", label: "Rollback application" },
  "an immutable previous release activates rollback from Overview",
);
assert.deepEqual(actions("DESTROYING"), [{ kind: "link", target: "pipeline", label: "View progress" }]);
assert.deepEqual(actions("DESTROYED"), [{ kind: "command", command: "deploy", label: "Deploy Again" }]);
assert.deepEqual(overviewLifecycleActions({ stateAuthority: { state: "FAILED" }, canRetry: false }, true), [{ kind: "link", target: "pipeline", label: "View Pipeline" }]);
assert.deepEqual(overviewLifecycleActions({ stateAuthority: { state: "READY" } }, false), []);
assert.doesNotMatch(lifecycle, /getGithubActionsDeploymentHistory|developerAction|estimatedCost|terraform/i);
assert.match(lifecycle, /acceptedOperation/);
assert.match(lifecycle, /dispatching\.current/);
assert.match(lifecycle, /retryGithubActionsDeployment\(projectId\)/, "failed Destroy uses the existing generic retry handler");
assert.match(api, /\/deploy\/retry[\s\S]*?method: "POST"/, "failed Destroy uses the existing generic retry endpoint");
assert.match(lifecycle, /getGithubActionsRollbackCandidates/);
assert.match(lifecycle, /rollbackGithubActionsDeployment/);
assert.match(lifecycle, /No previous successful release is available/);
assert.match(lifecycle, /rollbackError/);
assert.match(lifecycle, /Repository code will not be rebuilt/);
assert.match(lifecycle, /<MetricCard/g);
assert.equal((lifecycle.match(/<MetricCard/g) || []).length, 4, "Overview has exactly four summary cards");
assert.doesNotMatch(overview, /CanonicalDeploymentView|getProjectDetailedCurrentState/);
assert.match(overview, /subscribeProjectStateChanged/);
assert.match(lifecycle, /StageRail/);
for (const state of ["ready", "deploying", "failed", "live", "destroying", "destroyed"]) {
  assert.match(styles, new RegExp(`overview-state-${state}`), `responsive lifecycle styling covers ${state}`);
}
assert.doesNotMatch(styles, /overview-state-(?:deploying|destroying)[^}]*var\(--(?:cyan|amber)\)/);
assert.match(styles, /@media\s*\(max-width:\s*560px\)[\s\S]*overview-summary-grid/);
console.log("Overview canonical lifecycle action and responsive presentation verification passed.");
