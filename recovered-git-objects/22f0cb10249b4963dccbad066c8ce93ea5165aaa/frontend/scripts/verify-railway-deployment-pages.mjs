import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import {
  deploymentActionPresentation,
  deploymentCostPresentation,
  deploymentPhasePresentation,
} from "../src/utils/developerDeploymentPresentation.js";
import { commandErrorForCurrentSnapshot } from "../src/utils/canonicalCommandError.js";

const overview = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const deployments = readFileSync(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
const canonical = readFileSync(new URL("../src/components/projects/CanonicalDeploymentView.jsx", import.meta.url), "utf8");
const presentation = readFileSync(new URL("../src/utils/developerDeploymentPresentation.js", import.meta.url), "utf8");

for (const page of [overview, deployments]) {
  assert.match(page, /CanonicalDeploymentView/);
  assert.match(page, /getProjectCurrentState/);
  assert.doesNotMatch(page, /getPipelineRuns|getProjectDetailedCurrentState|executeNormalReleaseAction|developerAction/);
  assert.doesNotMatch(page, /Terraform|inventory|cleanup|residue|recovery|lifecycleCode|safeCodes|runId|provider|legacy/i);
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
  snapshot: cleanExpress,
};
assert.match(commandErrorForCurrentSnapshot(historicalCommandFailure, cleanExpress), /cannot continue/);
assert.equal(
  commandErrorForCurrentSnapshot(historicalCommandFailure, { ...cleanExpress }),
  "",
  "a new canonical ready/deploy snapshot must clear the stale command alert",
);
assert.match(canonical, /currentState\.applicationError/,
  "current application failures must retain their backend-owned alert surface");
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
