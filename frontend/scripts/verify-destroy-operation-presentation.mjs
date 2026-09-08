import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEVELOPER_DEPLOYMENT_PHASES,
  deploymentPhasePresentation,
} from "../src/utils/developerDeploymentPresentation.js";
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
assert.doesNotMatch(overview, /DESTROY_CONFIRMATION_PHRASE|destroyGithubActionsDeployment|Destroy Infrastructure/, "Project Overview must not expose infrastructure destruction");
assert.doesNotMatch(infrastructure, />Retry Failed Destroy<|>View Destroy progress</, "Infrastructure must not expose destroy controls");
assert.doesNotMatch(projects, /\["DESTROYED", "Destroyed"\]/, "Projects must not expose a Destroyed filter button");
assert.doesNotMatch(adminCleanup, /createEmergencyCleanupChallenge|executeEmergencyCleanup|retryCentralProjectDestroy|requestDestroy|>Retry destroy<|>Retry Terraform destroy<|>Destroy all DeployGuard testing\/preview resources</, "Admin UI must not expose destroy controls");
assert.equal(failureRecoveryCommand({ operationType: "destroy", diagnosis: { retryDecision: "SAFE_NOW" } }, true), null, "Pipeline and Overview suppress destroy retry actions");

console.log("Destroy UI presentation checks passed: historical evidence remains readable while all destroy controls are hidden.");
