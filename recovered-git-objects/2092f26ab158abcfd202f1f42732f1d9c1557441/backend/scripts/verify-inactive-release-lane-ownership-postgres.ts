import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreateReleaseLaneOwnerships1760000043000 } from "../src/migrations/1760000043000-CreateReleaseLaneOwnerships";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session8_2_ownership_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe schema identifier");
const baseOptions = AppDataSource.options as DataSourceOptions & { extra?: Record<string, unknown> };
const admin = new DataSource({ ...baseOptions, entities: [], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
const dataSource = new DataSource({
  ...baseOptions,
  schema,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
  extra: { ...(baseOptions.extra || {}), options: `-c search_path=${schema},public` },
} as DataSourceOptions);

const hash = (letter: string) => letter.repeat(64);
const projectId = "11111111-1111-4111-8111-111111111111";
const service = () => new InactiveReleaseLaneOwnershipService(dataSource);
const acquire = (lane: "legacy" | "v1", environmentName = "dev", extra: Partial<{
  leaseId: string; actorId: string; idempotencyKey: string; requestFingerprint: string; leaseTtlMs: number;
}> = {}) => service().acquire({
  projectId,
  environmentName,
  lane,
  leaseId: extra.leaseId ?? randomUUID(),
  actorId: extra.actorId ?? `${lane}:actor`,
  idempotencyKey: extra.idempotencyKey ?? hash(lane === "legacy" ? "a" : "b"),
  requestFingerprint: extra.requestFingerprint ?? hash(lane === "legacy" ? "c" : "d"),
  leaseTtlMs: extra.leaseTtlMs ?? 20_000,
});

async function setup() {
  await dataSource.query(`
    CREATE TABLE projects (id uuid PRIMARY KEY);
    CREATE TABLE project_pipeline_runs (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL, status varchar(64) NOT NULL);
    CREATE TABLE deployment_intents (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL, environment_name varchar(64) NOT NULL, status varchar(32) NOT NULL);
    CREATE TABLE project_operation_leases (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), project_id uuid NOT NULL, environment_name varchar(64) NOT NULL, status varchar(24) NOT NULL, expires_at timestamptz NOT NULL);
    INSERT INTO projects (id) VALUES ('${projectId}');
  `);
  const migration = new CreateReleaseLaneOwnerships1760000043000();
  const runner = dataSource.createQueryRunner();
  try {
    await migration.up(runner);
    await migration.up(runner);
  } finally {
    await runner.release();
  }
}

async function clearUnderlying() {
  await dataSource.query("DELETE FROM project_pipeline_runs");
  await dataSource.query("DELETE FROM deployment_intents");
  await dataSource.query("DELETE FROM project_operation_leases");
}

async function main() {
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  try {
    await setup();

    const identity = { leaseId: randomUUID(), actorId: "legacy:actor", idempotencyKey: hash("1"), requestFingerprint: hash("2") };
    const legacy = await acquire("legacy", "dev", identity);
    assert.equal(legacy.disposition, "acquired");
    if (legacy.disposition !== "acquired") throw new Error("Expected lease");
    assert.equal(legacy.ownership.fencingToken, "1");
    const replay = await acquire("legacy", "dev", identity);
    assert.equal(replay.disposition, "already_owned");
    const conflict = await acquire("legacy", "dev", { ...identity, actorId: "legacy:other" });
    assert.equal(conflict.disposition, "idempotency_conflict");
    assert.equal((await acquire("v1")).disposition, "blocked_by_legacy");

    const renewed = await service().renew({ projectId, environmentName: "dev", lane: "legacy", leaseId: identity.leaseId, actorId: identity.actorId, fencingToken: "1" });
    assert.equal(renewed.disposition, "already_owned");
    const released = await service().release({ projectId, environmentName: "dev", lane: "legacy", leaseId: identity.leaseId, actorId: identity.actorId, fencingToken: "1" });
    assert.equal(released.disposition, "already_owned");
    const [releasedRow] = await dataSource.query(
      `SELECT status FROM project_release_lane_ownerships WHERE project_id = $1 AND environment_name = 'dev'`,
      [projectId],
    );
    assert.equal(releasedRow.status, "released");
    assert.equal((await service().renew({ projectId, environmentName: "dev", lane: "legacy", leaseId: identity.leaseId, actorId: identity.actorId, fencingToken: "1" })).disposition, "ownership_lost", "released owner must not renew");

    const v1 = await acquire("v1", "dev", { leaseId: randomUUID(), actorId: "v1:actor", idempotencyKey: hash("3"), requestFingerprint: hash("4") });
    assert.equal(v1.disposition, "acquired");
    if (v1.disposition !== "acquired") throw new Error("Expected v1 lease");
    assert.equal(v1.ownership.fencingToken, "2");
    assert.equal((await acquire("legacy", "dev", { idempotencyKey: hash("5"), requestFingerprint: hash("6") })).disposition, "blocked_by_v1");
    assert.equal((await acquire("legacy", "production", { idempotencyKey: hash("7"), requestFingerprint: hash("8") })).disposition, "acquired");

    await service().release({ projectId, environmentName: "dev", lane: "v1", leaseId: v1.ownership.leaseId, actorId: "v1:actor", fencingToken: "2" });
    await dataSource.query(`UPDATE project_release_lane_ownerships SET expires_at = clock_timestamp() - interval '1 second', status = 'heartbeat_active' WHERE project_id = $1 AND environment_name = 'dev'`, [projectId]);
    await dataSource.query(`INSERT INTO project_pipeline_runs (project_id,status) VALUES ($1,'running')`, [projectId]);
    const unsafeTakeover = await acquire("v1", "dev", { idempotencyKey: hash("9"), requestFingerprint: hash("a") });
    assert.equal(unsafeTakeover.disposition, "expired_not_recoverable");
    await clearUnderlying();
    const replacement = await acquire("v1", "dev", { leaseId: randomUUID(), actorId: "v1:replacement", idempotencyKey: hash("b"), requestFingerprint: hash("c") });
    assert.equal(replacement.disposition, "acquired");
    if (replacement.disposition !== "acquired") throw new Error("Expected replacement");
    assert.equal(replacement.ownership.fencingToken, "3");
    assert.equal((await service().release({ projectId, environmentName: "dev", lane: "v1", leaseId: v1.ownership.leaseId, actorId: "v1:actor", fencingToken: "2" })).disposition, "ownership_lost", "stale owner must not release replacement");

    await service().release({ projectId, environmentName: "dev", lane: "v1", leaseId: replacement.ownership.leaseId, actorId: "v1:replacement", fencingToken: "3" });
    await dataSource.query(`INSERT INTO deployment_intents (project_id,environment_name,status) VALUES ($1,'dev','planned')`, [projectId]);
    assert.equal((await acquire("legacy", "dev", { idempotencyKey: hash("d"), requestFingerprint: hash("e") })).disposition, "blocked_by_v1");
    await dataSource.query("DELETE FROM deployment_intents");
    await dataSource.query(`INSERT INTO project_operation_leases (project_id,environment_name,status,expires_at) VALUES ($1,'dev','acquired',clock_timestamp()+interval '1 minute')`, [projectId]);
    assert.equal((await acquire("legacy", "dev", { idempotencyKey: hash("e"), requestFingerprint: hash("f") })).disposition, "blocked_by_v1");
    await clearUnderlying();

    await dataSource.query(`INSERT INTO deployment_intents (project_id,environment_name,status) VALUES ($1,'qa','planned')`, [projectId]);
    const ownIntent = await acquire("v1", "qa", { idempotencyKey: hash("f"), requestFingerprint: hash("0") });
    assert.equal(ownIntent.disposition, "acquired", "v1 must be able to own its own active intent");
    await clearUnderlying();

    await dataSource.query("DELETE FROM project_release_lane_ownerships");
    const concurrent = await Promise.all([
      acquire("legacy", "staging", { idempotencyKey: hash("a"), requestFingerprint: hash("b"), leaseId: randomUUID() }),
      acquire("v1", "staging", { idempotencyKey: hash("c"), requestFingerprint: hash("d"), leaseId: randomUUID() }),
    ]);
    assert.equal(concurrent.filter((result) => result.disposition === "acquired").length, 1);
    assert.equal(concurrent.filter((result) => result.disposition === "blocked_by_legacy" || result.disposition === "blocked_by_v1").length, 1);
    const rows = await dataSource.query(`SELECT count(*)::integer AS "count", max(fencing_token)::text AS "token" FROM project_release_lane_ownerships WHERE project_id = $1 AND environment_name = 'staging'`, [projectId]);
    assert.deepEqual(rows, [{ count: 1, token: "1" }]);
    console.log("Inactive legacy/v1 release-lane ownership PostgreSQL verification passed");
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
