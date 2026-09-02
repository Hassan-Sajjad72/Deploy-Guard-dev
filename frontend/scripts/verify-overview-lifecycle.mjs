import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { canonicalOverviewState, overviewFailureOwnershipLabel, overviewLifecycleActions, overviewLifecycleCopy } from "../src/utils/overviewLifecyclePresentation.js";
import { projectStatePresentation } from "../src/utils/projectStatePresentation.js";
import { deploymentPhasePresentation } from "../src/utils/developerDeploymentPresentation.js";

const overview = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const lifecycle = readFileSync(new URL("../src/components/projects/ProjectOverviewLifecycle.jsx", import.meta.url), "utf8");
const api = readFileSync(new URL("../src/api/projectApi.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const designSystem = readFileSync(new URL("../src/components/common/DesignSystem.jsx", import.meta.url), "utf8");

const actions = (state, canManage = true) => overviewLifecycleActions({ stateAuthority: { state }, canRetry: true, stableUrl: "https://example.test" }, canManage);
assert.equal(canonicalOverviewState({ stateAuthority: { state: "LIVE" }, developerState: "failed_application" }), "LIVE", "canonical state authority wins over historical state");
assert.deepEqual(actions("READY"), [{ kind: "command", command: "deploy", label: "Deploy" }]);
assert.deepEqual(actions("DEPLOYING"), [{ kind: "link", target: "pipeline", label: "View progress" }]);
const stableRuntimeWithActiveDestroy = {
  developerState: "live",
  stableUrl: "https://example.test",
  stableRelease: { rollbackAvailable: true },
  stateAuthority: {
    state: "LIVE",
    activeOperation: { id: "destroy-1", type: "destroy", status: "destroying", stage: "deploy" },
    applicationHealth: { status: "healthy" },
  },
};
assert.equal(projectStatePresentation(stableRuntimeWithActiveDestroy).active, true);
assert.equal(projectStatePresentation(stableRuntimeWithActiveDestroy).state, "DESTROYING");
assert.equal(canonicalOverviewState(stableRuntimeWithActiveDestroy), "DESTROYING");
assert.deepEqual(overviewLifecycleActions(stableRuntimeWithActiveDestroy, true), [{ kind: "link", target: "pipeline", label: "View progress" }]);
assert.equal(overviewLifecycleCopy(stableRuntimeWithActiveDestroy).title, "Infrastructure is being destroyed");
const stableRuntimeWithActiveRollback = {
  ...stableRuntimeWithActiveDestroy,
  stateAuthority: { ...stableRuntimeWithActiveDestroy.stateAuthority, activeOperation: { id: "rollback-1", type: "rollback", status: "verifying", stage: "verify" } },
};
assert.equal(projectStatePresentation(stableRuntimeWithActiveRollback).state, "DEPLOYING");
assert.equal(overviewLifecycleCopy(stableRuntimeWithActiveRollback).title, "Rollback in progress");
assert.deepEqual(overviewLifecycleActions(stableRuntimeWithActiveRollback, true), [{ kind: "link", target: "pipeline", label: "View progress" }]);
assert.deepEqual(actions("FAILED"), [
  { kind: "link", target: "pipeline", label: "View Pipeline" },
  { kind: "command", command: "retry", label: "Retry Failed Deployment" },
]);
const failedDeploy = { stateAuthority: { state: "FAILED", latestCompletedOperation: { type: "deploy" } }, latestAttempt: { operationType: "deploy", workflowRunId: "123" }, canRetry: true };
const failedDestroy = { stateAuthority: { state: "FAILED", latestCompletedOperation: { type: "destroy" } }, latestAttempt: { operationType: "destroy" }, canRetry: true };
const failedRollback = { stateAuthority: { state: "FAILED", latestCompletedOperation: { type: "rollback" } }, latestAttempt: { operationType: "rollback" }, canRetry: true };
assert.equal(overviewLifecycleCopy(failedDeploy).title, "Deployment failed");
assert.equal(overviewLifecycleActions(failedDeploy, true)[1].label, "Retry Failed Deployment");
assert.equal(overviewLifecycleCopy(failedDestroy).title, "Destroy failed");
assert.equal(overviewLifecycleActions(failedDestroy, true)[1].label, "Retry Failed Destroy");
assert.equal(overviewLifecycleCopy(failedRollback).title, "Rollback failed");
assert.equal(overviewLifecycleActions(failedRollback, true)[1].label, "Retry Failed Rollback");
assert.equal(overviewFailureOwnershipLabel({ ...failedDeploy, latestAttempt: { ...failedDeploy.latestAttempt, failureOwner: "REPOSITORY_APPLICATION" } }), "Repository failure");
for (const failureOwner of ["DEPLOYGUARD_PLATFORM", "EXTERNAL_PROVIDER", "UNVERIFIED", null, undefined]) {
  assert.equal(overviewFailureOwnershipLabel({ ...failedDeploy, latestAttempt: { ...failedDeploy.latestAttempt, failureOwner } }), null, `${failureOwner || "missing"} ownership must not add an Overview label`);
}
assert.match(lifecycle, /failureOwnershipLabel \? <StatusChip[^>]*>\{failureOwnershipLabel\}<\/StatusChip> : null/, "Overview renders only the authoritative repository-failure label");
assert.doesNotMatch(lifecycle, /DeployGuard failure/, "Overview does not add a DeployGuard ownership label");
const setupFailureRail = deploymentPhasePresentation({
  developerState: "failed_application",
  progress: { phase: "build" },
  latestAttempt: { workflowStages: [
    { key: "checkout_exact_application_source", status: "passed" },
    { key: "install_pinned_railpack", status: "passed" },
    { key: "build_and_push_immutable_railpack_image", status: "failed" },
    { key: "publish_immutable_image_to_ecr", status: "skipped" },
    { key: "install_terraform", status: "skipped" },
  ] },
});
assert.deepEqual(
  setupFailureRail.map(({ key, status }) => [key, status]),
  [["source", "passed"], ["build", "failed"], ["publish", "waiting"], ["deploy", "waiting"], ["verify", "waiting"], ["finalize", "waiting"]],
  "Railpack build failure must not present later deployment phases as completed",
);
assert.equal(overviewLifecycleCopy({
  developerState: "failed_application", progress: { phase: "build" }, latestAttempt: { workflowRunId: "33212514809" },
  stateAuthority: { state: "FAILED", latestCompletedOperation: { type: "deploy", outcome: "failed" } },
}).title, "Build Application failed");
assert.equal(overviewLifecycleCopy({
  developerState: "failed_application", progress: { phase: "finalize" }, latestAttempt: { workflowRunId: "33464002814" },
  stateAuthority: { state: "FAILED", latestCompletedOperation: { type: "deploy", outcome: "failed" } },
}).title, "Finalize Release failed");
const failedDestroyWithStableRuntime = {
  developerState: "live",
  developerMessage: "The latest destroy operation failed. The verified stable release remains live.",
  stableUrl: "https://example.test",
  canRetry: true,
  latestAttempt: { operationType: "destroy", status: "failed_application" },
  stateAuthority: {
    state: "LIVE",
    activeOperation: null,
    latestCompletedOperation: { type: "destroy", outcome: "failed" },
    applicationHealth: { status: "healthy" },
  },
};
assert.equal(projectStatePresentation(failedDestroyWithStableRuntime).state, "LIVE", "runtime truth remains LIVE");
assert.equal(projectStatePresentation(failedDestroyWithStableRuntime).active, false);
assert.equal(overviewLifecycleCopy(failedDestroyWithStableRuntime).title, "Destroy failed");
assert.match(overviewLifecycleCopy(failedDestroyWithStableRuntime).message, /remains live/i);
assert.deepEqual(overviewLifecycleActions(failedDestroyWithStableRuntime, true), [
  { kind: "link", target: "pipeline", label: "View Pipeline" },
  { kind: "command", command: "retry", label: "Retry Failed Destroy" },
]);
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
assert.match(lifecycle, /authority\.activeOperation\?\.id/, "the accepted-operation banner clears when persisted state has no matching active operation");
assert.match(lifecycle, /setAcceptedOperation\(null\)/, "terminal persisted state clears the local accepted-operation banner");
assert.match(lifecycle, /dispatching\.current/);
assert.match(lifecycle, /retryGithubActionsDeployment\(projectId\)/, "failed Destroy uses the existing generic retry handler");
assert.match(lifecycle, /latestOperationFailed/);
assert.match(api, /\/deploy\/retry[\s\S]*?method: "POST"/, "failed Destroy uses the existing generic retry endpoint");
assert.match(lifecycle, /getGithubActionsRollbackCandidates/);
assert.match(lifecycle, /rollbackGithubActionsDeployment/);
assert.match(lifecycle, /No previous successful release is available/);
assert.match(lifecycle, /rollbackError/);
assert.match(lifecycle, /Repository code will not be rebuilt/);
assert.match(lifecycle, /<MetricCard/g);
assert.equal((lifecycle.match(/<MetricCard/g) || []).length, 3, "Overview has exactly three summary cards");
assert.match(lifecycle, /<MetricCard detail=\{copy\.message\} label="Current state"/, "Current State retains its verified-release message");
assert.match(lifecycle, /<MetricCard label="Latest operation"[^>]*value=\{latest \? `Attempt \$\{latest\.attempt \|\| "—"\}`/, "Latest Operation contains the attempt only");
assert.match(lifecycle, /<MetricCard label="Last deployment duration" value=\{duration\(latest\?\.startedAt, latest\?\.completedAt\)\}/, "Last Deployment Duration contains no secondary timestamp detail");
assert.doesNotMatch(lifecycle, /label="Application health"/, "Overview does not present runtime health");
assert.doesNotMatch(lifecycle, /applicationHealth|health\.observedAt|health\.source/, "Overview does not consume detailed runtime health data");
assert.doesNotMatch(lifecycle, /detail=\{`Commit \$\{shortCommit\(latest/, "Overview does not show a commit beneath Latest Operation");
assert.doesNotMatch(lifecycle, /\$\{formatDate\(latest\.startedAt\)\} to \$\{formatDate\(latest\.completedAt\)\}/, "Overview does not show a verbose deployment timestamp range");
assert.match(styles, /\.overview-summary-grid\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/, "Overview summary layout has exactly three desktop cards");
assert.match(styles, /\.overview-lifecycle-card \.ds-stage-rail\{grid-template-columns:repeat\(6,minmax\(0,1fr\)\)/, "six deployment phases remain on the primary overview rail row");
assert.doesNotMatch(overview, /CanonicalDeploymentView|getProjectDetailedCurrentState/);
assert.match(overview, /subscribeProjectStateChanged/);
assert.match(lifecycle, /StageRail/);
for (const state of ["ready", "deploying", "failed", "live", "destroying", "destroyed"]) {
  assert.match(styles, new RegExp(`overview-state-${state}`), `responsive lifecycle styling covers ${state}`);
}
assert.doesNotMatch(styles, /overview-state-(?:deploying|destroying)[^}]*var\(--(?:cyan|amber)\)/);
assert.match(styles, /@media\s*\(max-width:\s*560px\)[\s\S]*overview-summary-grid/);
assert.match(styles, /\.ds-modal-backdrop\{[^}]*align-items:flex-start[^}]*overflow-y:auto[^}]*overscroll-behavior:contain/, "shared modal backdrop permits bounded viewport scrolling");
assert.match(styles, /\.ds-modal\{[^}]*max-height:calc\(100dvh[^}]*overflow-y:auto[^}]*overscroll-behavior:contain/, "shared modal content scrolls within the dynamic viewport");
assert.match(styles, /@media\(max-width:560px\),\(max-height:640px\)\{\.ds-modal-backdrop\{--modal-viewport-gutter:var\(--space-3\)/, "short and narrow viewports retain a reachable dialog gutter");
assert.match(designSystem, /document\.body\.style\.overflow = "hidden"[\s\S]*document\.body\.style\.overflow = bodyOverflow/, "modal preserves and restores body scroll locking");
assert.match(designSystem, /event\.key === "Escape"[\s\S]*event\.key !== "Tab"/, "Escape close and keyboard focus trapping remain active");
assert.match(designSystem, /event\.target === event\.currentTarget && onClose\?\.\(\)/, "backdrop close remains scoped to backdrop interaction");
assert.match(designSystem, /aria-labelledby=\{labelledBy\} aria-modal="true"[\s\S]*role="dialog"/, "shared modal accessibility contract remains intact");
assert.match(designSystem, /createPortal\(<div className="ds-modal-backdrop"[\s\S]*document\.body\)/, "shared modal escapes transformed page containing blocks through a body portal");
assert.match(designSystem, /createPortal\(<div className="ds-drawer-backdrop"[\s\S]*document\.body\)/, "shared drawer escapes transformed page containing blocks through a body portal");
console.log("Overview canonical lifecycle action and responsive presentation verification passed.");
