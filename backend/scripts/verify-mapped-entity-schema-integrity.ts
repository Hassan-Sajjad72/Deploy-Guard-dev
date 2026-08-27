import "reflect-metadata";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { RepairDeploymentContractEcsPlanSchemaDrift1787356805000 } from "../src/migrations/1787356805000-RepairDeploymentContractEcsPlanSchemaDrift";
import { RepairProjectDatabaseTierSchemaDrift1787356806000 } from "../src/migrations/1787356806000-RepairProjectDatabaseTierSchemaDrift";
import { assertMappedEntitySchemaIntegrity, mappedEntityColumns } from "../src/projects/product-start-schema-integrity.service";

const database = `deployguard_mapped_schema_${randomUUID().replaceAll("-", "")}`;
const base = AppDataSource.options as DataSourceOptions;
let admin: DataSource | null = null;
let testDatabase: DataSource | null = null;

async function close() {
  if (testDatabase?.isInitialized) await testDatabase.destroy();
  testDatabase = null;
  if (admin?.isInitialized) {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid()`);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.destroy();
  }
  admin = null;
}

void (async () => {
  admin = new DataSource({ ...base, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
  await admin.initialize();
  await admin.query(`CREATE DATABASE "${database}"`);

  testDatabase = new DataSource({ ...base, database, synchronize: false, logging: false } as DataSourceOptions);
  await testDatabase.initialize();
  await testDatabase.runMigrations();

  const expected = mappedEntityColumns(testDatabase);
  assert.ok(expected.length > 0, "the mapped-entity integrity test must inspect TypeORM metadata");
  await assertMappedEntitySchemaIntegrity(testDatabase);

  const [user] = await testDatabase.query(`INSERT INTO users (name) VALUES ('schema integrity fixture') RETURNING id`);
  const [project] = await testDatabase.query(
    `INSERT INTO projects (owner_user_id, name, repository_url) VALUES ($1, 'schema integrity project', 'https://example.invalid/schema-integrity.git') RETURNING id`,
    [user.id],
  );
  const executionPlan = {
    containerPort: 3000,
    targetGroupPort: 3000,
    healthCheckPath: "/health",
    command: "node dist/main.js",
    cpu: 256,
    memory: 512,
    environmentMappings: [],
    secretMappings: [],
    logGroups: { app: "/app", database: "/database", deployment: "/deployment" },
    database: { required: false, provider: "none", engine: null, host: null, port: null, databaseName: null, databaseUser: null, image: null, dataPath: null, healthCheck: null, initializationEnvironment: [], initializationSecretNames: [], urlScheme: null, urlQuery: "", persistenceEnabled: false },
  };
  await testDatabase.query(
    `INSERT INTO project_deployment_contracts (project_id, branch, ecs_plan, generated_at, overrides_hash, contract_hash, build_plan)
     VALUES ($1, 'main', $2::jsonb, now(), 'overrides', 'contract', $3::jsonb)`,
    [project.id, JSON.stringify(executionPlan), JSON.stringify({ version: 1 })],
  );

  // Reproduce a database whose migration history says current but whose physical
  // contract column still has the legacy name.
  await testDatabase.query(`ALTER TABLE project_deployment_contracts RENAME COLUMN ecs_plan TO runtime_plan`);
  await assert.rejects(
    () => assertMappedEntitySchemaIntegrity(testDatabase!),
    /project_deployment_contracts\.ecs_plan/,
    "the integrity check must detect the exact live ecs_plan schema drift",
  );

  const runner = testDatabase.createQueryRunner();
  await runner.connect();
  await new RepairDeploymentContractEcsPlanSchemaDrift1787356805000().up(runner);
  await runner.release();

  const [restored] = await testDatabase.query(`SELECT ecs_plan, to_regclass('public.project_deployment_contracts') AS table_name FROM project_deployment_contracts WHERE project_id = $1`, [project.id]);
  assert.deepEqual(restored.ecs_plan, executionPlan, "the repair must preserve the execution-plan JSON exactly");
  const legacy = await testDatabase.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'project_deployment_contracts' AND column_name = 'runtime_plan'
  `);
  assert.equal(legacy.length, 0, "the legacy execution-plan column must not remain ambiguous");

  await testDatabase.query(`ALTER TABLE project_database_tiers DROP CONSTRAINT IF EXISTS "FK_database_tiers_active_generation"`);
  await testDatabase.query(`
    ALTER TABLE project_database_tiers
      DROP COLUMN active_generation_id,
      DROP COLUMN external_host,
      DROP COLUMN external_port,
      DROP COLUMN external_tls_required,
      DROP COLUMN efs_file_system_id,
      DROP COLUMN efs_access_point_id,
      DROP COLUMN credentials_secret_arn,
      DROP COLUMN database_url_secret_arn
  `);
  await assert.rejects(
    () => assertMappedEntitySchemaIntegrity(testDatabase!),
    /project_database_tiers\.active_generation_id/,
    "the integrity check must detect database-tier history drift before runtime reads fail",
  );
  const databaseRunner = testDatabase.createQueryRunner();
  await databaseRunner.connect();
  await new RepairProjectDatabaseTierSchemaDrift1787356806000().up(databaseRunner);
  await databaseRunner.release();
  await assertMappedEntitySchemaIntegrity(testDatabase);
  console.log(`Mapped-entity schema-integrity regression passed (${expected.length} mapped columns).`);
})().finally(close).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
