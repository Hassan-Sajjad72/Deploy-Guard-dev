import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";
import { RAILPACK_WORKFLOW_INPUTS } from "../src/projects/railpack-workflow-contract";
import { GithubActionsDispatchError, GithubActionsService } from "../src/projects/pipeline/github-actions.service";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { GithubActionsRuntimeSecretService, RuntimeSecretMaterialization, RuntimeSecretMaterializationPort } from "../src/projects/github-actions-runtime-secret.service";

const operationId = "11111111-1111-4111-8111-111111111111";
const otherOperationId = "22222222-2222-4222-8222-222222222222";
const inputs = Object.fromEntries(RAILPACK_WORKFLOW_INPUTS.map(({ name }) => [name, `${name}-value`]));
Object.assign(inputs, { repository_full_name: "fixture/application", repository_branch: "feature/selected", deployment_operation_id: operationId });
const caller = renderDeployguardCallerWorkflow(`fixture/control-plane/.github/workflows/deployguard-reusable.yml@${"a".repeat(40)}`);
const run = (id: number, title = `DeployGuard ${operationId}`, extra: Record<string, unknown> = {}) => ({
  id, display_title: title, created_at: new Date().toISOString(), event: "workflow_dispatch", head_branch: "main", ...extra,
});

async function scenario(options: {
  receiptId?: number;
  pages?: Record<string, unknown>[][];
  discoveryStatus?: number;
  discoveryThrows?: boolean;
  malformedListing?: boolean;
  rawListing?: string;
  totalCount?: number;
  endlessPagination?: boolean;
}, verify: (service: GithubActionsService, posts: () => number) => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const originalTimeout = globalThis.setTimeout;
  let posts = 0;
  globalThis.setTimeout = ((callback: () => void) => { queueMicrotask(callback); return 0; }) as unknown as typeof setTimeout;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/dispatches")) {
      posts += 1;
      assert.equal(JSON.parse(String(init?.body)).ref, "main");
      return options.receiptId
        ? new Response(JSON.stringify({ workflow_run_id: options.receiptId, html_url: "https://untrusted.invalid/receipt" }), { status: 200 })
        : new Response(null, { status: 204 });
    }
    if (url.includes("/runs?")) {
      if (options.discoveryThrows) throw new Error("fixture transport failure");
      const page = Number(new URL(url).searchParams.get("page") || 1);
      const pages = options.pages || [[]];
      return new Response(options.rawListing ?? (options.malformedListing ? "{" : JSON.stringify({ workflow_runs: pages[page - 1] || [], total_count: options.totalCount })), {
        status: options.discoveryStatus || 200,
        headers: page < pages.length || options.endlessPagination ? { link: '<https://api.github.com/ignored>; rel="next"' } : {},
      });
    }
    if (url.includes("/contents/")) return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(caller).toString("base64") }));
    return new Response(JSON.stringify({ state: "active" }));
  };
  try {
    const service = new GithubActionsService(new ConfigService({ GITHUB_ACTIONS_WORKFLOW_FILE: "deployguard.yml" }));
    await verify(service, () => posts);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalTimeout;
  }
}

const dispatch = (service: GithubActionsService, options: { excludedIds?: string[]; operation?: string } = {}) => service.triggerWorkflow({
  repositoryFullName: "fixture/application", targetBranch: "feature/selected", workflowRegistrationBranch: "main", token: "fixture-token",
  inputs: { ...inputs, deployment_operation_id: options.operation ?? operationId }, excludedWorkflowRunIds: options.excludedIds,
});
const identityError = (error: unknown) => error instanceof GithubActionsDispatchError
  && error.diagnosticCode === "workflow_run_identity_missing" && error.dispatchMayHaveOccurred;

