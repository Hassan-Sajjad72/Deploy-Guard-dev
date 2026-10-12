import "reflect-metadata";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { RepairService } from "../src/recovery/repair.service";
import { recoveryFingerprint } from "../src/recovery/recovery-policy";
import { UserRole } from "../src/users/user.entity";

async function verify() {
  const user = { id: 7, role: UserRole.DEVELOPER };
  const project = { id: "project", ownerUserId: 7, repositoryFullName: "customer/app", targetBranch: "main" };
  const content = { sourceSha: "a".repeat(40), files: [{ path: "src/app.js", content: "export const fixed = true;\n" }] };
  const fingerprint = recoveryFingerprint(content);
  const proposal: any = { id: "11111111-1111-4111-8111-111111111111", projectId: project.id, createdByUserId: user.id, fingerprint, content,
    status: "passed", checks: { fingerprint, apiContractTests: "PASSED", applicationTests: "PASSED" } };
  const service = new RepairService({ getRepository: () => ({ save: async () => proposal }) } as any, {} as any, {} as any,
    { tokenForRepository: async () => ({ token: "fixture-only-token" }) } as any, {} as any, {} as any, { record: async () => undefined } as any);
  let authority = true, savedBranch = false, failingPull = true, forgedPatch = false;
  const observed: Array<{ path: string; method: string; body: any }> = [];
  (service as any).proposal = async () => ({ project, user: authority ? user : { ...user, role: UserRole.READONLY }, proposal });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, options: any) => {
    const path = new URL(String(input)).pathname.replace("/repos/customer/app/", "");
    const method = options.method; const body = options.body ? JSON.parse(options.body) : undefined;
    observed.push({ path, method, body });
    const response = (value: any, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
    if (path === "git/ref/heads/main") return response({ object: { sha: content.sourceSha } });
    if (path === `git/ref/heads/deployguard/repair-${proposal.id}`) return savedBranch ? response({ object: { sha: "repair-sha" } }) : response({}, 404);
    if (path === `git/commits/${content.sourceSha}`) return response({ tree: { sha: "base-tree" } });
    if (path === "git/blobs") return response({ sha: "patched-blob" });
    if (path === "git/trees") return response({ sha: "patched-tree" });
    if (path === "git/commits" && method === "POST") return response({ sha: "repair-sha" });
    if (path === "git/refs" && method === "POST") { savedBranch = true; return response({}); }
    if (path === "git/commits/repair-sha") return response({ parents: [{ sha: content.sourceSha }], message: `DeployGuard supervised repair ${proposal.id}\n\nfingerprint ${fingerprint}` });
    if (path.startsWith("compare/")) return response({ total_commits: 1, files: [{ filename: forgedPatch ? "src/unapproved.js" : "src/app.js", status: "modified",
      sha: createHash("sha1").update(`blob ${Buffer.byteLength(content.files[0].content)}\0`).update(content.files[0].content).digest("hex") }] });
    if (path === "pulls" && method === "GET") return response([]);
    if (path === "pulls" && method === "POST") return failingPull ? response({}, 503) : response({ html_url: "https://github.com/customer/app/pull/12" });
    throw new Error(`Unexpected mocked GitHub request ${method} ${path}`);
  }) as any;
  try {
    await assert.rejects(service.publish(user as any, project.id, proposal.id, fingerprint), /could not complete/);
    assert.equal(savedBranch, true); assert.equal(proposal.pullRequestUrl, undefined);
    const branchCreates = observed.filter((call) => call.path === "git/refs").length;
    const commitCreates = observed.filter((call) => call.path === "git/commits" && call.method === "POST").length;
    forgedPatch = true;
    await assert.rejects(service.publish(user as any, project.id, proposal.id, fingerprint), /does not match/);
    forgedPatch = false; failingPull = false;
    const completed = await service.publish(user as any, project.id, proposal.id, fingerprint);
    assert.equal(completed.proposal.pullRequestUrl, "https://github.com/customer/app/pull/12");
    assert.equal(completed.proposal.checks.operationalRecovery, "UNVERIFIED");
    assert.equal(observed.filter((call) => call.path === "git/refs").length, branchCreates);
    assert.equal(observed.filter((call) => call.path === "git/commits" && call.method === "POST").length, commitCreates);
    const published = observed.filter((call) => call.path === "pulls" && call.method === "POST");
    assert.ok(published.every((call) => call.body.draft === true && call.body.base === "main" && call.body.head === `deployguard/repair-${proposal.id}`));
    assert.ok(!observed.some((call) => call.method === "PATCH" || call.path.endsWith("/merge") || call.path === "deployments"));
    authority = false;
    await assert.rejects(service.publish(user as any, project.id, proposal.id, fingerprint), /must approve/);
    console.log("Focused repair publication outage recovery, exact patch identity, draft-only and authorization checks passed.");
  } finally { globalThis.fetch = originalFetch; }
}
verify().catch((error) => { console.error(error); process.exitCode = 1; });
