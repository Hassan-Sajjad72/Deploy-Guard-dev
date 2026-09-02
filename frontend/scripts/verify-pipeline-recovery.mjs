import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pipeline = read("../src/pages/ProjectPipeline.jsx");
const recovery = read("../src/components/projects/PipelineRecoveryPanel.jsx");
const controller = read("../../backend/src/ai-troubleshooting/ai-troubleshooting.controller.ts");
const service = read("../../backend/src/ai-troubleshooting/ai-troubleshooting.service.ts");

assert.match(pipeline, /PipelineRecoveryPanel/);
assert.match(pipeline, /getGithubActionsDeploymentHistory/);
assert.match(recovery, /operations = \[\]/);
assert.match(recovery, /hasEligibleFailure = operations\.some/);
assert.match(recovery, /if \(!hasEligibleFailure\)/);
assert.doesNotMatch(recovery, /getGithubActionsDeploymentHistory/);
assert.match(recovery, /Sanitized failure evidence/);
assert.match(recovery, /View GitHub Actions run/);
assert.match(recovery, /Analyze failure/);
assert.match(recovery, /startTroubleshooting/);
assert.match(recovery, /operation\.aiAnalysisEligible/);
assert.match(recovery, /troubleshooting\?operation=\$\{operation\.id\}&analyze=1/, "an explicit Analyze failure action opens one-shot automatic analysis");
assert.match(recovery, /Analyze available evidence/, "provider absence retains deterministic fallback access");
assert.doesNotMatch(recovery, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|safeLog.*outside/);
assert.match(controller, /providerStatus\(req\.user, projectId\)/);
assert.match(service, /async providerStatus\(user: User, projectId: string\)[\s\S]*assertAccess\(user, projectId, false\)/);
assert.match(service, /run\.status !== PipelineRunStatus\.FAILED[\s\S]*run\.metadata\?\.safeLog[\s\S]*Boolean\(run\.githubWorkflowRunId\) \|\| run\.metadata\?\.dispatchState === "failed"/);
assert.match(service, /isAiRuntimeTroubleshootingCandidate[\s\S]*cloudwatch_runtime/, "LIVE runtime analysis stays gated on real generation-correlated CloudWatch evidence");
console.log("Pipeline recovery, failed evidence, guarded LIVE runtime evidence, fallback, and provider authorization verification passed.");
