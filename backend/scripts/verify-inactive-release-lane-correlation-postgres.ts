import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreateReleaseLaneOwnerships1760000043000 } from "../src/migrations/1760000043000-CreateReleaseLaneOwnerships";
import { AddReleaseLaneOwnershipCorrelation1760000044000 } from "../src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation";
import { InactiveReleaseLaneCorrelationService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-correlation.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session8_4_correlation_${suffix}`;
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

const projectId = "11111111-1111-4111-8111-111111111111";
const adapter = () => new InactiveReleaseLaneCorrelationService(dataSource);
type Owner = { id: string; environmentName: string; lane: "legacy" | "v1"; leaseId: string; actorId: string; fencingToken: string };

async function insertOwner(environmentName: string, lane: "legacy" | "v1", token: number): Promise<Owner> {
  const owner: Owner = {
    id: randomUUID(), environmentName, lane, leaseId: randomUUID(), actorId: `${lane}:worker`, fencingToken: String(token),
  };
  await dataSource.query(
    `INSERT INTO project_release_lane_ownerships (
       id, project_id, environment_name, owner_lane, lease_id, actor_id,
       idempotency_key, request_fingerprint, fencing_token, status,
       acquired_at, heartbeat_at, expires_at, created_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::bigint,'acquired',clock_timestamp(),clock_timestamp(),
       clock_timestamp()+interval '5 minutes',clock_timestamp(),clock_timestamp())`,
    [owner.id, projectId, owner.environmentName, owner.lane, owner.leaseId, owner.actorId,
      "a".repeat(64), "b".repeat(64), owner.fencingToken],
  );
  return owner;
}

const fence = (owner: Owner) => ({
  projectId, environmentName: owner.environmentName, lane: owner.lane,
  ownershipLeaseId: owner.leaseId, actorId: owner.actorId, ownershipFencingToken: owner.fencingToken,
});

async function setup() {
  await dataSource.query(`
    CREATE TABLE projects (id uuid PRIMARY KEY);
    CREATE TABLE project_pipeline_runs (id uuid PRIMARY KEY, project_id uuid NOT NULL);
    CREATE TABLE project_rollback_records (id uuid PRIMARY KEY, project_id uuid NOT NULL);
    CREATE TABLE deployment_intents (id uuid PRIMARY KEY, project_id uuid NOT NULL, environment_name varchar(64) NOT NULL);
    CREATE TABLE project_operation_leases (
      id uuid PRIMARY KEY, project_id uuid NOT NULL, environment_name varchar(64) NOT NULL,
      intent_id uuid NOT NULL, owner_worker_id varchar(160) NOT NULL, fencing_token bigint NOT NULL,
      status varchar(24) NOT NULL, expires_at timestamptz NOT NULL
    );
    INSERT INTO projects (id) VALUES ('${projectId}');
  `);
  const runner = dataSource.createQueryRunner();
  try {
    const ownershipMigration = new CreateReleaseLaneOwnerships1760000043000();
    const correlationMigration = new AddReleaseLaneOwnershipCorrelation1760000044000();
    await ownershipMigration.up(runner);
    await correlationMigration.up(runner);
    await correlationMigration.up(runner);
  } finally {
    await runner.release();
  }
}

async function insertIntent(environmentName: string) {
  const id = randomUUID();
  await dataSource.query(`INSERT INTO deployment_intents (id,project_id,environment_name) VALUES ($1,$2,$3)`, [id, projectId, environmentName]);
  return id;
}

async function insertOperationLease(intentId: string, environmentName: string, workerId = "v1:worker", token = "11") {
  const id = randomUUID();
  await dataSource.query(
    `INSERT INTO project_operation_leases (id,project_id,environment_name,intent_id,owner_worker_id,fencing_token,status,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6::bigint,'acquired',clock_timestamp()+interval '5 minutes')`,
    [id, projectId, environmentName, intentId, workerId, token],
  );
  return { id, workerId, token };
}

async function main() {
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  try {
    await setup();

    const legacy = await insertOwner("dev", "legacy", 1);
    const pipelineRunId = randomUUID();
    const rollbackRecordId = randomUUID();
    await dataSource.query(`INSERT INTO project_pipeline_runs (id,project_id) VALUES ($1,$2)`, [pipelineRunId, projectId]);
    await dataSource.query(`INSERT INTO project_rollback_records (id,project_id) VALUES ($1,$2)`, [rollbackRecordId, projectId]);
    assert.equal((await adapter().linkLegacyRun({ ...fence(legacy), pipelineRunId })).disposition, "linked");
    assert.equal((await adapter().linkLegacyRun({ ...fence(legacy), pipelineRunId })).disposition, "already_linked");
    assert.equal((await adapter().linkLegacyRollback({ ...fence(legacy), rollbackRecordId })).disposition, "linked");
    assert.equal((await adapter().clearLegacyRunAfterRelease({ ...fence(legacy), pipelineRunId })).disposition, "ownership_lost", "active ownership cannot clear correlation");
    assert.equal((await adapter().linkLegacyRun({ ...fence(legacy), ownershipFencingToken: "2", pipelineRunId })).disposition, "ownership_lost", "stale token cannot overwrite correlation");
    await assert.rejects(
      () => adapter().linkLegacyRun({ ...fence(legacy), environmentName: "production", pipelineRunId }),
      /CORRELATION_INPUT_INVALID/,
      "cross-environment legacy linking is rejected",
    );
    await dataSource.query(`UPDATE project_release_lane_ownerships SET status = 'released', released_at = clock_timestamp() WHERE id = $1`, [legacy.id]);
    assert.equal((await adapter().clearLegacyRunAfterRelease({ ...fence(legacy), pipelineRunId })).disposition, "cleared");
    assert.equal((await adapter().clearLegacyRunAfterRelease({ ...fence(legacy), pipelineRunId })).disposition, "already_cleared");

    const v1 = await insertOwner("qa", "v1", 1);
    const intentId = await insertIntent("qa");
    const operation = await insertOperationLease(intentId, "qa");
    assert.equal((await adapter().linkV1IntentOwnership({ ...fence(v1), intentId })).disposition, "linked");
    assert.equal((await adapter().linkV1IntentOwnership({ ...fence(v1), intentId })).disposition, "already_linked");
    const attach = { ...fence(v1), intentId, operationLeaseId: operation.id, operationWorkerId: operation.workerId, operationFencingToken: operation.token };
    assert.equal((await adapter().attachClaimedV1OperationLease(attach)).disposition, "linked");
    assert.equal((await adapter().attachClaimedV1OperationLease(attach)).disposition, "already_linked");
    assert.equal((await adapter().validateBothIndependentFences(attach)).disposition, "already_linked");
    const otherOperation = await insertOperationLease(intentId, "qa", "v1:worker", "12");
    assert.equal((await adapter().attachClaimedV1OperationLease({ ...fence(v1), intentId, operationLeaseId: otherOperation.id, operationWorkerId: otherOperation.workerId, operationFencingToken: otherOperation.token })).disposition, "correlation_conflict");

    const concurrentOwner = await insertOwner("staging", "v1", 1);
    const concurrentIntent = await insertIntent("staging");
    const concurrentOperation = await insertOperationLease(concurrentIntent, "staging");
    assert.equal((await adapter().linkV1IntentOwnership({ ...fence(concurrentOwner), intentId: concurrentIntent })).disposition, "linked");
    const concurrentInput = { ...fence(concurrentOwner), intentId: concurrentIntent, operationLeaseId: concurrentOperation.id, operationWorkerId: concurrentOperation.workerId, operationFencingToken: concurrentOperation.token };
    const concurrent = await Promise.all([adapter().attachClaimedV1OperationLease(concurrentInput), adapter().attachClaimedV1OperationLease(concurrentInput)]);
    assert.deepEqual(concurrent.map((result) => result.disposition).sort(), ["already_linked", "linked"]);

    const rollbackOwner = await insertOwner("prod", "v1", 1);
    const rollbackIntent = await insertIntent("prod");
    assert.equal((await adapter().linkV1IntentOwnership({ ...fence(rollbackOwner), intentId: rollbackIntent })).disposition, "linked");
    assert.equal((await adapter().attachClaimedV1OperationLease({ ...fence(rollbackOwner), intentId: rollbackIntent, operationLeaseId: randomUUID(), operationWorkerId: "v1:worker", operationFencingToken: "99" })).disposition, "operation_lost");
    const [rollbackCheck] = await dataSource.query(`SELECT operation_lease_id FROM project_release_lane_ownerships WHERE id = $1`, [rollbackOwner.id]);
    assert.equal(rollbackCheck.operation_lease_id, null, "failed attachment must roll back without partial link");

    const protectedRollbackRunner = dataSource.createQueryRunner();
    try {
      await assert.rejects(
        () => new AddReleaseLaneOwnershipCorrelation1760000044000().down(protectedRollbackRunner),
        /Refusing to roll back release-lane correlation while correlation history exists/,
        "rollback must preserve correlation evidence",
      );
    } finally {
      await protectedRollbackRunner.release();
    }

    await dataSource.query(`DELETE FROM project_pipeline_runs`);
    await dataSource.query(`DELETE FROM project_rollback_records`);
    await dataSource.query(`DELETE FROM project_release_lane_ownerships`);
    await dataSource.query(`DELETE FROM project_operation_leases`);
    await dataSource.query(`DELETE FROM deployment_intents`);
    const runner = dataSource.createQueryRunner();
    try {
      const correlationMigration = new AddReleaseLaneOwnershipCorrelation1760000044000();
      const ownershipMigration = new CreateReleaseLaneOwnerships1760000043000();
      await correlationMigration.down(runner);
      await ownershipMigration.down(runner);
    } finally {
      await runner.release();
    }
    console.log("Inactive release-lane correlation PostgreSQL verification passed");
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
