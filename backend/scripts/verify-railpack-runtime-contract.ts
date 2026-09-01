import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";
import { assertReusableWorkflowCompatibility, generatedCallerWithKeys, parsePinnedReusableWorkflow } from "../src/projects/github-actions-workflow-contract";
import { RailpackRuntimeConfiguration, servicesBase64 } from "../src/projects/railpack-workflow-contract";
import { SERVICE_ALIAS_GROUPS } from "../src/projects/configuration-ownership";

const root = join(__dirname, "..", "..");
const terraform = readFileSync(join(root, "infrastructure", "railpack-runtime", "main.tf"), "utf8");
const outputs = readFileSync(join(root, "infrastructure", "railpack-runtime", "outputs.tf"), "utf8");
const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
const runtimeVerification = readFileSync(join(root, "infrastructure", "railpack-runtime", "verify-runtime.sh"), "utf8");
const deploymentService = readFileSync(join(root, "backend", "src", "projects", "railpack-deployment.service.ts"), "utf8");
const capabilityContract = readFileSync(join(root, "backend", "src", "projects", "github-actions-aws-capability-contract.ts"), "utf8");
const providerLock = readFileSync(join(root, "infrastructure", "railpack-runtime", ".terraform.lock.hcl"), "utf8");
const pinned = parsePinnedReusableWorkflow("Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@" + "a".repeat(40));
const caller = renderDeployguardCallerWorkflow(pinned.reference);
const jqContract = workflow.match(/jq -e[^']*'\n([\s\S]*?)\n\s*' \.deployguard\/runtime\.json/)?.[1];
assert.ok(jqContract, "the workflow service-contract jq filter must be extractable");
const contractFixture: RailpackRuntimeConfiguration = { schemaVersion: 2, projectId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222", environmentName: "dev", sourceSha: "a".repeat(40), services: [{ serviceId: "33333333-3333-4333-8333-333333333333", runtimeConfigRevisionId: "44444444-4444-4444-8444-444444444444", serviceName: "Web", serviceDirectory: ".", buildEnvironment: { PUBLIC_BUILD_MODE: "production" }, buildSecretReferences: { BUILD_TOKEN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/example:BUILD_TOKEN::${"c".repeat(64)}` }, environment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: { TOKEN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/example:TOKEN::${"b".repeat(64)}` }, databaseAttached: false, managedDatabase: { engine: null, aliases: [] } }] };
const jqResult = spawnSync("jq", ["-e", "--arg", "project", contractFixture.projectId, "--arg", "operation", contractFixture.operationId, "--arg", "sha", contractFixture.sourceSha, "--arg", "action", "deploy", jqContract], { input: JSON.stringify(contractFixture), encoding: "utf8" });
assert.equal(jqResult.status, 0, `workflow service contract must accept the canonical runtime fixture: ${jqResult.stderr}`);
const invalidReference = structuredClone(contractFixture);
invalidReference.services[0].secretReferences.TOKEN = "terraform://database/password";
const invalidJqResult = spawnSync("jq", ["-e", "--arg", "project", contractFixture.projectId, "--arg", "operation", contractFixture.operationId, "--arg", "sha", contractFixture.sourceSha, "--arg", "action", "deploy", jqContract], { input: JSON.stringify(invalidReference), encoding: "utf8" });
assert.notEqual(invalidJqResult.status, 0, "the workflow must reject non-ARN secret references before execution");
const invalidBuildPort: any = structuredClone(contractFixture);
invalidBuildPort.services[0].buildEnvironment.PORT = "9999";
assert.throws(() => servicesBase64(invalidBuildPort), /build environment is invalid/, "the platform PORT cannot be overridden at build scope");
const invalidBuildReference: any = structuredClone(contractFixture);
invalidBuildReference.services[0].buildSecretReferences.BUILD_TOKEN = "not-an-immutable-secret-reference";
assert.throws(() => servicesBase64(invalidBuildReference), /build secret reference is invalid/, "build secrets must use immutable Secrets Manager version references");
for (const [field, key] of [["environment", "DATABASE_URL"], ["secretReferences", "MONGODB_URI"]] as const) {
  const legacyDatabaseAlias: any = structuredClone(contractFixture);
  legacyDatabaseAlias.services[0][field][key] = field === "environment"
    ? "legacy-user-database-value"
    : `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/example:${key}::${"c".repeat(64)}`;
  assert.throws(() => servicesBase64(legacyDatabaseAlias), /runtime (?:environment|secret reference) is invalid/, `legacy ${key} must fail closed before workflow dispatch`);
}
const managedDatabaseAliases = [...new Set(SERVICE_ALIAS_GROUPS.filter((group) => group.service !== "storage").flatMap((group) => group.aliases))].sort();
for (const key of managedDatabaseAliases) {
  assert.match(workflow, new RegExp(`"${key}"`), `the workflow validator must include the canonical managed database alias ${key}`);
  for (const field of ["environment", "secretReferences"] as const) {
    const legacyDatabaseAlias: any = structuredClone(contractFixture);
    legacyDatabaseAlias.services[0][field][key] = field === "environment"
      ? "legacy-user-database-value"
      : `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/example:${key}::${"c".repeat(64)}`;
    const result = spawnSync("jq", ["-e", "--arg", "project", contractFixture.projectId, "--arg", "operation", contractFixture.operationId, "--arg", "sha", contractFixture.sourceSha, "--arg", "action", "deploy", jqContract], { input: JSON.stringify(legacyDatabaseAlias), encoding: "utf8" });
    assert.notEqual(result.status, 0, `the workflow must reject ${key} from generic ${field} at the execution boundary`);
  }
}
const historicalDatabaseVersionId = "terraform-20260830234105178100000005";
const rollbackDatabaseFixture: any = structuredClone(contractFixture);
rollbackDatabaseFixture.services[0].databaseAttached = true;
rollbackDatabaseFixture.services[0].managedDatabase = {
  engine: "mongodb",
  aliases: ["MONGODB_URI"],
  secretVersionId: historicalDatabaseVersionId,
};
rollbackDatabaseFixture.services[0].rollbackImage = `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-test@sha256:${"d".repeat(64)}`;
const encodedRollbackDatabase = servicesBase64(rollbackDatabaseFixture);
const serializedRollbackDatabase = Buffer.from(encodedRollbackDatabase, "base64").toString("utf8");
assert.equal(
  JSON.parse(serializedRollbackDatabase).services[0].managedDatabase.secretVersionId,
  historicalDatabaseVersionId,
  "a legitimate historical Secrets Manager VersionId must survive the rollback contract unchanged",
);
const historicalRollbackJqResult = spawnSync(
  "jq",
  ["-e", "--arg", "project", rollbackDatabaseFixture.projectId, "--arg", "operation", rollbackDatabaseFixture.operationId, "--arg", "sha", rollbackDatabaseFixture.sourceSha, "--arg", "action", "rollback", jqContract],
  { input: serializedRollbackDatabase, encoding: "utf8" },
);
assert.equal(historicalRollbackJqResult.status, 0, `the backend-serialized historical VersionId must pass the executable workflow jq contract unchanged: ${historicalRollbackJqResult.stderr}`);
for (const invalidVersionId of ["a".repeat(31), "a".repeat(65), `${"a".repeat(31)}_`]) {
  const invalidDatabaseVersion: any = structuredClone(rollbackDatabaseFixture);
  invalidDatabaseVersion.services[0].managedDatabase.secretVersionId = invalidVersionId;
  assert.throws(() => servicesBase64(invalidDatabaseVersion), /managed database secret-version identity is invalid/, "invalid Secrets Manager VersionIds must remain fail-closed");
}
const destroyFixture: any = structuredClone(contractFixture);
destroyFixture.services[0].rollbackImage = `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-test@sha256:${"c".repeat(64)}`;
destroyFixture.projectDeletion = { generationIds: ["55555555-5555-4555-8555-555555555555"] };
const destroyJqResult = spawnSync("jq", ["-e", "--arg", "project", destroyFixture.projectId, "--arg", "operation", destroyFixture.operationId, "--arg", "sha", destroyFixture.sourceSha, "--arg", "action", "destroy", jqContract], { input: JSON.stringify(destroyFixture), encoding: "utf8" });
assert.equal(destroyJqResult.status, 0, `workflow must accept the exact canonical destroy runtime fixture: ${destroyJqResult.stderr}`);
const destroyRuntime = workflow.slice(workflow.indexOf('if [ "$DEPLOYMENT_ACTION" = destroy ]; then'), workflow.indexOf('else\n            terraform -chdir=.deployguard/terraform plan'));
assert.match(destroyRuntime, /terraform -chdir=\.deployguard\/terraform destroy -input=false -auto-approve[\s\S]*?aws secretsmanager delete-secret --secret-id .*--force-delete-without-recovery[\s\S]*?aws ecr delete-repository --repository-name .* --force[\s\S]*?aws s3api delete-object --bucket "\$TERRAFORM_STATE_BUCKET" --key "\$state_key"[\s\S]*?aws s3api head-object/, "destroy must prove exact Terraform state, DeployGuard-owned runtime-secret, and immutable-image cleanup before it emits deletion evidence");
assert.match(destroyRuntime, /if ! aws ecr delete-repository[\s\S]*?DG_ECR_CLEANUP_FAILED[\s\S]*?if aws ecr describe-repositories[\s\S]*?DG_ECR_CLEANUP_FAILED/, "Destroy must fail closed when ECR deletion fails or the repository remains observable");
assert.doesNotMatch(destroyRuntime, /delete-repository[^\n]*\|\|\s*aws ecr describe-repositories[^\n]*\|\|\s*true/, "Destroy must never convert an extant ECR repository into successful deletion evidence");
const ecrCleanup = destroyRuntime.match(/if ! aws ecr delete-repository[\s\S]*?\n\s*fi\n\s*if aws ecr describe-repositories[\s\S]*?\n\s*fi/)?.[0];
assert.ok(ecrCleanup, "the executable ECR deletion proof must be extractable");
const executeEcrCleanup = (deleteExit: number, describeExit: number) => spawnSync("bash", ["-c", `
  aws() {
    if [ "$1 $2" = "ecr delete-repository" ]; then return ${deleteExit}; fi
    if [ "$1 $2" = "ecr describe-repositories" ]; then return ${describeExit}; fi
    return 99
  }
  repository=deployguard-test
  ${ecrCleanup}
`], { encoding: "utf8" });
assert.notEqual(executeEcrCleanup(1, 0).status, 0, "a rejected ECR deletion must stop Destroy before release evidence");
assert.notEqual(executeEcrCleanup(0, 0).status, 0, "an ECR repository still observable after deletion must stop Destroy before release evidence");
assert.equal(executeEcrCleanup(0, 1).status, 0, "confirmed ECR absence may continue to state cleanup and release evidence");
assert.match(destroyRuntime, /\.Name == \$serviceSecret[\s\S]*?\.Name == \$legacySecret/, "destroy supports only exact owned service-scoped or historical project-scoped runtime secret namespaces");
assert.match(destroyRuntime, /describe-secret --secret-id "\$service_secret" --query ARN --output text/, "destroy discovers the exact service secret even when it contains only build-scope values");
assert.match(destroyRuntime, /\[ "\$repository" = "deployguard-\$\{PROJECT_ID\}" \] \|\| \[ "\$repository" = "deployguard-\$\{compact_project:0:12\}-\$\{compact_service:0:8\}" \]/, "destroy must reject any ECR repository outside the exact legacy or service-scoped DeployGuard namespace");
assert.doesNotThrow(() => assertReusableWorkflowCompatibility(workflow, pinned, generatedCallerWithKeys(caller)));
const staleResultContract = workflow.replace(/^      result_contract_version:.*\n/m, "");
assert.throws(
  () => assertReusableWorkflowCompatibility(staleResultContract, pinned, generatedCallerWithKeys(caller)),
  /result_contract_version/,
  "a reusable workflow with the stale result schema is blocked before dispatch",
);
assert.throws(
  () => assertReusableWorkflowCompatibility(workflow.replace("# deployguard-result-contract: deployguard.release-result/v4", "# deployguard-result-contract: deployguard.release-result/v3"), pinned, generatedCallerWithKeys(caller)),
  /does not produce deployguard\.release-result\/v4/,
  "input compatibility alone cannot certify an incompatible result producer",
);

assert.doesNotMatch(terraform, /aws_db_instance|aws_db_subnet_group/);
assert.match(terraform, /aws_ecs_task_definition/);
assert.match(terraform, /aws_efs_file_system/);
assert.match(terraform, /aws_efs_access_point/);
assert.match(terraform, /aws_secretsmanager_secret/);
assert.match(terraform, /runtime_secrets_enabled\s+=\s+local\.database_enabled\s+\|\|\s+anytrue/, "runtime-secret IAM cardinality must be derived from plan-known configuration");
assert.doesNotMatch(terraform, /count\s+=\s+length\(local\.runtime_secret_arns\)/, "apply-time secret ARNs must never control Terraform cardinality");
assert.match(terraform, /for_each\s+= var\.services/);
assert.match(terraform, /database_services\s+= \{ for id, service in var\.services/);
assert.doesNotMatch(terraform, /Resource\s*=\s*"\*"/);
assert.match(terraform, /image\s*=\s*each\.value\.image/);
assert.match(terraform, /containerPort\s*=\s*var\.platform_port/);
for (const output of [
  "aws_region", "ecs_cluster_arn", "ecs_cluster_name", "services",
  "database_efs_file_system_id", "database_efs_access_point_id", "database",
]) assert.match(outputs, new RegExp(`output\\s+"${output}"`), `Railpack release evidence must expose ${output}`);
assert.match(workflow, /HOST:"0\.0\.0\.0"/);
assert.match(workflow, /aws-actions\/configure-aws-credentials@e3dd6a429d7300a6a4c196c26e071d42e0343502 # v4\.0\.2/);
assert.match(workflow, /actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4\.2\.2/);
assert.match(workflow, /hashicorp\/setup-terraform@b9cd54a3c349d3f38e8881555d616ced269862dd # v3\.1\.2/);
const terraformSetup = /- name: Install Terraform\n([\s\S]*?)(?=\n      - name: Materialize release runtime)/.exec(workflow)?.[1] || "";
const runtimeMaterialization = /- name: Materialize release runtime\n([\s\S]*?)(?=\n      - name: Publish verified release result)/.exec(workflow)?.[1] || "";
assert.match(terraformSetup, /if: success\(\)/);
assert.doesNotMatch(terraformSetup, /deployment_action|steps\.image\.outputs\.image/);
for (const action of ["deploy", "rollback", "destroy"]) {
  assert.match(runtimeMaterialization, new RegExp(`inputs\\.deployment_action == '${action}'`), `runtime materialization must include ${action}`);
}
assert.ok(workflow.indexOf("- name: Install Terraform") < workflow.indexOf("- name: Materialize release runtime"), "pinned Terraform setup must precede every runtime materialization path");
assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4\.6\.2/);
assert.doesNotMatch(workflow, /aws-actions\/configure-aws-credentials@0a3a7f8c8f8b37f3c7d2b23fe4cdd20b3b8a2746/);
assert.match(workflow, /control_plane_sha/);
assert.match(workflow, /result_contract_version: \{ required: true, type: string \}/);
assert.match(workflow, /RESULT_CONTRACT_VERSION.*inputs\.result_contract_version/);
assert.match(workflow, /deployguard\.release-result\/v4/);
for (const message of ["invalid_deployment_action", "invalid_immutable_release_identity", "incompatible_result_contract", "invalid_platform_port", "exact_source_sha_mismatch"]) {
  assert.match(workflow, new RegExp(`DG_FAILURE code=DG_WORKFLOW_CONTRACT_INVALID stage=validate_release message=${message}`), `Validate Release must emit structured platform failure evidence for ${message}`);
}
assert.match(workflow, /services_base64/);
assert.match(workflow, /verify-runtime\.sh[\s\S]*aws-runtime-verification\.json/);
assert.match(runtimeVerification, /\.services \| to_entries\[\]/);
assert.doesNotMatch(workflow, /rollback_image_uri|runtime_environment_base64|runtime_secret_references_base64/);
assert.match(deploymentService, /result_contract_version: RAILPACK_RESULT_CONTRACT_VERSION/);
assert.match(deploymentService, /release_contract_incompatible/);
assert.match(deploymentService, /Destroy requires the authoritative verified deployed release identity/);
assert.match(workflow, /railpack build "\$\{build_env_args\[@\]\}" --name "\$image" "\$directory"/);
assert.match(workflow, /get-secret-value --secret-id "\$secret_id" --version-id "\$version_id"/, "build secrets are fetched by immutable secret version");
assert.match(workflow, /build_env_args\+=\(--env "\$key"\)/, "Railpack receives build ENV names without raw values in argv");
assert.doesNotMatch(workflow, /--env "\$key=\$value"/, "Railpack command arguments must not expose secret values");
assert.match(workflow, /BUILDKIT_IMAGE: moby\/buildkit:v0\.16\.0@sha256:bc1fe18224dbcb92599139db0c745696c48ba9fd4ac24038d1fa81fdd7dcac27/);
assert.match(workflow, /docker version --format/);
assert.match(workflow, /docker run --rm --privileged --detach --name "\$BUILDKIT_CONTAINER" "\$BUILDKIT_IMAGE"/);
assert.match(workflow, /docker exec "\$BUILDKIT_CONTAINER" buildctl debug workers/);
assert.match(workflow, /BUILDKIT_HOST="docker-container:\/\/\$\{BUILDKIT_CONTAINER\}" railpack build "\$\{build_env_args\[@\]\}" --name "\$image" "\$directory"/);
assert.match(workflow, /DG_FAILURE code=DG_RAILPACK_PREREQUISITE_FAILED stage=prepare_build/);
assert.match(workflow, /name: Clean up Railpack BuildKit daemon[\s\S]*?if: always\(\) && inputs\.deployment_action == 'deploy'[\s\S]*?docker rm --force "\$BUILDKIT_CONTAINER"/);
assert.doesNotMatch(workflow, /moby\/buildkit:latest/);
assert.match(workflow, /\^\(deploy\|rollback\|destroy\)\$/);
assert.match(workflow, /key=projects\/\$PROJECT_ID\/\$ENVIRONMENT_NAME\/runtime\/terraform\.tfstate/);
assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
assert.match(runtimeVerification, /aws ecs wait services-stable/);
assert.match(runtimeVerification, /curl --show-error --silent --retry 20[\s\S]*--output \/dev\/null/);
assert.doesNotMatch(runtimeVerification, /curl --fail --show-error --silent --retry 20/, "application HTTP status is outside deployment readiness");
assert.match(terraform, /health_check\s*\{[\s\S]*?matcher\s*=\s*"200-499"/, "ALB readiness accepts completed non-5xx application responses");
assert.match(workflow, /destroyVerification:\{/);
assert.match(workflow, /contractVersion:"deployguard\.destroy-result\/v2"/);
assert.match(workflow, /generationIds:\(\$runtime\[0\]\.projectDeletion\.generationIds\s*\|\s*sort\)/);
assert.doesNotMatch(workflow, /build_plan_base64|generated_dockerfile_base64|terraform:\/\//);
assert.match(deploymentService, /getResultArtifact/);
assert.match(deploymentService, /releaseEvidence/);
assert.match(deploymentService, /RollbackTargetIdentity/);
assert.match(deploymentService, /immutableImage/);
assert.match(deploymentService, /StableReleaseStatus\.ROLLBACK_TARGET/);
assert.match(deploymentService, /awsCapabilities\.ensure/);
assert.match(capabilityContract, /ecs:CreateCluster/);
assert.match(capabilityContract, /elasticloadbalancing:CreateLoadBalancer/);
assert.match(capabilityContract, /iam:AttachRolePolicy/);
assert.match(capabilityContract, /RAILPACK_RUNTIME_AWS_PROVIDER_VERSION = "5\.100\.0"/);
assert.match(providerLock, /version\s+=\s+"5\.100\.0"/);
for (const action of [
  "elasticloadbalancing:DescribeLoadBalancerAttributes", "elasticloadbalancing:ModifyLoadBalancerAttributes", "elasticloadbalancing:DescribeTargetGroupAttributes",
  "elasticloadbalancing:SetSecurityGroups", "elasticloadbalancing:SetSubnets", "ecs:CreateCluster", "ecs:DeleteCluster", "ecs:RegisterTaskDefinition", "ecs:DeleteTaskDefinitions",
  "ec2:UpdateSecurityGroupRuleDescriptionsIngress", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:PutRolePolicy", "secretsmanager:UpdateSecret",
  "elasticfilesystem:ModifyMountTargetSecurityGroups", "s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject",
  "iam:ListInstanceProfilesForRole", "ecr:DeleteRepository",
]) assert.ok(capabilityContract.includes(action), `pinned-provider capability missing: ${action}`);
assert.match(capabilityContract, /id: "application-secrets"[\s\S]*?secretsmanager:GetSecretValue/, "build secret retrieval is part of explicit AWS admission");
assert.match(capabilityContract, /servicediscovery:CreatePrivateDnsNamespace/);
assert.doesNotMatch(capabilityContract, /sharedEcsClusterArn|sharedAlbArn|sharedAlbListenerArn|CreateRule/);
console.log("RAILPACK_RUNTIME_CONTRACT=PASS");
