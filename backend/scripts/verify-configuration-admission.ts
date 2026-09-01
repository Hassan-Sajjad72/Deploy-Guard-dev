import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CONTROL_PLANE_VERSION_MISMATCH, ControlPlaneCompatibilityError, GithubAppService, canonicalDeployguardReusableWorkflow, renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";
import { DatabaseTierService } from "../src/projects/database-tier.service";
import { DatabaseTierProvider, ProjectDatabaseTier } from "../src/projects/project-database-tier.entity";
import { ProjectEnvironmentVariable } from "../src/projects/project-environment-variable.entity";
import { ProjectDeployableService } from "../src/projects/project-deployable-service.entity";
import { isSupportedManagedDatabaseEngine, managedDatabaseEngine } from "../src/projects/managed-database-engine";
import { GithubActionsService } from "../src/projects/pipeline/github-actions.service";
import { RAILPACK_WORKFLOW_INPUTS } from "../src/projects/railpack-workflow-contract";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";

void (async () => {
const canonicalSha = "a9bcc72df2047de64cb4034960d4df72da3e9c1f";
const canonicalReusable = `Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@${canonicalSha}`;
const emptyConfig = new ConfigService({});
const github = new GithubAppService({
  find: async () => [],
  findOne: async () => null,
  create: (value: unknown) => value,
  save: async (value: unknown) => value,
} as any, emptyConfig);
assert.equal(github.configured(), false);
assert.equal(github.statusUrl(), null);
assert.throws(() => canonicalDeployguardReusableWorkflow(emptyConfig), (error: any) => error instanceof ServiceUnavailableException && error.getStatus() === 503 && /release revision is not configured/.test(error.message));
await assert.rejects(() => github.connectInstallation({} as any, "not-numeric"), (error: any) => error instanceof BadRequestException && /Invalid GitHub App installation id/.test(error.message));
await assert.rejects(() => github.tokenForRepository(1, "inaccessible/repository"), (error: any) => error instanceof BadRequestException && /Install the DeployGuard GitHub App/.test(error.message));

const workflowCalls: Array<{ url: string; init?: RequestInit }> = [];
const workflowGithub = Object.create(GithubAppService.prototype) as any;
workflowGithub.config = new ConfigService({ DEPLOYGUARD_REUSABLE_WORKFLOW: canonicalReusable });
workflowGithub.tokenForRepository = async () => ({ token: "installation-token", installationId: "42", repositoryId: "99", defaultBranch: "main" });
workflowGithub.validatePinnedReusableWorkflow = async () => undefined;
workflowGithub.githubFetch = async (url: string, init?: RequestInit) => {
  workflowCalls.push({ url, init });
  return new Response(null, { status: init?.method === "PUT" ? 201 : 404 });
};
const workflowRegistration = await workflowGithub.ensureWorkflow(1, "owner/application", "42");
assert.equal(workflowRegistration.registrationBranch, "main");
assert.match(workflowCalls[0].url, /deployguard\.yml\?ref=main$/);
assert.equal(JSON.parse(String(workflowCalls.at(-1)?.init?.body)).branch, "main", "caller workflow is registered on GitHub's default branch");
assert.doesNotMatch(JSON.stringify(workflowCalls), /feature\/selected/, "application source branch never controls workflow registration");
assert.match(Buffer.from(JSON.parse(String(workflowCalls.at(-1)?.init?.body)).content, "base64").toString("utf8"), new RegExp(`uses: ${canonicalReusable}`), "a fresh project gets the configured canonical workflow SHA");

async function reconcileManagedCaller(existingContent: string) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const candidate = Object.create(GithubAppService.prototype) as any;
  candidate.config = new ConfigService({ DEPLOYGUARD_REUSABLE_WORKFLOW: canonicalReusable });
  candidate.tokenForRepository = async () => ({ token: "installation-token", installationId: "42", repositoryId: "99", defaultBranch: "main" });
  candidate.validatePinnedReusableWorkflow = async () => undefined;
  candidate.githubFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "PUT") return new Response(null, { status: 200 });
    return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(existingContent).toString("base64"), sha: "caller-blob-sha" }), { status: 200 });
  };
  const result = await candidate.ensureWorkflow(1, "owner/application", "42");
  return { calls, result };
}

const oldManagedCaller = renderDeployguardCallerWorkflow("Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@2a769bd922a2561876d71def13d306360958d8d9");
const reconciled = await reconcileManagedCaller(oldManagedCaller);
assert.equal(reconciled.result.updated, true, "an existing DeployGuard-managed caller pinned to the old SHA is updated");
const reconciledBody = JSON.parse(String(reconciled.calls.find((call) => call.init?.method === "PUT")?.init?.body));
assert.match(Buffer.from(reconciledBody.content, "base64").toString("utf8"), new RegExp(`uses: ${canonicalReusable}`));
const alreadyCurrent = await reconcileManagedCaller(renderDeployguardCallerWorkflow(canonicalReusable));
assert.equal(alreadyCurrent.result.updated, false, "an already-current managed caller is left unchanged");
assert.equal(alreadyCurrent.calls.some((call) => call.init?.method === "PUT"), false);

