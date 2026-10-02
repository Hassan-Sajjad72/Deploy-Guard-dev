import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const overview = await readFile(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const lifecycle = await readFile(new URL("../src/components/projects/ProjectOverviewLifecycle.jsx", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
const troubleshooting = await readFile(new URL("../src/pages/ProjectTroubleshooting.jsx", import.meta.url), "utf8");
const routes = await readFile(new URL("../src/routes/AppRoutes.jsx", import.meta.url), "utf8");

for (const source of [overview, pipeline]) {
  assert.match(source, /getProjectCurrentState/);
  assert.doesNotMatch(source, /recoveryIssue|currentRecoveryIssue|previousDeploymentIssue|resumeProjectRecovery|retryPipelineRun|cancelPipelineRun/);
}
// Recovery actions live with the state (Overview) and the diagnosis (Troubleshoot) only.
assert.match(lifecycle, /retryGithubActionsDeployment/);
assert.match(troubleshooting, /retryGithubActionsDeployment/);
assert.match(lifecycle, /troubleshooting\$\{latest\?\.operationId \? `\?operation=/, "Overview opens the diagnosis of the exact failed operation");
assert.doesNotMatch(troubleshooting, /CloudWatch|Redis|BullMQ|DeploymentRecoveryCard/, "no infrastructure internals in the recovery surface");
assert.doesNotMatch(routes, /ProjectRecovery/);
assert.match(routes, /path="\/projects\/:projectId\/pipeline"/);
assert.match(routes, /path="\/projects\/:projectId\/troubleshooting"/);

console.log("Recovery actions are owned by Overview and Troubleshoot; Deployments stays a record.");
