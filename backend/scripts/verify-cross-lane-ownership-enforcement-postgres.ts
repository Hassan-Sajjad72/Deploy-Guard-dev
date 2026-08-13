import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreateReleaseLaneOwnerships1760000043000 } from "../src/migrations/1760000043000-CreateReleaseLaneOwnerships";
import { AddReleaseLaneOwnershipCorrelation1760000044000 } from "../src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation";
import {
  CrossLaneOwnershipEnforcementError,
  CrossLaneOwnershipEnforcementService,
} from "../src/orchestration-contracts/release-lane/cross-lane-ownership-enforcement.service";
import { InactiveReleaseLaneCorrelationService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-correlation.service";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session8_16_enforcement_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe schema identifier");
const base = AppDataSource.options as DataSourceOptions & {
  extra?: Record<string, unknown>;
};
const admin = new DataSource({
  ...base,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
} as DataSourceOptions);
const dataSource = new DataSource({
  ...base,
  schema,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
  extra: {
    ...(base.extra || {}),
    options: `-c search_path=${schema},public`,
  },
} as DataSourceOptions);

class ConfigFixture {
  constructor(private readonly enabled: boolean) {}
  get(key: string) {
    return key === "TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED"
      ? String(this.enabled)
      : undefined;
  }
}

const projects = {
  race: "11111111-1111-4111-8111-111111111111",
  duplicate: "22222222-2222-4222-8222-222222222222",
  rollback: "33333333-3333-4333-8333-333333333333",
  infrastructure: "44444444-4444-4444-8444-444444444444",
  storage: "55555555-5555-4555-8555-555555555555",
  disabled: "66666666-6666-4666-8666-666666666666",
};
const ownership = () => new InactiveReleaseLaneOwnershipService(dataSource);
const correlation = () => new InactiveReleaseLaneCorrelationService(dataSource);
const service = (enabled = true) =>
  new CrossLaneOwnershipEnforcementService(
    new ConfigFixture(enabled) as never,
    ownership(),
    correlation(),
  );

async function setup() {
  await dataSource.query(`
    CREATE TABLE projects (id uuid PRIMARY KEY);
    CREATE TABLE project_pipeline_runs (
      id uuid PRIMARY KEY, project_id uuid NOT NULL, status varchar(64) NOT NULL
    );
    CREATE TABLE project_rollback_records (
      id uuid PRIMARY KEY, project_id uuid NOT NULL
    );
    CREATE TABLE deployment_intents (
      id uuid PRIMARY KEY, project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL, status varchar(32) NOT NULL
    );
    CREATE TABLE project_operation_leases (
      id uuid PRIMARY KEY, intent_id uuid NOT NULL, project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL, owner_worker_id varchar(160) NOT NULL,
      fencing_token bigint NOT NULL, status varchar(24) NOT NULL,
      expires_at timestamptz NOT NULL
    );
  `);
  for (const projectId of Object.values(projects)) {
    await dataSource.query("INSERT INTO projects (id) VALUES ($1)", [projectId]);
  }
  const runner = dataSource.createQueryRunner();
  try {
    await new CreateReleaseLaneOwnerships1760000043000().up(runner);
    await new AddReleaseLaneOwnershipCorrelation1760000044000().up(runner);
  } finally {
    await runner.release();
  }
}

