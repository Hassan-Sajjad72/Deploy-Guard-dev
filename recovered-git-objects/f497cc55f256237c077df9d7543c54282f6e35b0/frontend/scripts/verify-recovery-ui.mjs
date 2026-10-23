import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";

const overview = await readFile(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const recovery = await readFile(new URL("../src/pages/ProjectRecovery.jsx", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/pages/ProjectSettings.jsx", import.meta.url), "utf8");
const pipeline = await readFile(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");

for (const source of [overview, recovery, pipeline]) {
  assert.match(source, /getProjectCurrentState/);
  assert.doesNotMatch(source, /recoveryIssue|currentRecoveryIssue|previousDeploymentIssue|failureClass|safeCodes|lifecycleCode|resumeProjectRecovery|retryPipelineRun|cancelPipelineRun/);
}
assert.match(recovery, /developerState/);
assert.match(recovery, /developerAction === "provide_configuration"/);
assert.match(recovery, /Platform attention/);
assert.doesNotMatch(recovery, /DeploymentRecoveryCard|IssueEvidenceList|ResumeDeploymentButton|Terraform|ECS|AWS/);
assert.match(settings, /getProjectDetailedCurrentState/);
assert.match(settings, /role === "admin"/);
assert.doesNotMatch(overview, /DeploymentRecoveryCard|DeveloperDetailsAccordion/);
assert.doesNotMatch(pipeline, /DeploymentRecoveryCard|DeveloperDetailsAccordion/);

console.log("Sanitized developer recovery and admin detail separation verification passed.");
