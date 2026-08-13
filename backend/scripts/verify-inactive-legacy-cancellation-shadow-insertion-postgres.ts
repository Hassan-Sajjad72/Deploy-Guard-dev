import { strict as assert } from "node:assert";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreateReleaseLaneOwnerships1760000043000 } from "../src/migrations/1760000043000-CreateReleaseLaneOwnerships";
import { AddReleaseLaneOwnershipCorrelation1760000044000 } from "../src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation";
import { CreateReleaseLaneShadowObservations1760000045000 } from "../src/migrations/1760000045000-CreateReleaseLaneShadowObservations";
import { InactiveLegacyShadowInsertionAdapter } from "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter";
import { InactiveReleaseLaneShadowObserverService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session8_11_cancel_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe schema identifier");
const baseOptions = AppDataSource.options as DataSourceOptions & { extra?: Record<string, unknown> };
const admin = new DataSource({ ...baseOptions, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
const dataSource = new DataSource({
  ...baseOptions, schema, entities: [], migrations: [], synchronize: false, logging: false,
  extra: { ...(baseOptions.extra || {}), options: `-c search_path=${schema},public` },
} as DataSourceOptions);
const projectId = "11111111-1111-4111-8111-111111111111";
const pipelineRunId = "22222222-2222-4222-8222-222222222222";

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
    adapter.observeCancellationPersisted({ projectId, pipelineRunId });
    adapter.observeCancellationPersisted({ projectId, pipelineRunId });
    const results = await Promise.all(pending);
    assert.equal(results.filter((result: any) => result.enabled && result.disposition === "observed").length, 1);
    assert.equal(results.filter((result: any) => result.enabled && result.disposition === "already_observed").length, 1);
    const rows = await dataSource.query(`SELECT operation_class, insertion_source, proposed_lane, environment_name, to_jsonb(t)::text AS value FROM project_release_lane_shadow_observations t`);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      operation_class: "legacy_cancel", insertion_source: "pipeline_service.cancel_persisted",
      proposed_lane: "legacy", environment_name: "dev",
      value: rows[0].value,
    });
    assert.equal(rows[0].value.includes(`cancel:${pipelineRunId}:cancelled`), false, "raw cancellation identity must not persist");
    assert.equal(rows[0].value.includes(pipelineRunId), false, "pipeline run ID must not persist in the observation");

    delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
    const disabledPending: Promise<unknown>[] = [];
    const disabledAdapter = new InactiveLegacyShadowInsertionAdapter({
      observe(input) {
        const result = observer.observe(input);
        disabledPending.push(result);
        return result;
      },
    } as never);
    disabledAdapter.observeCancellationPersisted({ projectId, pipelineRunId: "33333333-3333-4333-8333-333333333333" });
    assert.deepEqual(await Promise.all(disabledPending), [{ enabled: false }]);
    const [{ count }] = await dataSource.query(`SELECT count(*)::integer AS count FROM project_release_lane_shadow_observations`);
    assert.equal(count, 1);
    console.log("Inactive legacy cancellation shadow insertion PostgreSQL verification passed");
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