async function verifyAcceptedDiscoveryFailure(service: GithubActionsService, posts: () => number) {
  let failure: GithubActionsDispatchError;
  await assert.rejects(() => dispatch(service), (error: unknown) => {
    assert.ok(error instanceof GithubActionsDispatchError, "accepted discovery errors must retain the typed dispatch boundary");
    assert.equal(error.diagnosticCode, "workflow_run_identity_missing");
    assert.equal(error.dispatchMayHaveOccurred, true, "an accepted POST cannot become safe to compensate");
    failure = error;
    return true;
  });
  assert.equal(posts(), 1, "malformed discovery must never redispatch the accepted operation");

  // Exercise the production Railpack compensation gate with the actual error.
  // The SDK service uses only a rejecting local port; no AWS client is created.
  let providerCalls = 0;
  const forbidden = async (): Promise<never> => { providerCalls += 1; throw new Error("Provider calls are forbidden in this fixture."); };
  const port: RuntimeSecretMaterializationPort = {
    describe: forbidden, create: forbidden, restore: forbidden, put: forbidden, activateVersion: forbidden, delete: forbidden,
  };
  const runtimeSecrets = Object.create(GithubActionsRuntimeSecretService.prototype) as GithubActionsRuntimeSecretService;
  let portCalls = 0;
  Object.defineProperty(runtimeSecrets, "port", { value: () => { portCalls += 1; return port; } });
  const authority = Object.create(RailpackDeploymentService.prototype) as {
    runtimeSecrets: GithubActionsRuntimeSecretService;
    compensateProvisionalRuntimeSecrets(materializations: RuntimeSecretMaterialization[], remoteDispatchPossible: boolean): Promise<unknown>;
  };
  authority.runtimeSecrets = runtimeSecrets;
  const candidate: RuntimeSecretMaterialization = {
    secretArn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture-abcdef", secretName: "fixture",
    secretNames: ["TOKEN"], valueFromByName: {}, versionToken: "a".repeat(64), provisionalChange: "created", previousVersionToken: null,
  };
  const remoteDispatchPossible = failure instanceof GithubActionsDispatchError && failure.dispatchMayHaveOccurred;
  assert.deepEqual(await authority.compensateProvisionalRuntimeSecrets([candidate], remoteDispatchPossible), { skipped: "remote_dispatch_possible" });
  assert.equal(portCalls, 0, "the actual Railpack gate must not enter runtime-secret compensation");
  assert.equal(providerCalls, 0, "accepted dispatch uncertainty must perform zero secret provider calls");
}

