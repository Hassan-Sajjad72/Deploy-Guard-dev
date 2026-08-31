import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const apiBase = process.env.PLAYWRIGHT_API_URL;
const projectId = process.env.PLAYWRIGHT_PROJECT_ID;
const readonlyUserId = process.env.PLAYWRIGHT_READONLY_USER_ID;
const resultPath = process.env.PLAYWRIGHT_RESULT_PATH;

function saveResult(value) {
  mkdirSync(dirname(resultPath), { recursive: true });
  const current = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, "utf8")) : {};
  writeFileSync(resultPath, `${JSON.stringify({ ...current, ...value }, null, 2)}\n`);
}

async function expectJson(response, status = 200) {
  expect(response.status()).toBe(status);
  expect(response.headers()["content-type"] || "").toContain("application/json");
  return response.json();
}

test("real browser configuration, persistence-facing responses, navigation, reload, and authorization", async ({ page, request, browser }) => {
  const anonymous = await fetch(`${apiBase}/api/projects`);
  expect(anonymous.status).toBe(401);
  const invalid = await request.get(`${apiBase}/api/projects/not-a-uuid`);
  expect(invalid.status()).toBe(400);
  const missing = await request.get(`${apiBase}/api/projects/99999999-9999-4999-8999-999999999999`);
  expect(missing.status()).toBe(404);

  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText("fixture/local · main")).toBeVisible();

  await page.getByLabel("Name").first().fill("Certified application");
  await page.getByLabel("Description").fill("Full-stack persisted configuration");
  const detailsResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/projects/${projectId}`));
  await page.getByRole("button", { name: "Save project details" }).click();
  const details = await expectJson(await detailsResponse);
  expect(details.project.name).toBe("Certified application");
  await expect(page.getByText("Project details saved.")).toBeVisible();

  const addResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/projects/${projectId}/services`));
  await page.getByRole("button", { name: "+ Add Service" }).click();
  const added = await expectJson(await addResponse, 201);
  expect(added.service.id).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByText("Service added.")).toBeVisible();

  const cards = page.locator(".settings-service-card");
  await expect(cards).toHaveCount(2);
  const second = cards.nth(1);
  await second.getByLabel("Name").fill("Api");
  await second.getByLabel("Repository-relative directory").fill("apps/api");
  const serviceResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes(`/api/projects/${projectId}/services/`));
  await second.getByRole("button", { name: "Save service" }).click();
  const savedService = await expectJson(await serviceResponse);
  expect(savedService.service.serviceDirectory).toBe("apps/api");
  const apiServiceId = savedService.service.id;

  const first = cards.nth(0);
  await first.getByLabel("Paste KEY=VALUE lines").fill("PUBLIC_URL=https://example.test");
  const publicEnvResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/api/projects/${projectId}/services/`) && response.url().endsWith("/env/bulk"));
  await first.getByRole("button", { name: "Save pasted variables" }).click();
  const publicEnv = await expectJson(await publicEnvResponse, 201);
  expect(publicEnv.variables).toHaveLength(1);
  expect(JSON.stringify(publicEnv)).not.toContain("https://example.test");

  await second.getByLabel("Paste KEY=VALUE lines").fill("JWT_SECRET=browser-secret-value");
  const secretEnvResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(apiServiceId) && response.url().endsWith("/env/bulk"));
  await second.getByRole("button", { name: "Save pasted variables" }).click();
  const secretEnv = await expectJson(await secretEnvResponse, 201);
  expect(secretEnv.variables[0].isSecret).toBe(true);
  expect(JSON.stringify(secretEnv)).not.toContain("browser-secret-value");

  const databaseForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Managed database" }) });
  await databaseForm.locator("select").nth(0).selectOption("managed");
  await databaseForm.locator("select").nth(1).selectOption("mysql");
  await databaseForm.locator("select").nth(2).selectOption(apiServiceId);
  const databaseResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/projects/${projectId}/database-tier`));
  await databaseForm.getByRole("button", { name: "Save database settings" }).click();
  const database = await expectJson(await databaseResponse);
  expect(database.database).toMatchObject({ provider: "managed", engine: "mysql", attachedServiceId: apiServiceId });

  await databaseForm.locator("select").nth(0).selectOption("none");
  const disabledResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/projects/${projectId}/database-tier`));
  await databaseForm.getByRole("button", { name: "Save database settings" }).click();
  expect((await expectJson(await disabledResponse)).database.provider).toBe("none");
  await databaseForm.locator("select").nth(0).selectOption("managed");
  await databaseForm.locator("select").nth(1).selectOption("mongodb");
  await databaseForm.locator("select").nth(2).selectOption(apiServiceId);
  const mongodbResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/projects/${projectId}/database-tier`));
  await databaseForm.getByRole("button", { name: "Save database settings" }).click();
  expect((await expectJson(await mongodbResponse)).database.engine).toBe("mongodb");

  const wrongDestroy = await request.post(`${apiBase}/api/projects/${projectId}/deploy/destroy`, { data: { confirmationPhrase: "wrong" } });
  expect(wrongDestroy.status()).toBe(400);
  const rollbackCandidates = await request.get(`${apiBase}/api/projects/${projectId}/deploy/rollback-candidates`);
  expect((await expectJson(rollbackCandidates)).candidates).toEqual([]);

  const surfaces = [
    ["", "Certified application"], ["/pipeline", "Deployment pipeline"],
    ["/infrastructure", "Runtime infrastructure"], ["/monitoring", "Monitoring"], ["/settings", "Settings"],
  ];
  for (const [suffix, heading] of surfaces) {
    await page.goto(`/projects/${projectId}${suffix}`);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  const current = await expectJson(await request.get(`${apiBase}/api/projects/${projectId}/current-state`));
  const detailed = await expectJson(await request.get(`${apiBase}/api/projects/${projectId}/current-state/details`));
  expect(current.repository).toBe("fixture/local");
  expect(detailed.repository).toBe(current.repository);
  expect(detailed.branch).toBe(current.branch);
  expect(detailed.stateAuthority.state).toBe(current.stateAuthority.state);

  const readonly = await browser.newContext({ baseURL: process.env.PLAYWRIGHT_FRONTEND_URL, extraHTTPHeaders: { "X-User-Id": readonlyUserId } });
  const readonlyPage = await readonly.newPage();
  await readonlyPage.goto(`/projects/${projectId}/settings`);
  await expect(readonlyPage.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(readonlyPage.getByRole("button", { name: "Save project details" })).toHaveCount(0);
  await readonlyPage.goto("/deploy");
  await expect(readonlyPage).toHaveURL(/\/403$/);
  const forbidden = await readonly.request.patch(`${apiBase}/api/projects/${projectId}`, { data: { name: "forbidden" }, headers: { "X-User-Id": readonlyUserId } });
  expect(forbidden.status()).toBe(403);
  await readonly.close();

  saveResult({ projectId, apiServiceId, currentState: current.stateAuthority.state, browserMutations: 8, crossPageSurfaces: surfaces.length });
});