const root = join(__dirname, "..", "..");
const controlPlaneFiles: Record<string, string> = {
  ".github/workflows/deployguard-reusable.yml": readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8"),
  "infrastructure/railpack-runtime/build-release-result.sh": readFileSync(join(root, "infrastructure/railpack-runtime/build-release-result.sh"), "utf8"),
  "infrastructure/railpack-runtime/verify-runtime.sh": readFileSync(join(root, "infrastructure/railpack-runtime/verify-runtime.sh"), "utf8"),
};
async function validateControlPlane(overrides: Partial<Record<keyof typeof controlPlaneFiles, string>> = {}) {
  const candidate = Object.create(GithubAppService.prototype) as any;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  candidate.githubFetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const path = Object.keys(controlPlaneFiles).find((item) => url.includes(`/contents/${item}?ref=`));
    const content = path ? overrides[path] ?? controlPlaneFiles[path] : null;
    return content == null ? new Response(null, { status: 404 }) : new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(content).toString("base64") }), { status: 200 });
  };
  await candidate.validatePinnedReusableWorkflow("installation-token", canonicalReusable, renderDeployguardCallerWorkflow(canonicalReusable));
  return calls;
}
const validControlPlaneCalls = await validateControlPlane();
assert.equal(validControlPlaneCalls.length, 3, "valid admission verifies the workflow and both terminal-evidence executables at the exact SHA");
await assert.rejects(
  () => validateControlPlane({ "infrastructure/railpack-runtime/build-release-result.sh": controlPlaneFiles["infrastructure/railpack-runtime/build-release-result.sh"].replace("awsRuntimeVerification:$awsRuntimeVerification", "runtimeVerification:$awsRuntimeVerification") }),
  (error: any) => error instanceof ControlPlaneCompatibilityError && error.diagnosticCode === CONTROL_PLANE_VERSION_MISMATCH,
  "an incompatible producer fails control-plane admission before caller update or dispatch",
);

const applicationBranch = "feature/selected";
const reusable = `owner/repository/.github/workflows/deployguard-reusable.yml@${"a".repeat(40)}`;
const caller = renderDeployguardCallerWorkflow(reusable);
const dispatchInputs = Object.fromEntries(RAILPACK_WORKFLOW_INPUTS.map(({ name }) => [name, `${name}-value`])) as Record<string, string>;
dispatchInputs.repository_full_name = "owner/application";
dispatchInputs.repository_branch = applicationBranch;
dispatchInputs.deployment_operation_id = "11111111-1111-4111-8111-111111111111";
const dispatchCalls: Array<{ url: string; init?: RequestInit }> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input); dispatchCalls.push({ url, init });
  if (url.includes("/contents/.github/workflows/deployguard.yml")) return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(caller).toString("base64") }), { status: 200 });
  if (url.endsWith("/dispatches")) return new Response(JSON.stringify({ workflow_run_id: 12345, html_url: "https://github.com/owner/application/actions/runs/12345" }), { status: 200 });
  if (url.includes("/actions/workflows/deployguard.yml")) return new Response(JSON.stringify({ state: "active" }), { status: 200 });
  return new Response(JSON.stringify({}), { status: 200 });
};
try {
  const actions = new GithubActionsService(new ConfigService({ GITHUB_ACTIONS_WORKFLOW_FILE: "deployguard.yml" }));
  const dispatched = await actions.triggerWorkflow({ repositoryFullName: "owner/application", targetBranch: applicationBranch, workflowRegistrationBranch: "main", token: "installation-token", inputs: dispatchInputs });
  const dispatch = dispatchCalls.find((call) => call.url.endsWith("/dispatches"));
  assert.equal(JSON.parse(String(dispatch?.init?.body)).ref, "main", "GitHub executes the caller from its registration branch");
  assert.equal(dispatched.receipt.ref, "main");
  assert.equal(dispatched.receipt.sourceRef, applicationBranch);
  assert.equal(dispatchInputs.repository_branch, applicationBranch, "immutable application source branch remains selected");
  assert.ok(dispatchCalls.some((call) => call.url.includes(`/branches/${encodeURIComponent(applicationBranch)}`)), "selected source branch remains independently validated");
  assert.ok(dispatchCalls.some((call) => call.url.includes("/contents/.github/workflows/deployguard.yml?ref=main")), "caller contract is validated on the registration branch");
} finally {
  globalThis.fetch = originalFetch;
}

