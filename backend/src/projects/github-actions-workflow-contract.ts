import { createHash } from "crypto";
import {
  RAILPACK_WORKFLOW_CONTRACT_VERSION,
  RAILPACK_RESULT_CONTRACT_VERSION,
  RAILPACK_WORKFLOW_INPUTS,
} from "./railpack-workflow-contract";

export const AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION = "deployguard.aws-runtime-verification/v1";
export const CONTROL_PLANE_EXECUTABLE_PATHS = {
  releaseResultProducer: "infrastructure/railpack-runtime/build-release-result.sh",
  runtimeVerifier: "infrastructure/railpack-runtime/verify-runtime.sh",
} as const;
const CONTROL_PLANE_EXECUTABLE_SHA256 = {
  workflow: "28717a20e430fc4fcce2685bdbd265ab07711494b43d36588393a352228acb9f",
  releaseResultProducer: "0b652a54dc5337ee7bc42c3229bb22faf9d755a7e133b28239e73b9d50788340",
  runtimeVerifier: "08e72dade088477de6bafd990ce6ba7f63297045fab56e9f28ee853a6c7424d8",
} as const;

export type ReusableWorkflowExecutableContract = {
  releaseResultProducer: string;
  runtimeVerifier: string;
};

export type PinnedReusableWorkflow = {
  owner: string;
  repository: string;
  path: string;
  sha: string;
  reference: string;
};

export class GithubActionsWorkflowContractError extends Error {
  constructor(public readonly detail: string) {
    super(`Reusable workflow contract mismatch: ${detail}`);
  }
}

export function parsePinnedReusableWorkflow(reference: string): PinnedReusableWorkflow {
  const match = reference.match(/^([^/]+)\/([^/]+)\/(\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml)@([0-9a-f]{40})$/);
  if (!match) {
    throw new GithubActionsWorkflowContractError("configured reusable workflow must use an exact 40-character commit SHA.");
  }
  return { owner: match[1], repository: match[2], path: match[3], sha: match[4], reference };
}

export function reusableWorkflowInputDeclarations(workflow: string) {
  const block = workflow.match(/\n  workflow_call:\n    inputs:\n([\s\S]*?)\n\n(?:permissions|jobs):/)?.[1] || "";
  return [...block.matchAll(/^      ([a-z][a-z0-9_]*): \{ required: (true|false), type: (string|number|boolean)(?:, default: [^}]+)? \}$/gm)]
    .map((match) => ({ name: match[1], required: match[2] === "true", type: match[3] }));
}

export function generatedCallerWithKeys(workflow: string) {
  const block = workflow.match(/\n    with:\n([\s\S]*?)\n?$/)?.[1] || "";
  return [...block.matchAll(/^      ([a-z][a-z0-9_]*):/gm)].map((match) => match[1]);
}

function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }

export function assertReusableWorkflowCompatibility(workflow: string, pinned: PinnedReusableWorkflow, callerWithKeys: readonly string[] | undefined, executable: ReusableWorkflowExecutableContract) {
  const resultContract = workflow.match(/^# deployguard-result-contract: ([a-z0-9./_-]+)$/m)?.[1] || null;
  if (resultContract !== RAILPACK_RESULT_CONTRACT_VERSION) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not produce ${RAILPACK_RESULT_CONTRACT_VERSION} evidence.`);
  }
  if (!workflow.includes(`verify-runtime.sh .deployguard/terraform-outputs.json .deployguard/runtime.json .deployguard/aws-runtime-verification.json`)
    || !workflow.includes(`build-release-result.sh "$DEPLOYMENT_ACTION" "$RESULT_CONTRACT_VERSION" "$SOURCE_SHA" "$OPERATION_ID" .deployguard/service-artifacts.json .deployguard/terraform-outputs.json .deployguard/aws-runtime-verification.json .deployguard/release-runtime.json`)
    || !workflow.includes("cp .deployguard/release-runtime.json terraform/deployguard-result.json")) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not hand verified AWS runtime evidence to the terminal release artifact.`);
  }
  if (!executable.releaseResultProducer.includes("awsRuntimeVerification:$awsRuntimeVerification")
    || !executable.releaseResultProducer.includes(`.awsRuntimeVerification.contractVersion == "${AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION}"`)
    || !executable.releaseResultProducer.includes("DG_WORKFLOW_CONTRACT_INVALID stage=release_evidence_validation")) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not implement the required terminal evidence producer.`);
  }
  if (!executable.runtimeVerifier.includes(`--arg contractVersion ${AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION}`)
    || (!executable.runtimeVerifier.includes("awsRuntimeVerification") && !executable.runtimeVerifier.includes("services:$services"))) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not implement ${AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION}.`);
  }
  const declared = reusableWorkflowInputDeclarations(workflow);
  const byName = new Map(declared.map((input) => [input.name, input]));
  for (const expected of RAILPACK_WORKFLOW_INPUTS) {
    const actual = byName.get(expected.name);
    if (!actual) throw new GithubActionsWorkflowContractError(`caller input \`${expected.name}\` is not declared by pinned workflow ${pinned.sha}.`);
    if (actual.required !== expected.required || actual.type !== expected.type) {
      throw new GithubActionsWorkflowContractError(`input \`${expected.name}\` in pinned workflow ${pinned.sha} must be ${expected.required ? "required" : "optional"} ${expected.type} for ${RAILPACK_WORKFLOW_CONTRACT_VERSION}.`);
    }
  }
  const expectedNames = new Set(RAILPACK_WORKFLOW_INPUTS.map((input) => input.name));
  const extra = declared.find((input) => !expectedNames.has(input.name as never));
  if (extra) throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} declares unknown input \`${extra.name}\`.`);
  if (callerWithKeys) {
    const caller = new Set(callerWithKeys);
    const extraCaller = callerWithKeys.find((name) => !expectedNames.has(name as never));
    if (extraCaller) throw new GithubActionsWorkflowContractError(`caller input \`${extraCaller}\` is not declared by pinned workflow ${pinned.sha}.`);
    const missing = RAILPACK_WORKFLOW_INPUTS.find((input) => input.required && !caller.has(input.name));
    if (missing) throw new GithubActionsWorkflowContractError(`caller is missing required pinned-workflow input \`${missing.name}\`.`);
  }
  const executableHashes = {
    workflow: sha256(workflow),
    releaseResultProducer: sha256(executable.releaseResultProducer),
    runtimeVerifier: sha256(executable.runtimeVerifier),
  };
  for (const [name, expected] of Object.entries(CONTROL_PLANE_EXECUTABLE_SHA256)) {
    if (executableHashes[name as keyof typeof executableHashes] !== expected) {
      throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} executable ${name} is not the backend-certified control-plane release.`);
    }
  }
  return { contractVersion: RAILPACK_WORKFLOW_CONTRACT_VERSION, runtimeVerificationContractVersion: AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION, sha: pinned.sha, inputs: declared, executableHashes };
}
