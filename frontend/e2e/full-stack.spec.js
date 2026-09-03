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

async function directorySuggestionValues(picker) {
  return picker.getByRole("option").evaluateAll((options) => options.map((option) => option.dataset.directory).filter(Boolean));
}

test("new deployment directory picker autocompletes root and paths while preserving direct manual entry", async ({ page }) => {
  let createPayload;
  await mockDirectoryPickerShell(page, [{ id: "simple", fullName: "example/simple", defaultBranch: "main" }]);
  await page.route("**/api/projects/github/repositories/example/simple", (route) => route.fulfill({ json: { repository: { defaultBranch: "main", branches: ["main"] } } }));
  await page.route("**/api/projects/github/repositories/example/simple/directories?ref=main", (route) => route.fulfill({ json: { directories: [".", "src", "public"] } }));
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createPayload = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { project: { id: "33333333-3333-4333-8333-333333333333", repositoryFullName: "example/simple", targetBranch: "main", applicationEntryPointServiceId: createPayload.services[0].id, services: createPayload.services } } });
  });

  await page.goto("/deploy");
  const repositorySelector = page.locator(".new-project-fields select").first();
  const branchSelector = page.locator(".new-project-fields select").nth(1);
  const directory = page.getByRole("combobox", { name: "Directory", exact: true });

  await repositorySelector.selectOption("example/simple");
  await expect(branchSelector).toHaveValue("main");
  await directory.focus();
  const suggestions = page.getByRole("listbox", { name: "Directory suggestions for Web" });
  await expect.poll(() => directorySuggestionValues(suggestions)).toEqual([".", "public", "src"]);
  await suggestions.locator('[data-directory="."]').click();
  await expect(directory).toHaveValue(".");
  await directory.fill("src");
  await expect.poll(() => directorySuggestionValues(suggestions)).toEqual(["src"]);
  await directory.press("ArrowDown");
  await directory.press("Enter");
  await expect(directory).toHaveValue("src");
  await directory.fill("platform/products/customer/web/application");
  await expect(directory).toHaveValue("platform/products/customer/web/application");
  await expect(page.getByLabel("Exact directory path", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enter path manually" })).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("region", { name: "Deployment review" })).toBeVisible();
  expect(createPayload.services[0].serviceDirectory).toBe("platform/products/customer/web/application");
});