async function main() {
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  try {
    await setup();

    const disabled = await service(false).acquireLegacy({
      projectId: projects.disabled,
      operationId: randomUUID(),
      actorId: "user:1",
      operationClass: "legacy_full_deployment_run",
    });
    assert.deepEqual(disabled, { enabled: false });
    assert.equal(Number((await dataSource.query(
      "SELECT count(*) AS count FROM project_release_lane_ownerships WHERE project_id = $1",
      [projects.disabled],
    ))[0].count), 0);

    const intentId = randomUUID();
    await dataSource.query(
      "INSERT INTO deployment_intents (id,project_id,environment_name,status) VALUES ($1,$2,'dev','enqueued')",
      [intentId, projects.race],
    );
    const [legacyRace, v1Race] = await Promise.allSettled([
      service().acquireLegacy({
        projectId: projects.race,
        operationId: randomUUID(),
        actorId: "user:2",
        operationClass: "legacy_full_deployment_run",
      }),
      service().acquireV1({
        projectId: projects.race,
        environmentName: "dev",
        intentId,
        actorId: "worker:v1-race",
        requestFingerprint: "a".repeat(64),
      }),
    ]);
    assert.equal(
      [legacyRace, v1Race].filter((result) => result.status === "fulfilled").length,
      1,
      "legacy versus v1 race must have exactly one winner",
    );
    const rejected = [legacyRace, v1Race].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(
      rejected?.reason instanceof CrossLaneOwnershipEnforcementError,
    );

    const duplicateRunId = randomUUID();
    const duplicate = await service().acquireLegacy({
      projectId: projects.duplicate,
      operationId: duplicateRunId,
      actorId: "user:3",
      operationClass: "legacy_full_deployment_run",
    });
    const replay = await service().acquireLegacy({
      projectId: projects.duplicate,
      operationId: duplicateRunId,
      actorId: "user:3",
      operationClass: "legacy_full_deployment_run",
    });
    assert.equal(duplicate.enabled && replay.enabled, true);
    if (!duplicate.enabled || !replay.enabled) throw new Error("Expected claims");
    assert.equal(
      duplicate.fence.ownershipLeaseId,
      replay.fence.ownershipLeaseId,
    );
    assert.equal(await service().renew(duplicate, 20_000), true);
    const stale = {
      ...duplicate,
      fence: {
        ...duplicate.fence,
        ownershipFencingToken: "999",
      },
    };
    assert.equal(await service().renew(stale, 20_000), false);
    assert.equal(await service().release(stale), false);
    assert.equal(await service().release(duplicate), true);

    const rollbackId = randomUUID();
    await dataSource.query(
      "INSERT INTO project_rollback_records (id,project_id) VALUES ($1,$2)",
      [rollbackId, projects.rollback],
    );
    const rollback = await service().acquireLegacy({
      projectId: projects.rollback,
      operationId: rollbackId,
      actorId: `legacy-rollback:${rollbackId}`,
      operationClass: "legacy_rollback",
    });
    await service().linkLegacyRollback(rollback, rollbackId);
    const [rollbackRow] = await dataSource.query(
      `SELECT cross_lane_owner_fencing_token::text AS token
       FROM project_rollback_records WHERE id = $1`,
      [rollbackId],
    );
    assert.equal(rollbackRow.token, "1");
    assert.equal(
      await service().releaseLegacyRollback(rollback, rollbackId),
      true,
    );

    for (const [projectId, operationClass] of [
      [projects.infrastructure, "legacy_infrastructure_apply"],
      [projects.storage, "legacy_storage_provision"],
    ] as const) {
      const runId = randomUUID();
      const claim = await service().acquireLegacy({
        projectId,
        operationId: runId,
        actorId: "user:4",
        operationClass,
      });
      await dataSource.query(
        "INSERT INTO project_pipeline_runs (id,project_id,status) VALUES ($1,$2,'queued')",
        [runId, projectId],
      );
      await service().linkLegacyRun(claim, runId);
      const [row] = await dataSource.query(
        `SELECT cross_lane_owner_lane AS lane,
                cross_lane_owner_environment_name AS environment
         FROM project_pipeline_runs WHERE id = $1`,
        [runId],
      );
      assert.deepEqual(row, { lane: "legacy", environment: "dev" });
    }

    const v1Project = projects.disabled;
    const v1Intent = randomUUID();
    const operationLeaseId = randomUUID();
    await dataSource.query(
      "INSERT INTO deployment_intents (id,project_id,environment_name,status) VALUES ($1,$2,'dev','running')",
      [v1Intent, v1Project],
    );
    const v1 = await service().acquireV1({
      projectId: v1Project,
      environmentName: "dev",
      intentId: v1Intent,
      actorId: "worker:v1",
      requestFingerprint: "b".repeat(64),
    });
    if (!v1.enabled) throw new Error("Expected v1 ownership");
    await dataSource.query(
      `INSERT INTO project_operation_leases
       (id,intent_id,project_id,environment_name,owner_worker_id,fencing_token,status,expires_at)
       VALUES ($1,$2,$3,'dev','worker:v1',7,'acquired',clock_timestamp()+interval '1 minute')`,
      [operationLeaseId, v1Intent, v1Project],
    );
    await service().attachV1OperationLease(v1, {
      intentId: v1Intent,
      operationLeaseId,
      operationWorkerId: "worker:v1",
      operationFencingToken: "7",
    });
    assert.notEqual(v1.fence.ownershipLeaseId, operationLeaseId);
    const v1Replay = await service().acquireV1({
      projectId: v1Project,
      environmentName: "dev",
      intentId: v1Intent,
      actorId: "worker:v1",
      requestFingerprint: "b".repeat(64),
    });
    assert.equal(v1Replay.enabled, true);
    if (!v1Replay.enabled) throw new Error("Expected replay");
    assert.equal(
      v1Replay.fence.ownershipLeaseId,
      v1.fence.ownershipLeaseId,
      "v1 duplicate must reuse its independent cross-lane identity",
    );
    assert.equal(await service().validateV1Fences(v1, {
      intentId: v1Intent,
      operationLeaseId,
      operationWorkerId: "worker:v1",
      operationFencingToken: "7",
    }), true);
    assert.equal(await service().releaseV1(v1, {
      intentId: v1Intent,
      operationLeaseId,
    }), true);
    const [releasedV1] = await dataSource.query(
      `SELECT status, deployment_intent_id AS intent,
              operation_lease_id AS operation
       FROM project_release_lane_ownerships
       WHERE project_id = $1 AND environment_name = 'dev'`,
      [v1Project],
    );
    assert.deepEqual(releasedV1, {
      status: "released",
      intent: null,
      operation: null,
    });

    console.log("Default-off cross-lane ownership enforcement PostgreSQL verification passed");
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
