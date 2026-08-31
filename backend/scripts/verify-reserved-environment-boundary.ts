import "reflect-metadata";
import { strict as assert } from "node:assert";
import { BadRequestException } from "@nestjs/common";
import { ProjectsService } from "../src/projects/projects.service";
import { isDeployGuardManagedDatabaseAlias, partitionSubmittedEnvironmentVariables, SERVICE_ALIAS_GROUPS } from "../src/projects/configuration-ownership";

const service = Object.create(ProjectsService.prototype) as ProjectsService;

async function structuredFailure(work: () => Promise<unknown> | unknown, key: string) {
  try {
    await work();
    assert.fail(`${key} must be rejected`);
  } catch (error) {
    assert.ok(error instanceof BadRequestException);
    const response = error.getResponse() as Record<string, unknown>;
    assert.equal(response.code, "RESERVED_ENVIRONMENT_VARIABLE");
    assert.equal(response.key, key);
    assert.equal(response.managedBy, "DeployGuard");
    assert.doesNotMatch(JSON.stringify(response), /secret-value|token-value/);
  }
}

async function run() {
  const ownership = (service as unknown as { assertEnvironmentOwnership(projectId: string, key: string): Promise<void> }).assertEnvironmentOwnership.bind(service);
  const mutable = (service as unknown as { assertVariableMutable(variable: Record<string, unknown>): void }).assertVariableMutable.bind(service);
  for (const [action, key] of [["create", "PORT"], ["edit", "AWS_REGION"], ["override", "DATABASE_URL"]] as const) {
    await structuredFailure(() => ownership("project-id", key), key);
    assert.ok(action);
  }
  const bulk = partitionSubmittedEnvironmentVariables([
    { key: "DEPLOYGUARD_PROJECT_ID", value: "must-not-survive" },
    { key: "APP_SECRET", value: "application-value" },
  ]);
  assert.deepEqual(bulk.ignoredVariableNames, ["DEPLOYGUARD_PROJECT_ID"]);
  assert.deepEqual(bulk.accepted.map((item) => item.key), ["APP_SECRET"]);
  assert.doesNotMatch(JSON.stringify(bulk), /must-not-survive/);
  await structuredFailure(() => mutable({ key: "HOST", normalizedKey: "HOST", isRequired: true, protected: true, owner: "platform" }), "HOST");
  await structuredFailure(() => mutable({ key: "DB_PASSWORD", normalizedKey: "DB_PASSWORD", isRequired: true, protected: true, owner: "managed_service" }), "DB_PASSWORD");
  assert.doesNotThrow(() => mutable({ key: "FEATURE_FLAG", normalizedKey: "FEATURE_FLAG", isRequired: false, protected: false, owner: "user_optional" }));

  const projectId = "11111111-1111-4111-8111-111111111111";
  const serviceId = "22222222-2222-4222-8222-222222222222";
  const project = { id: projectId, name: "Ownership fixture", ownerUserId: 7, environmentName: "dev" };
  const deployableService = { id: serviceId, projectId, name: "Web", serviceDirectory: "." };
  const saved: any[] = [];
  const repository = {
    findOne: async ({ where }: any) => where?.id ? { id: where.id, projectId, serviceId, key: "FEATURE_FLAG", normalizedKey: "FEATURE_FLAG", value: "encrypted", isSecret: false, scope: "runtime", owner: "user_optional", protected: false, environment: "dev" } : null,
    find: async () => [],
    create: (value: any) => ({ ...value }),
    save: async (value: any) => { const row = { id: value.id || `33333333-3333-4333-8333-${String(saved.length + 1).padStart(12, "0")}`, createdAt: new Date(), updatedAt: new Date(), ...value }; saved.push(row); return row; },
  };
  const manager = { query: async () => undefined, getRepository: () => repository };
  const boundary = Object.create(ProjectsService.prototype) as any;
  boundary.findProject = async () => project;
  boundary.assertCanManage = () => undefined;
  boundary.requireService = async (_projectId: string, requestedServiceId?: string) => { assert.equal(requestedServiceId || serviceId, serviceId); return deployableService; };
  boundary.dataSource = { transaction: async (work: any) => work(manager) };
  boundary.environmentCrypto = { encrypt: (value: string) => `encrypted:${value}` };
  boundary.auditLogService = { record: async () => undefined };

  for (const key of ["DATABASE_URL", "MONGODB_URI", "REDIS_URL", "DB_HOST", "MYSQL_PASSWORD"]) {
    assert.equal(isDeployGuardManagedDatabaseAlias(key), true);
    await structuredFailure(() => boundary.createEnvVar({ id: 7 }, projectId, { key, value: "user-database-value" }, undefined, serviceId), key);
  }
  await structuredFailure(() => boundary.updateEnvVar({ id: 7 }, projectId, "44444444-4444-4444-8444-444444444444", { key: "DATABASE_URL" }, undefined, serviceId), "DATABASE_URL");

  const serviceBulk = await boundary.bulkUpsertEnvVars({ id: 7 }, projectId, { variables: [
    { key: "MONGO_URI", value: "user-database-value", isSecret: true },
    { key: "FEATURE_FLAG", value: "enabled", isSecret: false },
  ] }, undefined, serviceId);
  assert.deepEqual(serviceBulk.ignoredVariableNames, ["MONGO_URI"]);
  assert.deepEqual(serviceBulk.variables.map((item: any) => item.key), ["FEATURE_FLAG"]);
  assert.equal(saved.some((item) => item.key === "MONGO_URI"), false, "bulk/service-scoped DB aliases are never persisted");

  const custom = await boundary.createEnvVar({ id: 7 }, projectId, { key: "CUSTOM_API_ORIGIN", value: "https://example.test", isSecret: false }, undefined, serviceId);
  assert.equal(custom.variable.key, "CUSTOM_API_ORIGIN", "unrelated service-scoped application ENV remains supported");
  for (const key of ["PORT", "HOST"]) {
    const platform = await boundary.createEnvVar({ id: 7 }, projectId, { key, value: "9999" }, undefined, serviceId);
    assert.equal(platform.variable, null);
    assert.deepEqual(platform.ignoredVariableNames, [key], `${key} keeps the existing ignore/override contract`);
  }
  const canonicalAliases = new Set(SERVICE_ALIAS_GROUPS.filter((group) => group.service !== "storage").flatMap((group) => [...group.aliases]));
  assert.equal(canonicalAliases.has("MONGODB_URI"), true);
  assert.equal(canonicalAliases.has("REDIS_URL"), true, "external database providers remain unsupported through generic ENV");
  console.log("DATABASE_ENV_OWNERSHIP=PASS SINGLE_CREATE_REJECTED=1 UPDATE_RENAME_REJECTED=1 BULK_IGNORED=1 SERVICE_SCOPED=1 CUSTOM_ENV=1 PLATFORM_PORT_HOST_UNCHANGED=1 EXTERNAL_DATABASE_SUPPORTED=0");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
