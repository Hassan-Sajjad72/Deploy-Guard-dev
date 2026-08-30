import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEVELOPER_DEPLOYMENT_PHASES,
  deploymentPhasePresentation,
} from "../src/utils/developerDeploymentPresentation.js";
import { DESTROY_CONFIRMATION_PHRASE } from "../src/utils/deploymentConfirmation.js";

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
assert.match(pipeline, /latest\?\.stageLabel/);
assert.match(pipeline, /details\.stageLabel/);
assert.match(pipeline, /destroyVerificationStatus === "pending"/);
assert.match(pipeline, /Verification pending/);
assert.match(pipeline, /destroyVerificationUnresolved/);
assert.match(pipeline, /Retry failed \$\{operationType\(latest\)\.toLowerCase\(\)\}/, "pipeline retry wording must preserve the failed operation type");
assert.match(recovery, /operation\.stageLabel/);
assert.match(recovery, /operation\.aiAnalysisEligible/, "AI analysis must use backend-certified evidence eligibility");
assert.match(overview, /deploymentPhasePresentation/);
assert.equal(DESTROY_CONFIRMATION_PHRASE, "DESTROY");
assert.match(overview, /DESTROY_CONFIRMATION_PHRASE/);
assert.doesNotMatch(overview, /destroyPhrase !== "DESTROY"/);

console.log("Destroy UI presentation checks passed: canonical four-label rail, unchanged deploy rail, completed destroy rail, and shared action-aware presentation consumers.");
