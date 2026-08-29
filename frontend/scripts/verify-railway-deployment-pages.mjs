import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  deploymentActionPresentation,
  deploymentCostPresentation,
  deploymentPhasePresentation,
} from "../src/utils/developerDeploymentPresentation.js";
import { commandErrorForCanonicalFetch } from "../src/utils/canonicalCommandError.js";

const overview = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const deployments = readFileSync(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
const canonical = readFileSync(new URL("../src/components/projects/CanonicalDeploymentView.jsx", import.meta.url), "utf8");
const presentation = readFileSync(new URL("../src/utils/developerDeploymentPresentation.js", import.meta.url), "utf8");

for (const page of [overview, deployments]) {
  assert.match(page, /CanonicalDeploymentView/);
  assert.match(page, /getProjectCurrentState/);
  assert.doesNotMatch(page, /getPipelineRuns|getProjectDetailedCurrentState|executeNormalReleaseAction|developerAction/);
  assert.doesNotMatch(page, /Terraform|inventory|cleanup|residue|recovery|lifecycleCode|safeCodes|runId|provider|legacy/i);
  assert.match(page, /setCanonicalFetchVersion\(\(version\) => version \+ 1\)/,
    "each successful canonical fetch must advance the command-error invalidation version");
  assert.match(page, /canonicalFetchVersion=\{canonicalFetchVersion\}/,
    "each canonical page must pass its successful-fetch version to the shared view");
}

for (const field of ["developerState", "developerAction", "developerMessage", "progress", "estimatedCost", "latestAttempt", "stableRelease", "stableUrl", "applicationError", "missingConfiguration"]) {
  assert.match(`${canonical}\n${presentation}`, new RegExp(`\\b${field}\\b`));
}
assert.match(canonical, /View application logs/);
for (const phase of ["Analyze", "Build", "Prepare", "Deploy", "Verify"]) assert.match(presentation, new RegExp(phase));
assert.doesNotMatch(canonical, /Terraform|inventory|cleanup|residue|recovery|lifecycleCode|safeCodes|runId|provider|legacy/i);
assert.doesNotMatch(canonical, /getPipelineRuns|getProjectDetailedCurrentState|NormalInfrastructurePlanningPanel|ReleaseLaneDeveloperDetails/);

assert.deepEqual(deploymentActionPresentation({ developerAction: "deploy" }, "p1"), { kind: "command", label: "Deploy" });
const cleanExpress = {
  developerState: "ready",
  developerAction: "deploy",
  repository: "render-examples/express-hello-world",
  branch: "main",
  missingConfiguration: [],
  latestAttempt: { outcome: "blocked" },
  stableRelease: null,
};
assert.deepEqual(deploymentActionPresentation(cleanExpress, "7ff60e82-e166-4d3b-9ea7-78203370e59f"), {
  kind: "command",
  label: "Deploy",
});
const historicalCommandFailure = {
  message: "The platform cannot continue this deployment automatically. No deployment was started.",
  canonicalFetchVersion: 3,
};
assert.equal(commandErrorForCanonicalFetch(null, 1), "",
  "a fresh mount with historical failed-attempt evidence must not create a command alert");
assert.equal(commandErrorForCanonicalFetch(null, 1), "",
  "a navigation remount must begin without a command alert");
assert.equal(commandErrorForCanonicalFetch(null, 1), "",
  "a hard-refresh mount must begin without a command alert");
assert.match(commandErrorForCanonicalFetch(historicalCommandFailure, 3), /cannot continue/,
  "a command that fails during the mounted canonical snapshot must remain visible");
assert.equal(
  commandErrorForCanonicalFetch(historicalCommandFailure, 4),
  "",
  "a later successful canonical fetch must clear the stale command alert",
);
assert.equal(commandErrorForCanonicalFetch(null, 4), "",
  "Ready + Deploy + applicationError null must not render a current command alert");
assert.match(canonical, /currentState\.applicationError/,
  "current application failures must retain their backend-owned alert surface");
assert.match(canonical, /\["failed_application", "platform_attention"\]/,
  "current application and platform failures must retain attention presentation");
assert.match(canonical, /failure\?\.canonicalFetchVersion === canonicalFetchVersion \? failure : null/,
  "the runtime owner must discard stale command state after a successful canonical fetch");
assert.deepEqual(deploymentActionPresentation({ developerAction: "redeploy" }, "p1"), { kind: "command", label: "Redeploy" });
assert.deepEqual(deploymentActionPresentation({ developerAction: "approve_cost" }, "p1"), { kind: "command", label: "Approve Cost" });
assert.deepEqual(deploymentActionPresentation({ developerAction: "provide_configuration" }, "p1"), { kind: "link", label: "Provide Configuration", href: "/projects/p1/requirements" });
assert.deepEqual(deploymentActionPresentation({ developerAction: "open_application", stableUrl: "https://app.test" }, "p1"), { kind: "external", label: "Open Application", href: "https://app.test" });
assert.equal(deploymentActionPresentation({ developerAction: "none" }, "p1"), null);
assert.equal(deploymentActionPresentation({ developerAction: "open_application", stableUrl: null }, "p1"), null);

assert.deepEqual(
  deploymentPhasePresentation({ developerState: "building", progress: { phase: "build" } }).map((phase) => phase.status),
  ["passed", "running", "waiting", "waiting", "waiting"],
);
assert.deepEqual(
  deploymentPhasePresentation({ developerState: "failed_application", progress: { phase: "deploy" } }).map((phase) => phase.status),
  ["passed", "passed", "passed", "failed", "waiting"],
);
assert.deepEqual(
  deploymentPhasePresentation({ developerState: "live", progress: { phase: "verify" } }).map((phase) => phase.status),
  ["passed", "passed", "passed", "passed", "passed"],
);
assert.deepEqual(
  deploymentPhasePresentation({ developerState: "ready", latestAttempt: { outcome: "completed" } }).map((phase) => phase.status),
  ["passed", "passed", "passed", "passed", "passed"],
);

assert.equal(deploymentCostPresentation(null).label, "Pending");
assert.match(deploymentCostPresentation({ status: "estimated", currency: "USD", monthly: 12.5 }).label, /12\.50/);
assert.equal(deploymentCostPresentation({ status: "approval_required", monthly: null }).label, "Approval required");
assert.equal(deploymentCostPresentation({ status: "unavailable" }).label, "Unavailable");

console.log("Railway-like canonical Overview and Deployments verification passed.");
