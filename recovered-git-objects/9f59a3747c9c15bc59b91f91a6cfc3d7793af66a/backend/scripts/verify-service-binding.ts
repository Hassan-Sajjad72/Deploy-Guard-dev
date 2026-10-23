import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseServiceBindingService } from "../src/infrastructure/database-service-binding.service";
import { DatabaseTierProvider, DatabaseTierStatus } from "../src/projects/project-database-tier.entity";
import { ServiceBindingStatus } from "../src/projects/project-service-binding.entity";

const projectId = "846665b9-ce31-405d-a131-b84457d80932";
const pipelineRunId = "8879d4af-9384-4199-b38b-1d9225bcd413";
const privateHost = `db.project-${projectId}.deployguard.local`;
const rows = [
  { id: "old-host", key: "DB_HOST", value: "localhost", isSecret: false, scope: "runtime", owner: "platform_detected", updatedAt: new Date(), isActive: false },
  { id: "external-password", key: "DB_PASSWORD", value: "external-password-test", isSecret: true, scope: "runtime", owner: "external_service", updatedAt: new Date(), isActive: false },
  { id: "external-url", key: "DATABASE_URL", value: "postgresql://external:test@postgres.internal.example:5432/cattle_farm_db", isSecret: true, scope: "runtime", owner: "external_service", updatedAt: new Date(), isActive: false },
  { id: "jwt", key: "JWT_SECRET", value: "jwt-plaintext-test-value", isSecret: true, scope: "runtime", owner: "user_supplied", updatedAt: new Date(), isActive: true },
];
const run: any = { id: pipelineRunId, projectId, databaseServiceBindingId: null };
const contract: any = {
  projectId, contractHash: "contract-v10", databaseRequired: true, runtimeType: "server",
  databaseEngine: "postgres", requiredEnvVars: ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL", "JWT_SECRET"], optionalEnvVars: [], runtimeEnvVars: ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_URL", "JWT_SECRET"], buildTimeEnvVars: [],
  ecsPlan: { containerPort: 5000 },
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
  assert.equal(preApply.runtimeVariables.DB_HOST, privateHost, "managed binding overrides repository localhost");
  assert.equal(preApply.runtimeVariables.DB_NAME, "cattle_farm_db");
  assert.equal(preApply.ownership.DB_HOST.owner, "managed_service");
  assert.equal(preApply.projectSecretValues.JWT_SECRET, "jwt-plaintext-test-value");
  assert(!Object.values(preApply.runtimeVariables).includes("localhost"));
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
  assert.equal(ready.secretReferences.DB_PASSWORD.includes(":secret:password"), true);
  assert.equal(ready.secretReferences.DATABASE_URL.includes(":secret:url"), true);
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

  const terraform = readFileSync(join(process.cwd(), "terraform/modules/database-service/main.tf"), "utf8");
  const infra = readFileSync(join(process.cwd(), "src/infrastructure/infrastructure.service.ts"), "utf8");
  const worker = readFileSync(join(process.cwd(), "src/projects/pipeline/pipeline-worker.service.ts"), "utf8");
  const resolver = readFileSync(join(process.cwd(), "src/projects/current-state/pipeline-stage-resolver.service.ts"), "utf8");
  const currentState = readFileSync(join(process.cwd(), "src/projects/current-state/project-current-state.service.ts"), "utf8");
  const ecsDiagnostics = readFileSync(join(process.cwd(), "src/orchestration/ecs.service.ts"), "utf8");
  assert.match(terraform, /pg_isready -h 127\.0\.0\.1/);
  assert.match(terraform, /containerPath = local\.data_path/);
  assert.match(terraform, /assign_public_ip = false/);
  assert.match(terraform, /security_groups = \[var\.app_security_group_id\]/);
  assert.match(infra, /ecs_desired_count: database\.provider === "managed" \? 0/);
  assert.match(worker, /verifyManagedDatabaseReady/);
  assert.match(worker, /validateApplicationTaskDefinition/);
  assert.match(worker, /activateApplicationService/);
  assert.match(resolver, /flagStagesMissingCompletionEvidence/);
  assert.match(currentState, /deploymentSucceeded/);
  assert.match(ecsDiagnostics, /task\.taskDefinitionArn === deployment\.taskDefinitionArn/, "diagnostics ignore tasks from older task definitions");
  assert.match(ecsDiagnostics, /endsWith\(`\/\$\{taskId\}`\)/, "diagnostics select the current task's log stream");
  assert.match(ecsDiagnostics, /lastEventTimestamp \|\| 0\) >= deploymentStartedAt/, "log fallback cannot select pre-deployment evidence");
  console.log("Managed database service binding verification passed.");
}

void verify();