async function verify() {
  await scenario({ receiptId: 10, pages: [[run(30, `DeployGuard ${otherOperationId}`), run(20)]] }, async (service) => {
    const result = await dispatch(service, { excludedIds: ["10"] });
    assert.equal(result.workflowRunId, "20", "a stale receipt cannot attach an overlapping operation's recent run");
    assert.equal(result.receipt.workflowRunUrl, "https://github.com/fixture/application/actions/runs/20");
  });
  await scenario({ receiptId: 30, pages: [[run(30, `DeployGuard ${otherOperationId}`), run(20)]] }, async (service) => {
    assert.equal((await dispatch(service)).workflowRunId, "20", "even a non-excluded numeric receipt must correlate to the operation");
  });
  await scenario({ pages: [[run(30, `DeployGuard ${otherOperationId}`)], [run(20)]] }, async (service) => {
    assert.equal((await dispatch(service)).workflowRunId, "20", "empty receipt recovery must inspect later result pages");
  });
  await scenario({ pages: [[run(20), run(21)]] }, async (service, posts) => {
    await assert.rejects(() => dispatch(service), identityError, "multiple operation matches must remain ambiguous");
    assert.equal(posts(), 1, "identity uncertainty must not send another dispatch");
  });
  await scenario({ pages: [[run(20)], [run(21)]] }, async (service) => {
    await assert.rejects(() => dispatch(service), identityError, "duplicates across pages cannot choose the first match");
  });
  await scenario({ receiptId: 30, pages: [[run(30, `DeployGuard ${otherOperationId}`)]] }, async (service, posts) => {
    await assert.rejects(() => dispatch(service), identityError, "unrelated runs cannot substitute for missing operation identity");
    assert.equal(posts(), 1);
  });
  await scenario({ pages: [[run(20), run(21)]] }, async (service) => {
    assert.equal(await service.findWorkflowRunForOperation("fixture/application", "main", operationId, new Date(), "fixture-token", ["20"]), "21");
    await assert.rejects(() => service.findWorkflowRunForOperation("fixture/application", "main", operationId, new Date(), "fixture-token"), identityError, "interrupted dispatch recovery must reject ambiguity too");
  });
  await scenario({ pages: [[run(20, undefined, { created_at: "2000-01-01T00:00:00Z" }), run(21, undefined, { head_branch: "other" }), run(22, undefined, { event: "push" })]] }, async (service) => {
    assert.equal(await service.findWorkflowRunForOperation("fixture/application", "main", operationId, new Date(), "fixture-token"), null, "old, wrong-branch and wrong-event matches cannot bind");
  });
  await scenario({ discoveryStatus: 403 }, async (service, posts) => {
    await assert.rejects(() => dispatch(service), (error: unknown) => error instanceof GithubActionsDispatchError && error.dispatchMayHaveOccurred);
    assert.equal(posts(), 1, "observation failure keeps accepted dispatch recoverable");
  });
  for (const observationFailure of [{ discoveryThrows: true }, { malformedListing: true }]) {
    await scenario(observationFailure, async (service, posts) => {
      await assert.rejects(() => dispatch(service), (error: unknown) => error instanceof GithubActionsDispatchError && error.dispatchMayHaveOccurred);
      assert.equal(posts(), 1, "transport and parse failures cannot make an accepted operation retryable");
    });
  }
  const malformedListings: unknown[] = [
    null, [], [run(20)], {}, { workflow_runs: {} }, { workflow_runs: null },
    { workflow_runs: [null] }, { workflow_runs: [[]] }, { workflow_runs: [[run(20)]] },
    ...[{}, [], [1], { valueOf: null, toString: null }, { count: { value: 1 } }, "1", null, false, -1, 0.5]
      .map((total_count) => ({ workflow_runs: [run(20)], total_count })),
    ...[{}, [], ["20"], { toString: null }, { valueOf: null, toString: null }, true, null, 0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]
      .map((id) => ({ workflow_runs: [run(20), run(21, undefined, { id })], total_count: 2 })),
    ...[{}, [], [new Date().toISOString()], null, 1, "not-a-date"]
      .map((created_at) => ({ workflow_runs: [run(20, undefined, { created_at })] })),
    ...[{ display_title: [`DeployGuard ${operationId}`] }, { event: {} }, { head_branch: ["main"] }]
      .map((fields) => ({ workflow_runs: [run(20, undefined, fields)] })),
  ];
  for (const listing of malformedListings) {
    await scenario({ rawListing: JSON.stringify(listing) }, verifyAcceptedDiscoveryFailure);
  }
  for (const unexpected of [new TypeError("PRIVATE_DISCOVERY_ERROR"), new GithubActionsDispatchError("unknown_github_error", "PRIVATE_DISCOVERY_ERROR")]) {
    await scenario({}, async (service, posts) => {
      service.findWorkflowRunForOperation = async () => { throw unexpected; };
      await verifyAcceptedDiscoveryFailure(service, posts);
    });
  }
  await scenario({ pages: [[run(20, undefined, { id: "20" })]] }, async (service) => {
    assert.equal((await dispatch(service)).workflowRunId, "20", "valid string identities retain their exact value");
  });
  await scenario({ totalCount: 1_000, pages: [[run(20)]] }, async (service) => {
    await assert.rejects(() => dispatch(service), identityError, "GitHub's capped search cannot prove uniqueness");
  });
  await scenario({ endlessPagination: true, pages: [[run(20)]] }, async (service) => {
    await assert.rejects(() => dispatch(service), identityError, "a truncated listing cannot prove uniqueness");
  });
  await scenario({}, async (service, posts) => {
    await assert.rejects(() => dispatch(service, { operation: "not-an-operation" }), (error: unknown) => error instanceof GithubActionsDispatchError && error.diagnosticCode === "invalid_workflow_inputs" && !error.dispatchMayHaveOccurred);
    assert.equal(posts(), 0, "invalid operation identity must be rejected before remote dispatch");
  });
  console.log(`WORKFLOW_RUN_IDENTITY=PASS STALE_RECEIPT=1 UNTRUSTED_RECEIPT=1 OVERLAP=1 PAGINATION=1 AMBIGUITY=1 INTERRUPTED_RECOVERY=1 EXCLUSIONS=1 MISSING_IDENTITY=1 OBSERVATION_FAILURE=1 NO_REDISPATCH=1 MALFORMED_LISTINGS=${malformedListings.length} UNEXPECTED_DISCOVERY_ERRORS=2 RAILPACK_COMPENSATION_CALLS=0 AWS_CALLS=0`);
}

void verify().catch((error) => { console.error(error); process.exitCode = 1; });