test("real GitHub-backed repository and branch selection with project creation when admitted", async ({ page, request }) => {
  let statusResponse = await request.get(`${apiBase}/api/projects/github/status`);
  let status = await expectJson(statusResponse);
  if (!status.connected && status.availableInstallations?.length) {
    const connect = await request.post(`${apiBase}/api/projects/github/installations/${status.availableInstallations[0].installationId}/connect`);
    await expectJson(connect, 201);
    statusResponse = await request.get(`${apiBase}/api/projects/github/status`);
    status = await expectJson(statusResponse);
  }
  const repositoriesResponse = await request.get(`${apiBase}/api/projects/github/repositories`);
  if (!status.connected || repositoriesResponse.status() !== 200) {
    await page.goto("/deploy");
    await expect(page.getByRole("heading", { name: "Connect GitHub App" })).toBeVisible();
    saveResult({ githubSelection: "EXPECTED_BLOCKER", githubMessage: "GitHub App installation is not connected for the isolated user." });
    return;
  }
  const repositories = (await repositoriesResponse.json()).repositories || [];
  expect(repositories.length).toBeGreaterThan(0);
  await page.goto("/deploy");
  await expect(page.getByRole("heading", { name: "Repository, branch, and environment" })).toBeVisible();
  const repository = repositories.find((item) => item.fullName !== "fixture/local") || repositories[0];
  await page.getByLabel("Authorized repository").selectOption(repository.fullName);
  await expect.poll(async () => page.getByLabel("Branch").locator("option").count()).toBeGreaterThan(1);
  const createResponsePromise = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/projects");
  await page.getByRole("button", { name: "Continue" }).click();
  const createResponse = await createResponsePromise;
  const body = await createResponse.json();
  expect([200, 201, 409]).toContain(createResponse.status());
  const createdProject = body.project || body.existingProject;
  expect(createdProject?.id).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByText(/ready for deployment/i)).toBeVisible();
  saveResult({ githubSelection: "PASS", createdProjectId: createdProject.id, selectedRepository: repository.fullName, selectedBranch: createdProject.targetBranch });
});
