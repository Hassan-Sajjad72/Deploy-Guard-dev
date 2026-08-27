import { strict as assert } from "node:assert";
import { DatabaseServiceBindingService } from "../src/infrastructure/database-service-binding.service";
import { DatabaseTierProvider, DatabaseTierStatus } from "../src/projects/project-database-tier.entity";
import { ServiceBindingStatus } from "../src/projects/project-service-binding.entity";
import { BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";

const projectId = "846665b9-ce31-405d-a131-b84457d80932";
const pipelineRunId = "8879d4af-9384-4199-b38b-1d9225bcd413";
const privateHost = `db.project-${projectId}.deployguard.local`;
const rows = [
  { id: "old-host", key: "DB_HOST", value: "localhost", isSecret: false, scope: "runtime", owner: "platform_detected", updatedAt: new Date(), isActive: false },
  { id: "external-password", key: "DB_PASSWORD", value: "external-password-test", isSecret: true, scope: "runtime", owner: "external_service", updatedAt: new Date(), isActive: false },
  { id: "external-url", key: "DATABASE_URL", value: "postgresql://external:test@postgres.internal.example:5432/cattle_farm_db", isSecret: true, scope: "runtime", owner: "external_service", updatedAt: new Date(), isActive: false },
  { id: "jwt", key: "JWT_SECRET", value: "jwt-plaintext-test-value", isSecret: true, scope: "runtime", owner: "user_supplied", updatedAt: new Date(), isActive: true },
];
const run: any = { id: pipelineRunId, projectId, generationId: "5c90c9e0-85e7-4ec7-a3a7-1b24da7ea1ac", databaseServiceBindingId: null };
const databaseBuildPlan = (aliases: string[]) => {
  const ownership = aliases.map((key) => ({
    key, owner: "infrastructure", component: "backend", source: "managed_database", exposure: "private",
    requirement: "required", required: true, phase: "runtime", secret: /PASSWORD|URL/.test(key),
  }));
  const backend = {
    id: "backend", role: "backend", root: "backend", buildContext: "backend", repositoryInstallRoot: "backend", detectorId: "python.fastapi", language: "python",
    framework: "fastapi", frameworkMode: "fastapi-asgi", runtimeType: "server", packageManager: "pip", dependencyManifest: "requirements.txt",
    lockfile: "requirements.txt", runtimeVersion: "3.12", baseImage: "python:3.12-alpine3.21", runtimeImage: "python:3.12-alpine3.21",
    installCommand: "pip install -r requirements.txt", buildCommand: null, runCommand: "uvicorn app:app", runtimeFiles: [], outputDirectory: null,
    port: 8000, healthPath: "/health", bindHost: "0.0.0.0", bindsToPortEnv: true, dockerStrategy: "generated", dockerTemplate: "fastapi-asgi",
    environmentOwnership: ownership, database: { required: true, provider: "managed", engine: "postgres" },
  };
  return {
    planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, platformBackendMount: "/__deployguard/backend", serviceBindings: [], repositoryFullName: "fixture/database-aliases", branch: "main", commitSha: "a".repeat(40),
    detectorId: "topology-v2", language: "python", framework: "fastapi", frameworkMode: "fastapi-asgi", confidence: "high", evidence: [], appRoot: "backend",
    repositoryInstallRoot: "backend", packageManager: "pip", dependencyManifest: "requirements.txt", lockfile: "requirements.txt", runtimeVersion: "3.12",
    baseImage: "python:3.12-alpine3.21", runtimeImage: "python:3.12-alpine3.21", installCommand: "pip install -r requirements.txt", buildCommand: null,
    buildCommands: [], releaseCommand: null, releaseCommands: [], runCommand: "uvicorn app:app", runtimeFiles: [], outputDirectory: null,
    buildSystemDependencies: [], runtimeSystemDependencies: [], port: 8000, portSource: "source", healthPath: "/health", bindHost: "0.0.0.0",
    bindsToPortEnv: true, runtimeType: "server", database: { required: true, provider: "managed", engine: "postgres" }, environmentOwnership: ownership,
    requiredInputs: aliases, requiredUserInputs: [], optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: aliases,
    secretEnvVars: aliases.filter((key) => /PASSWORD|URL/.test(key)), dockerStrategy: "generated", dockerTemplate: "fastapi-asgi", warnings: [], blockers: [],
    components: [{
      id: "frontend", role: "frontend", root: "frontend", buildContext: "frontend", repositoryInstallRoot: "frontend", detectorId: "javascript.vite-react", language: "javascript",
      framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", packageManager: "npm", dependencyManifest: "package.json",
      lockfile: "package-lock.json", runtimeVersion: "22", baseImage: "node:22-alpine3.21", runtimeImage: "nginx:alpine", installCommand: "npm ci",
      buildCommand: "npm run build", runCommand: null, runtimeFiles: [], outputDirectory: "dist", port: 8080, healthPath: "/", bindHost: null,
      bindsToPortEnv: false, dockerStrategy: "generated", dockerTemplate: "vite-static", environmentOwnership: [], database: { required: false, provider: "none", engine: null },
    }, backend],
  };
};
const postgresAliases = ["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"];
const contract: any = {
  projectId, contractHash: "contract-v10", databaseRequired: true, runtimeType: "server",
  databaseEngine: "postgres", requiredEnvVars: postgresAliases, optionalEnvVars: [], runtimeEnvVars: postgresAliases, buildTimeEnvVars: [],
  ecsPlan: { containerPort: 5000 },
  buildPlan: databaseBuildPlan(postgresAliases),
};
const tier: any = {
  id: "tier-v1",
  projectId, provider: DatabaseTierProvider.MANAGED, engine: "postgres", status: DatabaseTierStatus.PENDING,
  internalHost: privateHost, externalHost: null, externalPort: null, databaseName: "cattle_farm_db",
  databaseUser: "dg_846665b9ce31", persistenceEnabled: true,
};
const stored: any[] = [];
let storedSnapshot: any = null;
const repository = (find: () => any) => ({
  findOne: async () => find(),
  create: (value: any) => value,
  save: async (value: any) => {
    if (!value.id) value.id = "binding-v1";
    const index = stored.findIndex((item) => item.id === value.id);
    if (index >= 0) stored[index] = value; else if (value.serviceType === "database") stored.push(value);
    return value;
  },
});
const variableRepository: any = {
  createQueryBuilder: () => ({
    addSelect() { return this; }, where() { return this; }, andWhere() { return this; }, orderBy() { return this; },
    async getMany() { return rows.filter((row) => row.isActive); },
  }),
};
const snapshotRepository: any = {
  findOne: async () => storedSnapshot,
  createQueryBuilder: () => ({ addSelect() { return this; }, where() { return this; }, andWhere() { return this; }, async getOne() { return storedSnapshot; } }),
  create: (value: any) => value,
  save: async (value: any) => { storedSnapshot = { id: "snapshot-v1", validationBlockers: [], ...value }; return storedSnapshot; },
};
const service = new DatabaseServiceBindingService(
  repository(() => stored[0] || null) as any,
  repository(() => run) as any,
  repository(() => contract) as any,
  repository(() => tier) as any,
  variableRepository,
  snapshotRepository,
  repository(() => null) as any,
  repository(() => null) as any,
  {
    encrypt: (value: string) => `enc:${Buffer.from(value).toString("base64")}`,
    decrypt: (value: string) => value.startsWith("enc:") ? Buffer.from(value.slice(4), "base64").toString("utf8") : value,
  } as any,
  { get: (_key: string, fallback: string) => fallback } as any,
  repository(() => ({ id: projectId, environmentName: "dev" })) as any,
);

async function verify() {
  const intent = await service.ensureIntent(projectId, pipelineRunId);
  assert(intent);
  assert.equal(intent.provider, "managed");
  assert.equal(intent.databaseName, "cattle_farm_db");
  assert.equal(intent.hostReference, privateHost);
  assert.equal(run.databaseServiceBindingId, intent.id, "pipeline run snapshots the binding revision");
  assert(!JSON.stringify(intent).includes("jwt-plaintext-test-value"), "binding persists no secret plaintext");

  const preApply = await service.resolveEffectiveDeploymentConfiguration(projectId, pipelineRunId);
  assert.equal(preApply.runtimeVariables.POSTGRES_HOST, privateHost, "the exact application host alias is materialized");
  assert.equal(preApply.runtimeVariables.POSTGRES_PORT, "5432");
  assert.equal(preApply.runtimeVariables.POSTGRES_DB, "cattle_farm_db");
  assert.equal(preApply.runtimeVariables.POSTGRES_USER, "dg_846665b9ce31");
  assert.equal(preApply.secretReferences.POSTGRES_PASSWORD, "terraform://database/password", "the exact password alias stays secret-backed");
  assert.equal(preApply.ownership.POSTGRES_HOST.owner, "managed_service");
  assert.equal(preApply.runtimeVariables.DB_HOST, undefined, "generic aliases are not added when the repository did not request them");
  assert.equal(preApply.secretReferences.DB_PASSWORD, undefined, "generic password aliases are not added when unrequested");
  assert.equal(Object.keys(preApply.runtimeVariables).some((key) => /^POSTGRES_|^DB_/.test(key) && preApply.ownership[key]?.detectedReference === "frontend"), false, "database values remain backend-owned");
  assert.equal(preApply.projectSecretValues.JWT_SECRET, "jwt-plaintext-test-value");
  assert(!Object.values(preApply.runtimeVariables).includes("localhost"));

  contract.buildPlan = databaseBuildPlan(["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"]);
  const generic = await service.resolveEffectiveDeploymentConfiguration(projectId, pipelineRunId, "dev", { useSnapshot: false });
  assert.equal(generic.runtimeVariables.DB_USER, "dg_846665b9ce31", "existing DB_* applications remain supported");
  assert.equal(generic.secretReferences.DB_PASSWORD, "terraform://database/password");
  assert.equal(generic.runtimeVariables.POSTGRES_USER, undefined);

  contract.buildPlan = databaseBuildPlan(["DB_USER", "POSTGRES_USER", "DB_PASSWORD", "POSTGRES_PASSWORD"]);
  const dual = await service.resolveEffectiveDeploymentConfiguration(projectId, pipelineRunId, "dev", { useSnapshot: false });
  assert.equal(dual.runtimeVariables.DB_USER, dual.runtimeVariables.POSTGRES_USER, "explicit username aliases resolve to one managed value");
  assert.equal(dual.secretReferences.DB_PASSWORD, dual.secretReferences.POSTGRES_PASSWORD, "explicit password aliases resolve to one managed secret");

  contract.buildPlan = databaseBuildPlan(postgresAliases);
  const snapshot = await service.createRunConfigurationSnapshot(projectId, pipelineRunId);
  assert.equal(snapshot.id, "snapshot-v1");
  assert.equal(JSON.stringify(snapshot).includes("jwt-plaintext-test-value"), false, "snapshot must not persist secret plaintext");

  const applied = await service.applyTerraformOutputs(projectId, pipelineRunId, {
    database_internal_host: privateHost,
    database_service_arn: "arn:aws:ecs:us-east-1:123456789012:service/db-cluster/database",
    database_cloud_map_service_arn: "arn:aws:servicediscovery:us-east-1:123456789012:service/srv-db",
    database_password_secret_arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:password",
    database_url_secret_arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:url",
    database_efs_file_system_id: "fs-test",
    database_efs_access_point_id: "fsap-test",
  }, "output-v1");
  assert.equal(applied?.status, ServiceBindingStatus.APPLIED);
  await assert.rejects(() => service.resolveEffectiveDeploymentConfiguration(projectId, pipelineRunId, true), /requires ready/);
  await service.markReady(projectId, pipelineRunId);
  const ready = await service.resolveEffectiveDeploymentConfiguration(projectId, pipelineRunId, true);
  assert.equal(ready.secretReferences.POSTGRES_PASSWORD.includes(":secret:password"), true);
  assert.equal(ready.secretReferences.DB_PASSWORD, undefined);
  await service.assertRunConfigurationCurrent(projectId, pipelineRunId);
  await service.markVerified(projectId, pipelineRunId);
  assert.equal(tier.status, DatabaseTierStatus.READY);
  await service.markFailed(projectId, pipelineRunId, "Managed database readiness failed.");
  assert.equal(tier.status, DatabaseTierStatus.UNHEALTHY);
  assert.equal(tier.lastError, "Managed database readiness failed.");
  await service.markReady(projectId, pipelineRunId);

  storedSnapshot = null;
  applied.provider = "external";
  applied.hostReference = "postgres.internal.example";
  applied.passwordSecretReference = null;
  applied.databaseUrlSecretReference = null;
  contract.buildPlan = databaseBuildPlan(["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL"]);
  rows.filter((row) => ["external-password", "external-url"].includes(row.id)).forEach((row) => { row.isActive = true; });
  const external = await service.resolveEffectiveDeploymentConfiguration(projectId, pipelineRunId);
  assert.equal(external.ownership.DB_HOST.owner, "external_service");
  assert.equal(external.ownership.DB_PASSWORD.owner, "external_service");
  assert.equal(external.projectSecretValues.DB_PASSWORD, "external-password-test");
  applied.provider = "managed";
  applied.hostReference = privateHost;
  applied.passwordSecretReference = "arn:aws:secretsmanager:us-east-1:123456789012:secret:password";
  applied.databaseUrlSecretReference = "arn:aws:secretsmanager:us-east-1:123456789012:secret:url";

  tier.databaseName = "changed_after_snapshot";
  await assert.rejects(() => service.ensureIntent(projectId, pipelineRunId), /older database binding revision/);

  console.log("Managed database service binding verification passed.");
}

void verify();
