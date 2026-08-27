import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";
import { GITHUB_ACTIONS_CALLER_INPUT_NAMES, GITHUB_ACTIONS_INPUT_NAMES, GithubActionsOperationInputs } from "../src/projects/github-actions-operation-contract";
import { GithubActionsDispatchError, GithubActionsService, githubWorkflowDispatchInputs } from "../src/projects/pipeline/github-actions.service";

const repository = "Hassan-Sajjad72/react-pomodoro";
const branch = "master";
const operationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const token = "installation-token-must-never-survive";
const secretValue = "runtime-secret-must-never-survive";
const inputs = Object.fromEntries(GITHUB_ACTIONS_INPUT_NAMES.map((name) => [name, "value"])) as GithubActionsOperationInputs;
Object.assign(inputs, {
  deployment_operation_id: operationId,
  repository_full_name: repository,
  repository_branch: branch,
  environment_references_base64: secretValue,
  app_port: "8080",
  rollback_source_operation_id: "",
  rollback_image_uri: "",
  rollback_task_definition_arn: "",
});
const workflow = renderDeployguardCallerWorkflow("owner/control/.github/workflows/deployguard-reusable.yml@0123456789abcdef0123456789abcdef01234567");

function service() {
  return new GithubActionsService({ get: (key: string, fallback: unknown) => key === "GITHUB_ACTIONS_RUN_POLL_INTERVAL_MS" ? 0 : fallback } as never);
}

function mockGithub(dispatchStatus = 200, exposeRunIdentity = true) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const mock = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (init?.method === "POST") {
      return dispatchStatus === 200
        ? Response.json(exposeRunIdentity ? { workflow_run_id: 987654, html_url: "https://github.test/runs/987654" } : {}, { status: 200 })
        : Response.json({ message: "Invalid request. No more than 25 properties are allowed; 26 were supplied." }, { status: dispatchStatus });
    }
    if (url.includes("/contents/.github/workflows/deployguard.yml")) {
      return Response.json({ encoding: "base64", content: Buffer.from(workflow).toString("base64") });
    }
    if (/\/actions\/workflows\/deployguard\.yml$/.test(url)) return Response.json({ state: "active" });
    if (url.includes("/runs?")) return Response.json({ workflow_runs: [{ id: 123456, created_at: new Date().toISOString() }] });
    return Response.json({ id: 1 });
  }) as typeof fetch;
  return { mock, requests };
}

async function rejectedAt(status: number) {
  const original = global.fetch;
  const { mock } = mockGithub(status);
  global.fetch = mock;
  try {
    await service().triggerWorkflow({ repositoryFullName: repository, targetBranch: branch, token, inputs });
    assert.fail(`Expected HTTP ${status} rejection.`);
  } catch (error) {
    assert.ok(error instanceof GithubActionsDispatchError);
    assert.equal(error.evidence?.httpStatus, status);
    const serialized = JSON.stringify(error.evidence);
    assert.doesNotMatch(serialized, new RegExp(token));
    assert.doesNotMatch(serialized, new RegExp(secretValue));
  } finally { global.fetch = original; }
}

