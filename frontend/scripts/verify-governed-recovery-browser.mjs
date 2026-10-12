import { strict as assert } from "node:assert";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
const server = await createServer({ define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("") }, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;
try {
  await server.listen(); browser = await chromium.launch({ executablePath: process.env.DG_CHROME_BIN || "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true });
  const page = await browser.newPage(); const projectId = "11111111-1111-4111-8111-111111111111", id = "22222222-2222-4222-8222-222222222222", incidentId = "33333333-3333-4333-8333-333333333333";
  let request = null, canRequest = true, canApprove = false, dispatches = 0, decisions = 0;
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname, method = route.request().method(); if (!path.startsWith("/api/")) { await route.continue(); return; }
    let body;
    if (path === "/api/auth/me") body = { user: { id: 1, role: canRequest || canApprove ? "developer" : "readonly", githubLogin: "alice" } };
    else if (path === `/api/projects/${projectId}`) body = { project: { id: projectId, name: "Recovery fixture" } };
    else if (path.endsWith("/runbooks")) body = { runbooks: [{ id: "verified_rollback", version: 1, title: "Restore previous release", maxAttempts: 1, timeoutSeconds: 900, preconditions: ["Verified incident", "Exact human approval"] }] };
    else if (path.endsWith("/requests") && method === "GET") body = { requests: request ? [request] : [], canRequest, canApprove };
    else if (path.endsWith("/requests") && method === "POST") {
      const input = route.request().postDataJSON(); assert.equal(input.incidentId, incidentId); assert.equal(input.monthlyBudgetUsd, 50);
      request = { id, fingerprint: "a".repeat(64), status: "requested", content: { runbookId: "verified_rollback", scope: { sourceSha: "b".repeat(40), region: "us-east-1" }, cost: { conservativeMonthlyCeilingUsd: 20 } } }; body = { request };
    } else if (path.endsWith("/decisions")) {
      const input = route.request().postDataJSON(); assert.equal(input.fingerprint, request.fingerprint); assert.equal(input.decision, "approved"); decisions++; request.status = "approved"; body = { request };
    } else if (path.endsWith("/execute")) { assert.equal(route.request().postDataJSON().fingerprint, request.fingerprint); dispatches++; request.status = "running"; request.outcome = { verification: "UNVERIFIED" }; body = { request }; }
    else if (path.endsWith(`/requests/${id}`)) { request.status = "unverified"; request.outcome = { verification: "UNVERIFIED", reason: "Independent health evidence unavailable." }; body = { request }; }
    else if (path.endsWith("/repairs")) body = { proposals: [] };
    else if (path.includes("/activity")) body = {};
    else { await route.fulfill({ status: 404, json: { message: `Unexpected fixture request ${path}` } }); return; }
    await route.fulfill({ json: body });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/projects/${projectId}/recovery`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Request recovery", exact: true }).waitFor();
  await page.getByLabel("Verified incident ID", { exact: true }).first().fill(incidentId);
  await page.getByLabel("Maximum monthly AWS cost (USD)", { exact: true }).fill("50");
  await page.getByRole("button", { name: "Prepare recovery request", exact: true }).click();
  await page.getByText("REQUESTED", { exact: true }).waitFor(); assert.equal(dispatches, 0); assert.equal(await page.getByRole("button", { name: "Record human decision", exact: true }).count(), 0);
  canApprove = true; canRequest = false; await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByLabel("Review reason", { exact: true }).fill("Reviewed exact source, resource scope and monthly ceiling.");
  await page.getByLabel("Decision", { exact: true }).selectOption("approved"); await page.getByRole("button", { name: "Record human decision", exact: true }).click();
  await page.getByText("APPROVED", { exact: true }).waitFor(); assert.equal(decisions, 1); assert.equal(dispatches, 0);
  canRequest = true; canApprove = false; await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Execute approved recovery", exact: true }).click(); await page.getByText("RUNNING", { exact: true }).waitFor(); assert.equal(dispatches, 1);
  await page.getByRole("button", { name: "Check independent recovery outcome", exact: true }).click(); await page.getByText("UNVERIFIED", { exact: true }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "Execute approved recovery", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Save reviewable repair proposal", exact: true }).scrollIntoViewIfNeeded();
  const repairForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Supervised code repair proposal", exact: true }) });
  await repairForm.getByLabel("Verified incident ID", { exact: true }).fill(incidentId); await repairForm.getByLabel("Exact source SHA", { exact: true }).fill("b".repeat(40)); await repairForm.getByLabel("Reproducible defect evidence", { exact: true }).fill("Fixture test fails reproducibly."); await repairForm.getByLabel("Proposed file replacements (JSON array)", { exact: true }).fill("invalid JSON");
  await repairForm.getByRole("button", { name: "Save reviewable repair proposal", exact: true }).click(); await page.getByText("Action could not complete", { exact: true }).waitFor();
  canRequest = false; await page.reload({ waitUntil: "domcontentloaded" }); await page.getByRole("heading", { name: "Governed recovery", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Prepare recovery request", exact: true }).count(), 0); assert.equal(await page.getByRole("button", { name: "Record human decision", exact: true }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)); assert.deepEqual(errors, []);
  console.log("Focused recovery browser human approval, execution, unverified outcome, repair validation and role checks passed.");
} finally { if (browser) await browser.close(); await server.close(); }
