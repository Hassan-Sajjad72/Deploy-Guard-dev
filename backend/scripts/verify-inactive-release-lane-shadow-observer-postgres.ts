import { strict as assert } from "node:assert";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreateReleaseLaneOwnerships1760000043000 } from "../src/migrations/1760000043000-CreateReleaseLaneOwnerships";
import { AddReleaseLaneOwnershipCorrelation1760000044000 } from "../src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation";
import { CreateReleaseLaneShadowObservations1760000045000 } from "../src/migrations/1760000045000-CreateReleaseLaneShadowObservations";
import { InactiveReleaseLaneShadowObserverService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session8_5_shadow_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe schema identifier");
const baseOptions = AppDataSource.options as DataSourceOptions & { extra?: Record<string, unknown> };
const admin = new DataSource({ ...baseOptions, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
const dataSource = new DataSource({
  ...baseOptions, schema, entities: [], migrations: [], synchronize: false, logging: false,
  extra: { ...(baseOptions.extra || {}), options: `-c search_path=${schema},public` },
} as DataSourceOptions);
const projectId = "11111111-1111-4111-8111-111111111111";
const missingProjectId = "22222222-2222-4222-8222-222222222222";
const baseInput = {
  projectId, environmentName: "qa", proposedLane: "v1" as const,
  operationClass: "v1_plan_release" as const,
  logicalOperationIdentity: "shadow-op-1",
  insertionSource: "transactional_deployment_planner.plan" as const,
};
const observer = () => new InactiveReleaseLaneShadowObserverService(dataSource);

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
    ]) {
      await migration.up(runner);
      await migration.up(runner);
    }
  } finally {
    await runner.release();
  }
}

async function clearEvidence() {
  await dataSource.query("DELETE FROM project_pipeline_runs");
  await dataSource.query("DELETE FROM project_operation_leases");
  await dataSource.query("DELETE FROM deployment_intents");
  await dataSource.query("DELETE FROM project_release_lane_ownerships");
}

async function insertOwner(environmentName: string, lane: "legacy" | "v1", token: number, expired = false) {
  await dataSource.query(
    `INSERT INTO project_release_lane_ownerships (
      id,project_id,environment_name,owner_lane,lease_id,actor_id,idempotency_key,request_fingerprint,
      fencing_token,status,acquired_at,heartbeat_at,expires_at,created_at,updated_at
    ) VALUES (uuid_generate_v4(),$1,$2,$3,uuid_generate_v4(),'shadow:worker',$4,$5,$6::bigint,'acquired',
      clock_timestamp(),clock_timestamp(),clock_timestamp() ${expired ? "- interval '1 minute'" : "+ interval '5 minutes'"},clock_timestamp(),clock_timestamp())`,
    [projectId, environmentName, lane, "a".repeat(64), "b".repeat(64), token],
  );
}

