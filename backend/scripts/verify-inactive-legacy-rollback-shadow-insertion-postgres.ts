import { strict as assert } from "node:assert";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreateReleaseLaneOwnerships1760000043000 } from "../src/migrations/1760000043000-CreateReleaseLaneOwnerships";
import { AddReleaseLaneOwnershipCorrelation1760000044000 } from "../src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation";
import { CreateReleaseLaneShadowObservations1760000045000 } from "../src/migrations/1760000045000-CreateReleaseLaneShadowObservations";
import { InactiveLegacyShadowInsertionAdapter } from "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter";
import { InactiveReleaseLaneShadowObserverService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session8_10_rollback_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe schema identifier");
const baseOptions = AppDataSource.options as DataSourceOptions & { extra?: Record<string, unknown> };
const admin = new DataSource({ ...baseOptions, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
const dataSource = new DataSource({
  ...baseOptions, schema, entities: [], migrations: [], synchronize: false, logging: false,
  extra: { ...(baseOptions.extra || {}), options: `-c search_path=${schema},public` },
} as DataSourceOptions);
const projectId = "11111111-1111-4111-8111-111111111111";
const rollbackRecordId = "22222222-2222-4222-8222-222222222222";

async function setup() {
  await dataSource.query(`
    CREATE TABLE projects (id uuid PRIMARY KEY);
    CREATE TABLE project_pipeline_runs (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL, status varchar(64) NOT NULL);
    CREATE TABLE project_rollback_records (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL);
    CREATE TABLE deployment_intents (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL, environment_name varchar(64) NOT NULL, status varchar(32) NOT NULL);
    CREATE TABLE project_operation_leases (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL, environment_name varchar(64) NOT NULL, intent_id uuid, owner_worker_id varchar(160), fencing_token bigint, status varchar(24) NOT NULL, expires_at timestamptz NOT NULL);
    INSERT INTO projects (id) VALUES ('${projectId}');
  `);
  const runner = dataSource.createQueryRunner();
  try {
    for (const migration of [
      new CreateReleaseLaneOwnerships1760000043000(),
      new AddReleaseLaneOwnershipCorrelation1760000044000(),
      new CreateReleaseLaneShadowObservations1760000045000(),
    ]) await migration.up(runner);
  } finally {
    await runner.release();
  }
}

async function main() {
  const priorMode = process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  try {
    await setup();
    process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE = "true";
    const observer = new InactiveReleaseLaneShadowObserverService(dataSource);
    const pending: Promise<unknown>[] = [];
    const adapter = new InactiveLegacyShadowInsertionAdapter({
      observe(input) {
        const result = observer.observe(input);
        pending.push(result);
        return result;
      },
    } as never);
    const input = { projectId, rollbackRecordId };
    adapter.observeRollbackRecordCreated(input);
    adapter.observeRollbackRecordCreated(input);
    adapter.observeRollbackBeforeEcsUpdate(input);
    adapter.observeRollbackBeforeEcsUpdate(input);
    adapter.observeRollbackSucceeded(input);
    adapter.observeRollbackSucceeded(input);
    const results = await Promise.all(pending);
    assert.equal(results.filter((result: any) => result.enabled && result.disposition === "observed").length, 3);
    assert.equal(results.filter((result: any) => result.enabled && result.disposition === "already_observed").length, 3);
    const rows = await dataSource.query(`SELECT insertion_source, operation_class, proposed_lane, environment_name, to_jsonb(t)::text AS value FROM project_release_lane_shadow_observations t ORDER BY insertion_source`);
    assert.deepEqual(rows.map((row: any) => row.insertion_source), [
      "rollback_service.before_ecs_update", "rollback_service.record_created", "rollback_service.terminal_succeeded",
    ]);
    assert.equal(rows.every((row: any) => row.operation_class === "legacy_rollback" && row.proposed_lane === "legacy" && row.environment_name === "dev"), true);
    assert.equal(rows.every((row: any) => !row.value.includes("rollback-request:") && !row.value.includes(rollbackRecordId)), true);

    const failedPending: Promise<unknown>[] = [];
    const failedAdapter = new InactiveLegacyShadowInsertionAdapter({
      observe(input) {
        const result = observer.observe(input);
        failedPending.push(result);
        return result;
      },
    } as never);
    failedAdapter.observeRollbackFailed(input);
    failedAdapter.observeRollbackFailed(input);
    const failedResults = await Promise.all(failedPending);
    assert.equal(failedResults.filter((result: any) => result.enabled && result.disposition === "observed").length, 1);
    assert.equal(failedResults.filter((result: any) => result.enabled && result.disposition === "already_observed").length, 1);

    delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
    const disabledPending: Promise<unknown>[] = [];
    const disabledAdapter = new InactiveLegacyShadowInsertionAdapter({
      observe(input) {
        const result = observer.observe(input);
        disabledPending.push(result);
        return result;
      },
    } as never);
    disabledAdapter.observeRollbackRecordCreated({ projectId, rollbackRecordId: "33333333-3333-4333-8333-333333333333" });
    const disabled = await Promise.all(disabledPending);
    assert.deepEqual(disabled, [{ enabled: false }]);
    const [{ count }] = await dataSource.query(`SELECT count(*)::integer AS count FROM project_release_lane_shadow_observations`);
    assert.equal(count, 4);
    console.log("Inactive legacy rollback shadow insertion PostgreSQL verification passed");
  } finally {
    if (priorMode === undefined) delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
    else process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE = priorMode;
    if (dataSource.isInitialized) await dataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
