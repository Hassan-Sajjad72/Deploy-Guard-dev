import "reflect-metadata";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { RepairProjectPipelineSchemaDrift1787356802000 } from "../src/migrations/1787356802000-RepairProjectPipelineSchemaDrift";
import { RepairDeploymentGenerationSchemaDrift1787356803000 } from "../src/migrations/1787356803000-RepairDeploymentGenerationSchemaDrift";
import { RepairStableReleaseSchemaDrift1787356804000 } from "../src/migrations/1787356804000-RepairStableReleaseSchemaDrift";
import { RepairNotificationSchemaDrift1787356809600 } from "../src/migrations/1787356809600-RepairNotificationSchemaDrift";
import { RemoveRetiredRepositoryAnalysisSchema1787356810000 } from "../src/migrations/1787356810000-RemoveRetiredRepositoryAnalysisSchema";
import { ProjectDeployableServices1787356813000 } from "../src/migrations/1787356813000-ProjectDeployableServices";
import { RepairDeployableServiceUuidDefault1787356817000 } from "../src/migrations/1787356817000-RepairDeployableServiceUuidDefault";
import { assertProductStartSchemaIntegrity } from "../src/projects/product-start-schema-integrity.service";

const database = `deployguard_product_start_${randomUUID().replaceAll("-", "")}`;
const base = AppDataSource.options as DataSourceOptions;
let admin: DataSource | null = null;
let testDatabase: DataSource | null = null;
const retiredTables = [
  ["project", "detection", "profiles"].join("_"),
  ["project", "preflight", "reports"].join("_"),
  ["project", "deployment", "contracts"].join("_"),
  ["project", "deployment", "requirements"].join("_"),
];
const retiredDetectorColumn = ["required", "by", "detection"].join("_");

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

  testDatabase = new DataSource({ ...base, database, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
  await testDatabase.initialize();
  await testDatabase.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
  await testDatabase.query(`CREATE TABLE migrations (id serial PRIMARY KEY, timestamp bigint NOT NULL, name varchar NOT NULL)`);
  await testDatabase.query(`INSERT INTO migrations (timestamp, name) VALUES (1760000000000, 'CreateProjectPipelineTables1760000000000')`);
  await testDatabase.query(`CREATE TABLE users (id integer PRIMARY KEY)`);
  await testDatabase.query(`CREATE TABLE projects (
    id uuid PRIMARY KEY,
    app_directory varchar,
    deployment_overrides jsonb NOT NULL DEFAULT '{}'::jsonb
  )`);
  await testDatabase.query(`CREATE TABLE project_service_bindings (id uuid PRIMARY KEY)`);
  await testDatabase.query(`CREATE TABLE project_configuration_snapshots (id uuid PRIMARY KEY, pipeline_run_id uuid)`);
  const [detectionProfiles, preflightReports, deploymentContracts, deploymentRequirements] = retiredTables;
  await testDatabase.query(`CREATE TABLE ${detectionProfiles} (id uuid PRIMARY KEY)`);
  await testDatabase.query(`CREATE TABLE ${preflightReports} (id uuid PRIMARY KEY, detection_profile_id uuid REFERENCES ${detectionProfiles}(id))`);
  await testDatabase.query(`CREATE TABLE ${deploymentContracts} (id uuid PRIMARY KEY, project_id uuid NOT NULL, ecs_plan jsonb NOT NULL, detection_profile_id uuid REFERENCES ${detectionProfiles}(id))`);
  await testDatabase.query(`CREATE TABLE ${deploymentRequirements} (id uuid PRIMARY KEY, project_id uuid NOT NULL)`);
  await testDatabase.query(`CREATE TABLE project_database_tiers (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    provider varchar NOT NULL DEFAULT 'none',
    active_generation_id uuid,
    external_host varchar,
    external_port integer,
    external_tls_required boolean NOT NULL DEFAULT true,
    efs_file_system_id varchar,
    efs_access_point_id varchar,
    credentials_secret_arn varchar,
    database_url_secret_arn varchar,
    ${retiredDetectorColumn} boolean NOT NULL DEFAULT false
  )`);
  await testDatabase.query(`CREATE TABLE project_environment_variables (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    key varchar NOT NULL,
    normalized_key varchar NOT NULL,
    encrypted_value text NOT NULL
  )`);
  await testDatabase.query(`CREATE TABLE project_persistent_storage (id uuid PRIMARY KEY, ${retiredDetectorColumn} boolean NOT NULL DEFAULT false)`);
  await testDatabase.query(`CREATE TABLE project_environment_routes (
    id uuid PRIMARY KEY,
    project_id uuid NOT NULL,
    environment_name varchar(64) NOT NULL,
    listener_priority integer NOT NULL,
    live_generation_id uuid,
    candidate_generation_id uuid
  )`);

  await assert.rejects(
    () => assertProductStartSchemaIntegrity(testDatabase!),
    /project_pipeline_runs\.created_at/,
    "the product-start guard must reject migration-history drift before reconciliation starts",
  );

  const runner = testDatabase.createQueryRunner();
  await runner.connect();
  await new RepairProjectPipelineSchemaDrift1787356802000().up(runner);
  await new RepairDeploymentGenerationSchemaDrift1787356803000().up(runner);
  await new RepairStableReleaseSchemaDrift1787356804000().up(runner);
  await new RepairNotificationSchemaDrift1787356809600().up(runner);
  await new RemoveRetiredRepositoryAnalysisSchema1787356810000().up(runner);
  await new ProjectDeployableServices1787356813000().up(runner);
  await new RepairDeployableServiceUuidDefault1787356817000().up(runner);
  await runner.release();

  await assertProductStartSchemaIntegrity(testDatabase);
  const generatedProjectId = randomUUID();
  await testDatabase.query(`INSERT INTO "projects" ("id") VALUES ($1)`, [generatedProjectId]);
  const generatedServices = await testDatabase.query(
    `INSERT INTO "project_deployable_services" ("project_id", "name") VALUES ($1, 'Web') RETURNING "id"`,
    [generatedProjectId],
  );
  assert.match(generatedServices[0]?.id || "", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "fresh project service insert must generate its UUID in PostgreSQL");
  const retired = await testDatabase.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
  `, [retiredTables]);
  assert.deepEqual(retired, [], "retired repository-analysis tables must be absent while current schema integrity passes");
  const detectorColumns = await testDatabase.query(`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = $1
  `, [retiredDetectorColumn]);
  assert.deepEqual(detectorColumns, [], "retired detector-derived columns must be absent while current schema integrity passes");
  const tables = await testDatabase.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('project_pipeline_runs', 'project_pipeline_events', 'project_deployment_generations', 'project_stable_releases')
    ORDER BY table_name
  `);
  assert.deepEqual(tables.map((row: { table_name: string }) => row.table_name), ["project_deployment_generations", "project_pipeline_events", "project_pipeline_runs", "project_stable_releases"]);
  const notificationTables = await testDatabase.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('notification_preferences', 'notification_subscriptions', 'notification_deliveries')
    ORDER BY table_name
  `);
  assert.deepEqual(notificationTables.map((row: { table_name: string }) => row.table_name), ["notification_deliveries", "notification_preferences", "notification_subscriptions"]);
  const history = await testDatabase.query(`SELECT name FROM migrations ORDER BY id`);
  assert.deepEqual(history.map((row: { name: string }) => row.name), ["CreateProjectPipelineTables1760000000000"]);
  console.log("Product-start schema-integrity regression passed.");
})().finally(close).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
