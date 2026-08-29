import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const overview = await readFile(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
const canonical = await readFile(new URL("../src/components/projects/PipelineExecution.jsx", import.meta.url), "utf8");
const recovery = await readFile(new URL("../src/components/projects/PipelineRecoveryPanel.jsx", import.meta.url), "utf8");
const routes = await readFile(new URL("../src/routes/AppRoutes.jsx", import.meta.url), "utf8");

for (const source of [overview, pipeline]) {
  assert.match(source, /getProjectCurrentState/);
  assert.doesNotMatch(source, /recoveryIssue|currentRecoveryIssue|previousDeploymentIssue|resumeProjectRecovery|retryPipelineRun|cancelPipelineRun/);
}
assert.match(canonical, /retryGithubActionsDeployment/);
assert.match(recovery, /const failures = next\.filter/);
assert.match(recovery, /Analyze failure/);
assert.match(recovery, /Sanitized failure evidence/);
assert.doesNotMatch(recovery, /CloudWatch|Redis|BullMQ|DeploymentRecoveryCard/);
assert.doesNotMatch(routes, /ProjectRecovery/);
assert.match(routes, /path="\/projects\/:projectId\/pipeline"/);
assert.match(routes, /path="\/projects\/:projectId\/troubleshooting"/);

console.log("Canonical Pipeline recovery and Admin-only diagnostic separation verification passed.");
