import "reflect-metadata";
import { strict as assert } from "node:assert";
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GithubAppService, canonicalDeployguardReusableWorkflow, renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";
import { DatabaseTierService } from "../src/projects/database-tier.service";
import { DatabaseTierProvider } from "../src/projects/project-database-tier.entity";
import { isSupportedManagedDatabaseEngine, managedDatabaseEngine } from "../src/projects/managed-database-engine";
import { GithubActionsService } from "../src/projects/pipeline/github-actions.service";
import { RAILPACK_WORKFLOW_INPUTS } from "../src/projects/railpack-workflow-contract";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";

void (async () => {
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
workflowGithub.config = new ConfigService({ DEPLOYGUARD_REUSABLE_WORKFLOW: `owner/repository/.github/workflows/deployguard-reusable.yml@${"a".repeat(40)}` });
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

const railpack = Object.create(RailpackDeploymentService.prototype) as any;
railpack.config = emptyConfig;
for (const key of ["DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN", "DEPLOYGUARD_VPC_ID", "DEPLOYGUARD_PUBLIC_SUBNET_IDS", "DEPLOYGUARD_TERRAFORM_STATE_BUCKET"]) {
  assert.throws(() => railpack.required(key), (error: any) => error instanceof ServiceUnavailableException && error.getStatus() === 503 && error.message === `Platform configuration is missing: ${key}.`);
}
assert.throws(() => railpack.controlPlaneSha(), (error: any) => error instanceof ServiceUnavailableException && /DEPLOYGUARD_REUSABLE_WORKFLOW/.test(error.message));
railpack.config = new ConfigService({ DEPLOYGUARD_REUSABLE_WORKFLOW: "owner/repository/.github/workflows/deployguard-reusable.yml@main" });
assert.throws(() => railpack.controlPlaneSha(), (error: any) => error instanceof ServiceUnavailableException && /exact control-plane SHA/.test(error.message));

console.log("CONFIGURATION_ADMISSION_MATRIX=PASS GITHUB_DEFAULT_BRANCH_REGISTRATION=1 APPLICATION_SOURCE_PRESERVED=1 SUPPORTED_DATABASES=3 UNSUPPORTED_PREMUTATION=1 AWS_REQUIRED_INPUTS=4 CONTROL_PLANE_PIN=1");
})().catch((error) => { console.error(error); process.exitCode = 1; });
