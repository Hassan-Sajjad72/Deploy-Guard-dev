import { createHash } from "crypto";
import {
  RAILPACK_WORKFLOW_CONTRACT_VERSION,
  RAILPACK_RESULT_CONTRACT_VERSION,
  RAILPACK_WORKFLOW_INPUTS,
} from "./railpack-workflow-contract";

export const AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION = "deployguard.aws-runtime-verification/v1";
export const CONTROL_PLANE_EXECUTABLE_PATHS = {
  releaseResultProducer: "infrastructure/railpack-runtime/build-release-result.sh",
  releaseOnlyTaskDefinitions: "infrastructure/railpack-runtime/register-release-task-definitions.sh",
  runtimeVerifier: "infrastructure/railpack-runtime/verify-runtime.sh",
  runtimeInfrastructure: "infrastructure/railpack-runtime/main.tf",
  fallbackBuilder: "infrastructure/docker-fallback/build-images.sh",
  fallbackContract: "infrastructure/docker-fallback/fallback-contract.mjs",
  fallbackTemplate: "infrastructure/docker-fallback/node22-npm-workspace.Dockerfile",
  fallbackManifest: "infrastructure/docker-fallback/templates.json",
} as const;
const CONTROL_PLANE_EXECUTABLE_SHA256 = {
  workflow: "73fd6267f682554a31a3454558b90065c2d3a0e884c000a8528c3c2f2ea9f016",
  releaseResultProducer: "b0a19dd5cba4144dc460a99981ada034fef12d2ac1c1a5a2b1bdbe3f415af7ea",
  releaseOnlyTaskDefinitions: "518ecab10d7fee7e6c283955e476030faf8ad61dfcbb2a60f6d75cde52bb0f87",
  runtimeVerifier: "adcd8c5f5b9eb535a53ee868d894caccc67b415f92d89eafb46b0a7d51843c90",
  runtimeInfrastructure: "a57d0142ff63eed47399aad6a3f6f8bf5dd4f8bd7ade731bac98c9c0d7cf955a",
  fallbackBuilder: "b4974d375b0db2215552d1dc69b887da83a622b9ecc89610fd81e7c4d5f8497e",
  fallbackContract: "d23b986804cfddc24a2b651535dde0dad2f2ef92d008045d2db13c462536aafd",
  fallbackTemplate: "04872857e43a18e2e083a71f739e1cd5f9b7c2463cd50516832c05558686b4d6",
  fallbackManifest: "3446d4cbd87b97041ae0ea6fd623a993f3eeb20ae3b8d503e22c6f6c83e89340",
} as const;

