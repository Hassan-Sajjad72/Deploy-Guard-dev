import { strict as assert } from "node:assert";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const server = await createServer({ define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("") }, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.DG_CHROME_BIN || "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (error) => console.error(error.message));
  const personal = "11111111-1111-4111-8111-111111111111";
  const team = "22222222-2222-4222-8222-222222222222";
  const agency = "44444444-4444-4444-8444-444444444444";
  const clients = [];
  const engagements = [];
  let userRole = "developer";
  const bindings = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) { await route.continue(); return; }
    const method = route.request().method();
    let body;
    if (path === "/api/auth/me") body = { user: { id: "1", role: userRole, name: "Alice", githubLogin: "alice" } };
    else if (path === "/api/workspaces") body = { workspaces: [{ id: personal, name: "Alice", kind: "personal", role: "owner" }, { id: team, name: "Team", kind: "team", role: "engineer" }, { id: agency, name: "Agency", kind: "agency", role: "owner" }] };
    else if (path.endsWith("/members")) body = { members: [{ userId: 1, githubLogin: "alice", role: path.includes(team) ? "engineer" : "owner" }] };
    else if (path.endsWith("/portfolio")) body = { clients, engagements };
    else if (path.endsWith("/clients") && method === "POST") { clients.push({ id: "55555555-5555-4555-8555-555555555555", ...route.request().postDataJSON(), archivedAt: null }); body = { client: clients[0] }; }
    else if (path.endsWith("/engagements") && method === "POST") { const submitted = route.request().postDataJSON(); assert.equal(submitted.clientAuthorizationConfirmed, true); assert.equal(submitted.awsAccountBindingId, bindings[0].id); engagements.push({ id: "66666666-6666-4666-8666-666666666666", clientId: clients[0].id, ...submitted }); body = { engagement: engagements[0] }; }
    else if (path.endsWith("/archive") && method === "POST") { assert.equal(route.request().postDataJSON().reason, "Contract completed"); clients[0].archivedAt = new Date().toISOString(); body = { archived: true }; }
    else if (path.endsWith("/aws-bindings") && method === "GET") body = { bindings: path.includes(personal) || path.includes(agency) ? bindings : [] };
    else if (path.endsWith("/aws-bindings") && method === "POST") {
      const submitted = route.request().postDataJSON();
      assert.equal(submitted.accountId, "123456789012");
      const binding = { id: "33333333-3333-4333-8333-333333333333", ...submitted, verificationStatus: "pending" };
      bindings.push(binding);
      body = { binding, trustPolicy: { Statement: [{ Principal: { AWS: "arn:aws:iam::111122223333:role/ControlPlane" }, Condition: { StringEquals: { "sts:ExternalId": "test-binding-id" } } }] } };
    } else if (path.endsWith("/verify")) { bindings[0].verificationStatus = "verified"; body = { status: "verified", evidence: { mutationAuthority: "unverified" } }; }
    else { await route.fulfill({ status: 404, json: { message: `Unexpected fixture request: ${method} ${path}` } }); return; }
    await route.fulfill({ json: body });
  });
  const url = `http://127.0.0.1:${server.httpServer.address().port}/workspaces`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Workspaces & AWS accounts", exact: true }).waitFor({ timeout: 10000 }).catch(async (error) => { console.error((await page.locator("body").innerText()).slice(0, 2000)); throw error; });
  await page.getByLabel("AWS account ID", { exact: true }).fill("123456789012");
  await page.getByLabel("Customer IAM role ARN").fill("arn:aws:iam::123456789012:role/CustomerRole");
  await page.getByLabel("Authorized AWS regions, separated by commas").fill("us-east-1");
  await page.getByRole("button", { name: "Add AWS account", exact: true }).click();
  await page.getByText("AWS account binding created.", { exact: false }).waitFor();
  assert.equal(await page.getByText("test-binding-id", { exact: false }).count(), 1);
  await page.getByRole("button", { name: "Verify account", exact: true }).click();
  await page.getByText("AWS account identity and read authorization verified.", { exact: true }).waitFor();
  await page.getByLabel("Workspace", { exact: true }).selectOption(team);
  await page.getByText("No AWS account bindings yet.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Add AWS account", exact: true }).count(), 0, "engineers cannot administer AWS bindings");
  await page.getByLabel("Workspace", { exact: true }).selectOption(agency);
  await page.getByRole("heading", { name: "Client portfolio", exact: true }).waitFor();
  await page.getByLabel("New client name", { exact: true }).fill("Acme");
  await page.getByRole("button", { name: "Create client", exact: true }).click();
  await page.getByText("Client created.", { exact: true }).waitFor();
  await page.getByText("Add engagement for Acme", { exact: true }).click();
  await page.getByLabel("Engagement name", { exact: true }).fill("Website");
  await page.getByLabel("Client AWS account", { exact: true }).selectOption(bindings[0].id);
  await page.getByLabel("Client authorization reference", { exact: true }).fill("Signed authorization");
  await page.getByRole("checkbox", { name: "I confirm the client authorized this AWS account for this engagement.", exact: true }).check();
  await page.getByRole("button", { name: "Create engagement", exact: true }).click();
  await page.getByText("Client-authorized engagement created.", { exact: true }).waitFor();
  assert.equal(await page.getByRole("link", { name: "View engagement projects", exact: true }).getAttribute("href"), `/projects?engagementId=${engagements[0].id}`);
  await page.getByText("Manage Acme", { exact: true }).click();
  await page.getByLabel("Archive reason", { exact: true }).first().fill("Contract completed");
  await page.getByRole("button", { name: "Archive client", exact: true }).click();
  await page.getByRole("heading", { name: "Acme · Archived", exact: true }).waitFor();
  assert.equal(await page.getByText("Add engagement for Acme", { exact: true }).count(), 0);
  assert.equal(bindings[0].verificationStatus, "verified", "archival does not revoke account or delete workload");
  userRole = "readonly";
  await page.reload();
  await page.getByRole("heading", { name: "AWS account bindings", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Add AWS account", exact: true }).count(), 0);
  assert.equal(await page.getByText("Create a team or agency workspace", { exact: true }).count(), 0);
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, "workspace controls fit a mobile viewport");
  console.log("Workspace browser checks passed: AWS onboarding, agency authorization, archive retention, role restrictions and mobile viewport.");
} finally { await browser?.close(); await server.close(); }
