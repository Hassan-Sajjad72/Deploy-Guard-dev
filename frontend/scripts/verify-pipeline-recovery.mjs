import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pipeline = read("../src/pages/ProjectPipeline.jsx");
const recovery = read("../src/components/projects/PipelineRecoveryPanel.jsx");

assert.match(pipeline, /PipelineRecoveryPanel/);
assert.match(pipeline, /getGithubActionsDeploymentHistory/);
assert.match(recovery, /operations = \[\]/);
assert.doesNotMatch(recovery, /getGithubActionsDeploymentHistory/);
assert.match(recovery, /Sanitized failure evidence/);
assert.match(recovery, /Deployment failure diagnosis/);
assert.match(recovery, /DeployGuard diagnosis/);
assert.match(recovery, /confidenceLabel\(diagnosis\.confidence\)/);
assert.match(recovery, /Repository \/ Application issue/);
assert.match(recovery, /diagnosis\.rootCauseCode/);
assert.match(recovery, /diagnosis\.remediationSteps/);
assert.match(recovery, /diagnosis\.retryDecision === "SAFE_AFTER_FIX"/);
assert.match(recovery, /Do not retry the same immutable commit/);
assert.match(recovery, /retrySummary\(diagnosis\.retryDecision\)/);
assert.match(recovery, /operation\.diagnosis \|\| operation/, "canonical diagnosis ownership supersedes legacy operation ownership");
assert.match(recovery, /operation\.diagnosis\?\.terminalFailureCode \|\| operation\.failureCode/, "terminal code retains historical fallback");
assert.match(recovery, /Pipeline failure code/);
assert.match(recovery, /View relevant logs/);
assert.match(recovery, /View full GitHub Actions logs/);
assert.match(recovery, /View GitHub Actions run/);
for (const forbidden of ["Ask AI", "Analyze failure", "AI troubleshooting", "Evidence-bounded failure guidance", "aiAnalysisEligible", "getTroubleshootingSession", "getTroubleshootingSessions", "startTroubleshooting", "pipeline-ai-panel", "pipeline-ai-result"]) {
  assert.doesNotMatch(recovery, new RegExp(forbidden), `Pipeline recovery must not contain ${forbidden}`);
}
assert.doesNotMatch(pipeline, /recoveryRefreshVersion|troubleshooting|platformApi/, "Pipeline page owns no AI troubleshooting state or API");
assert.doesNotMatch(recovery, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|safeLog.*outside/);
console.log("PIPELINE_RECOVERY=PASS DETERMINISTIC_DIAGNOSIS=1 SANITIZED_EVIDENCE=1 GITHUB_LINKS=1 PIPELINE_AI_SURFACES=0");