async function main() {
  const original = process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  try {
    await setup();
    delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
    assert.deepEqual(await observer().observe(baseInput), { enabled: false }, "disabled mode must not read or write");
    const [{ count: disabledCount }] = await dataSource.query(`SELECT count(*)::integer AS count FROM project_release_lane_shadow_observations`);
    assert.equal(disabledCount, 0);

    process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE = "true";
    const first = await observer().observe(baseInput);
    assert.equal(first.enabled, true);
    if (!first.enabled || first.disposition !== "observed") throw new Error("Expected shadow observation");
    assert.equal(first.observation.decision, "acquirable");
    const replay = await observer().observe(baseInput);
    assert.equal(replay.enabled, true);
    if (!replay.enabled) throw new Error("Expected enabled replay");
    assert.equal(replay.disposition, "already_observed");
    const conflict = await observer().observe({ ...baseInput, environmentName: "prod" });
    assert.equal(conflict.enabled, true);
    if (!conflict.enabled) throw new Error("Expected enabled conflict");
    assert.equal(conflict.disposition, "idempotency_conflict");
    const [stored] = await dataSource.query(`SELECT to_jsonb(t)::text AS value FROM project_release_lane_shadow_observations t WHERE project_id = $1`, [projectId]);
    assert.equal(stored.value.includes("shadow-op-1"), false, "raw idempotency identity must not persist");
    assert.equal(stored.value.includes("shadow:worker"), false, "actor identity must not persist");

    await clearEvidence();
    const legacyRun = await observer().observe({
      ...baseInput, environmentName: "dev", proposedLane: "legacy", operationClass: "legacy_full_deployment_run",
      logicalOperationIdentity: "legacy-active", insertionSource: "pipeline_service.start_run",
    });
    assert.equal(legacyRun.enabled, true);
    if (!legacyRun.enabled || legacyRun.disposition !== "observed") throw new Error("Expected legacy baseline");
    assert.equal(legacyRun.observation.decision, "acquirable");
    await dataSource.query(`INSERT INTO project_pipeline_runs (project_id,status) VALUES ($1,'running')`, [projectId]);
    const legacyBlocked = await observer().observe({
      ...baseInput, environmentName: "dev", proposedLane: "v1", operationClass: "v1_plan_release",
      logicalOperationIdentity: "legacy-blocked", insertionSource: "transactional_deployment_planner.plan",
    });
    assert.equal(legacyBlocked.enabled, true);
    if (!legacyBlocked.enabled || legacyBlocked.disposition !== "observed") throw new Error("Expected legacy decision");
    assert.equal(legacyBlocked.observation.decision, "would_block_legacy");

    await clearEvidence();
    await dataSource.query(`INSERT INTO deployment_intents (project_id,environment_name,status) VALUES ($1,'qa','planned')`, [projectId]);
    const v1Blocked = await observer().observe({ ...baseInput, logicalOperationIdentity: "v1-blocked" });
    assert.equal(v1Blocked.enabled, true);
    if (!v1Blocked.enabled || v1Blocked.disposition !== "observed") throw new Error("Expected v1 decision");
    assert.equal(v1Blocked.observation.decision, "would_block_v1");

    await clearEvidence();
    await insertOwner("qa", "v1", 7);
    const ownerBlocked = await observer().observe({ ...baseInput, logicalOperationIdentity: "owner-blocked" });
    assert.equal(ownerBlocked.enabled, true);
    if (!ownerBlocked.enabled || ownerBlocked.disposition !== "observed") throw new Error("Expected owner decision");
    assert.equal(ownerBlocked.observation.decision, "would_block_v1");
    assert.equal(ownerBlocked.observation.currentFencingToken, "7");

    await clearEvidence();
    await insertOwner("qa", "legacy", 8, true);
    const stale = await observer().observe({ ...baseInput, logicalOperationIdentity: "stale-owner" });
    assert.equal(stale.enabled, true);
    if (!stale.enabled || stale.disposition !== "observed") throw new Error("Expected stale decision");
    assert.equal(stale.observation.decision, "unsafe_stale");
    assert.equal(stale.observation.currentFencingToken, null, "unsafe owner evidence must not be surfaced as current fencing");

    await clearEvidence();
    await insertOwner("prod", "v1", 9);
    const isolated = await observer().observe({ ...baseInput, logicalOperationIdentity: "environment-isolated" });
    assert.equal(isolated.enabled, true);
    if (!isolated.enabled || isolated.disposition !== "observed") throw new Error("Expected environment decision");
    assert.equal(isolated.observation.decision, "acquirable");

    const insufficient = await observer().observe({ ...baseInput, projectId: missingProjectId, logicalOperationIdentity: "missing-project" });
    assert.equal(insufficient.enabled, true);
    if (!insufficient.enabled || insufficient.disposition !== "observed") throw new Error("Expected insufficient evidence");
    assert.equal(insufficient.observation.decision, "insufficient_evidence");
    await assert.rejects(
      () => observer().observe({ ...baseInput, environmentName: "prod", proposedLane: "legacy", operationClass: "legacy_full_deployment_run", logicalOperationIdentity: "legacy-nondev", insertionSource: "pipeline_service.start_run" }),
      /SHADOW_OBSERVATION_INPUT_INVALID/,
    );

    const concurrentInput = { ...baseInput, logicalOperationIdentity: "concurrent-shadow" };
    const concurrent = await Promise.all([observer().observe(concurrentInput), observer().observe(concurrentInput)]);
    assert.equal(concurrent.filter((result) => result.enabled && result.disposition === "observed").length, 1);
    assert.equal(concurrent.filter((result) => result.enabled && result.disposition === "already_observed").length, 1);

    await dataSource.query(`CREATE FUNCTION fail_shadow_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced shadow rollback'; END; $$`);
    await dataSource.query(`CREATE TRIGGER fail_shadow_insert_trigger BEFORE INSERT ON project_release_lane_shadow_observations FOR EACH ROW WHEN (NEW.insertion_source = 'durable_outbox_dispatcher.dispatch_one') EXECUTE FUNCTION fail_shadow_insert()`);
    await assert.rejects(
      () => observer().observe({ ...baseInput, logicalOperationIdentity: "transaction-rollback", insertionSource: "durable_outbox_dispatcher.dispatch_one", operationClass: "v1_dispatch_release" }),
      /forced shadow rollback/,
    );
    const [{ count: rollbackCount }] = await dataSource.query(`SELECT count(*)::integer AS count FROM project_release_lane_shadow_observations WHERE canonical_operation_key = $1`, [require("../src/orchestration-contracts/contracts/canonical-json").canonicalSha256({ domain: "deployguard.release-lane-shadow.v1", identity: "transaction-rollback" })]);
    assert.equal(rollbackCount, 0, "failed observation transaction must not persist a partial row");

    console.log("Inactive release-lane shadow observer PostgreSQL verification passed");
  } finally {
    if (original === undefined) delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
    else process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE = original;
    if (dataSource.isInitialized) await dataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
