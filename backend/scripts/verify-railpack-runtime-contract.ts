import { strict as assert } from "node:assert";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";
import { assertReusableWorkflowCompatibility, generatedCallerWithKeys, parsePinnedReusableWorkflow } from "../src/projects/github-actions-workflow-contract";
import { classifyStructuredFailure } from "../src/projects/failure-ownership";
import { MANAGED_DATABASE_ENGINE_PROFILES, ManagedDatabaseEngine } from "../src/projects/managed-database-engine";
import { RailpackRuntimeConfiguration, servicesBase64 } from "../src/projects/railpack-workflow-contract";
import { aliasesFor, SERVICE_ALIAS_GROUPS } from "../src/projects/configuration-ownership";

const root = join(__dirname, "..", "..");
const terraform = readFileSync(join(root, "infrastructure", "railpack-runtime", "main.tf"), "utf8");
const mysqlGrantReconcilerCommand = terraform.match(/mysql_grant_reconciler_command = \["sh", "-ec", <<-EOT\n([\s\S]*?)\n  EOT/)?.[1] || "";
assert.ok(mysqlGrantReconcilerCommand, "the managed MySQL grant reconciler command must be extractable");
const mysqlGrantSyntax = spawnSync("sh", ["-n"], { input: mysqlGrantReconcilerCommand, encoding: "utf8" });
assert.equal(mysqlGrantSyntax.status, 0, `the managed MySQL grant reconciler must be valid POSIX shell: ${mysqlGrantSyntax.stderr}`);
const outputs = readFileSync(join(root, "infrastructure", "railpack-runtime", "outputs.tf"), "utf8");
const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
const runtimeVerification = readFileSync(join(root, "infrastructure", "railpack-runtime", "verify-runtime.sh"), "utf8");
const databaseReadiness = runtimeVerification.match(/managed_database_failure\(\) \{[\s\S]*?\n\}\n\ncluster=/)?.[0].replace(/\ncluster=$/, "") || "";
assert.ok(databaseReadiness, "the executable managed-database readiness boundary must be extractable from the runtime verifier");
const releaseResultProducer = readFileSync(join(root, "infrastructure", "railpack-runtime", "build-release-result.sh"), "utf8");
const executableContract = { releaseResultProducer, runtimeVerifier: runtimeVerification, runtimeInfrastructure: terraform };
const deploymentService = readFileSync(join(root, "backend", "src", "projects", "railpack-deployment.service.ts"), "utf8");
const capabilityContract = readFileSync(join(root, "backend", "src", "projects", "github-actions-aws-capability-contract.ts"), "utf8");
const providerLock = readFileSync(join(root, "infrastructure", "railpack-runtime", ".terraform.lock.hcl"), "utf8");
const pinned = parsePinnedReusableWorkflow("Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@" + "a".repeat(40));
const caller = renderDeployguardCallerWorkflow(pinned.reference);
const jqContract = workflow.match(/jq -e[^']*'\n([\s\S]*?)\n\s*' \.deployguard\/runtime\.json/)?.[1];
assert.ok(jqContract, "the workflow service-contract jq filter must be extractable");
const contractFixture: RailpackRuntimeConfiguration = { schemaVersion: 3, projectId: "11111111-1111-4111-8111-111111111111", operationId: "22222222-2222-4222-8222-222222222222", environmentName: "dev", sourceSha: "a".repeat(40), services: [{ serviceId: "33333333-3333-4333-8333-333333333333", runtimeConfigRevisionId: "44444444-4444-4444-8444-444444444444", serviceName: "Web", serviceDirectory: ".", servicePort: 8080, buildEnvironment: { PUBLIC_BUILD_MODE: "production" }, buildSecretReferences: { BUILD_TOKEN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/example:BUILD_TOKEN::${"c".repeat(64)}` }, environment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: { TOKEN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/example:TOKEN::${"b".repeat(64)}` }, databaseAttached: false, managedDatabase: { engine: null, aliases: [] } }] };
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
const managedMysqlAliases = (["host", "port", "username", "password", "database", "url"] as const).flatMap((property) => aliasesFor("mysql", property)).sort();
const completeMysqlFixture: any = structuredClone(contractFixture);
completeMysqlFixture.services[0].databaseAttached = true;
completeMysqlFixture.services[0].managedDatabase = { engine: "mysql", aliases: managedMysqlAliases };
assert.doesNotThrow(() => servicesBase64(completeMysqlFixture), "the complete DeployGuard-owned MySQL alias set must be admitted");
const completeMysqlJqResult = spawnSync("jq", ["-e", "--arg", "project", completeMysqlFixture.projectId, "--arg", "operation", completeMysqlFixture.operationId, "--arg", "sha", completeMysqlFixture.sourceSha, "--arg", "action", "deploy", jqContract], { input: JSON.stringify(completeMysqlFixture), encoding: "utf8" });
assert.equal(completeMysqlJqResult.status, 0, `workflow service contract must admit the complete MySQL alias set: ${completeMysqlJqResult.stderr}`);
const incompleteMysqlFixture: any = structuredClone(completeMysqlFixture);
incompleteMysqlFixture.services[0].managedDatabase.aliases = managedMysqlAliases.filter((alias) => alias !== "MYSQL_DATABASE");
assert.throws(() => servicesBase64(incompleteMysqlFixture), /Managed MySQL runtime aliases are incomplete/, "the backend must reject a managed MySQL snapshot missing MYSQL_DATABASE before dispatch");
const incompleteMysqlJqResult = spawnSync("jq", ["-e", "--arg", "project", incompleteMysqlFixture.projectId, "--arg", "operation", incompleteMysqlFixture.operationId, "--arg", "sha", incompleteMysqlFixture.sourceSha, "--arg", "action", "deploy", jqContract], { input: JSON.stringify(incompleteMysqlFixture), encoding: "utf8" });
assert.notEqual(incompleteMysqlJqResult.status, 0, "the workflow must reject a managed MySQL runtime snapshot missing MYSQL_DATABASE before Terraform materialization");
const managedDatabaseAliases = [...new Set(SERVICE_ALIAS_GROUPS.filter((group) => group.service !== "storage").flatMap((group) => group.aliases))].sort();
for (const key of managedDatabaseAliases) {
  for (const field of ["environment", "secretReferences"] as const) {
    const externalDatabaseAlias: any = structuredClone(contractFixture);
    externalDatabaseAlias.services[0][field][key] = field === "environment"
      ? "user-supplied-external-database-value"
      : `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/example:${key}::${"c".repeat(64)}`;
    assert.doesNotThrow(() => servicesBase64(externalDatabaseAlias), `external database alias ${key} is ordinary application configuration when no managed database is attached`);
    const externalResult = spawnSync("jq", ["-e", "--arg", "project", contractFixture.projectId, "--arg", "operation", contractFixture.operationId, "--arg", "sha", contractFixture.sourceSha, "--arg", "action", "deploy", jqContract], { input: JSON.stringify(externalDatabaseAlias), encoding: "utf8" });
    assert.equal(externalResult.status, 0, `the workflow must accept external database alias ${key} when no managed database is attached`);
    const managedConflict: any = structuredClone(externalDatabaseAlias);
    managedConflict.services[0].databaseAttached = true;
    managedConflict.services[0].managedDatabase = { engine: "postgres", aliases: [key] };
    assert.throws(() => servicesBase64(managedConflict), /(?:environment|secret reference) is invalid/, `a managed database must reject the exact ${key} alias it injects`);
    const managedResult = spawnSync("jq", ["-e", "--arg", "project", contractFixture.projectId, "--arg", "operation", contractFixture.operationId, "--arg", "sha", contractFixture.sourceSha, "--arg", "action", "deploy", jqContract], { input: JSON.stringify(managedConflict), encoding: "utf8" });
    assert.notEqual(managedResult.status, 0, `the workflow must reject managed alias ${key} at the execution boundary`);
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
assert.doesNotThrow(() => assertReusableWorkflowCompatibility(workflow, pinned, generatedCallerWithKeys(caller), executableContract));
const staleResultContract = workflow.replace(/^      result_contract_version:.*\n/m, "");
assert.throws(
  () => assertReusableWorkflowCompatibility(staleResultContract, pinned, generatedCallerWithKeys(caller), executableContract),
  /result_contract_version/,
  "a reusable workflow with the stale result schema is blocked before dispatch",
);
assert.throws(
  () => assertReusableWorkflowCompatibility(workflow.replace("# deployguard-result-contract: deployguard.release-result/v5", "# deployguard-result-contract: deployguard.release-result/v4"), pinned, generatedCallerWithKeys(caller), executableContract),
  /does not produce deployguard\.release-result\/v5/,
  "input compatibility alone cannot certify an incompatible result producer",
);
assert.throws(
  () => assertReusableWorkflowCompatibility(workflow, pinned, generatedCallerWithKeys(caller), { ...executableContract, releaseResultProducer: releaseResultProducer.replace("awsRuntimeVerification:$awsRuntimeVerification", "runtimeVerification:$awsRuntimeVerification") }),
  /required terminal evidence producer/,
  "matching contract markers and inputs cannot certify a producer that drops awsRuntimeVerification",
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
assert.match(terraform, /containerPort\s*=\s*each\.value\.service_port/);
for (const output of [
  "aws_region", "ecs_cluster_arn", "ecs_cluster_name", "services",
  "database_efs_file_system_id", "database_efs_access_point_id", "database",
]) assert.match(outputs, new RegExp(`output\\s+"${output}"`), `Railpack release evidence must expose ${output}`);
assert.match(workflow, /HOST:"0\.0\.0\.0"/);
assert.match(workflow, /service_port="\$\(jq -r '\.servicePort'/, "pre-Terraform validation consumes the canonical service port");
assert.match(workflow, /--env PORT="\$service_port"/, "pre-Terraform validation injects each service's own PORT");
assert.match(workflow, /service_port:\.servicePort/, "Terraform materialization consumes each canonical service port");
assert.match(workflow, /Select immutable rollback service images[\s\S]*?\{serviceId,serviceName,serviceDirectory,servicePort,runtimeConfigRevisionId/, "rollback release evidence preserves the historical service port");
assert.doesNotMatch(workflow, /platform_port/, "the obsolete global port is not an executable workflow authority");
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
assert.match(workflow, /deployguard\.release-result\/v5/);
for (const message of ["invalid_deployment_action", "invalid_immutable_release_identity", "incompatible_result_contract", "exact_source_sha_mismatch"]) {
  assert.match(workflow, new RegExp(`DG_FAILURE code=DG_WORKFLOW_CONTRACT_INVALID stage=validate_release message=${message}`), `Validate Release must emit structured platform failure evidence for ${message}`);
}
assert.match(workflow, /services_base64/);
assert.match(workflow, /verify-runtime\.sh[\s\S]*aws-runtime-verification\.json/);
assert.match(workflow, /build-release-result\.sh[\s\S]*aws-runtime-verification\.json[\s\S]*release-runtime\.json/);
assert.match(workflow, /name: Preserve terminal verification failure evidence[\s\S]*if: failure\(\) && steps\.runtime\.outcome == 'failure'[\s\S]*deployguard\.release-failure\/v1[\s\S]*awsRuntimeVerification:\$verification\[0\]/, "failed AWS verification materializes a bounded diagnostic artifact without creating a v5 release");
assert.match(workflow, /name: Publish terminal verification failure evidence[\s\S]*if: failure\(\)[\s\S]*deployguard-failure-evidence\.json/, "failed verification evidence remains retrievable while the workflow stays failed");
assert.match(runtimeVerification, /\.services \| to_entries\[\]/);
assert.doesNotMatch(runtimeVerification, /\(verify_service "\$service"\) \|\| true/, "terminal service verification must never be swallowed");
assert.match(runtimeVerification, /verification_failed=true[\s\S]*exit 1/, "collected service failures must make the verifier return non-zero");
assert.match(runtimeVerification, /wait_for_target_health[\s\S]*DEPLOYGUARD_TARGET_HEALTH_MAX_ATTEMPTS/, "target health uses bounded state convergence");
assert.match(runtimeVerification, /all\(\$current\[\];[\s\S]*\.state == "healthy"\)[\s\S]*or \.state == "draining"/, "current ECS task targets must be healthy while only unexpected draining targets are tolerated");
assert.match(runtimeVerification, /failureMarker:[\s\S]*attach_diagnostics/, "failed terminal verification persists its structured DG_FAILURE and bounded ECS\/ALB diagnostics");
assert.match(runtimeVerification, /\$task\.containers \/\/ \[\]/, "ECS diagnostics must tolerate absent containers");
assert.match(releaseResultProducer, /\.awsRuntimeVerification\.verified == true/);
assert.match(releaseResultProducer, /all\(\.awsRuntimeVerification\.services\[\]; \.verified == true\)/);
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
assert.match(terraform, /platform_health_check_path\s*=\s*"\/_deployguard\/transport-ready"/, "the platform owns its transport-readiness endpoint");
assert.match(terraform, /name\s*=\s*"deployguard-transport-probe"[\s\S]*?APPLICATION_PORT[\s\S]*?nc -z -w 1 127\.0\.0\.1/, "the task-local probe succeeds only while the declared application port accepts TCP");
assert.match(terraform, /name\s*=\s*"application"[\s\S]*?awslogs-stream-prefix = "application"/, "developer application errors remain available in the existing runtime log stream");
assert.match(terraform, /health_check\s*\{[\s\S]*?path\s*=\s*local\.platform_health_check_path[\s\S]*?port\s*=\s*tostring\(local\.transport_probe_ports\[each\.key\]\)[\s\S]*?matcher\s*=\s*"200-299"/, "ALB stability uses DeployGuard transport readiness instead of application response status");
assert.match(terraform, /resource "aws_lb_target_group" "application"[\s\S]*?name\s*=\s*"\$\{local\.project_name\}-\$\{substr\(replace\(each\.key, "-", ""\), 0, 8\)\}-\$\{each\.value\.service_port\}"[\s\S]*?lifecycle\s*\{[\s\S]*?create_before_destroy\s*=\s*true/, "service-port changes must create a distinctly named target group before retiring the listener's current target group");
assert.doesNotMatch(terraform, /health_check\s*\{[\s\S]*?path\s*=\s*"\/"/, "developer root-route semantics are not a default deployment gate");
assert.match(runtimeVerification, /readinessMode:"platform_transport"/);
assert.match(releaseResultProducer, /\$outcome\.readinessMode == "platform_transport"/);
const normalizedTerraform = terraform.replaceAll('\\"', '"');
for (const engine of ["postgres", "mysql", "mongodb"] as ManagedDatabaseEngine[]) {
  const profile = MANAGED_DATABASE_ENGINE_PROFILES[engine];
  assert.ok(normalizedTerraform.includes(profile.healthCheck[1]), `${engine} ECS readiness must remain aligned with the canonical managed-database health command`);
}
assert.match(terraform, /healthCheck\s+=\s+\{[\s\S]*?command\s+=\s+local\.database_health_check/, "the managed database container must expose engine health to ECS");
assert.match(terraform, /resource "aws_ecs_service" "database"[\s\S]*?deployment_minimum_healthy_percent\s*=\s*0[\s\S]*?deployment_maximum_percent\s*=\s*100/, "the singleton managed database must stop its prior task before replacement so two processes never contend for persistent storage");
assert.doesNotMatch(terraform, /terraform_data" "database_readiness|database_readiness_command/, "Terraform must not own the procedural managed-database readiness decision");
assert.match(terraform, /resource "aws_ecs_service" "application"[\s\S]*?desired_count\s+=\s+each\.value\.database_attached\s+\?\s+0\s+:\s+1/, "only the database-attached application starts at zero");
assert.match(terraform, /resource "aws_ecs_service" "application"[\s\S]*?lifecycle\s*\{[\s\S]*?ignore_changes\s+=\s+\[desired_count\]/, "Terraform must not undo DeployGuard's post-readiness application scale-up");
assert.doesNotMatch(terraform, /resource "aws_ecs_service" "application"[\s\S]*?depends_on\s+=\s+\[[^\]]*database/, "application service resource creation must not retain a global database gate");
assert.match(runtimeVerification, /wait_for_managed_database_readiness[\s\S]*?aws ecs update-service --cluster "\$cluster" --service "\$attached_service" --desired-count 1/, "DeployGuard must release only the attached ECS service after database readiness");
const verifyDatabase = runtimeVerification.match(/verify_database\(\) \{[\s\S]*?\n\}\n\ndatabase_failed=/)?.[0] || "";
assert.ok(verifyDatabase, "the managed-database release orchestration must be extractable");
assert.ok(
  verifyDatabase.indexOf('wait_for_managed_database_readiness "$database_id"') < verifyDatabase.indexOf('release_database_attached_service "$database_id"'),
  "the attached application scale-up must occur strictly after managed-database readiness",
);
assert.equal((runtimeVerification.match(/aws ecs update-service --cluster "\$cluster" --service "\$attached_service" --desired-count 1/g) || []).length, 1, "the runtime boundary has one explicit attached-service release action");
assert.match(terraform, /mysql_grant_reconciler_name\s+=\s+"deployguard-mysql-grant-reconciler"/, "managed MySQL must name its grant reconciler explicitly");
assert.match(terraform, /CREATE USER IF NOT EXISTS 'deployguard'@'%'[\s\S]*?ALTER USER 'deployguard'@'%'[\s\S]*?GRANT ALL PRIVILEGES ON \\`application\\`\.\* TO 'deployguard'@'%'/, "managed MySQL must reconcile the application account for changing ECS task IPs");
assert.match(terraform, /mysqladmin --protocol=SOCKET --socket=\/var\/run\/mysqld\/mysqld\.sock -uroot[\s\S]*?mysql --protocol=SOCKET --socket=\/var\/run\/mysqld\/mysqld\.sock -uroot/, "managed MySQL grant reconciliation must use the task-local root socket so persisted host grants cannot block repair");
assert.match(terraform, /dynamic "volume"[\s\S]*?content \{ name = "mysql-runtime" \}/, "managed MySQL must define a task-local socket volume");
assert.equal((terraform.match(/sourceVolume = "mysql-runtime", containerPath = "\/var\/run\/mysqld"/g) || []).length, 2, "the managed MySQL database and grant reconciler must both mount the task-local socket volume");
assert.match(terraform, /local\.database_engine == "mysql" \? \[\{/, "the MySQL grant reconciler must exist only for managed MySQL");
assert.match(terraform, /dependsOn\s+=\s+\[\{ containerName = "database", condition = "HEALTHY" \}\][\s\S]*?MYSQL_ROOT_PASSWORD/, "the MySQL grant reconciler must wait for database health and receive only managed credentials");
assert.doesNotMatch(workflow, /deployguard-apply-failure/, "managed-database readiness evidence must no longer be tunneled through Terraform apply failure handling");
assert.match(workflow, /terraform .* plan .*DG_TERRAFORM_PLAN_FAILED stage=terraform_plan/, "Terraform plan failures must not be mislabeled as apply failures");
assert.doesNotMatch(workflow.match(/terraform .* plan[^\n]+/)?.[0] || "", /DG_TERRAFORM_APPLY_FAILED/, "Terraform plan and apply failure boundaries remain distinct");
assert.doesNotMatch(databaseReadiness, /DG_ECS_STABILITY_FAILED/, "database prerequisite failure must not be attributed to application ECS convergence");
assert.deepEqual(
  classifyStructuredFailure("managed_database_readiness", "DG_FAILURE serviceId=33333333-3333-4333-8333-333333333333 code=DG_MANAGED_DATABASE_READINESS_FAILED stage=managed_database_readiness"),
  { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null, failureCode: "DG_MANAGED_DATABASE_READINESS_FAILED", failureServiceId: "33333333-3333-4333-8333-333333333333" },
);
assert.deepEqual(
  classifyStructuredFailure("managed_database_readiness", "DG_FAILURE serviceId=33333333-3333-4333-8333-333333333333 code=DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED stage=managed_database_readiness"),
  { failureOwner: "DEPLOYGUARD_PLATFORM", externalProvider: null, failureCode: "DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED", failureServiceId: "33333333-3333-4333-8333-333333333333" },
);
assert.deepEqual(
  classifyStructuredFailure("ecs_stability", 'DG_ECS_DIAGNOSTICS {"containerExitCode":1,"stoppedTaskReason":"Essential container exited"}\nDG_FAILURE serviceId=33333333-3333-4333-8333-333333333333 code=DG_ECS_STABILITY_FAILED stage=ecs_stability'),
  { failureOwner: "REPOSITORY_APPLICATION", externalProvider: null, failureCode: "DG_ECS_STABILITY_FAILED", failureServiceId: "33333333-3333-4333-8333-333333333333" },
  "a genuine application failure after database readiness must retain application ECS failure semantics",
);

function executeDatabaseReadiness(engine: ManagedDatabaseEngine, mode: "later_ready" | "never_ready" | "mysql_grant_pending" | "mysql_grant_failed") {
  const directory = mkdtempSync(join(tmpdir(), "deployguard-database-readiness-"));
  const bin = join(directory, "bin");
  const marker = join(directory, "failure-marker");
  const counter = join(directory, "counter");
  const releaseCounter = join(directory, "release-counter");
  mkdirSync(bin);
  const aws = join(bin, "aws");
  writeFileSync(aws, `#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  "ecs list-tasks") printf '%s\\n' '{"taskArns":["database-task"]}' ;;
  "ecs describe-tasks")
    count=0; [ ! -f "$READINESS_COUNTER" ] || count="$(<"$READINESS_COUNTER")"; count=$((count + 1)); printf '%s' "$count" > "$READINESS_COUNTER"
    health=UNKNOWN; [ "$READINESS_MODE" != later_ready ] && [ "$READINESS_MODE" != mysql_grant_pending ] && [ "$READINESS_MODE" != mysql_grant_failed ] || [ "$count" -lt 2 ] || health=HEALTHY
    grant='[]'
    if [ "$DATABASE_ENGINE" = mysql ] && [ "$health" = HEALTHY ]; then
      case "$READINESS_MODE" in
        later_ready) grant='[{"name":"deployguard-mysql-grant-reconciler","lastStatus":"STOPPED","exitCode":0}]' ;;
        mysql_grant_pending) grant='[{"name":"deployguard-mysql-grant-reconciler","lastStatus":"RUNNING","exitCode":null}]' ;;
        mysql_grant_failed) grant='[{"name":"deployguard-mysql-grant-reconciler","lastStatus":"STOPPED","exitCode":1,"reason":"grant failed"}]' ;;
      esac
    fi
    jq -cn --arg task "$DATABASE_TASK_DEFINITION_ARN" --arg health "$health" --argjson grant "$grant" '{tasks:[{taskDefinitionArn:$task,lastStatus:"RUNNING",healthStatus:$health,containers:([{name:"database",lastStatus:"RUNNING",healthStatus:$health}] + $grant)}]}' ;;
  "ecs update-service") printf '1' >> "$RELEASE_COUNTER"; printf '%s\n' '{"service":{"serviceName":"application","desiredCount":1}}' ;;
  *) exit 2 ;;
esac
`, "utf8");
  chmodSync(aws, 0o755);
  const result = spawnSync("bash", ["-c", `
set -euo pipefail
append_outcome() { printf 'DG_FAILURE serviceId=%s code=%s stage=%s\n' "$1" "$3" "$5" > "$FAILURE_MARKER"; }
attach_diagnostics() { :; }
sanitize() { cat; }
configuration_failure() { return 1; }
provider_failure() { return 1; }
${databaseReadiness}
wait_for_managed_database_readiness "33333333-3333-4333-8333-333333333333" cluster database "database-task-definition:1" "$DATABASE_ENGINE"
release_database_attached_service "33333333-3333-4333-8333-333333333333" cluster application
`], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DATABASE_TASK_DEFINITION_ARN: "database-task-definition:1",
      DATABASE_ENGINE: engine,
      DEPLOYGUARD_DATABASE_READINESS_MAX_ATTEMPTS: "3",
      DEPLOYGUARD_DATABASE_READINESS_INTERVAL_SECONDS: "0",
      FAILURE_MARKER: marker,
      READINESS_COUNTER: counter,
      RELEASE_COUNTER: releaseCounter,
      READINESS_MODE: mode,
    },
  });
  const attempts = Number(readFileSync(counter, "utf8"));
  const failureMarker = result.status === 0 ? null : readFileSync(marker, "utf8").trim();
  const releases = existsSync(releaseCounter) ? readFileSync(releaseCounter, "utf8").length : 0;
  rmSync(directory, { recursive: true, force: true });
  return { result, attempts, failureMarker, releases };
}

const mysqlGrantPending = executeDatabaseReadiness("mysql", "mysql_grant_pending");
assert.notEqual(mysqlGrantPending.result.status, 0, "a healthy MySQL container must not release applications before the host-grant reconciliation completes");
assert.equal(mysqlGrantPending.attempts, 3, "MySQL grant reconciliation remains bounded by the database readiness policy");
assert.equal(mysqlGrantPending.releases, 0, "a pending MySQL grant never releases the attached application");
assert.match(mysqlGrantPending.failureMarker || "", /code=DG_MANAGED_DATABASE_READINESS_FAILED stage=managed_database_readiness/);
const mysqlGrantFailed = executeDatabaseReadiness("mysql", "mysql_grant_failed");
assert.notEqual(mysqlGrantFailed.result.status, 0, "a failed MySQL host-grant reconciliation must block dependent application services");
assert.equal(mysqlGrantFailed.releases, 0, "a rejected MySQL grant never releases the attached application");
assert.match(mysqlGrantFailed.failureMarker || "", /code=DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED stage=managed_database_readiness/);
for (const engine of ["postgres", "mysql", "mongodb"] as ManagedDatabaseEngine[]) {
  const converged = executeDatabaseReadiness(engine, "later_ready");
  assert.equal(converged.result.status, 0, `${engine} readiness must continue until the engine becomes healthy: ${converged.result.stderr}`);
  assert.equal(converged.attempts, 2, `${engine} readiness must not release the application on the first unhealthy observation`);
  assert.equal(converged.releases, 1, `${engine} readiness releases the attached application exactly once after convergence`);
  const timedOut = executeDatabaseReadiness(engine, "never_ready");
  assert.notEqual(timedOut.result.status, 0, `${engine} readiness must fail after its bounded deadline`);
  assert.equal(timedOut.attempts, 3, `${engine} readiness must stop at the configured bound`);
  assert.equal(timedOut.releases, 0, `${engine} timeout must leave the attached application stopped`);
  assert.match(timedOut.failureMarker || "", /code=DG_MANAGED_DATABASE_READINESS_FAILED stage=managed_database_readiness/);
  assert.doesNotMatch(timedOut.result.stderr, /DG_ECS_STABILITY_FAILED/);
}

const serviceVerificationLoop = runtimeVerification.match(/verification_failed="\$database_failed"[\s\S]*?done < <\(jq -c '\.services \| to_entries\[\]' "\$outputs"\)/)?.[0] || "";
assert.ok(serviceVerificationLoop, "the database/service failure-isolation loop must be extractable");
function executeServiceIsolation(databasePresent: boolean) {
  const directory = mkdtempSync(join(tmpdir(), "deployguard-database-isolation-"));
  const outputsPath = join(directory, "outputs.json");
  const observedPath = join(directory, "verified-services");
  writeFileSync(outputsPath, JSON.stringify({ services: {
    "33333333-3333-4333-8333-333333333333": {},
    "55555555-5555-4555-8555-555555555555": {},
  } }), "utf8");
  const result = spawnSync("bash", ["-c", `
set -euo pipefail
outputs="$1"; observed="$2"
database_failed="$3"; database_id="33333333-3333-4333-8333-333333333333"
verify_service() { jq -r '.key' <<<"$1" >> "$observed"; }
${serviceVerificationLoop}
`, "_", outputsPath, observedPath, databasePresent ? "true" : "false"], { encoding: "utf8" });
  const verified = existsSync(observedPath) ? readFileSync(observedPath, "utf8").trim().split("\n") : [];
  rmSync(directory, { recursive: true, force: true });
  return { result, verified };
}
const isolatedDatabaseFailure = executeServiceIsolation(true);
assert.equal(isolatedDatabaseFailure.result.status, 0, isolatedDatabaseFailure.result.stderr);
assert.deepEqual(isolatedDatabaseFailure.verified, ["55555555-5555-4555-8555-555555555555"], "database failure skips only the attached service and still verifies unrelated services");
const noDatabasePath = executeServiceIsolation(false);
assert.equal(noDatabasePath.result.status, 0, noDatabasePath.result.stderr);
assert.deepEqual(noDatabasePath.verified.sort(), ["33333333-3333-4333-8333-333333333333", "55555555-5555-4555-8555-555555555555"], "no-database deployments bypass the database barrier and verify every service");
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
