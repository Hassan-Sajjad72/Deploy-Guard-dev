import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEVELOPER_DEPLOYMENT_PHASES,
  deploymentPhasePresentation,
} from "../src/utils/developerDeploymentPresentation.js";
import { DESTROY_CONFIRMATION_PHRASE } from "../src/utils/deploymentConfirmation.js";
import { failureRecoveryCommand } from "../src/utils/overviewLifecyclePresentation.js";

const destroy = deploymentPhasePresentation({
  developerState: "destroying",
  deploymentAction: "destroy",
  progress: { phase: "deploy" },
});
assert.deepEqual(destroy.map(({ key, label }) => [key, label]), [
  ["prepare", "Prepare"],
  ["destroy", "Destroy Infrastructure"],
  ["verify", "Verify Deletion"],
  ["finalize", "Finalize Cleanup"],
]);
assert.ok(!destroy.some((phase) => phase.label === "Deploy"));
assert.equal(destroy.find((phase) => phase.key === "destroy")?.status, "running");

const deploy = deploymentPhasePresentation({ developerState: "deploying", progress: { phase: "deploy" } });
assert.deepEqual(deploy.map(({ key, label }) => [key, label]), DEVELOPER_DEPLOYMENT_PHASES.map(({ key, label }) => [key, label]));
assert.equal(deploy.find((phase) => phase.key === "deploy")?.status, "running");

const destroyed = deploymentPhasePresentation({ developerState: "destroyed", progress: { phase: "verify" } });
assert.ok(destroyed.every((phase) => phase.status === "passed"));

const pipeline = readFileSync(join(import.meta.dirname, "../src/components/projects/PipelineExecution.jsx"), "utf8");
const presentation = readFileSync(join(import.meta.dirname, "../src/utils/failurePresentation.js"), "utf8");
const overview = readFileSync(join(import.meta.dirname, "../src/components/projects/ProjectOverviewLifecycle.jsx"), "utf8");
const destroyControl = readFileSync(join(import.meta.dirname, "../src/components/projects/DestroyInfrastructure.jsx"), "utf8");
const settings = readFileSync(join(import.meta.dirname, "../src/pages/ProjectSettings.jsx"), "utf8");
const primitives = readFileSync(join(import.meta.dirname, "../src/components/common/DesignSystem.jsx"), "utf8");
const infrastructure = readFileSync(join(import.meta.dirname, "../src/pages/ProjectInfrastructure.jsx"), "utf8");
const projects = readFileSync(join(import.meta.dirname, "../src/pages/Projects.jsx"), "utf8");
const admin = readFileSync(join(import.meta.dirname, "../src/pages/AdminUsers.jsx"), "utf8");
const adminCleanup = readFileSync(join(import.meta.dirname, "../src/pages/AdminCloudCleanup.jsx"), "utf8");
assert.match(pipeline, /const stages = latest\?\.workflowStages \|\| \[\]/, "destroy stage evidence remains in the technical timeline");
assert.match(pipeline, /details\.failedStageLabel \|\| details\.stageLabel/);
assert.match(pipeline, /destroyVerificationStatus === "pending"/);
assert.match(presentation, /destroyVerificationStatus === "pending"\) return \{ label: "Verifying deletion"/, "a destroy is not called finished while deletion is still being verified");
assert.match(pipeline, /destroyVerificationUnresolved/);
assert.match(overview, /deploymentPhasePresentation/);
assert.equal(DESTROY_CONFIRMATION_PHRASE, "DESTROY");

// Destroy lives in the Settings danger zone behind the shared typed confirmation.
assert.match(settings, /<DestroyInfrastructure canManage=\{canManage\} currentState=\{currentState\}/);
assert.match(destroyControl, /destroyGithubActionsDeployment\(projectId, phrase\)/, "the existing project-scoped destroy API is used");
assert.match(destroyControl, /phrase !== DESTROY_CONFIRMATION_PHRASE/, "the exact destructive confirmation phrase is required");
assert.match(destroyControl, /overviewLifecycleActions\(currentState, canManage\)\.some\(\(action\) => action\.command === "destroy"\)/, "destroy is offered exactly when the canonical presenter offers it");
assert.match(primitives, /disabled=\{busy \|\| !matches\}/, "the confirm button stays disabled until the phrase matches exactly");
assert.match(overview, /command === "destroy"\) \{ menu\.push\(\{ icon: "trash", label: "Destroy infrastructure…", to: `\/projects\/\$\{projectId\}\/settings\?section=danger`/, "Overview points to the single destroy location");
assert.doesNotMatch(overview, /destroyGithubActionsDeployment/, "Overview does not start a destroy itself");
assert.match(infrastructure, />Go to overview to retry</, "a failed destroy points to the canonical retry");
assert.match(infrastructure, />Follow progress</, "an active destroy links to its progress");
assert.match(projects, /\["DESTROYED", "Destroyed"\]/, "Projects exposes the Destroyed lifecycle filter");
assert.match(admin, /\["ALL", "LIVE", "DEPLOYING", "FAILED", "DESTROYED"\]/, "Admin exposes the Destroyed lifecycle filter");
assert.match(adminCleanup, /createEmergencyCleanupChallenge|executeEmergencyCleanup|retryCentralProjectDestroy|requestDestroy/, "Admin cleanup uses only the pre-existing destroy and emergency cleanup APIs");
assert.match(adminCleanup, /label: "Retry destroy…"/);
assert.match(adminCleanup, /phrase !== "DESTROY"\) return/, "Admin failed-Destroy retry keeps its exact confirmation gate");
assert.match(adminCleanup, /phrase !== "DESTROY ALL DEPLOYGUARD TEST RESOURCES"\) return/, "Emergency cleanup keeps its stronger exact confirmation gate");
assert.match(adminCleanup, /Production and shared resources are excluded by design/, "Emergency cleanup retains protected-resource exclusions");
assert.equal(failureRecoveryCommand({ operationType: "destroy", diagnosis: { retryDecision: "SAFE_NOW" } }, true), "retry", "Eligible failed Destroy operations use the existing generic retry path");

console.log("Destroy UI presentation checks passed: one guarded destroy location, honest deletion verification, recovery links and admin controls.");
