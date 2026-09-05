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

async function mockDirectoryPickerShell(page, repositories) {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: { id: "1", name: "Directory Picker Tester", role: "developer" } } }));
  await page.route("**/api/projects/github/status", (route) => route.fulfill({ json: { connected: true } }));
  await page.route("**/api/projects/github/repositories", (route) => route.fulfill({ json: { repositories } }));
}

async function directoryValues(picker) {
  return picker.locator("[data-directory]").evaluateAll((directories) => directories.map((directory) => directory.dataset.directory).filter((directory) => directory && directory !== "."));
}

async function expandDirectory(picker, directory) {
  await picker.getByRole("button", { name: `Expand ${directory.split("/").at(-1)}`, exact: true }).click();
}

async function selectDirectory(picker, directory) {
  await picker.locator(`[data-directory="${directory}"]`).click();
}

test("new deployment directory picker expands a complete tree and selects canonical paths", async ({ page }) => {
  const directories = [".", ".github", ".github/workflows", "fullstack_20_combination_apps", "fullstack_20_combination_apps/01", "fullstack_20_combination_apps/01/backend", "fullstack_20_combination_apps/01/backend/config", "fullstack_20_combination_apps/01/frontend", "fullstack_20_combination_apps/01/frontend/src", "fullstack_20_combination_apps/02", "fullstack_20_combination_apps/02/backend", "fullstack_20_combination_apps/02/frontend"];
  await mockDirectoryPickerShell(page, [{ id: "tree", fullName: "example/tree", defaultBranch: "main" }]);
  await page.route("**/api/projects/github/repositories/example/tree", (route) => route.fulfill({ json: { repository: { defaultBranch: "main", branches: ["main"] } } }));
  await page.route("**/api/projects/github/repositories/example/tree/directories?ref=main", (route) => route.fulfill({ json: { directories } }));

  await page.goto("/deploy");
  await page.locator(".new-project-fields select").first().selectOption("example/tree");
  const directory = page.getByRole("combobox", { name: "Directory", exact: true });
  await directory.click();
  const picker = page.getByRole("tree", { name: "Repository directories" });
  await expect.poll(() => directoryValues(picker)).toEqual([".github", "fullstack_20_combination_apps"]);
  await expect(picker.locator('[data-directory*="/01"]')).toHaveCount(0);
  await expandDirectory(picker, "fullstack_20_combination_apps");
  await expect(picker.locator('[data-directory="fullstack_20_combination_apps/01"]')).toBeVisible();
  await expandDirectory(picker, "fullstack_20_combination_apps/01");
  await expect(picker.locator('[data-directory="fullstack_20_combination_apps/01/backend"]')).toBeVisible();
  await expect(picker.locator('[data-directory="fullstack_20_combination_apps/01/frontend"]')).toBeVisible();
  await expandDirectory(picker, "fullstack_20_combination_apps/01/frontend");
  await expect(picker.locator('[data-directory="fullstack_20_combination_apps/01/frontend/src"]')).toBeVisible();
  await selectDirectory(picker, "fullstack_20_combination_apps/01/frontend");
  await expect(directory).toHaveValue("fullstack_20_combination_apps/01/frontend");
  await expect(page.getByRole("tree")).toHaveCount(0);

  await directory.click();
  await selectDirectory(page.getByRole("tree", { name: "Repository directories" }), ".");
  await expect(directory).toHaveValue(".");
});

test("new deployment directory picker searches the tree and keeps every direct child scrollable", async ({ page }) => {
  const products = Array.from({ length: 300 }, (_, index) => `apps/product-${String(index).padStart(3, "0")}`);
  const directories = [".", "apps", "apps/customer", "apps/customer/web", ...products];
  await mockDirectoryPickerShell(page, [{ id: "many", fullName: "example/many", defaultBranch: "main" }]);
  await page.route("**/api/projects/github/repositories/example/many", (route) => route.fulfill({ json: { repository: { defaultBranch: "main", branches: ["main"] } } }));
  await page.route("**/api/projects/github/repositories/example/many/directories?ref=main", (route) => route.fulfill({ json: { directories } }));

  await page.goto("/deploy");
  await page.locator(".new-project-fields select").first().selectOption("example/many");
  const directory = page.getByRole("combobox", { name: "Directory", exact: true });
  await directory.click();
  const picker = page.getByRole("tree", { name: "Repository directories" });
  await expandDirectory(picker, "apps");
  await expect(picker.locator('[data-directory^="apps/"]')).toHaveCount(301);
  await expect(picker).toHaveCSS("overflow-y", "auto");
  await directory.fill("product-250");
  await expect.poll(() => directoryValues(picker)).toEqual(["apps", "apps/product-250"]);
  await selectDirectory(picker, "apps/product-250");
  await expect(directory).toHaveValue("apps/product-250");
});

