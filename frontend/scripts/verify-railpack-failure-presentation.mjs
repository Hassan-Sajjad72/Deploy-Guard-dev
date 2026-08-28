import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { deploymentPhasePresentation } from "../src/utils/developerDeploymentPresentation.js";
import { overviewLifecycleCopy } from "../src/utils/overviewLifecyclePresentation.js";

const failure = {
  developerState: "failed_application",
  developerMessage: "BuildKit was unavailable to the Railpack builder.",
  progress: { phase: "build" },
  latestAttempt: {
    workflowRunId: "33212514809",
    workflowStages: [
      { key: "checkout_exact_application_source", status: "passed" },
      { key: "install_pinned_railpack", status: "passed" },
      { key: "build_and_push_immutable_railpack_image", status: "failed" },
      { key: "publish_immutable_image_to_ecr", status: "skipped" },
      { key: "install_terraform", status: "skipped" },
      { key: "materialize_release_runtime", status: "skipped" },
      { key: "publish_verified_release_result", status: "skipped" },
    ],
  },
  stateAuthority: { state: "FAILED", latestCompletedOperation: { type: "deploy", outcome: "failed" } },
};

assert.deepEqual(deploymentPhasePresentation(failure).map(({ key, status }) => [key, status]), [
  ["source", "passed"],
  ["build", "failed"],
  ["publish", "waiting"],
  ["deploy", "waiting"],
  ["verify", "waiting"],
]);
const overview = overviewLifecycleCopy(failure);
assert.equal(overview.title, "Railpack Build failed");
assert.equal(overview.message, "BuildKit was unavailable to the Railpack builder.");
assert.ok(overview.message.length < 320);
const infrastructure = readFileSync(new URL("../src/pages/ProjectInfrastructure.jsx", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/components/projects/PipelineExecution.jsx", import.meta.url), "utf8");
const overviewComponent = readFileSync(new URL("../src/components/projects/ProjectOverviewLifecycle.jsx", import.meta.url), "utf8");
const troubleshooting = readFileSync(new URL("../src/pages/ProjectTroubleshooting.jsx", import.meta.url), "utf8");
assert.match(infrastructure, /Runtime infrastructure not provisioned/);
assert.match(infrastructure, /Railpack Build/);
assert.match(pipeline, /Not created — deployment failed before runtime generation\./);
assert.match(pipeline, /details\.createdAt \|\| details\.startedAt \|\| details\.failedAt/);
assert.match(overviewComponent, /detail=\{copy\.message\}/, "Overview must use the concise canonical message, never raw evidence.");
assert.match(overviewComponent, /value=\{duration\(latest\?\.startedAt, latest\?\.completedAt\)\}/);
assert.match(overviewComponent, /Runtime was not deployed\./);
assert.match(troubleshooting, /Not created — deployment failed before runtime generation\./);
assert.match(troubleshooting, /operationTimestamp\(operation\)/);
assert.match(infrastructure, /subscribeProjectStateChanged/);
assert.match(infrastructure, /window\.setInterval\(load, 5000\)/);
assert.match(troubleshooting, /getProjectCurrentState/);
assert.match(troubleshooting, /subscribeProjectStateChanged/);
assert.match(troubleshooting, /window\.setInterval\(load, 5000\)/);
console.log("RAILPACK_FAILURE_PRESENTATION=PASS");
