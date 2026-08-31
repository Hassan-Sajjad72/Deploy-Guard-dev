import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyStructuredFailure } from "../src/projects/failure-ownership";

const serviceId = "11111111-1111-4111-8111-111111111111";
assert.deepEqual(classifyStructuredFailure("railpack_build", `DG_FAILURE serviceId=${serviceId} code=DG_RAILPACK_BUILD_FAILED stage=railpack_build`), { failureOwner: "REPOSITORY_APPLICATION", externalProvider: null, failureCode: "DG_RAILPACK_BUILD_FAILED", failureServiceId: serviceId });
assert.deepEqual(classifyStructuredFailure("service_directory_validation", `DG_FAILURE serviceId=${serviceId} code=DG_SERVICE_DIRECTORY_MISSING stage=service_directory_validation`), { failureOwner: "REPOSITORY_APPLICATION", externalProvider: null, failureCode: "DG_SERVICE_DIRECTORY_MISSING", failureServiceId: serviceId });
assert.equal(classifyStructuredFailure("terraform_validate", "DG_FAILURE code=DG_TERRAFORM_VALIDATE_FAILED stage=terraform_validate").failureOwner, "DEPLOYGUARD_PLATFORM");
assert.deepEqual(classifyStructuredFailure("ecs_stability", `DG_FAILURE serviceId=${serviceId} code=DG_ECS_STABILITY_FAILED stage=ecs_stability`), { failureOwner: "EXTERNAL_PROVIDER", externalProvider: "aws", failureCode: "DG_ECS_STABILITY_FAILED", failureServiceId: serviceId });
const echoedWorkflowSource = `
  echo "DG_FAILURE serviceId=${serviceId} code=DG_SERVICE_DIRECTORY_MISSING stage=service_directory_validation" >&2
  echo "DG_FAILURE code=DG_WORKFLOW_CONTRACT_INVALID stage=validate_release" >&2
`;
assert.deepEqual(
  classifyStructuredFailure("validate_immutable_release_input", `${echoedWorkflowSource}\nDG_FAILURE code=DG_WORKFLOW_CONTRACT_INVALID stage=validate_release`),
  { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null, failureCode: "DG_WORKFLOW_CONTRACT_INVALID", failureServiceId: null },
  "the terminal marker, not an echoed non-executed shell branch, controls failure ownership",
);
assert.equal(
  classifyStructuredFailure("validate_immutable_release_input", "echo 'DG_WORKFLOW_CONTRACT_INVALID: contract invalid' >&2").failureOwner,
  "UNVERIFIED",
  "unstructured code text must not become authoritative workflow evidence",
);
assert.equal(classifyStructuredFailure("workflow_dispatch", "provider unavailable").externalProvider, "github");
assert.equal(classifyStructuredFailure("railpack_build", "Railpack said something ambiguous").failureOwner, "UNVERIFIED");
const root = join(__dirname, "..", "..");
const ai = readFileSync(join(root, "backend/src/ai-troubleshooting/ai-evidence-preprocessor.service.ts"), "utf8");
const pipeline = readFileSync(join(root, "frontend/src/components/projects/PipelineRecoveryPanel.jsx"), "utf8");
const troubleshooting = readFileSync(join(root, "frontend/src/pages/ProjectTroubleshooting.jsx"), "utf8");
assert.match(ai, /failureOwner[\s\S]{0,200}authoritative[\s\S]{0,200}never replace/i);
for (const ui of [pipeline, troubleshooting]) {
  assert.match(ui, /failureOwner/);
  assert.match(ui, /failureCode/);
  assert.match(ui, /failureService/);
}
console.log("FAILURE_OWNERSHIP=PASS DETERMINISTIC=1 UNVERIFIED_SUPPORTED=1 AI_OVERRIDE=0");