test("new deployment directory picker keeps multi-service selections isolated and persists canonical paths", async ({ page }) => {
  const directories = [".", "apps", "apps/customer", "apps/customer/web", "services", "services/api"];
  let createPayload;
  await mockDirectoryPickerShell(page, [{ id: "multi", fullName: "example/multi", defaultBranch: "main" }]);
  await page.route("**/api/projects/github/repositories/example/multi", (route) => route.fulfill({ json: { repository: { defaultBranch: "main", branches: ["main"] } } }));
  await page.route("**/api/projects/github/repositories/example/multi/directories?ref=main", (route) => route.fulfill({ json: { directories } }));
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createPayload = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { project: { id: "11111111-1111-4111-8111-111111111111", repositoryFullName: "example/multi", targetBranch: "main", applicationEntryPointServiceId: createPayload.applicationEntryPointServiceId, services: createPayload.services } } });
  });

  await page.goto("/deploy");
  await page.locator(".new-project-fields select").first().selectOption("example/multi");
  const directoriesByService = page.getByRole("combobox", { name: "Directory", exact: true });
  await directoriesByService.first().click();
  let picker = page.getByRole("tree", { name: "Repository directories" });
  await expandDirectory(picker, "apps");
  await expandDirectory(picker, "apps/customer");
  await selectDirectory(picker, "apps/customer/web");
  await page.getByRole("button", { name: "+ Add Service" }).click();
  await directoriesByService.nth(1).click();
  picker = page.getByRole("tree", { name: "Repository directories" });
  await expandDirectory(picker, "services");
  await selectDirectory(picker, "services/api");
  await expect(directoriesByService.nth(0)).toHaveValue("apps/customer/web");
  await expect(directoriesByService.nth(1)).toHaveValue("services/api");
  const applicationService = page.getByRole("combobox", { name: "Application service", exact: true });
  const secondServiceIdentity = await applicationService.locator("option").nth(2).getAttribute("value");
  await applicationService.selectOption(secondServiceIdentity);
  await page.getByRole("button", { name: "Continue" }).click();
  expect(createPayload.services.map(({ serviceDirectory }) => serviceDirectory)).toEqual(["apps/customer/web", "services/api"]);
});

