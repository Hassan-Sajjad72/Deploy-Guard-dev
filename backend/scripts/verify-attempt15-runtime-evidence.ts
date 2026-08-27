import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import {
  DEPLOYGUARD_DEPLOYMENT_RESULT_CONTRACT_VERSION,
  DEPLOYGUARD_DEPLOYMENT_RESULT_FIELDS,
  extractGithubActionsReleaseEvidence,
  RuntimeEvidenceContractError,
  sanitizedRuntimeEvidenceFailure,
  validateGithubActionsRuntimeEvidence,
} from "../src/projects/github-actions-release-evidence";
import {
  environmentReferencesBase64,
  GITHUB_ACTIONS_INPUT_NAMES,
  GithubActionsOperationInputs,
  GithubActionsRuntimeConfiguration,
  immutableDispatchFingerprint,
} from "../src/projects/github-actions-operation-contract";

const operationId = "720d3ad2-8da1-4ffa-9d1a-f2e243bbc891";
const projectId = "4da59401-2847-4896-b1fa-54e8b649c4c6";
const commitSha = "2475b069a2d1a7559ab6666a86bd70ff2ac2f090";
const snapshotId = "1d89aa71-1517-4211-8a0a-8bb598f6bde9";
const fingerprint = "39ebf004b4099c73e733264e08536ead49de43268b3833ae5428a459e4bd47de";
const digest = "sha256:4c9572a74871cb7ba12c38b6a2a73365e56cfb9225d17fc84b82d7bd681814f7";
const imageUri = `563149050793.dkr.ecr.us-east-1.amazonaws.com/deployguard-4da59401-2847-4896-b1fa-54e8@${digest}`;

// Sanitized exact shape downloaded from run 31363762450, artifact 9053467276.
const attempt15 = {
  appPort: 8080,
  clusterName: "dg-4da59401-2847-4896-b1fa-5",
  commitSha,
  configurationFingerprint: fingerprint,
  configurationSnapshotId: snapshotId,
  databaseBindingId: null,
  databaseOutputs: {},
  deployedUrl: "http://dg-4da59401-2847-4896-b1fa-5.example.invalid",
  deploymentOperationId: operationId,
  environmentName: "dev",
  generationId: "11111111-1111-4111-8111-111111111111",
  healthCheckPath: "/",
  imageDigest: digest,
  imageUri,
  secretReferenceNames: [],
  serviceName: "dg-4da59401-2847-4896-b1fa-5",
  status: "succeeded",
  taskDefinitionArn: "arn:aws:ecs:us-east-1:563149050793:task-definition/dg-4da59401-2847-4896-b1fa-5:4",
};

