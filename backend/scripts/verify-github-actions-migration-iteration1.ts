import "reflect-metadata";
import { strict as assert } from "assert";
import { generateKeyPairSync } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { GithubAppService, DEPLOYGUARD_WORKFLOW_PATH } from "../src/projects/github-app.service";
import { authorizeGithubRepositoryInTrust, githubTrustAuthorizesRepository } from "../src/projects/github-actions-oidc-trust.service";
import { githubActionsStagePresentation } from "../src/projects/pipeline/github-actions-stage-presentation";
import { GITHUB_ACTIONS_CALLER_INPUT_NAMES, GITHUB_ACTIONS_INPUT_NAMES } from "../src/projects/github-actions-operation-contract";

async function run() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const configValues: Record<string, string> = {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "deployguard-test",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    DEPLOYGUARD_REUSABLE_WORKFLOW: "Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@830a641caf58d38600452a729498e16845b61943",
  };
  const rows: any[] = [];
  const repository = {
    findOne: async ({ where }: any) => rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) || null,
    find: async ({ where }: any) => rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
    create: (value: any) => value,
    save: async (value: any) => { const index = rows.findIndex((row) => row.ownerUserId === value.ownerUserId && row.installationId === value.installationId); const saved = { id: value.id || `installation-row-${value.ownerUserId}`, ...value }; if (index >= 0) rows[index] = saved; else rows.push(saved); return saved; },
  };
  const service = new GithubAppService(repository as never, { get: (key: string, fallback?: string) => configValues[key] ?? fallback } as never);
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  let workflowExists = false;
  let staleRemovalReads = 0;
  const originalFetch = global.fetch;
  const reusableWorkflowFixture = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method || "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
    if (url.endsWith("/app/installations?per_page=100")) return Response.json([{ id: 9001, account: { login: "sample-owner", id: 77 }, repository_selection: "all", suspended_at: null }]);
    if (url.endsWith("/app/installations/9001")) return Response.json({ account: { login: "sample-owner", id: 77 }, repository_selection: "all" });
    if (url === "https://api.github.com/installation/repositories?per_page=100") return Response.json({ repositories: [{ id: 10, full_name: "sample-owner/sample-app", name: "sample-app", default_branch: "main", private: true }] });
    if (url === "https://api.github.com/repos/sample-owner/sample-app") return Response.json({ id: 10, full_name: "sample-owner/sample-app" });
    if (url.includes("/repos/Hassan-Sajjad72/Deploy-Guard-dev/contents/.github/workflows/deployguard-reusable.yml?ref=")) return Response.json({ encoding: "base64", content: Buffer.from(reusableWorkflowFixture).toString("base64") });
    if (url.includes(`/contents/${DEPLOYGUARD_WORKFLOW_PATH}`) && method === "GET") {
      if (!workflowExists && staleRemovalReads === 0) return new Response("", { status: 404 });
      if (staleRemovalReads > 0) staleRemovalReads -= 1;
      return Response.json({ path: DEPLOYGUARD_WORKFLOW_PATH, encoding: "base64", content: calls.find((call) => call.method === "PUT")?.body.content, sha: "workflow-sha" });
    }
    if (url.endsWith(`/contents/${DEPLOYGUARD_WORKFLOW_PATH}`) && method === "PUT") { workflowExists = true; return Response.json({ content: { path: DEPLOYGUARD_WORKFLOW_PATH } }, { status: 201 }); }
    if (url.endsWith(`/contents/${DEPLOYGUARD_WORKFLOW_PATH}`) && method === "DELETE") { workflowExists = false; staleRemovalReads = 1; return Response.json({ commit: { sha: "deleted-workflow-sha" } }); }
    throw new Error(`Unexpected GitHub request: ${method} ${url}`);
  }) as typeof fetch;
  try {
    const connected = await service.connectInstallation({ id: 42 } as never, "9001");
    assert.equal(connected.ownerUserId, 42);
    const available = await service.availableInstallations({ id: 43, role: "admin", githubLogin: null } as never);
    assert.equal(available[0].installationId, "9001");
    await service.connectInstallation({ id: 43 } as never, "9001");
    assert.deepEqual(rows.map((row) => row.ownerUserId).sort(), [42, 43]);
    const listed = await service.listRepositories(42);
    assert.equal(listed[0].installationId, "9001");
    assert.equal(await service.oidcTrustSubject(42, "sample-owner/sample-app", "9001"), "repo:sample-owner@77/*:*");
    const generated = await service.ensureWorkflow(42, "sample-owner/sample-app", "main", "9001");
    assert.deepEqual({ verified: generated.verified, generated: generated.generated, path: generated.path }, { verified: true, generated: true, path: DEPLOYGUARD_WORKFLOW_PATH });
    const put = calls.find((call) => call.method === "PUT");
    const pinnedValidation = calls.find((call) => call.url.includes("/Deploy-Guard-dev/contents/.github/workflows/deployguard-reusable.yml?ref="));
    assert.ok(pinnedValidation?.url.endsWith("ref=830a641caf58d38600452a729498e16845b61943"), "compatibility gate reads the exact immutable SHA");
    assert.ok(calls.indexOf(pinnedValidation!) < calls.indexOf(put!), "pinned reusable validates before customer workflow mutation");
    const workflow = Buffer.from(put?.body.content, "base64").toString("utf8");
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /Hassan-Sajjad72\/Deploy-Guard-dev\/\.github\/workflows\/deployguard-reusable\.yml@830a641caf58d38600452a729498e16845b61943/);
    assert.match(workflow, /id-token:\s*write/);
    assert.equal(GITHUB_ACTIONS_CALLER_INPUT_NAMES.length, 21, "packed GitHub workflow_dispatch stays below 25 inputs");
    for (const input of GITHUB_ACTIONS_CALLER_INPUT_NAMES) assert.match(workflow, new RegExp(`\\b${input}:`));
    for (const input of ["rollback_source_operation_id", "rollback_image_uri", "rollback_task_definition_arn"]) {
      assert.match(workflow, new RegExp(`^      ${input}: \\$\\{\\{ fromJSON\\(inputs\\.rollback_release_json\\)`, "m"));
    }
    assert.match(workflow, /app_port: \$\{\{ fromJSON\(inputs\.build_plan_contract_json\)\.app_port \}\}/);
    const trust: any = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }, Action: "sts:AssumeRoleWithWebIdentity", Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" }, StringLike: { "token.actions.githubusercontent.com:sub": "repo:Hassan-Sajjad72/Project-Tst:*" } } }] };
    assert.equal(githubTrustAuthorizesRepository(trust, "Hassan-Sajjad72/react-pomodoro"), false);
    assert.equal(authorizeGithubRepositoryInTrust(trust, "Hassan-Sajjad72/react-pomodoro"), true);
    assert.equal(githubTrustAuthorizesRepository(trust, "Hassan-Sajjad72/react-pomodoro"), true);
    assert.equal(authorizeGithubRepositoryInTrust(trust, "Hassan-Sajjad72/react-pomodoro"), false, "trust onboarding is idempotent");
    const ownerTrust: any = JSON.parse(JSON.stringify(trust));
    assert.equal(authorizeGithubRepositoryInTrust(ownerTrust, "another-owner/new-app", "repo:another-owner@88/*:*"), true);
    assert.equal(authorizeGithubRepositoryInTrust(ownerTrust, "another-owner/new-app", "repo:another-owner@88/*:*"), false, "identity-aware owner trust is idempotent");
    assert.deepEqual(githubActionsStagePresentation("configure_aws_credentials_through_oidc"), { key: "configure_aws_credentials_through_oidc", label: "Connecting securely to AWS" });
    const reusableWorkflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
    assert.match(reusableWorkflow, /container_profile: \{ required: true, type: string \}/);
    assert.match(reusableWorkflow, /ref: \$\{\{ inputs\.commit_sha \}\}/);
    assert.match(reusableWorkflow, /Materialize immutable container contract/);
    assert.doesNotMatch(reusableWorkflow, /FROM node:20-alpine AS build/);
    assert.match(reusableWorkflow, /Configure AWS credentials through OIDC[\s\S]*role-to-assume: \$\{\{ inputs\.aws_role_arn \}\}/);
    const verified = await service.ensureWorkflow(42, "sample-owner/sample-app", "main", "9001");
    assert.equal(verified.generated, false);
    await service.removeManagedWorkflow(42, "sample-owner/sample-app", "main", "9001");
    assert.equal(workflowExists, false, "caller removal tolerates one stale GitHub Contents read and verifies eventual absence");
    const projectsController = readFileSync(join(__dirname, "../src/projects/projects.controller.ts"), "utf8");
    assert.match(projectsController, /@Controller\("api\/projects"\)/);
    assert.match(projectsController, /@Post\("github\/installations\/:installationId\/connect"\)/);
    console.log("PASS iteration-1 GitHub App onboarding -> authorized repository -> fixed workflow generation/verification -> readiness prerequisite");
  } finally { global.fetch = originalFetch; }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