test("new deployment directory picker ignores stale repository and branch directory responses", async ({ page }) => {
  let firstRepositoryRequest;
  const firstRepositoryRequested = new Promise((resolve) => { firstRepositoryRequest = resolve; });
  let releaseFirstRepository;
  const firstRepositoryReleased = new Promise((resolve) => { releaseFirstRepository = resolve; });
  let releaseBranchRequest;
  const releaseBranchRequested = new Promise((resolve) => { releaseBranchRequest = resolve; });
  let releaseBranch;
  const releaseBranchReleased = new Promise((resolve) => { releaseBranch = resolve; });
  let firstRepositoryCalls = 0;

  await mockDirectoryPickerShell(page, [
    { id: "a", fullName: "example/a", defaultBranch: "main" },
    { id: "b", fullName: "example/b", defaultBranch: "main" },
  ]);
  await page.route("**/api/projects/github/repositories/example/a", (route) => route.fulfill({ json: { repository: { defaultBranch: "main", branches: ["main"] } } }));
  await page.route("**/api/projects/github/repositories/example/b", (route) => route.fulfill({ json: { repository: { defaultBranch: "main", branches: ["main", "release"] } } }));
  await page.route("**/api/projects/github/repositories/example/a/directories?ref=main", async (route) => {
    firstRepositoryCalls += 1;
    if (firstRepositoryCalls === 1) {
      firstRepositoryRequest();
      await firstRepositoryReleased;
    }
    await route.fulfill({ json: { directories: [".", "from-a"] } });
  });
  await page.route("**/api/projects/github/repositories/example/b/directories?ref=*", async (route) => {
    if (new URL(route.request().url()).searchParams.get("ref") === "release") {
      releaseBranchRequest();
      await releaseBranchReleased;
      await route.fulfill({ json: { directories: [".", "from-b-release"] } });
      return;
    }
    await route.fulfill({ json: { directories: [".", "from-b-main"] } });
  });

  await page.goto("/deploy");
  const repositorySelector = page.locator(".new-project-fields select").first();
  const branchSelector = page.locator(".new-project-fields select").nth(1);
  const directory = page.getByRole("combobox", { name: "Directory", exact: true });
  await repositorySelector.selectOption("example/a");
  await firstRepositoryRequested;
  await repositorySelector.selectOption("example/b");
  await expect(branchSelector).toHaveValue("main");
  await directory.click();
  await expect.poll(() => directoryValues(page.getByRole("tree", { name: "Repository directories" }))).toEqual(["from-b-main"]);
  releaseFirstRepository();
  await expect.poll(() => directoryValues(page.getByRole("tree", { name: "Repository directories" }))).toEqual(["from-b-main"]);

  await page.getByRole("tree").locator('[data-directory="from-b-main"]').click();
  await expect(directory).toHaveValue("from-b-main");
  await directory.fill("from-b");
  await branchSelector.selectOption("release");
  await releaseBranchRequested;
  await expect(directory).toHaveValue("from-b-main");
  const mainDirectoryResponse = page.waitForResponse((response) => response.url().includes("/example/b/directories?ref=main"));
  await branchSelector.selectOption("main");
  await mainDirectoryResponse;
  await directory.click();
  await expect.poll(() => directoryValues(page.getByRole("tree", { name: "Repository directories" }))).toEqual(["from-b-main"]);
  releaseBranch();
  await expect.poll(() => directoryValues(page.getByRole("tree", { name: "Repository directories" }))).toEqual(["from-b-main"]);

  await repositorySelector.selectOption("example/a");
  await expect(directory).toHaveValue("");
  await directory.click();
  await expect.poll(() => directoryValues(page.getByRole("tree", { name: "Repository directories" }))).toEqual(["from-a"]);
});

