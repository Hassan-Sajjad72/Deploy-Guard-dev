import { strict as assert } from "node:assert";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const server = await createServer({ define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("") }, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.DG_CHROME_BIN || "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true });
  const page = await browser.newPage();
  const personal = "11111111-1111-4111-8111-111111111111", team = "22222222-2222-4222-8222-222222222222", binding = "33333333-3333-4333-8333-333333333333", project = "44444444-4444-4444-8444-444444444444";
  const errors = [], created = [];
  let bindingsUnavailable = false, duplicate = false, approvedLimit = false;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (!path.startsWith("/api/")) return route.continue();
    let body;
    if (path === "/api/auth/me") body = { user: { id: 1, role: "developer", githubLogin: "alice" } };
    else if (path === "/api/workspaces") body = { workspaces: [{ id: personal, name: "Alice", kind: "personal", role: "owner" }, { id: team, name: "Delivery team", kind: "team", role: "admin" }, { id: "55555555-5555-4555-8555-555555555555", name: "Archived team", kind: "team", role: "owner", archivedAt: new Date().toISOString() }] };
    else if (path.endsWith("/aws-bindings")) {
      if (bindingsUnavailable) return route.fulfill({ status: 503, json: { message: "Provider evidence unavailable" } });
      body = { bindings: path.includes(team) ? [{ id: binding, accountId: "123456789012", verificationStatus: "verified" }, { id: "revoked", accountId: "999999999999", verificationStatus: "revoked" }] : [] };
    } else if (path === "/api/projects/github/status") body = { connected: true, message: "GitHub connected" };
    else if (path === "/api/projects/github/repositories") body = { repositories: [{ fullName: "alice/example", defaultBranch: "main" }] };
    else if (path.endsWith("/directories")) body = { directories: [".", "api"] };
    else if (path === "/api/projects/github/repositories/alice/example") body = { repository: { fullName: "alice/example", defaultBranch: "main", branches: ["main"] } };
    else if (path === "/api/projects" && method === "POST") {
      const input = route.request().postDataJSON(); created.push(input);
      body = { project: { id: project, executionMode: "customer", ...input } };
      if (duplicate) return route.fulfill({ status: 409, json: { code: "EXISTING_PROJECT", existingProject: { ...body.project, awsAccountBindingId: "different-binding" } } });
    } else if (path === "/api/billing/summary") body = { plan: "pro", planName: "Pro", subscriptionProvider: "b2b", billingPeriodEnd: "2026-11-11T00:00:00Z", billing: { enabled: false, mode: "disabled" }, provider: { configured: false }, workspaceUsage: { currentProjects: 8, liveProjects: 4, hasApprovedProjectLimit: approvedLimit, limits: { currentProjects: approvedLimit ? 3 : null, liveProjects: null }, overLimit: { currentProjects: true, liveProjects: true } }, invoices: [] };
    else { errors.push(`Unexpected request: ${method} ${path}`); return route.fulfill({ status: 404, json: { message: errors.at(-1) } }); }
    await route.fulfill({ json: body });
  });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  async function selectSource() {
    await page.goto(`${origin}/deploy`);
    await page.getByRole("combobox", { name: /^Workspace/ }).selectOption(team);
    assert.equal(await page.getByRole("combobox", { name: /^Workspace/ }).locator("option").filter({ hasText: "Archived team" }).count(), 0);
    await page.getByRole("combobox", { name: /^Repository/ }).selectOption("alice/example");
    await page.getByRole("combobox", { name: /^Branch/ }).selectOption("main");
    await page.getByRole("combobox", { name: "Directory", exact: true }).click();
    await page.getByRole("button", { name: "Repository root", exact: true }).click();
  }
  await selectSource();
  await page.getByLabel("Customer AWS account", { exact: true }).selectOption(binding);
  assert.equal(await page.getByLabel("Customer AWS account", { exact: true }).locator("option").filter({ hasText: "999999999999" }).count(), 0);
  await page.getByLabel("Deployment environment").fill("INVALID ENV");
  assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled(), true);
  await page.getByLabel("Deployment environment").fill("staging");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("link", { name: "Review deployment plan", exact: true }).waitFor();
  assert.equal(created[0].environmentName, "staging"); assert.equal(created[0].organizationId, team); assert.equal(created[0].awsAccountBindingId, binding);
  assert.equal(await page.getByRole("link", { name: "Review deployment plan", exact: true }).getAttribute("href"), `/projects/${project}/planning`);
  assert.equal(await page.getByRole("button", { name: "Deploy", exact: true }).count(), 0);
  bindingsUnavailable = true;
  await selectSource();
  await page.getByText(/Account bindings could not be loaded:/).waitFor();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("link", { name: "Review deployment plan", exact: true }).waitFor();
  assert.equal(created[1].environmentName, "dev"); assert.equal("awsAccountBindingId" in created[1], false);
  bindingsUnavailable = false; duplicate = true;
  await selectSource();
  await page.getByLabel("Customer AWS account", { exact: true }).selectOption(binding);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByText(/Existing project environment or AWS account does not match/).waitFor();
  assert.equal(await page.getByRole("link", { name: "Review deployment plan", exact: true }).count(), 0);
  await page.goto(`${origin}/billing`);
  await page.getByText(/^Period ends /).waitFor();
  assert.equal(await page.getByText("Over your workspace limit", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Over your plan's limit", { exact: true }).count(), 0);
  approvedLimit = true;
  await page.reload();
  await page.getByText("Over your workspace limit", { exact: true }).waitFor();
  assert.equal(await page.getByText("Over your plan's limit", { exact: true }).count(), 1);
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  assert.deepEqual(errors, []);
  console.log("Customer onboarding browser checks passed: environment/account scope, revoked/archive exclusion, unavailable bindings, duplicate scope refusal, plan review only and reviewed quota display.");
} finally { await browser?.close(); await server.close(); }