test("new deployment directory picker searches large monorepos and preserves independent multi-service configuration", async ({ page }) => {
  const manySiblings = Array.from({ length: 300 }, (_, index) => `apps/product-${String(index).padStart(3, "0")}`);
  const mainDirectories = [
    ".", "apps", "apps/admin", "apps/admin/src", "apps/customer", "apps/customer/src", ...manySiblings,
    "packages", "packages/shared", "services", "services/api", "services/api/src", "services/auth",
    "platform/products/customer/web/application",
  ];
  let createPayload;
  let databasePayload;
  await mockDirectoryPickerShell(page, [{ id: "monorepo", fullName: "example/monorepo", defaultBranch: "main" }]);
  await page.route("**/api/projects/github/repositories/example/monorepo", (route) => route.fulfill({ json: { repository: { defaultBranch: "main", branches: ["main"] } } }));
  await page.route("**/api/projects/github/repositories/example/monorepo/directories?ref=main", (route) => route.fulfill({ json: { directories: mainDirectories } }));
  await page.route("**/api/projects", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createPayload = route.request().postDataJSON();
    await route.fulfill({ status: 201, json: { project: { id: "11111111-1111-4111-8111-111111111111", repositoryFullName: "example/monorepo", targetBranch: "main", applicationEntryPointServiceId: createPayload.applicationEntryPointServiceId, services: createPayload.services } } });
  });
  await page.route("**/api/projects/11111111-1111-4111-8111-111111111111/database-tier", async (route) => {
    databasePayload = route.request().postDataJSON();
    await route.fulfill({ json: { database: databasePayload } });
  });

  await page.goto("/deploy");
  await page.locator(".new-project-fields select").first().selectOption("example/monorepo");
  const directories = page.getByRole("combobox", { name: "Directory", exact: true });
  await directories.first().fill("api");
  let suggestionPickers = page.getByRole("listbox");
  await expect.poll(() => directorySuggestionValues(suggestionPickers.first())).toEqual(["services/api", "services/api/src"]);
  await expect(suggestionPickers.first().getByRole("option")).toHaveCount(2);
  const apiSuggestion = suggestionPickers.first().locator('[data-directory="services/api"]');
  await expect(apiSuggestion.locator("strong")).toHaveText("api");
  await expect(apiSuggestion.locator("small")).toHaveText("services/api");
  await apiSuggestion.click();
  await expect(directories.first()).toHaveValue("services/api");
  await page.getByRole("button", { name: "+ Add Service" }).click();

  await directories.nth(1).fill("customer");
  await expect(directories.first()).toHaveValue("services/api");
  suggestionPickers = page.getByRole("listbox");
  await expect.poll(() => directorySuggestionValues(suggestionPickers)).toEqual(["apps/customer", "apps/customer/src", "platform/products/customer/web/application"]);
  const deepSuggestion = suggestionPickers.locator('[data-directory="platform/products/customer/web/application"]');
  await expect(deepSuggestion.locator("strong")).toHaveText("application");
  await expect(deepSuggestion.locator("small")).toHaveText("platform/products/customer/web/application");
  await suggestionPickers.locator('[data-directory="apps/customer"]').click();
  await expect(directories.first()).toHaveValue("services/api");
  await expect(directories.nth(1)).toHaveValue("apps/customer");

  const applicationService = page.getByRole("combobox", { name: "Application service", exact: true });
  const secondServiceIdentity = await applicationService.locator("option").nth(2).getAttribute("value");
  await applicationService.selectOption(secondServiceIdentity);
  const ports = page.getByRole("spinbutton", { name: /Application port/ });
  await ports.first().fill("4173");
  await ports.nth(1).fill("8000");
  const databaseControls = page.locator(".settings-simple-form select");
  await databaseControls.first().selectOption("mysql");
  await databaseControls.nth(1).selectOption(secondServiceIdentity);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("region", { name: "Deployment review" })).toBeVisible();
  expect(createPayload.services.map(({ serviceDirectory, servicePort }) => ({ serviceDirectory, servicePort }))).toEqual([
    { serviceDirectory: "services/api", servicePort: 4173 },
    { serviceDirectory: "apps/customer", servicePort: 8000 },
  ]);
  expect(createPayload.applicationEntryPointServiceId).toBe(secondServiceIdentity);
  expect(databasePayload).toMatchObject({ provider: "managed", engine: "mysql", attachedServiceId: secondServiceIdentity });
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
  await directory.focus();
  await expect.poll(() => directorySuggestionValues(page.getByRole("listbox"))).toEqual([".", "from-b-main"]);
  releaseFirstRepository();
  await expect.poll(() => directorySuggestionValues(page.getByRole("listbox"))).toEqual([".", "from-b-main"]);

  await page.getByRole("listbox").locator('[data-directory="from-b-main"]').click();
  await directory.fill("from-b");
  await branchSelector.selectOption("release");
  await releaseBranchRequested;
  await expect(directory).toHaveValue("from-b");
  const mainDirectoryResponse = page.waitForResponse((response) => response.url().includes("/example/b/directories?ref=main"));
  await branchSelector.selectOption("main");
  await mainDirectoryResponse;
  await expect(page.getByText("Type a path or choose a directory suggestion.")).toBeVisible();
  await directory.focus();
  await expect.poll(() => directorySuggestionValues(page.getByRole("listbox"))).toEqual(["from-b-main"]);
  releaseBranch();
  await expect.poll(() => directorySuggestionValues(page.getByRole("listbox"))).toEqual(["from-b-main"]);

  await directory.fill("from-b");
  await repositorySelector.selectOption("example/a");
  await expect(directory).toHaveValue("");
  await expect(page.getByText("Type a path or choose a directory suggestion.")).toBeVisible();
  await directory.focus();
  await expect.poll(() => directorySuggestionValues(page.getByRole("listbox"))).toEqual([".", "from-a"]);
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

  const applicationService = page.getByRole("combobox", { name: "Application service", exact: true });
  await applicationService.selectOption(apiServiceId);
  const applicationServiceResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith(`/api/projects/${projectId}`));
  await page.getByRole("button", { name: "Save application service" }).click();
  const applicationProject = await expectJson(await applicationServiceResponse);
  expect(applicationProject.project.applicationEntryPointServiceId).toBe(apiServiceId);
  const selectedDelete = await request.delete(`${apiBase}/api/projects/${projectId}/services/${apiServiceId}`);
  expect(selectedDelete.status()).toBe(400);

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