assert.equal(isSupportedManagedDatabaseEngine("postgres"), true);
assert.equal(isSupportedManagedDatabaseEngine("mysql"), true);
assert.equal(isSupportedManagedDatabaseEngine("mongodb"), true);
assert.equal(isSupportedManagedDatabaseEngine("redis"), false);
assert.equal(managedDatabaseEngine("mariadb"), null, "unsupported MariaDB cannot silently substitute MySQL");
const databaseTier = Object.create(DatabaseTierService.prototype) as any;
databaseTier.projects = { getProjectEntityForManage: async () => ({ id: "project" }) };
await assert.rejects(() => databaseTier.update({} as any, "project", { provider: DatabaseTierProvider.MANAGED } as any), /Select a supported managed database engine/);
await assert.rejects(() => databaseTier.update({} as any, "project", { provider: DatabaseTierProvider.MANAGED, engine: "redis" } as any), /Select a supported managed database engine/);

async function updateDatabase(services: any[], dto: any, conflictingKeys: string[] = []) {
  const candidate = Object.create(DatabaseTierService.prototype) as any;
  let saved: any = null;
  candidate.projects = { getProjectEntityForManage: async () => ({ id: "11111111-1111-4111-8111-111111111111", environmentName: "dev" }) };
  candidate.audit = { record: async () => undefined };
  const tierRepository = { findOne: async () => null, create: (value: any) => value, save: async (value: any) => { saved = value; return value; } };
  const environmentRepository = { createQueryBuilder: () => ({ where() { return this; }, andWhere() { return this; }, orderBy() { return this; }, getMany: async () => conflictingKeys.map((key) => ({ key })) }) };
  const serviceRepository = { find: async () => services };
  candidate.dataSource = { transaction: async (work: any) => work({ query: async () => undefined, getRepository: (entity: unknown) => entity === ProjectDatabaseTier ? tierRepository : entity === ProjectEnvironmentVariable ? environmentRepository : entity === ProjectDeployableService ? serviceRepository : null }) };
  const result = await candidate.update({ id: 7 }, "11111111-1111-4111-8111-111111111111", dto);
  return { result, saved };
}
const singleService = [{ id: "22222222-2222-4222-8222-222222222222", position: 0 }];
const singleManaged = await updateDatabase(singleService, { provider: DatabaseTierProvider.MANAGED, engine: "postgres", persistenceEnabled: true });
assert.equal(singleManaged.saved.attachedServiceId, singleService[0].id, "a single-service managed database attaches automatically");
const multiServices = [...singleService, { id: "33333333-3333-4333-8333-333333333333", position: 1 }];
await assert.rejects(() => updateDatabase(multiServices, { provider: DatabaseTierProvider.MANAGED, engine: "mysql", persistenceEnabled: true }), /Select the service/);
const explicitManaged = await updateDatabase(multiServices, { provider: DatabaseTierProvider.MANAGED, engine: "mysql", persistenceEnabled: true, attachedServiceId: multiServices[1].id });
assert.equal(explicitManaged.saved.attachedServiceId, multiServices[1].id, "a multi-service managed database attaches only to the explicit service");
await assert.rejects(
  () => updateDatabase(singleService, { provider: DatabaseTierProvider.MANAGED, engine: "mongodb", persistenceEnabled: true }, ["MONGODB_URI"]),
  /Managed database conflicts with existing application ENV: MONGODB_URI/,
);

const railpack = Object.create(RailpackDeploymentService.prototype) as any;
railpack.config = emptyConfig;
for (const key of ["DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN", "DEPLOYGUARD_VPC_ID", "DEPLOYGUARD_PUBLIC_SUBNET_IDS", "DEPLOYGUARD_TERRAFORM_STATE_BUCKET"]) {
  assert.throws(() => railpack.required(key), (error: any) => error instanceof ServiceUnavailableException && error.getStatus() === 503 && error.message === `Platform configuration is missing: ${key}.`);
}
assert.throws(() => railpack.controlPlaneSha(), (error: any) => error instanceof ServiceUnavailableException && /DEPLOYGUARD_REUSABLE_WORKFLOW/.test(error.message));
railpack.config = new ConfigService({ DEPLOYGUARD_REUSABLE_WORKFLOW: "owner/repository/.github/workflows/deployguard-reusable.yml@main" });
assert.throws(() => railpack.controlPlaneSha(), (error: any) => error instanceof ServiceUnavailableException && /exact control-plane SHA/.test(error.message));

console.log("CONFIGURATION_ADMISSION_MATRIX=PASS GITHUB_DEFAULT_BRANCH_REGISTRATION=1 APPLICATION_SOURCE_PRESERVED=1 FRESH_CALLER_CURRENT=1 STALE_CALLER_RECONCILED=1 CURRENT_CALLER_UNCHANGED=1 CONTROL_PLANE_COMPATIBILITY=1 SUPPORTED_DATABASES=3 DATABASE_ATTACHMENT_AUTHORITY=1 DATABASE_CONFLICT_PREMUTATION=1 UNSUPPORTED_PREMUTATION=1 AWS_REQUIRED_INPUTS=4 CONTROL_PLANE_PIN=1");
})().catch((error) => { console.error(error); process.exitCode = 1; });
