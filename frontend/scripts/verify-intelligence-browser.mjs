import { strict as assert } from "node:assert";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { adminLandingPath, adminSectionAllowed } from "../src/utils/adminScope.js";
for (const [role, path] of [["billing", "/admin/billing"], ["support", "/admin/access"], ["security_auditor", "/admin?section=audit"], ["platform_ops", "/admin"]]) assert.equal(adminLandingPath(role), path);
assert.equal(adminSectionAllowed("support", "users"), false);
assert.equal(adminSectionAllowed("billing", "audit"), false);
const server = await createServer({ define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("") }, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;
try {
  await server.listen(); browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true });
  const page = await browser.newPage(); const projectId = "11111111-1111-4111-8111-111111111111"; const orgId = "22222222-2222-4222-8222-222222222222"; const serviceId = "33333333-3333-4333-8333-333333333333";
  const base = `http://127.0.0.1:${server.httpServer.address().port}`; let role = "developer"; let internalRole = "support"; let records = []; let approvals = []; let grants = []; let runCount = 0; let viewedSupport = 0;
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname; if (!pathname.startsWith("/api/")) return route.continue(); const method = route.request().method(); let body;
    if (pathname === "/api/auth/me") body = { user: { id: 1, role, githubLogin: "owner" } };
    else if (pathname === "/api/admin-auth/me") body = { user: { id: 9, role: "admin", internalAdminRole: internalRole, email: "support@example.test" } };
    else if (pathname === "/api/workspaces") body = { workspaces: [{ id: orgId, name: "Team", role: "owner", kind: "team" }] };
    else if (pathname === `/api/projects/${projectId}`) body = { project: { id: projectId, name: "API", organizationId: orgId, environmentName: "staging", canManage: role !== "readonly", services: [{ id: serviceId, name: "Web" }] } };
    else if (pathname.endsWith("/deployment-plans") && method === "GET") body = { plans: [] };
    else if (pathname.endsWith("/aws-bindings")) body = { bindings: [{ id: "binding", accountId: "123456789012", verificationStatus: "verified", regions: ["us-east-1"] }] };
    else if (pathname.endsWith("/intelligence/records/optimization")) body = { record: { id: "optimization", kind: "optimization", content: { window: { start: "2026-10-10T00:00:00Z", end: "2026-10-11T00:00:00Z" }, confidence: "moderate", recommendations: [{ cpu: 0.5, memoryMiB: 2048, replicas: 2 }] } } };
    else if (pathname.endsWith("/intelligence") && method === "GET") body = { records, approvals, canManage: role !== "readonly", canApprove: role !== "readonly" };
    else if (pathname.endsWith("/intelligence/incidents")) { const record = { id: "incident", kind: "incident", createdAt: new Date().toISOString(), content: { status: "verified", scope: { sourceSha: "a".repeat(40) }, findings: [{ classification: "FACT", statement: "Application health failed.", references: [{ source: "application_health", id: "release", timestamp: new Date().toISOString() }] }, { classification: "HYPOTHESIS", statement: "Dependency availability may explain the failure.", references: [] }, { classification: "MISSING_EVIDENCE", statement: "No correlated logs.", references: [] }] } }; records.unshift(record); body = { record }; }
    else if (pathname.endsWith("/api-contracts")) { const input = route.request().postDataJSON(); assert.equal(input.serviceId, serviceId); assert.equal(input.healthPath, "/health"); const record = { id: "contract", kind: "api_contract", fingerprint: "b".repeat(64), createdAt: new Date().toISOString(), content: { target: { origin: "https://owned.example.test", environment: "staging", sourceSha: "a".repeat(40) }, probes: [{ method: "GET", path: "/health" }] } }; records.unshift(record); body = { record }; }
    else if (pathname.endsWith("/api-contracts/contract/approve")) { const input = route.request().postDataJSON(); assert.equal(input.fingerprint, "b".repeat(64)); assert.equal(input.reason, "Approved safe staging checks"); approvals.push({ contractId: "contract", expiresAt: new Date(Date.now() + 3600_000).toISOString() }); body = { approval: approvals[0] }; }
    else if (pathname.endsWith("/api-contracts/contract/run")) { runCount++; const record = { id: "run", kind: "api_run", createdAt: new Date().toISOString(), content: { result: "FAILED", executionId: "execution", contractId: "contract", target: { sourceSha: "a".repeat(40) }, results: [{ method: "GET", path: "/health", kind: "regression", result: "FAILED", httpStatus: 500, reason: "Health endpoint returned an unsuccessful HTTP status" }] } }; records.unshift(record); body = { record }; }
    else if (pathname.endsWith("/optimizations")) { const input = route.request().postDataJSON(); assert.equal(input.range, "24h"); const record = { id: "optimization", kind: "optimization", createdAt: new Date().toISOString(), content: { status: "insufficient_evidence", confidence: "insufficient", window: { start: "2026-10-10T00:00:00Z", end: "2026-10-11T00:00:00Z" }, samples: { cpu: 0, memory: 0 }, recommendations: [], reliabilityEffects: "No change is justified by incomplete observations.", planningRoute: `/projects/${projectId}/planning` } }; records.unshift(record); body = { record }; }
    else if (pathname === "/api/admin/verify-identity") { assert.equal(route.request().postDataJSON().password, "fixture-password"); body = { expiresAt: new Date(Date.now() + 900_000).toISOString() }; }
    else if (pathname === "/api/admin/support-access") body = { grants: [{ id: "grant", project_id: projectId, purpose: "Investigate staging incident", expires_at: new Date(Date.now() + 3600_000).toISOString(), revoked_at: null }] };
    else if (pathname.startsWith("/api/admin/support-access/grant/projects/")) { viewedSupport++; body = { projectId, stateAuthority: { state: "FAILED", applicationHealth: { status: "failed" } }, release: { commit: "a".repeat(40) } }; }
    else if (pathname === `/api/workspaces/${orgId}/support-access` && method === "GET") body = { grants };
    else if (pathname === `/api/workspaces/${orgId}/support-access` && method === "POST") { const input = route.request().postDataJSON(); assert.equal(input.operatorUserId, 9); assert.equal(input.durationMinutes, 60); grants = [{ id: "owner-grant", purpose: input.purpose, operator_user_id: 9, expires_at: new Date(Date.now() + 3600_000).toISOString(), revoked_at: null }]; body = { grant: grants[0] }; }
    else if (pathname.endsWith("/support-access/owner-grant/revoke")) { grants[0].revoked_at = new Date().toISOString(); body = { revoked: true }; }
    else if (pathname.includes("/activity")) body = {};
    else { await route.fulfill({ status: 404, json: { message: `Unexpected fixture ${method} ${pathname}` } }); return; }
    await route.fulfill({ json: body });
  });
  await page.goto(`${base}/projects/${projectId}/intelligence`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Collect incident evidence" }).click();
  await page.getByText(/Failure observed/).click(); await page.getByText("No correlated logs.", { exact: true }).waitFor();
  await page.getByRole("checkbox", { name: /These GET\/HEAD endpoints/ }).check(); await page.getByRole("button", { name: "Register contract for approval" }).click();
  await page.getByText(/Awaiting approval/).click(); assert.equal(await page.getByRole("button", { name: "Run approved checks" }).count(), 0);
  await page.getByLabel("Approval reason", { exact: true }).fill("Approved safe staging checks"); await page.getByRole("button", { name: "Approve bounded checks" }).click();
  await page.getByRole("button", { name: "Run approved checks" }).click(); await page.getByText(/^FAILED ·/).click(); await page.getByText(/HTTP 500/).waitFor(); assert.equal(runCount, 1);
  await page.getByRole("button", { name: "Analyze last 24 hours" }).click(); await page.getByText(/insufficient evidence · confidence/).click(); await page.getByText("No change is justified by incomplete observations.", { exact: true }).waitFor();
  await page.goto(`${base}/projects/${projectId}/planning?optimization=optimization`, { waitUntil: "domcontentloaded" }); await page.getByRole("button", { name: "Use measured settings in review form" }).click(); assert.equal(await page.getByLabel("CPU per service (vCPU)", { exact: true }).inputValue(), "0.5"); assert.equal(await page.getByLabel("Memory per service (MiB)", { exact: true }).inputValue(), "2048"); assert.equal(runCount, 1, "Measured settings never dispatch cloud or API execution");
  await page.goto(`${base}/projects/${projectId}/intelligence`, { waitUntil: "domcontentloaded" });
  role = "readonly"; await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "Operational intelligence", exact: true }).waitFor(); assert.equal(await page.getByRole("button", { name: "Collect incident evidence" }).count(), 0); assert.equal(await page.getByRole("button", { name: "Run approved checks" }).count(), 0);
  role = "developer"; await page.goto(`${base}/support-access`, { waitUntil: "domcontentloaded" }); await page.getByLabel("Internal support operator account ID").fill("9"); await page.getByLabel("Purpose", { exact: true }).fill("Investigate staging incident"); await page.getByRole("button", { name: "Approve temporary support access" }).click(); await page.getByRole("button", { name: "Revoke access" }).click(); await page.getByText(/operator 9.*Revoked/).waitFor();
  await page.goto(`${base}/admin`, { waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "Privileged access", exact: true }).waitFor(); assert.equal(new URL(page.url()).pathname, "/admin/access"); assert.equal(await page.getByRole("link", { name: "Users", exact: true }).count(), 0); assert.equal(await page.getByRole("link", { name: "Billing", exact: true }).count(), 0);
  await page.getByLabel("Administrator password", { exact: true }).fill("fixture-password"); await page.getByRole("button", { name: "Verify identity", exact: true }).click(); await page.getByText(/^Confirmed until/).waitFor(); await page.getByRole("button", { name: "View authorized evidence" }).click(); await page.getByText(/application health failed/).waitFor(); assert.equal(viewedSupport, 1);
  await page.setViewportSize({ width: 390, height: 844 }); assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  console.log("Focused browser incident, API approval/run, missing measurements, support grant/revoke and scoped operator navigation checks passed.");
} finally { await browser?.close(); await server.close(); }
