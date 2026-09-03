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
  runtimeInfrastructure: "infrastructure/railpack-runtime/main.tf",
} as const;
const CONTROL_PLANE_EXECUTABLE_SHA256 = {
  workflow: "25afcf291b53592e8ff0f982bb43cb4cfdeeb1eda9a0aef07bffa27a5076652c",
  releaseResultProducer: "cbda8bb60b9bd08ae8c305ce0a036ec5ffab960476aabe0b8e9caaa63cf31b80",
  runtimeVerifier: "eb202a5f60d4ab79b6a8e0415fdeb7d3aa5e6de3df8c543334eeb03c3ce3b76e",
  runtimeInfrastructure: "88a7b589a994590391482563e95e59327b005ece2f318c2e5dd6236382ab276f",
} as const;

export type ReusableWorkflowExecutableContract = {
  releaseResultProducer: string;
  runtimeVerifier: string;
  runtimeInfrastructure: string;
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
    || !workflow.includes("cp .deployguard/release-runtime.json terraform/deployguard-result.json")
    || !workflow.includes("deployguard.release-failure/v1")
    || !workflow.includes("terraform/deployguard-failure-evidence.json")
    || !workflow.includes("if: failure() && steps.runtime.outcome == 'failure'")
    || !workflow.includes("service_port:.servicePort")
    || !workflow.includes('--env PORT="$service_port"')
    || !workflow.includes("apply_failure_marker=.deployguard/terraform/.deployguard-apply-failure")) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not hand verified AWS runtime evidence to the terminal release artifact.`);
  }
  if (!executable.releaseResultProducer.includes("awsRuntimeVerification:$awsRuntimeVerification")
    || !executable.releaseResultProducer.includes(`.awsRuntimeVerification.contractVersion == "${AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION}"`)
    || !executable.releaseResultProducer.includes(".servicePort == $release.terraform.services[.serviceId].service_port")
    || !executable.releaseResultProducer.includes("DG_WORKFLOW_CONTRACT_INVALID stage=release_evidence_validation")) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not implement the required terminal evidence producer.`);
  }
  if (!executable.runtimeVerifier.includes(`--arg contractVersion ${AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION}`)
    || !executable.runtimeVerifier.includes("expected_port=\"$(jq -r '.servicePort' <<<\"$expected\")\"")
    || !executable.runtimeVerifier.includes('or .state == "draining"')
    || !executable.runtimeVerifier.includes("failureMarker:")
    || (!executable.runtimeVerifier.includes("awsRuntimeVerification") && !executable.runtimeVerifier.includes("services:$services"))) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not implement ${AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION}.`);
  }
  if (!executable.runtimeInfrastructure.includes('platform_health_check_path = "/_deployguard/transport-ready"')
    || !executable.runtimeInfrastructure.includes('name         = "deployguard-transport-probe"')
    || !executable.runtimeInfrastructure.includes('nc -z -w 1 127.0.0.1')
    || !executable.runtimeInfrastructure.includes('port    = tostring(local.transport_probe_ports[each.key])')
    || !executable.runtimeInfrastructure.includes('resource "terraform_data" "database_readiness"')
    || !executable.runtimeInfrastructure.includes('command     = local.database_readiness_command')
    || !executable.runtimeInfrastructure.includes('terraform_data.database_readiness')) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not implement platform-owned transport readiness.`);
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
    runtimeInfrastructure: sha256(executable.runtimeInfrastructure),
  };
  for (const [name, expected] of Object.entries(CONTROL_PLANE_EXECUTABLE_SHA256)) {
    if (executableHashes[name as keyof typeof executableHashes] !== expected) {
      throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} executable ${name} is not the backend-certified control-plane release.`);
    }
  }
  return { contractVersion: RAILPACK_WORKFLOW_CONTRACT_VERSION, runtimeVerificationContractVersion: AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION, sha: pinned.sha, inputs: declared, executableHashes };
}