test("new deployment directory picker keeps exact path entry available when directory browsing is unavailable", async ({ page }) => {
  let createPayload;
  await mockDirectoryPickerShell(page, [{ id: "large", fullName: "example/large", defaultBranch: "main" }]);
  await page.route("**/api/projects/github/repositories/example/large", (route) => route.fulfill({ json: { repository: { defaultBranch: "main", branches: ["main"] } } }));
  await page.route("**/api/projects/github/repositories/example/large/directories?ref=main", (route) => route.fulfill({ status: 400, json: { message: "Repository tree is too large to browse safely. Enter the repository-relative service directory explicitly." } }));
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createPayload = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { project: { id: "22222222-2222-4222-8222-222222222222", repositoryFullName: "example/large", targetBranch: "main", applicationEntryPointServiceId: createPayload.services[0].id, services: createPayload.services } } });
  });

  await page.goto("/deploy");
  await page.locator(".new-project-fields select").first().selectOption("example/large");
  await expect(page.getByText("Suggestions are unavailable. Enter the exact repository-relative path.")).toBeVisible();
  await expect(page.getByLabel("Exact directory path", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enter path manually" })).toHaveCount(0);
  const directory = page.getByRole("combobox", { name: "Directory", exact: true });
  await expect(directory).toBeEnabled();
  await directory.fill("products/customer/application");
  await expect(directory).toHaveValue("products/customer/application");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("region", { name: "Deployment review" })).toBeVisible();
  expect(createPayload.services[0].serviceDirectory).toBe("products/customer/application");
});

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
  await page.getByRole("button", { name: "Save changes" }).click();
  const details = await expectJson(await detailsResponse);
  expect(details.project.name).toBe("Certified application");
  await expect(page.getByText("Project details saved.")).toBeVisible();

  await page.getByRole("tab", { name: "Services" }).click();
  const addResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith(`/api/projects/${projectId}/services`));
  await page.getByRole("button", { name: "+ Add service" }).click();
  const added = await expectJson(await addResponse, 201);
  expect(added.service.id).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByText("Service added.")).toBeVisible();

  const cards = page.locator(".settings-service-card");
  await expect(cards).toHaveCount(2);
  const second = cards.nth(1);
  await second.locator("summary").click();
  await second.getByLabel("Name").fill("Api");
  await second.getByLabel("Directory").fill("apps/api");
  const serviceResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes(`/api/projects/${projectId}/services/`));
  await second.getByRole("button", { name: "Save service" }).click();
  const savedService = await expectJson(await serviceResponse);
  expect(savedService.service.serviceDirectory).toBe("apps/api");
  const apiServiceId = savedService.service.id;

  const applicationService = page.getByRole("combobox", { name: "Open Application service", exact: true });
  await applicationService.selectOption(apiServiceId);
  const applicationServiceResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/projects/${projectId}`));
  await page.getByRole("button", { name: "Save entrypoint" }).click();
  const applicationProject = await expectJson(await applicationServiceResponse);
  expect(applicationProject.project.applicationEntryPointServiceId).toBe(apiServiceId);
  const selectedDelete = await request.delete(`${apiBase}/api/projects/${projectId}/services/${apiServiceId}`);
  expect(selectedDelete.status()).toBe(400);

  await page.getByRole("tab", { name: "Variables" }).click();
  const variableService = page.getByRole("combobox", { name: "Service", exact: true });
  await variableService.selectOption({ index: 0 });
  await page.getByLabel("Paste KEY=VALUE lines").fill("PUBLIC_URL=https://example.test");
  const publicEnvResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(`/api/projects/${projectId}/services/`) && response.url().endsWith("/env/bulk"));
  await page.getByRole("button", { name: "Save pasted variables" }).click();
  const publicEnv = await expectJson(await publicEnvResponse, 201);
  expect(publicEnv.variables).toHaveLength(1);
  expect(JSON.stringify(publicEnv)).not.toContain("https://example.test");

  await variableService.selectOption(apiServiceId);
  await page.getByLabel("Paste KEY=VALUE lines").fill("JWT_SECRET=browser-secret-value");
  const secretEnvResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes(apiServiceId) && response.url().endsWith("/env/bulk"));
  await page.getByRole("button", { name: "Save pasted variables" }).click();
  const secretEnv = await expectJson(await secretEnvResponse, 201);
  expect(secretEnv.variables[0].isSecret).toBe(true);
  expect(JSON.stringify(secretEnv)).not.toContain("browser-secret-value");

  await page.getByRole("tab", { name: "Database" }).click();
  const databaseForm = page.locator("form").filter({ has: page.getByRole("heading", { name: "Managed database" }) });
  await databaseForm.getByLabel("Database type").selectOption("mysql");
  await databaseForm.getByLabel("Attached service").selectOption(apiServiceId);
  const databaseResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/projects/${projectId}/database-tier`));
  await databaseForm.getByRole("button", { name: "Save database" }).click();
  const database = await expectJson(await databaseResponse);
  expect(database.database).toMatchObject({ provider: "managed", engine: "mysql", attachedServiceId: apiServiceId });

  await databaseForm.getByLabel("Database type").selectOption("none");
  const disabledResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/projects/${projectId}/database-tier`));
  await databaseForm.getByRole("button", { name: "Save database" }).click();
  expect((await expectJson(await disabledResponse)).database.provider).toBe("none");
  await databaseForm.getByLabel("Database type").selectOption("mongodb");
  await databaseForm.getByLabel("Attached service").selectOption(apiServiceId);
  const mongodbResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/projects/${projectId}/database-tier`));
  await databaseForm.getByRole("button", { name: "Save database" }).click();
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
  await expect(readonlyPage.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  await readonlyPage.goto("/deploy");
  await expect(readonlyPage).toHaveURL(/\/403$/);
  const forbidden = await readonly.request.patch(`${apiBase}/api/projects/${projectId}`, { data: { name: "forbidden" }, headers: { "X-User-Id": readonlyUserId } });
  expect(forbidden.status()).toBe(403);
  await readonly.close();

  saveResult({ projectId, apiServiceId, currentState: current.stateAuthority.state, browserMutations: 9, crossPageSurfaces: surfaces.length });
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
