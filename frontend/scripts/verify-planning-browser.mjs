import { strict as assert } from "node:assert";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const server = await createServer({ define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("") }, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.DG_CHROME_BIN || "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true });
  const page = await browser.newPage();
  const projectId = "11111111-1111-4111-8111-111111111111";
  const organizationId = "22222222-2222-4222-8222-222222222222";
  const bindingId = "33333333-3333-4333-8333-333333333333";
  const planId = "44444444-4444-4444-8444-444444444444";
  let role = "developer";
  let canApprove = true;
  let plan = null;
  let created = 0;
  let rejected = false;
  const generationId = "55555555-5555-4555-8555-555555555555";
  const providerActions = [];
  const buildId = "66666666-6666-4666-8666-666666666666";
  let buildPolls = 0; let createdBuildId = null;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) { await route.continue(); return; }
    const method = route.request().method();
    let body;
    if (path === "/api/auth/me") body = { user: { id: 1, role, githubLogin: "alice" } };
    else if (path === `/api/projects/${projectId}`) body = { project: { id: projectId, name: "Example", organizationId, canManage: role !== "readonly" } };
    else if (path.endsWith("/aws-bindings")) body = { bindings: [{ id: bindingId, accountId: "123456789012", regions: ["us-east-1"], verificationStatus: "verified" }] };
    else if (path.endsWith("/deployment-goals/interpret")) body = { suggestions: { monthlyBudgetUsd: 30, availability: "single_instance", stateful: null, continuousCompute: true, explanation: "Confirm resource sizing." }, userReviewRequired: true, mutationsAuthorized: false };
    else if (path.endsWith("/deployment-plans") && method === "GET") body = { plans: plan ? [plan] : [] };
    else if (path.endsWith("/deployment-plans") && method === "POST") {
      created++;
      const input = route.request().postDataJSON();
      createdBuildId = input.buildId || null;
      assert.equal(input.assumptions.monthlyBudgetUsd, 30); assert.equal(input.bindingId, bindingId);
      plan = { id: planId, version: 1, fingerprint: "a".repeat(64), content: {
        ownership: { accountId: "123456789012", region: "us-east-1" }, selectedProfile: "ecs_fargate", status: "blocked",
        repository: { sourceSha: "b".repeat(40) }, services: [{ id: "web", name: "web", directory: ".", port: 8080 }], environmentReferences: [],
        blockers: ["Scoped customer execution authority has not been verified."], risks: ["Estimates are not guarantees."], securityFindings: [{ reason: "Image scan is unavailable." }],
        comparison: { options: [{ id: "ecs_fargate", eligible: false, reasons: ["Complete pricing unavailable."], cost: { monthlyUsd: null, items: [{ category: "compute", monthlyUsd: null, kind: "fixed", reason: "Price unavailable." }] } }] },
      } };
      body = { plan };
    } else if (path.endsWith(`/deployment-plans/${planId}`)) body = { plan, canApprove: role !== "readonly" && canApprove, decision: rejected ? { decision: "rejected" } : null };
    else if (path.endsWith("/decisions")) { const input = route.request().postDataJSON(); assert.equal(input.decision, "rejected", "blocked plans never send approval requests"); assert.equal(input.fingerprint, plan.fingerprint); rejected = true; body = { decision: { decision: "rejected" } }; }
    else if (path.endsWith("/services")) body = { services: [{ id: "web", name: "web", serviceDirectory: "." }] };
    else if (path.endsWith("/hosting-builds") && method === "POST") { assert.deepEqual(route.request().postDataJSON(), { profile: "static", serviceId: "web" }); body = { build: { buildId, status: "running", profile: "static" } }; }
    else if (path.endsWith(`/hosting-builds/${buildId}`)) { buildPolls++; body = { build: { buildId, status: "succeeded", profile: "static", sourceSha: "b".repeat(40), securityScan: { status: "passed" } } }; }
    else if (path.endsWith("/provider-generations")) body = { generations: [{ id: generationId, profile: "lightsail", status: "verified", artifactFingerprint: "c".repeat(64), runtimeIdentity: { instance: "dg-app-0" }, createdAt: "2026-10-01T00:00:00Z" }], route: { generationId }, currentHealth: "not_observed" };
    else if (path.endsWith(`/provider-generations/${generationId}/rollback`) && method === "POST") { const input = route.request().postDataJSON(); assert.equal(input.artifactFingerprint, "c".repeat(64)); providerActions.push(input.reason); body = { status: "verified", jobId: "job" }; }
    else if (path.includes("/activity")) body = {};
    else { await route.fulfill({ status: 404, json: { message: `Unexpected fixture request: ${method} ${path}` } }); return; }
    await route.fulfill({ json: body });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/projects/${projectId}/planning`, { waitUntil: "domcontentloaded" });
  await page.getByText("Describe a deployment goal", { exact: true }).click();
  await page.getByLabel("Deployment goal", { exact: true }).fill("A continuously running API for 30 USD per month");
  await page.getByRole("button", { name: "Interpret goal", exact: true }).click();
  await page.getByText("Confirm resource sizing.", { exact: true }).waitFor();
  assert.equal(created, 0, "a natural-language prompt does not create or execute a deployment");
  await page.getByRole("button", { name: "Use suggestions in review form", exact: true }).click();
  assert.equal(await page.getByLabel("Maximum monthly AWS budget (USD)", { exact: true }).inputValue(), "30");
  await page.getByLabel("Hosting profile to review", { exact: true }).selectOption("static");
  await page.getByRole("button", { name: "Generate build evidence", exact: true }).click();
  await page.getByText("It will be sealed into the next plan.", { exact: false }).waitFor({ timeout: 15000 });
  assert(buildPolls >= 1, "the running build is polled until it finishes");
  await page.getByLabel("I reviewed these workload and budget assumptions.", { exact: true }).check();
  await page.getByRole("button", { name: "Analyze and create plan", exact: true }).click();
  await page.getByRole("heading", { name: "Version 1 · blocked", exact: true }).waitFor();
  assert.equal(createdBuildId, buildId, "succeeded build evidence is sealed into plan creation");
  assert.equal(await page.getByRole("button", { name: "Approve this plan", exact: true }).isDisabled(), true);
  await page.getByText("ECS Fargate · Incomplete estimate · Unavailable or blocked", { exact: true }).click();
  await page.getByText("Unknown · fixed · Price unavailable.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Reject this plan", exact: true }).click();
  await page.getByText("Decision: rejected", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Provider generations", exact: true }).waitFor();
  await page.getByText("Lightsail · verified · live route", { exact: false }).waitFor();
  await page.getByText("Rollback or clean up this generation", { exact: true }).click();
  await page.getByLabel("Action", { exact: true }).selectOption("cleanup");
  await page.getByLabel("Reason", { exact: true }).fill("Retire generation");
  await page.getByRole("button", { name: "Submit for exact approval checks", exact: true }).click();
  await page.getByText("Type DESTROY to confirm generation cleanup.", { exact: true }).waitFor();
  assert.equal(providerActions.length, 0, "cleanup without DESTROY confirmation never reaches the API");
  await page.getByLabel("Action", { exact: true }).selectOption("rollback");
  await page.getByRole("button", { name: "Submit for exact approval checks", exact: true }).click();
  await page.getByText("Route moved to the retained generation.", { exact: true }).waitFor();
  assert.deepEqual(providerActions, ["Retire generation"]);
  rejected = false; canApprove = false;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Version 1 · blocked", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Reject this plan", exact: true }).count(), 0, "engineers cannot approve or reject plans");
  role = "readonly";
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Version 1 · blocked", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Analyze and create plan", exact: true }).count(), 0);
  assert.equal(await page.getByText("Rollback or clean up this generation", { exact: true }).count(), 0, "read-only users cannot act on provider generations");
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  console.log("Planning browser checks passed: reviewed AI suggestions, immutable plan review, unknown pricing, blocked approval, provider generation actions and role restrictions.");
} finally { await browser?.close(); await server.close(); }
