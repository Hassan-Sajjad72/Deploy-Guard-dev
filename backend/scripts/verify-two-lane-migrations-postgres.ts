import { strict as assert } from "node:assert";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreateTwoLaneManifestsAndStateRevisions1760000034000 } from "../src/migrations/1760000034000-CreateTwoLaneManifestsAndStateRevisions";
import { CreateDeploymentIntentsOutboxAndOperationLeases1760000035000 } from "../src/migrations/1760000035000-CreateDeploymentIntentsOutboxAndOperationLeases";
import { LinkLegacyExecutionToTwoLaneContracts1760000036000 } from "../src/migrations/1760000036000-LinkLegacyExecutionToTwoLaneContracts";
import { CreateWorkerCapabilityRegistry1760000037000 } from "../src/migrations/1760000037000-CreateWorkerCapabilityRegistry";
import { CreateReleaseLaneOwnerships1760000043000 } from "../src/migrations/1760000043000-CreateReleaseLaneOwnerships";
import { AddReleaseLaneOwnershipCorrelation1760000044000 } from "../src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation";
import { CreateReleaseLaneShadowObservations1760000045000 } from "../src/migrations/1760000045000-CreateReleaseLaneShadowObservations";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `two_lane_migration_test_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe test schema identifier.");

const dataSource = new DataSource({
  ...AppDataSource.options,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
} as DataSourceOptions);

const migrations = [
  new CreateTwoLaneManifestsAndStateRevisions1760000034000(),
  new CreateDeploymentIntentsOutboxAndOperationLeases1760000035000(),
  new LinkLegacyExecutionToTwoLaneContracts1760000036000(),
  new CreateWorkerCapabilityRegistry1760000037000(),
  new CreateReleaseLaneOwnerships1760000043000(),
  new AddReleaseLaneOwnershipCorrelation1760000044000(),
  new CreateReleaseLaneShadowObservations1760000045000(),
];

async function main() {
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query(`CREATE SCHEMA "${schema}"`);
    await runner.query(`SET search_path TO "${schema}", public`);
    await runner.query(`CREATE TABLE "users" ("id" integer PRIMARY KEY)`);
    await runner.query(`CREATE TABLE "projects" ("id" uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE "project_pipeline_runs" ("id" uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE "project_rollback_records" ("id" uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE "project_deployment_contracts" ("id" uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE "project_configuration_snapshots" ("id" uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE "project_deployments" ("id" uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE "project_stable_releases" ("id" uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE "project_infrastructure_environments" ("id" uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE "infrastructure_destroy_operations" ("id" uuid PRIMARY KEY)`);

    const ids = {
      project: "11111111-1111-4111-8111-111111111111",
      run: "22222222-2222-4222-8222-222222222222",
      deployment: "33333333-3333-4333-8333-333333333333",
      stable: "44444444-4444-4444-8444-444444444444",
      infrastructure: "55555555-5555-4555-8555-555555555555",
      destroy: "66666666-6666-4666-8666-666666666666",
    };
    await runner.query(`INSERT INTO "users" ("id") VALUES (1)`);
    await runner.query(`INSERT INTO "projects" ("id") VALUES ($1)`, [ids.project]);
    await runner.query(`INSERT INTO "project_pipeline_runs" ("id") VALUES ($1)`, [ids.run]);
    await runner.query(`INSERT INTO "project_deployments" ("id") VALUES ($1)`, [ids.deployment]);
    await runner.query(`INSERT INTO "project_stable_releases" ("id") VALUES ($1)`, [ids.stable]);
    await runner.query(`INSERT INTO "project_infrastructure_environments" ("id") VALUES ($1)`, [ids.infrastructure]);
    await runner.query(`INSERT INTO "infrastructure_destroy_operations" ("id") VALUES ($1)`, [ids.destroy]);

    const legacyTables = [
      "projects",
      "project_pipeline_runs",
      "project_rollback_records",
      "project_deployments",
      "project_stable_releases",
      "project_infrastructure_environments",
      "infrastructure_destroy_operations",
    ];
    const before: Record<string, Array<{ id: string }>> = {};
    for (const table of legacyTables) {
      before[table] = await runner.query(`SELECT "id" FROM "${table}" ORDER BY "id"`);
    }

    for (const migration of migrations) await migration.up(runner);
    for (const migration of migrations) await migration.up(runner);

    const newTables = [
      "infrastructure_manifests",
      "release_manifests",
      "project_state_revisions",
      "deployment_intents",
      "orchestration_outbox",
      "project_operation_leases",
      "worker_capabilities",
      "project_release_lane_ownerships",
      "project_release_lane_shadow_observations",
    ];
    for (const table of newTables) {
      const [{ count }] = await runner.query(`SELECT count(*)::integer AS "count" FROM "${table}"`);
      assert.equal(count, 0, `${table} must remain empty after schema migration`);
    }
    for (const table of legacyTables) {
      assert.deepEqual(
        await runner.query(`SELECT "id" FROM "${table}" ORDER BY "id"`),
        before[table],
        `${table} legacy rows changed`,
      );
    }

    const [releaseInfrastructureColumn] = await runner.query(
      `SELECT is_nullable AS "isNullable"
       FROM information_schema.columns
       WHERE table_schema = $1
         AND table_name = 'release_manifests'
         AND column_name = 'infrastructure_manifest_id'`,
      [schema],
    );
    assert.equal(releaseInfrastructureColumn.isNullable, "NO");

    const nullableLinkChecks = await runner.query(
      `SELECT table_name AS "table", column_name AS "column", is_nullable AS "isNullable"
       FROM information_schema.columns
       WHERE table_schema = $1
         AND (
           (table_name = 'project_pipeline_runs' AND column_name IN (
             'deployment_intent_id','infrastructure_manifest_id','release_manifest_id',
             'cross_lane_ownership_id','cross_lane_owner_lane','cross_lane_owner_environment_name',
             'cross_lane_owner_lease_id','cross_lane_owner_actor_id','cross_lane_owner_fencing_token'
           ))
           OR (table_name = 'project_rollback_records' AND column_name IN (
             'cross_lane_ownership_id','cross_lane_owner_lane','cross_lane_owner_environment_name',
             'cross_lane_owner_lease_id','cross_lane_owner_actor_id','cross_lane_owner_fencing_token'
           ))
           OR (table_name = 'project_deployments' AND column_name = 'release_manifest_id')
           OR (table_name = 'project_stable_releases' AND column_name = 'release_manifest_id')
           OR (table_name = 'project_infrastructure_environments' AND column_name IN (
             'desired_manifest_id','applied_manifest_id'
           ))
           OR (table_name = 'infrastructure_destroy_operations' AND column_name IN (
             'deployment_intent_id','infrastructure_manifest_id'
           ))
         )`,
      [schema],
    );
    assert.equal(nullableLinkChecks.length, 21);
    assert.equal(nullableLinkChecks.every((row: any) => row.isNullable === "YES"), true);

    const indexRows = await runner.query(
      `SELECT indexname AS "name"
       FROM pg_indexes
       WHERE schemaname = $1
         AND indexname IN (
           'UQ_deployment_intent_idempotency',
           'IDX_deployment_intent_request_fingerprint',
           'IDX_release_manifest_fingerprints',
           'IDX_infrastructure_manifest_plan_fingerprints'
         )`,
      [schema],
    );
    assert.deepEqual(
      indexRows.map((row: any) => row.name).sort(),
      [
        "IDX_deployment_intent_request_fingerprint",
        "IDX_infrastructure_manifest_plan_fingerprints",
        "IDX_release_manifest_fingerprints",
        "UQ_deployment_intent_idempotency",
      ],
    );

    const legacyNulls = await runner.query(
      `SELECT deployment_intent_id, execution_lane, infrastructure_manifest_id,
              release_manifest_id, worker_protocol_version, operation_fencing_token,
              cross_lane_ownership_id, cross_lane_owner_lane,
              cross_lane_owner_environment_name, cross_lane_owner_lease_id,
              cross_lane_owner_actor_id, cross_lane_owner_fencing_token
       FROM "project_pipeline_runs" WHERE id = $1`,
      [ids.run],
    );
    assert.deepEqual(legacyNulls, [{
      deployment_intent_id: null,
      execution_lane: null,
      infrastructure_manifest_id: null,
      release_manifest_id: null,
      worker_protocol_version: null,
      operation_fencing_token: null,
      cross_lane_ownership_id: null,
      cross_lane_owner_lane: null,
      cross_lane_owner_environment_name: null,
      cross_lane_owner_lease_id: null,
      cross_lane_owner_actor_id: null,
      cross_lane_owner_fencing_token: null,
    }]);

    for (const migration of [...migrations].reverse()) await migration.down(runner);
    for (const table of legacyTables) {
      assert.deepEqual(
        await runner.query(`SELECT "id" FROM "${table}" ORDER BY "id"`),
        before[table],
        `${table} legacy rows changed during rollback`,
      );
    }
    for (const table of newTables) {
      const [{ relation }] = await runner.query(`SELECT to_regclass($1) AS "relation"`, [`${schema}.${table}`]);
      assert.equal(relation, null, `${table} still exists after rollback`);
    }
    console.log("Two-lane migrations applied twice and rolled back cleanly in an isolated legacy-shaped PostgreSQL schema");
  } finally {
    await runner.query(`SET search_path TO public`);
    await runner.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await runner.release();
    await dataSource.destroy();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