export type ReusableWorkflowExecutableContract = {
  releaseResultProducer: string;
  releaseOnlyTaskDefinitions: string;
  runtimeVerifier: string;
  runtimeInfrastructure: string;
  fallbackBuilder: string;
  fallbackContract: string;
  fallbackTemplate: string;
  fallbackManifest: string;
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
    || !workflow.includes("managed_database_url_scheme:(.managedDatabase.urlScheme//\"\")")
    || !workflow.includes('database_url="${database_url_scheme}://')
    || !workflow.includes("DG_APPLICATION_STARTUP_FAILED")
    || !workflow.includes('--env PORT="$service_port"')
    || !workflow.includes("DG_TERRAFORM_PLAN_FAILED stage=terraform_plan")
    || !workflow.includes("DG_TERRAFORM_APPLY_FAILED stage=terraform_apply")) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not hand verified AWS runtime evidence to the terminal release artifact.`);
  }
  if (!executable.releaseResultProducer.includes("awsRuntimeVerification:$awsRuntimeVerification")
    || !executable.releaseResultProducer.includes(`.awsRuntimeVerification.contractVersion == "${AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION}"`)
    || !executable.releaseResultProducer.includes(".servicePort == $release.terraform.services[.serviceId].service_port")
    || !executable.releaseResultProducer.includes("DG_WORKFLOW_CONTRACT_INVALID stage=release_evidence_validation")) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not implement the required terminal evidence producer.`);
  }
  if (!workflow.includes("Checkout immutable DeployGuard builder contracts") || !workflow.includes("infrastructure/docker-fallback/build-images.sh")
    || !executable.fallbackBuilder.includes("DG_DOCKER_FALLBACK_BUILD_FAILED") || !executable.fallbackBuilder.includes("--secret \"id=deployguard_build_secrets")
    || !executable.fallbackContract.includes("pinned_railpack_go_panic") || !executable.fallbackContract.includes("no_exact_certified_contract")
    || !executable.fallbackTemplate.includes("USER node") || !executable.fallbackTemplate.includes("@sha256:")
    || !executable.fallbackManifest.includes("deployguard.docker-fallback/v1")) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not implement the certified fail-closed Docker fallback boundary.`);
  }
  if (!workflow.includes("register-release-task-definitions.sh")
    || !workflow.includes('if [ "$RELEASE_ONLY" = true ]; then')
    || !executable.releaseOnlyTaskDefinitions.includes("aws ecs register-task-definition")
    || !executable.releaseOnlyTaskDefinitions.includes("aws ecs update-service")
    || !executable.releaseOnlyTaskDefinitions.includes("rollback_requires_immutable_task_definition")
    || !executable.releaseOnlyTaskDefinitions.includes("rollback_task_definition_identity_mismatch")
    || !workflow.includes("release_only_requires_deploy_or_rollback")
    || !workflow.includes("trivy_enforce_requires_enabled")
    || !workflow.includes("deployguard.security-result/v1")
    || !workflow.includes("DG_TRIVY_POLICY_BLOCKED")
    || !workflow.includes("securityScan:$security[0]")
    || !executable.releaseOnlyTaskDefinitions.includes("active_task_definition_topology_mismatch")
    || !executable.releaseOnlyTaskDefinitions.includes("service_port_changed_requires_terraform")) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not implement the direct ECS release-only boundary.`);
  }
  if (!executable.runtimeVerifier.includes(`--arg contractVersion ${AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION}`)
    || !executable.runtimeVerifier.includes("expected_port=\"$(jq -r '.servicePort' <<<\"$expected\")\"")
    || !executable.runtimeVerifier.includes('or .state == "draining"')
    || !executable.runtimeVerifier.includes("failureMarker:")
    || !executable.runtimeVerifier.includes("wait_for_managed_database_readiness")
    || !executable.runtimeVerifier.includes("wait_for_cloud_map_registration")
    || !executable.runtimeVerifier.includes('aws ecs update-service --cluster "$cluster" --service "$attached_service" --desired-count 1')
    || !executable.runtimeVerifier.includes("wait_for_alb_active")
    || !executable.runtimeVerifier.includes("wait_for_listener")
    || !executable.runtimeVerifier.includes("wait_for_public_dns")
    || !executable.runtimeVerifier.includes("wait_for_public_transport")
    || (!executable.runtimeVerifier.includes("awsRuntimeVerification") && !executable.runtimeVerifier.includes("services:$services"))) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not implement ${AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION}.`);
  }
  if (!executable.runtimeInfrastructure.includes('platform_health_check_path = "/_deployguard/transport-ready"')
    || !executable.runtimeInfrastructure.includes('name         = "deployguard-transport-probe"')
    || !executable.runtimeInfrastructure.includes('task_ip=\\"$(hostname -i')
    || !executable.runtimeInfrastructure.includes('nc -z -w 1 \\"$task_ip\\"')
    || !executable.runtimeInfrastructure.includes('port    = tostring(local.transport_probe_ports[each.key])')
    || !executable.runtimeInfrastructure.includes('database_url_scheme         = local.database_enabled ? local.database_service.managed_database_url_scheme : ""')
    || !executable.runtimeInfrastructure.includes('url      = "${local.database_url_scheme}://')
    || !executable.runtimeInfrastructure.includes('desired_count   = each.value.database_attached ? 0 : 1')
    || !executable.runtimeInfrastructure.includes('ignore_changes = [desired_count, task_definition]')
    || executable.runtimeInfrastructure.includes('terraform_data.database_readiness')) {
    throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} does not implement platform-owned transport and managed-database release readiness.`);
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
    releaseOnlyTaskDefinitions: sha256(executable.releaseOnlyTaskDefinitions),
    runtimeVerifier: sha256(executable.runtimeVerifier),
    runtimeInfrastructure: sha256(executable.runtimeInfrastructure),
    fallbackBuilder: sha256(executable.fallbackBuilder),
    fallbackContract: sha256(executable.fallbackContract),
    fallbackTemplate: sha256(executable.fallbackTemplate),
    fallbackManifest: sha256(executable.fallbackManifest),
  };
  for (const [name, expected] of Object.entries(CONTROL_PLANE_EXECUTABLE_SHA256)) {
    if (executableHashes[name as keyof typeof executableHashes] !== expected) {
      throw new GithubActionsWorkflowContractError(`pinned workflow ${pinned.sha} executable ${name} is not the backend-certified control-plane release.`);
    }
  }
  return { contractVersion: RAILPACK_WORKFLOW_CONTRACT_VERSION, runtimeVerificationContractVersion: AWS_RUNTIME_VERIFICATION_CONTRACT_VERSION, sha: pinned.sha, inputs: declared, executableHashes };
}