async function run() {
  const canonical = githubWorkflowDispatchInputs(inputs)!;
  assert.deepEqual(Object.keys(canonical).sort(), GITHUB_ACTIONS_CALLER_INPUT_NAMES.filter((name) => name !== "rollback_release_json").sort());
  assert.ok(GITHUB_ACTIONS_CALLER_INPUT_NAMES.length <= 25, "workflow_dispatch must stay within GitHub's 25-input limit");
  assert.equal("build_plan_base64" in canonical, false);
  assert.equal(typeof canonical.build_plan_contract_json, "string");
  await assert.rejects(
    service().triggerWorkflow({ repositoryFullName: "other/repository", targetBranch: branch, token, inputs }),
    (error: unknown) => error instanceof GithubActionsDispatchError && error.safeDetail === "Dispatch repository and ref do not match the immutable deployment snapshot.",
  );

  const original = global.fetch;
  const valid = mockGithub();
  global.fetch = valid.mock;
  const accepted = await service().triggerWorkflow({ repositoryFullName: repository, targetBranch: branch, token, inputs });
  global.fetch = original;
  assert.deepEqual(accepted, {
    status: "dispatch_accepted",
    workflowRunId: "987654",
    receipt: {
      httpStatus: 200,
      workflow: "deployguard.yml",
      repository,
      ref: branch,
      inputNames: Object.keys(canonical).sort(),
      operationId,
      apiVersion: "2026-03-10",
      authentication: "Bearer installation token",
      workflowRunId: "987654",
      workflowRunUrl: "https://github.test/runs/987654",
    },
  });
  const post = valid.requests.find((request) => request.init?.method === "POST");
  assert.ok(post);
  assert.match(post!.url, new RegExp(`/repos/${repository}/actions/workflows/deployguard\\.yml/dispatches$`));
  const body = JSON.parse(String(post!.init!.body));
  assert.equal(body.ref, branch);
  assert.deepEqual(Object.keys(body.inputs).sort(), Object.keys(canonical).sort());
  assert.equal(body.return_run_details, true);
  assert.equal(new Headers(post!.init!.headers).get("X-GitHub-Api-Version"), "2026-03-10");

  const staleIdentity = mockGithub();
  global.fetch = staleIdentity.mock;
  const corrected = await service().triggerWorkflow({
    repositoryFullName: repository,
    targetBranch: branch,
    token,
    inputs,
    excludedWorkflowRunIds: ["987654"],
  });
  global.fetch = original;
  assert.equal(corrected.workflowRunId, "123456", "an accepted continuation must never be rebound to its completed scan run");
  assert.equal(corrected.receipt.workflowRunId, "123456");
  assert.equal(corrected.receipt.workflowRunUrl, `https://github.com/${repository}/actions/runs/123456`);

  const missingIdentity = mockGithub(200, false);
  global.fetch = missingIdentity.mock;
  await assert.rejects(
    service().triggerWorkflow({ repositoryFullName: "Hassan-Sajjad72/smart-retail-pro", targetBranch: "main", token, inputs: { ...inputs, repository_full_name: "Hassan-Sajjad72/smart-retail-pro", repository_branch: "main" } }),
    (error: unknown) => error instanceof GithubActionsDispatchError && error.diagnosticCode === "workflow_run_identity_missing" && error.evidence?.httpStatus === 200,
  );
  global.fetch = original;

  for (const status of [401, 403, 404, 422]) await rejectedAt(status);
  const deploymentSource = readFileSync(join(__dirname, "../src/projects/github-actions-deployment.service.ts"), "utf8");
  const pipelineUi = readFileSync(join(__dirname, "../../frontend/src/components/projects/PipelineRecoveryPanel.jsx"), "utf8");
  assert.match(deploymentSource, /dispatchFailureEvidence:[\s\S]*dispatchFailureLog/);
  assert.match(deploymentSource, /safeLog:[\s\S]*dispatchFailureLog/);
  assert.doesNotMatch(deploymentSource, /schedulePersistedOperation|setImmediate\(\(\) => \{[\s\S]{0,300}scheduleOperation/, "Destroy dispatch must complete durably before the API reports acceptance");
  assert.match(deploymentSource, /if \(action === "destroy"\) \{[\s\S]*?await this\.scheduleNewOperation\(runRepository, operation, credential\.token, inputs\)/);
  assert.match(deploymentSource, /if \(retryInputs\.deployment_action === "destroy"\) \{[\s\S]*?await this\.scheduleNewOperation\(runRepository, retry, credential\.token, retryInputs\)/);
  assert.match(deploymentSource, /scheduleNewOperation[\s\S]*pg_advisory_lock[\s\S]*scheduleOperation[\s\S]*pg_advisory_unlock/, "initial dispatch and reconciliation must be serialized by operation identity");
  assert.match(deploymentSource, /operation\.githubWorkflowStatus === "dispatching" && !operation\.metadata\?\.dispatchAcceptedAt[\s\S]*dispatchAgeMs < 300_000[\s\S]*githubWorkflowStatus = "dispatch_interrupted"/, "reconciliation must preserve an in-flight dispatch and classify an interrupted dispatch truthfully");
  assert.match(deploymentSource, /dispatchStartedAt:[\s\S]*dispatchState: "dispatch_prepared"/, "the immutable snapshot must identify the prepared dispatch before network work");
  assert.match(pipelineUi, /Safe GitHub Actions evidence[\s\S]*operation\.safeLog/);
  assert.doesNotMatch(deploymentSource.match(/private dispatchFailureLog[\s\S]*?\n  }/)?.[0] || "", /environment_references_base64|Authorization|token/i);
  console.log("GitHub Actions dispatch regression checks passed: canonical 21-input caller, direct immutable run identity, serialized Destroy dispatch and safe HTTP failures.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
