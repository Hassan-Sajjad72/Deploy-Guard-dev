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
const recovery = readFileSync(join(import.meta.dirname, "../src/components/projects/PipelineRecoveryPanel.jsx"), "utf8");
const overview = readFileSync(join(import.meta.dirname, "../src/components/projects/ProjectOverviewLifecycle.jsx"), "utf8");
const infrastructure = readFileSync(join(import.meta.dirname, "../src/pages/ProjectInfrastructure.jsx"), "utf8");
const projects = readFileSync(join(import.meta.dirname, "../src/pages/Projects.jsx"), "utf8");
const admin = readFileSync(join(import.meta.dirname, "../src/pages/AdminUsers.jsx"), "utf8");
const adminCleanup = readFileSync(join(import.meta.dirname, "../src/pages/AdminCloudCleanup.jsx"), "utf8");
assert.match(pipeline, /const stages = latest\?\.workflowStages \|\| \[\]/, "destroy stage evidence remains in the technical timeline");
assert.match(pipeline, /details\.stageLabel/);
assert.match(pipeline, /destroyVerificationStatus === "pending"/);
assert.match(pipeline, /Verification pending/);
assert.match(pipeline, /destroyVerificationUnresolved/);
assert.match(pipeline, /Retry failed \$\{operationType\(latest\)\.toLowerCase\(\)\}/, "pipeline retry wording must preserve the failed operation type");
assert.match(recovery, /operation\.stageLabel/);
assert.doesNotMatch(recovery, /aiAnalysisEligible|AI troubleshooting|Analyze failure|Ask AI/, "Pipeline recovery must remain deterministic and AI-free");
assert.match(overview, /deploymentPhasePresentation/);
assert.equal(DESTROY_CONFIRMATION_PHRASE, "DESTROY");
assert.match(overview, /destroyGithubActionsDeployment\(projectId, destroyPhrase\)/, "Overview uses the existing project-scoped destroy API");
assert.match(overview, /destroyPhrase !== DESTROY_CONFIRMATION_PHRASE/, "Overview requires the exact destructive confirmation phrase");
assert.match(overview, /command === "destroy"[\s\S]*setDestroyOpen\(true\)/, "LIVE Overview renders its Destroy action through the guarded modal");
assert.match(infrastructure, />Retry Failed Destroy</, "Infrastructure links failed Destroy recovery to the canonical Pipeline");
assert.match(infrastructure, />View Destroy progress</, "Infrastructure links an active Destroy to canonical progress evidence");
assert.match(projects, /\["DESTROYED", "Destroyed"\]/, "Projects exposes the Destroyed lifecycle filter");
assert.match(admin, /\["ALL", "LIVE", "DEPLOYING", "FAILED", "DESTROYED"\]/, "Admin exposes the Destroyed lifecycle filter");
assert.match(adminCleanup, /createEmergencyCleanupChallenge|executeEmergencyCleanup|retryCentralProjectDestroy|requestDestroy/, "Admin cleanup uses only the pre-existing destroy and emergency cleanup APIs");
assert.match(adminCleanup, />Retry destroy<|>Retry Terraform destroy<|>Destroy all DeployGuard testing\/preview resources</, "Admin cleanup restores its prior Destroy controls");
assert.match(adminCleanup, /destroyPhrase !== "DESTROY"/, "Admin failed-Destroy retry keeps its exact confirmation gate");
assert.match(adminCleanup, /emergencyPhrase !== "DESTROY ALL DEPLOYGUARD TEST RESOURCES"/, "Emergency cleanup keeps its stronger exact confirmation gate");
assert.match(adminCleanup, /Production and shared resources are structurally excluded/, "Emergency cleanup retains protected-resource exclusions");
assert.equal(failureRecoveryCommand({ operationType: "destroy", diagnosis: { retryDecision: "SAFE_NOW" } }, true), "retry", "Eligible failed Destroy operations use the existing generic retry path");

console.log("Destroy UI presentation checks passed: guarded Overview, recovery, Infrastructure, project visibility, and Admin controls are restored.");
