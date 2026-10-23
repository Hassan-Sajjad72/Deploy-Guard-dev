import "reflect-metadata";
import { strict as assert } from "assert";
import { generateKeyPairSync } from "crypto";
import { GithubAppService, DEPLOYGUARD_WORKFLOW_PATH } from "../src/projects/github-app.service";

async function run() {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const configValues: Record<string, string> = {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_SLUG: "deployguard-test",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    DEPLOYGUARD_REUSABLE_WORKFLOW: "deployguard/deployguard/.github/workflows/deploy.yml@v1",
  };
  const rows: any[] = [];
  const repository = {
    findOne: async ({ where }: any) => rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) || null,
    find: async ({ where }: any) => rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
    create: (value: any) => value,
    save: async (value: any) => { const index = rows.findIndex((row) => row.installationId === value.installationId); const saved = { id: value.id || "installation-row", ...value }; if (index >= 0) rows[index] = saved; else rows.push(saved); return saved; },
  };
  const service = new GithubAppService(repository as never, { get: (key: string, fallback?: string) => configValues[key] ?? fallback } as never);
  const calls: Array<{ url: string; method: string; body?: any }> = [];
  let workflowExists = false;
  const originalFetch = global.fetch;
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const method = init?.method || "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/access_tokens")) return Response.json({ token: "installation-token" });
    if (url.endsWith("/app/installations/9001")) return Response.json({ account: { login: "sample-owner", id: 77 } });
    if (url === "https://api.github.com/installation/repositories?per_page=100") return Response.json({ repositories: [{ id: 10, full_name: "sample-owner/sample-app", name: "sample-app", default_branch: "main", private: true }] });
    if (url === "https://api.github.com/repos/sample-owner/sample-app") return Response.json({ id: 10, full_name: "sample-owner/sample-app" });
    if (url.includes(`/contents/${DEPLOYGUARD_WORKFLOW_PATH}`) && method === "GET") return workflowExists ? Response.json({ path: DEPLOYGUARD_WORKFLOW_PATH }) : new Response("", { status: 404 });
    if (url.endsWith(`/contents/${DEPLOYGUARD_WORKFLOW_PATH}`) && method === "PUT") { workflowExists = true; return Response.json({ content: { path: DEPLOYGUARD_WORKFLOW_PATH } }, { status: 201 }); }
    throw new Error(`Unexpected GitHub request: ${method} ${url}`);
  }) as typeof fetch;
  try {
    const connected = await service.connectInstallation({ id: 42 } as never, "9001");
    assert.equal(connected.ownerUserId, 42);
    const listed = await service.listRepositories(42);
    assert.equal(listed[0].installationId, "9001");
    const generated = await service.ensureWorkflow(42, "sample-owner/sample-app", "main", "9001");
    assert.deepEqual({ verified: generated.verified, generated: generated.generated, path: generated.path }, { verified: true, generated: true, path: DEPLOYGUARD_WORKFLOW_PATH });
    const put = calls.find((call) => call.method === "PUT");
    const workflow = Buffer.from(put?.body.content, "base64").toString("utf8");
    assert.match(workflow, /workflow_dispatch:/);
    assert.match(workflow, /deployguard\/deployguard\/\.github\/workflows\/deploy\.yml@v1/);
    const verified = await service.ensureWorkflow(42, "sample-owner/sample-app", "main", "9001");
    assert.equal(verified.generated, false);
    console.log("PASS iteration-1 GitHub App onboarding -> authorized repository -> fixed workflow generation/verification -> readiness prerequisite");
  } finally { global.fetch = originalFetch; }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