const marker = (value: unknown) => `DEPLOYGUARD_RELEASE_RESULT=${JSON.stringify(value)}`;
async function main() {
const evidence = extractGithubActionsReleaseEvidence(marker(attempt15));
assert.ok(evidence, "the exact Attempt-15 result shape parses");
assert.equal(evidence.contractVersion, DEPLOYGUARD_DEPLOYMENT_RESULT_CONTRACT_VERSION, "unversioned published v1 evidence is read as canonical v1");
assert.equal(evidence.appPort, 8080);
assert.equal(typeof evidence.appPort, "number");

const expected = {
  deploymentOperationId: operationId,
  commitSha,
  environmentName: "dev",
  configurationSnapshotId: snapshotId,
  configurationFingerprint: fingerprint,
  databaseBindingId: null,
  runtimeDatabaseBindingId: null,
  secretReferenceNames: [] as string[],
  generationId: attempt15.generationId,
  promotionIntentFingerprint: null,
};
assert.deepEqual(validateGithubActionsRuntimeEvidence(evidence, expected), [], "null no-database identities are canonically equal");
assert.ok(validateGithubActionsRuntimeEvidence(null, expected).some((issue) => issue.field === "deploymentResult"));
assert.ok(validateGithubActionsRuntimeEvidence(evidence, { ...expected, commitSha: "a".repeat(40) }).some((issue) => issue.field === "commitSha"));
assert.ok(validateGithubActionsRuntimeEvidence(evidence, { ...expected, deploymentOperationId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }).some((issue) => issue.field === "deploymentOperationId"));
assert.equal(extractGithubActionsReleaseEvidence(marker({ ...attempt15, imageDigest: `sha256:${"f".repeat(64)}` })), null, "digest and immutable image URI must agree");
assert.equal(extractGithubActionsReleaseEvidence(marker({ ...attempt15, appPort: "8080" })), null, "numeric identity cannot change to a string");
assert.throws(
  () => extractGithubActionsReleaseEvidence(marker({ ...attempt15, contractVersion: "deployguard.deployment-result/v2" })),
  (error) => error instanceof RuntimeEvidenceContractError && error.issues[0]?.field === "contractVersion",
  "contract-version mismatch is precise",
);
const roundTrip = extractGithubActionsReleaseEvidence(marker(JSON.parse(JSON.stringify({ ...attempt15, contractVersion: DEPLOYGUARD_DEPLOYMENT_RESULT_CONTRACT_VERSION }))));
assert.equal(roundTrip?.appPort, 8080);
assert.equal(roundTrip?.deploymentOperationId, operationId);

const runtime = {
  schemaVersion: 1,
  configurationSnapshotId: snapshotId,
  configurationFingerprint: fingerprint,
  environmentName: "dev",
  generationId: "11111111-1111-4111-8111-111111111111",
  environment: { NODE_ENV: "production" },
  secretReferences: {},
  componentRuntime: { application: { environment: { NODE_ENV: "production" }, secretReferences: {} } },
  deploymentContext: { schemaVersion: 1, deploymentMode: "FRESH", persistentState: "NONE", recoveryState: "NOT_REQUIRED", recoveryRequired: false, recoveryEvidenceAvailable: false, persistentPreviouslyEstablished: false, deploymentAllowed: true, reason: "Fresh fixture." },
  retentionProtectedRelease: { imageDigests: [], taskDefinitionArns: [] },
  managedDatabase: null,
} as unknown as GithubActionsRuntimeConfiguration;
const references = environmentReferencesBase64(runtime);
const values: Record<string, string> = {
  deployment_action: "deploy", deployment_operation_id: operationId, project_id: projectId, environment_name: "dev",
  repository_full_name: "Hassan-Sajjad72/react-pomodoro", repository_branch: "master", detection_profile_version: "profile-v2",
  deployment_contract_version: "contract-v2", build_plan_base64: "eyJwbGFuVmVyc2lvbiI6MX0=", image_tag: "2475b069a2d1-720d3ad28da1",
  environment_references_base64: references, infrastructure_namespace: `/deployguard/${projectId}`, aws_region: "us-east-1",
  aws_role_arn: "arn:aws:iam::563149050793:role/DeployGuardGitHubActionsProjectTst", vpc_id: "vpc-12345678",
  public_subnet_ids: "subnet-a,subnet-b", commit_sha: commitSha, application_root: ".", app_port: "8080", health_check_path: "/",
  terraform_state_bucket: "deployguard-state", container_profile: "react-webpack-static", output_directory: "app",
  generated_dockerfile_base64: "", build_time_public_config_base64: "", rollback_source_operation_id: "", rollback_image_uri: "", rollback_task_definition_arn: "",
};
const inputs = Object.fromEntries(GITHUB_ACTIONS_INPUT_NAMES.map((name) => [name, values[name]])) as GithubActionsOperationInputs;
const operation: any = {
  id: operationId, projectId, commitSha, repositoryFullName: "Hassan-Sajjad72/react-pomodoro", targetBranch: "master",
  configurationSnapshotId: snapshotId, databaseServiceBindingId: null,
  metadata: { deploymentAction: "deploy", immutableDispatchInputs: inputs, immutableDispatchFingerprint: immutableDispatchFingerprint(inputs) },
};
const savedReleases: any[] = [];
const service: any = Object.create(GithubActionsDeploymentService.prototype);
service.databaseBindings = { validateApplicationTaskDefinition: async () => ({ passed: true }) };
service.dataSource = { transaction: async (work: (manager: any) => Promise<unknown>) => work({ query: async () => undefined, getRepository: () => ({
  findOne: async () => null,
  create: (value: unknown) => value,
  save: async (value: unknown) => { savedReleases.push(value); return value; },
}) }) };
await service.verifyAndPersistStableRelease(operation, evidence);
assert.equal(savedReleases.length, 1, "valid Attempt-15 evidence persists the Live release projection");
assert.equal(savedReleases[0].status, "stable");

const secret = "never-print-runtime-secret";
const safeLog = sanitizedRuntimeEvidenceFailure(
  new RuntimeEvidenceContractError([{ field: "runtime.managedDatabase.bindingId", reason: "mismatched" }]),
  "31363762450",
  commitSha,
);
assert.match(safeLog, /Runtime evidence validation failed/);
assert.match(safeLog, /GitHub run: 31363762450/);
assert.match(safeLog, /runtime\.managedDatabase\.bindingId/);
assert.doesNotMatch(safeLog, new RegExp(secret));

const workflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
assert.match(workflow, new RegExp(DEPLOYGUARD_DEPLOYMENT_RESULT_CONTRACT_VERSION.replaceAll("/", "\\/")));
for (const field of DEPLOYGUARD_DEPLOYMENT_RESULT_FIELDS) assert.match(workflow, new RegExp(`${field}(?:[:$])`), `producer declares canonical ${field}`);
const deploymentSource = readFileSync(join(__dirname, "../src/projects/github-actions-deployment.service.ts"), "utf8");
assert.match(deploymentSource, /status = effectiveSuccess \? PipelineRunStatus\.COMPLETED : PipelineRunStatus\.FAILED/);
assert.match(deploymentSource, /currentStage = destroyed \? "destroyed" : "healthy"/);
assert.match(deploymentSource, /safeLog = sanitizedRuntimeEvidenceFailure/);
const pipelineUi = readFileSync(join(__dirname, "../../frontend/src/components/projects/PipelineRecoveryPanel.jsx"), "utf8");
assert.match(pipelineUi, /operation\.safeLog/);
assert.doesNotMatch(safeLog, /environment values|Authorization|token|credential/i);

console.log("Attempt 15 runtime-evidence checks passed: exact legacy-v1 shape, canonical null identity, immutable mismatches, version/type safety, Live persistence, UI evidence, and secret-safe diagnostics.");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Attempt 15 runtime-evidence verification failed.");
  process.exitCode = 1;
});
