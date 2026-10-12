import { strict as assert } from "node:assert";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const server = await createServer({ define: { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("") }, server: { host: "127.0.0.1", port: 0 }, logLevel: "error" });
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.DG_CHROME_BIN || "/usr/bin/google-chrome", args: ["--no-sandbox"], headless: true });
  const page = await browser.newPage();
  const workspace = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222";
  const invoices = [], attempts = [], errors = [];
  let failFirstIssue = true;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (!path.startsWith("/api/")) return route.continue();
    let body;
    if (path === "/api/auth/me") body = { user: { id: 1, role: "developer", name: "Alice" } };
    else if (path === "/api/admin-auth/me") body = { user: { id: 3, role: "admin", internalAdminRole: "billing" } };
    else if (path === "/api/admin/verify-identity") { assert.equal(route.request().postDataJSON().password, "operator-password"); body = { verifiedUntil: new Date(Date.now() + 900000).toISOString() }; }
    else if (path === "/api/admin/billing/workspaces") body = { workspaces: [{ id: workspace, name: "Delivery team", kind: "team" }, { id: other, name: "Another team", kind: "team" }] };
    else if (path.endsWith("/invoices") && method === "GET") body = { invoices: path.includes(workspace) ? invoices : [] };
    else if (path === "/api/admin/billing/invoices" && method === "POST") {
      const input = route.request().postDataJSON(); attempts.push(input);
      assert.equal(input.organizationId, workspace); assert.equal(input.amountDueCents, 39900); assert.equal(input.reason, "Agreed subscription");
      if (failFirstIssue) { failFirstIssue = false; await route.fulfill({ status: 503, json: { message: "Temporary billing outage" } }); return; }
      assert.equal(input.idempotencyKey, attempts[0].idempotencyKey, "retry preserves invoice identity");
      invoices.push({ id: "33333333-3333-4333-8333-333333333333", invoiceNumber: "DG-B2B-ORIGINAL", organizationId: workspace, amountDue: input.amountDueCents, plan: input.plan, currency: "USD", provider: "b2b", status: "open", dueAt: input.dueAt });
      body = { invoice: invoices[0] };
    } else if (path.endsWith("/adjust")) {
      const input = route.request().postDataJSON(); assert.equal(input.amountDueCents, 35000); assert.equal(input.reason, "Corrected agreed amount");
      invoices[0].status = "void";
      invoices.push({ ...invoices[0], id: "44444444-4444-4444-8444-444444444444", invoiceNumber: "DG-B2B-ADJUSTED", adjustmentOfInvoiceId: invoices[0].id, amountDue: 35000, status: "open" }); body = { invoice: invoices[1] };
    } else if (path.endsWith("/reconcile")) {
      const input = route.request().postDataJSON(); assert.equal(input.amountPaidCents, 35000); assert.equal(input.externalPaymentReference, "bank-001");
      invoices[1].status = "paid"; invoices[1].providerTransactionId = "b2b:bank-001"; invoices[1].paidAt = input.paidAt; body = { invoice: invoices[1] };
    } else { errors.push(`Unexpected request: ${method} ${path}`); await route.fulfill({ status: 404, json: { message: errors.at(-1) } }); return; }
    await route.fulfill({ json: body });
  });
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/admin/billing`);
  // First load includes Vite dependency optimization; allow a cold start.
  await page.getByLabel("Administrator password", { exact: true }).waitFor({ timeout: 30000 }).catch(async (error) => { console.error({ url: page.url(), errors, text: (await page.locator("body").innerText()).slice(0, 1800) }); throw error; });
  await page.getByLabel("Administrator password", { exact: true }).fill("operator-password");
  await page.getByRole("button", { name: "Confirm identity", exact: true }).click();
  await page.getByLabel("Organization", { exact: true }).selectOption(workspace);
  await page.getByLabel("Amount in USD cents", { exact: true }).fill("39900");
  await page.getByLabel("Due date", { exact: true }).fill("2026-10-20T12:00");
  await page.getByLabel("Period starts", { exact: true }).fill("2026-10-11T00:00");
  await page.getByLabel("Period ends", { exact: true }).fill("2026-11-11T00:00");
  await page.getByLabel("Invoice reason", { exact: true }).fill("Agreed subscription");
  await page.getByRole("button", { name: "Issue invoice", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Temporary billing outage" }).waitFor();
  await page.getByRole("button", { name: "Issue invoice", exact: true }).click();
  await page.getByRole("heading", { name: "DG-B2B-ORIGINAL", exact: true }).waitFor();
  assert.equal(await page.getByLabel("Administrator password", { exact: true }).inputValue(), "", "password is cleared after verification");
  await page.getByText("Adjust unpaid invoice", { exact: true }).click();
  await page.getByLabel("Adjusted amount in USD cents", { exact: true }).fill("35000");
  await page.getByLabel("Adjustment reason", { exact: true }).fill("Corrected agreed amount");
  await page.getByRole("button", { name: "Record adjustment", exact: true }).click();
  await page.getByRole("heading", { name: "DG-B2B-ADJUSTED", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "DG-B2B-ORIGINAL", exact: true }).count(), 1);
  await page.getByLabel("External payment reference", { exact: true }).fill("bank-001");
  await page.getByLabel("Paid amount in USD cents", { exact: true }).fill("35000");
  await page.getByLabel("Payment received at", { exact: true }).fill("2026-10-11T12:00");
  await page.getByLabel("Reconciliation reason", { exact: true }).fill("Receipt verified against bank statement");
  await page.getByRole("checkbox", { name: "I verified this payment against the external receipt.", exact: true }).check();
  await page.getByRole("button", { name: "Reconcile payment", exact: true }).click();
  await page.getByText("Receipt: b2b:bank-001", { exact: true }).waitFor();
  await page.getByLabel("Organization", { exact: true }).selectOption(other);
  await page.getByText("No invoices for this organization.", { exact: true }).waitFor();
  assert.equal(await page.getByText("Receipt: b2b:bank-001", { exact: true }).count(), 0);
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
  assert.deepEqual(errors, []);
  console.log("Organization billing browser checks passed: verification, retry identity, retained adjustment, external receipt, workspace isolation and mobile controls.");
} finally { await browser?.close(); await server.close(); }
