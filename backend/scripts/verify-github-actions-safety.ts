import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertInitialGithubActionsIdentity,
  environmentReferencesBase64,
  GITHUB_ACTIONS_INPUT_NAMES,
  GITHUB_ACTIONS_CALLER_INPUT_NAMES,
  GithubActionsOperationContractError,
  GithubActionsOperationInputs,
  immutableDispatchFingerprint,
  immutableImageTag,
  requireRetryInputs,
  retryOperationEligibility,
} from "../src/projects/github-actions-operation-contract";
import { githubWorkflowDispatchInputs, GithubActionsDispatchError, GithubActionsService } from "../src/projects/pipeline/github-actions.service";
import { renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";

const project = { id: "11111111-2222-4333-8444-555555555555", repositoryFullName: "owner/repository", targetBranch: "main" };
const commit = "0123456789abcdef0123456789abcdef01234567";
const profile = { ...project, projectId: project.id, id: "profile-v1", commitSha: commit, inputFingerprint: "profile-fingerprint" };
const contract = {
  projectId: project.id,
  commitSha: commit,
  detectionSourceCommit: commit,
  contractHash: "contract-fingerprint",
  port: 3000,
  healthPath: "/health",
  appRoot: ".",
  dockerTemplate: "node",
  dockerStrategy: "generated",
  generatedDockerfile: "FROM node:20",
  runtimeType: "server",
  outputDirectory: null,
  ecsPlan: { environmentMappings: [{ name: "PORT" }, { name: "PUBLIC_URL" }], secretMappings: [{ name: "DATABASE_URL" }] },
};

function code(work: () => unknown) {
  try { work(); } catch (error) {
    assert.ok(error instanceof GithubActionsOperationContractError);
    return error.code;
  }
  assert.fail("Expected immutable contract rejection.");
}

assert.doesNotThrow(() => assertInitialGithubActionsIdentity(project, profile, contract, commit));
assert.equal(code(() => assertInitialGithubActionsIdentity(project, { ...profile, repositoryFullName: "other/repository" }, contract, commit)), "wrong_repository");
assert.equal(code(() => assertInitialGithubActionsIdentity(project, { ...profile, targetBranch: "release" }, contract, commit)), "wrong_branch");
assert.equal(code(() => assertInitialGithubActionsIdentity(project, profile, contract, "f".repeat(40))), "stale_commit");
assert.equal(code(() => assertInitialGithubActionsIdentity(project, profile, { ...contract, projectId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, commit)), "cross_project_contract");

const operationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const references = environmentReferencesBase64(contract);
const decodedReferences = JSON.parse(Buffer.from(references, "base64").toString("utf8"));
assert.deepEqual(decodedReferences.public, ["PORT", "PUBLIC_URL"]);
assert.deepEqual(decodedReferences.secret, ["DATABASE_URL"]);
assert.doesNotMatch(Buffer.from(references, "base64").toString("utf8"), /password|token-value|secret-value/i, "environment evidence must contain names, never values");

const inputs = Object.fromEntries(GITHUB_ACTIONS_INPUT_NAMES.map((name) => [name, "value"])) as GithubActionsOperationInputs;
Object.assign(inputs, {
  deployment_action: "deploy",
  deployment_operation_id: operationId,
  project_id: project.id,
  repository_full_name: project.repositoryFullName,
  repository_branch: project.targetBranch,
  commit_sha: commit,
  image_tag: immutableImageTag(commit, operationId),
  environment_references_base64: references,
  app_port: "3000",
});
const deployDispatchInputs = githubWorkflowDispatchInputs({
  ...inputs,
  build_time_public_config_base64: "",
  rollback_source_operation_id: "",
  rollback_image_uri: "",
  rollback_task_definition_arn: "",
})!;
assert.ok(Object.keys(deployDispatchInputs).length <= 25, "deploy remains below GitHub's 25-property limit");
assert.equal(GITHUB_ACTIONS_CALLER_INPUT_NAMES.length, 21, "canonical caller contract remains below GitHub's limit");
assert.equal("rollback_image_uri" in deployDispatchInputs, false);
const rollbackDispatchInputs = githubWorkflowDispatchInputs({
  ...inputs,
  generated_dockerfile_base64: "",
  build_time_public_config_base64: "",
})!;
assert.ok(Object.keys(rollbackDispatchInputs).length <= 25, "rollback packs immutable groups below GitHub's limit");
assert.deepEqual(JSON.parse(rollbackDispatchInputs.rollback_release_json), {
  sourceOperationId: "value",
  imageUri: "value",
  taskDefinitionArn: "value",
});
assert.throws(
  () => githubWorkflowDispatchInputs({ rollback_source_operation_id: "value", rollback_image_uri: "", rollback_task_definition_arn: "" }),
  (error: unknown) => error instanceof GithubActionsDispatchError && error.safeDetail === "Immutable rollback dispatch evidence is incomplete.",
);
const metadata = { immutableDispatchInputs: inputs, immutableDispatchFingerprint: immutableDispatchFingerprint(inputs) };
assert.strictEqual(requireRetryInputs(metadata, {
  operationId,
  projectId: project.id,
  repositoryFullName: project.repositoryFullName,
  targetBranch: project.targetBranch,
  commitSha: commit,
}), inputs, "retry must use the exact stored operation snapshot");
assert.equal(code(() => requireRetryInputs(metadata, {
  operationId,
  projectId: project.id,
  repositoryFullName: project.repositoryFullName,
  targetBranch: project.targetBranch,
  commitSha: "f".repeat(40),
})), "stale_commit", "retry must not accept a newer commit");
assert.equal(code(() => requireRetryInputs({ ...metadata, immutableDispatchInputs: { ...inputs, project_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" } }, {
  operationId,
  projectId: project.id,
  repositoryFullName: project.repositoryFullName,
  targetBranch: project.targetBranch,
  commitSha: commit,
})), "immutable_snapshot_tampered");
assert.equal(code(() => requireRetryInputs({}, {
  operationId,
  projectId: project.id,
  repositoryFullName: project.repositoryFullName,
  targetBranch: project.targetBranch,
  commitSha: commit,
})), "immutable_snapshot_missing");
assert.equal(retryOperationEligibility({
  id: operationId,
  projectId: project.id,
  repositoryFullName: project.repositoryFullName,
  targetBranch: project.targetBranch,
  commitSha: commit,
  currentStage: "workflow_run_discovery",
  githubWorkflowRunId: null,
  githubWorkflowStatus: "run_not_found",
  metadata: { deploymentAction: "destroy" },
}, project), "undispatched_destroy_recovery", "an undispatched Destroy whose snapshot was lost before dispatch is safely recoverable");
assert.equal(retryOperationEligibility({
  id: operationId,
  projectId: project.id,
  repositoryFullName: project.repositoryFullName,
  targetBranch: project.targetBranch,
  commitSha: commit,
  currentStage: "workflow_dispatch",
  githubWorkflowRunId: null,
  githubWorkflowStatus: "not_dispatched",
  metadata: { deploymentAction: "destroy" },
}, project), "undispatched_destroy_recovery", "a failed Destroy admission with no GitHub request remains safely recoverable");
assert.equal(retryOperationEligibility({
  id: operationId,
  projectId: project.id,
  repositoryFullName: project.repositoryFullName,
  targetBranch: project.targetBranch,
  commitSha: commit,
  currentStage: "workflow_run_discovery",
  githubWorkflowRunId: "123456",
  githubWorkflowStatus: "failure",
  metadata: { deploymentAction: "destroy" },
}, project), "ineligible", "a Destroy that reached GitHub cannot reconstruct a missing immutable snapshot");

const root = join(__dirname, "../..");
const workflow = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const caller = readFileSync(join(root, "backend/src/projects/github-app.service.ts"), "utf8");
const deployment = readFileSync(join(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
const actions = readFileSync(join(root, "backend/src/projects/pipeline/github-actions.service.ts"), "utf8");
for (const name of GITHUB_ACTIONS_INPUT_NAMES) {
  assert.match(workflow, new RegExp(`^      ${name}:`, "m"), `reusable workflow input ${name}`);
}
assert.match(caller, /GITHUB_ACTIONS_WORKFLOW_INPUTS/, "caller input schema must use the central typed contract");
assert.match(workflow, /concurrency:[\s\S]*group: deployguard-\$\{\{ inputs\.project_id \}\}[\s\S]*cancel-in-progress: false/);
assert.match(workflow, /Validate immutable operation contract[\s\S]*GITHUB_REPOSITORY[\s\S]*GITHUB_REF_NAME[\s\S]*git rev-parse HEAD/);
assert.match(workflow, /describe-images[\s\S]*imageDetails\[0\]\.imageDigest[\s\S]*@\$IMAGE_DIGEST/);
assert.doesNotMatch(workflow, /set -x|\$\{\{\s*secrets\.|echo .*BUILD_TIME_PUBLIC_CONFIG_BASE64|echo .*ENVIRONMENT_REFERENCES_BASE64/, "workflow must not log credentials or encoded configuration values");

const initialSave = deployment.indexOf("const operation = await runRepository.save");
const scheduling = deployment.indexOf("await this.scheduleOperation", initialSave);
assert.ok(initialSave >= 0 && scheduling > initialSave, "queued operation must be persisted before scheduling");
const trigger = deployment.indexOf("this.actions.triggerWorkflow", scheduling);
const runId = deployment.indexOf("operation.githubWorkflowRunId = result.workflowRunId", trigger);
const runIdSave = deployment.indexOf("await runRepository.save(operation)", runId);
assert.ok(trigger > scheduling && runId > trigger && runIdSave > runId, "returned workflow run ID must be saved immediately");
const retry = deployment.slice(deployment.indexOf("private async redispatch"), deployment.indexOf("private async scheduleOperation"));
const retryAdmission = deployment.slice(deployment.indexOf("async retry("), deployment.indexOf("async resetAndDeployFresh"));
assert.match(retryAdmission, /retryOperationEligibility\(failed, project\)[\s\S]*"undispatched_destroy_recovery"[\s\S]*this\.dispatch\(user, projectId, runRepository, "destroy"[\s\S]*retryOfOperationId: failed\.id/, "an undispatched Destroy reconstructs a new linked immutable snapshot through the normal Destroy preparation path");
assert.match(retry, /requireRetryInputs/);
assert.match(retry, /randomUUID\(\)[\s\S]*runRepository\.save\(runRepository\.create\([\s\S]*retryOfOperationId: operation\.id/, "retry must create a new immutable operation linked to the failed attempt");
assert.match(retry, /id: operationId, projectId: project\.id, generationId/, "retry persists a new operation in the failed operation's active generation");
assert.match(retry, /\.\.\.\(operation\.metadata \|\| \{\}\)/, "retry preserves the persisted deploymentAction");
assert.match(retry, /retryInputs\.deployment_action === "destroy"[\s\S]*await this\.scheduleNewOperation/, "failed Destroy keeps deployment_action=destroy and durably completes dispatch before returning");
assert.doesNotMatch(retry, /schedulePersistedOperation|setImmediate/, "Destroy retry must not defer dispatch until after the accepted response");
assert.doesNotMatch(retry, /resolveRemoteCommit|requireForProject/, "retry must not load mutable commit or deployment-contract evidence");
assert.match(deployment, /pg_advisory_lock/);
assert.match(deployment, /if \(active\) return this\.result\("no_op"/, "duplicate clicks must be idempotent");
assert.match(deployment, /ServiceUnavailableException\(\{ code: error\.diagnosticCode/);
assert.match(actions, /workflow_file_missing/);
assert.match(actions, /wrong_branch/);
assert.match(actions, /safeDispatchFailureDetail/);
assert.match(deployment, /error\.safeDetail/);
assert.doesNotMatch(actions, /safeDetail:[^\n]*input\.inputs|JSON\.stringify\(input\.inputs\)/, "dispatch evidence must not persist input values");

async function verifyDispatchFailures() {
  const missing = new GithubActionsService({ get: () => "" } as never);
  await assert.rejects(
    missing.triggerWorkflow({ repositoryFullName: project.repositoryFullName, targetBranch: project.targetBranch, token: "redacted-token" }),
    (error: unknown) => error instanceof GithubActionsDispatchError && error.diagnosticCode === "workflow_file_missing" && !error.message.includes("redacted-token"),
  );

  const service = new GithubActionsService({ get: (_key: string, fallback: string) => fallback } as never);
  const originalFetch = global.fetch;
  const generatedCaller = renderDeployguardCallerWorkflow("owner/control/.github/workflows/deployguard-reusable.yml@0123456789abcdef0123456789abcdef01234567");
  global.fetch = (async (request: string | URL | Request, init?: RequestInit) => {
    const url = String(request);
    if ((init?.method || "GET") === "POST") return Response.json({ message: "internal failure" }, { status: 500 });
    if (url.includes("/contents/.github/workflows/deployguard.yml")) return Response.json({ encoding: "base64", content: Buffer.from(generatedCaller).toString("base64") });
    if (/\/actions\/workflows\/deployguard\.yml$/.test(url)) return Response.json({ state: "active" });
    if (url.includes("/runs?")) return Response.json({ workflow_runs: [] });
    return Response.json({ id: 1 });
  }) as typeof fetch;
  try {
    await assert.rejects(
      service.triggerWorkflow({ repositoryFullName: project.repositoryFullName, targetBranch: project.targetBranch, token: "redacted-token", inputs }),
      (error: unknown) => error instanceof GithubActionsDispatchError && error.diagnosticCode === "unknown_github_error" && !error.message.includes("redacted-token"),
    );
  } finally {
    global.fetch = originalFetch;
  }
}

void verifyDispatchFailures().then(() => {
  console.log("Iteration 6 GitHub Actions safety checks passed: immutable identity, parity, idempotency, immutable retry lineage, dispatch ordering, digest pinning and structured failures.");
}).catch((error) => {
  console.error(error instanceof Error ? error.message : "GitHub Actions safety verification failed.");
  process.exitCode = 1;
});
