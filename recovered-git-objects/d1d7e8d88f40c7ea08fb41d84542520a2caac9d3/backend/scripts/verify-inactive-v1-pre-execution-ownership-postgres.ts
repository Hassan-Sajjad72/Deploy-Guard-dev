import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import { workerEnvelopePayloadForHash } from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { CreateWorkerCapabilityRegistry1760000037000 } from "../src/migrations/1760000037000-CreateWorkerCapabilityRegistry";
import { InactiveV1PreExecutionOwnershipService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-pre-execution-ownership.service";
import { InactiveV1WorkerRuntimeService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.service";
import {
  ExecutableV1MessageType,
  V1WorkerCapabilityIdentity,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types";
import { PreExecutionOwnershipError } from "../src/orchestration-contracts/worker-runtime/v1-pre-execution-ownership.types";
import { V1WorkerCapabilityService } from "../src/orchestration-contracts/worker-runtime/v1-worker-capability.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session6_2_ownership_test_${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) {
  throw new Error("Unsafe test schema identifier.");
}

const baseOptions = AppDataSource.options as DataSourceOptions & {
  extra?: Record<string, unknown>;
};
const admin = new DataSource({
  ...baseOptions,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
} as DataSourceOptions);
const dataSource = new DataSource({
  ...baseOptions,
  schema,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
  extra: {
    ...(baseOptions.extra || {}),
    options: `-c search_path=${schema},public`,
  },
} as DataSourceOptions);

const routes: Record<
  ExecutableV1MessageType,
  {
    role: "release" | "infrastructure" | "deletion";
    lane: DeployGuardWorkerEnvelopeV1["routing"]["lane"];
    operation: DeployGuardWorkerEnvelopeV1["routing"]["operation"];
    queue: string;
    classification: "release_only" | "infrastructure_change" | "deletion";
  }
> = {
  "intent.release.execute": {
    role: "release",
    lane: "release",
    operation: "execute",
    queue: "deployguard-release-v1",
    classification: "release_only",
  },
  "intent.infrastructure.plan": {
    role: "infrastructure",
    lane: "infrastructure",
    operation: "plan",
    queue: "deployguard-infrastructure-v1",
    classification: "infrastructure_change",
  },
  "intent.infrastructure.apply": {
    role: "infrastructure",
    lane: "infrastructure",
    operation: "apply",
    queue: "deployguard-infrastructure-v1",
    classification: "infrastructure_change",
  },
  "intent.deletion.execute": {
    role: "deletion",
    lane: "deletion",
    operation: "destroy",
    queue: "deployguard-deletion-v1",
    classification: "deletion",
  },
};

const workers: Record<string, V1WorkerCapabilityIdentity> = {
  releaseA: {
    workerId: `release-a:${suffix}`,
    role: "release",
    supportedMessageTypes: ["intent.release.execute"],
    serviceVersion: "session6.2-test",
    gitSha: "test",
    heartbeatTtlMs: 120_000,
  },
  releaseB: {
    workerId: `release-b:${suffix}`,
    role: "release",
    supportedMessageTypes: ["intent.release.execute"],
    serviceVersion: "session6.2-test",
    gitSha: "test",
    heartbeatTtlMs: 120_000,
  },
  infrastructureA: {
    workerId: `infrastructure-a:${suffix}`,
    role: "infrastructure",
    supportedMessageTypes: [
      "intent.infrastructure.plan",
      "intent.infrastructure.apply",
    ],
    serviceVersion: "session6.2-test",
    gitSha: "test",
    heartbeatTtlMs: 120_000,
  },
  deletionA: {
    workerId: `deletion-a:${suffix}`,
    role: "deletion",
    supportedMessageTypes: ["intent.deletion.execute"],
    serviceVersion: "session6.2-test",
    gitSha: "test",
    heartbeatTtlMs: 120_000,
  },
};

async function createSchema() {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  await dataSource.query(`
    CREATE TABLE projects (
      id uuid PRIMARY KEY,
      deletion_fence_token bigint,
      deletion_intent_id uuid,
      deletion_started_at timestamptz
    )
  `);
  await dataSource.query(`
    CREATE TABLE infrastructure_manifests (
      id uuid PRIMARY KEY,
      status varchar(32) NOT NULL
    )
  `);
  await dataSource.query(`
    CREATE TABLE release_manifests (
      id uuid PRIMARY KEY,
      status varchar(32) NOT NULL
    )
  `);
  await dataSource.query(`
    CREATE TABLE deployment_intents (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id),
      environment_name varchar(64) NOT NULL,
      classification varchar(32),
      status varchar(32) NOT NULL,
      canonical_idempotency_key char(64) NOT NULL,
      infrastructure_manifest_id uuid,
      release_manifest_id uuid,
      pipeline_run_id uuid,
      destroy_operation_id uuid,
      failure_code varchar(128),
      failure_message text,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
  await dataSource.query(`
    CREATE TABLE project_operation_leases (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id),
      environment_name varchar(64) NOT NULL,
      lane varchar(24) NOT NULL,
      scope varchar(32) NOT NULL,
      intent_id uuid NOT NULL REFERENCES deployment_intents(id),
      pipeline_run_id uuid,
      destroy_operation_id uuid,
      owner_worker_id varchar NOT NULL,
      fencing_token bigint NOT NULL,
      status varchar(24) NOT NULL,
      acquired_at timestamptz NOT NULL,
      heartbeat_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      released_at timestamptz,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    )
  `);
  await dataSource.query(`
    CREATE UNIQUE INDEX "UQ_project_operation_lease_active_scope"
    ON project_operation_leases (
      project_id, environment_name, lane, scope
    )
    WHERE status IN ('acquired','heartbeat_active')
  `);
  await dataSource.query(`
    CREATE UNIQUE INDEX "UQ_project_operation_lease_fencing_token"
    ON project_operation_leases (
      project_id, environment_name, fencing_token
    )
  `);
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await new CreateWorkerCapabilityRegistry1760000037000().up(runner);
  } finally {
    await runner.release();
  }
}

function buildEnvelope(input: {
  messageType: ExecutableV1MessageType;
  intentId: string;
  projectId: string;
  infrastructureManifestId: string | null;
  releaseManifestId: string | null;
}) {
  const route = routes[input.messageType];
  const canonicalKey = createHash("sha256")
    .update(`intent:${input.intentId}`)
    .digest("hex");
  const envelope = {
    protocol: {
      name: "deployguard.worker",
      schemaVersion: 1,
      messageType: input.messageType,
      minimumWorkerProtocol: 1,
      maximumWorkerProtocol: 1,
    },
    producer: {
      service: "deployguard-outbox-dispatcher",
      serviceVersion: "session6.2-test",
      gitSha: "test",
      producedAt: new Date().toISOString(),
    },
    identity: {
      intentId: input.intentId,
      projectId: input.projectId,
      environmentName: "production",
      pipelineRunId: null,
      destroyOperationId: null,
      infrastructureManifestId: input.infrastructureManifestId,
      releaseManifestId: input.releaseManifestId,
    },
    routing: {
      lane: route.lane,
      operation: route.operation,
      queue: route.queue,
    },
    idempotency: {
      canonicalKey,
      payloadSha256: "0".repeat(64),
      attempt: 1,
      replayOfJobId: null,
    },
    execution: {
      mode: "full",
      resumeFromStage: null,
      reusableCheckpointIds: [],
      invalidatedCheckpointIds: [],
      reasonCodes: ["SESSION_6_2_TEST"],
      fencingTokenRequired: true,
    },
    trace: {
      correlationId: input.intentId,
      causationId: null,
      actorUserId: 1,
    },
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  } as DeployGuardWorkerEnvelopeV1;
  envelope.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(envelope),
  );
  return envelope;
}

async function seedIntent(
  messageType: ExecutableV1MessageType,
  options: {
    projectId?: string;
    status?: string;
    createdAt?: Date;
    setDeletionFence?: boolean;
  } = {},
) {
  const projectId = options.projectId || randomUUID();
  const intentId = randomUUID();
  if (!options.projectId) {
    await dataSource.query(
      `INSERT INTO projects (id) VALUES ($1)`,
      [projectId],
    );
  }
  const infrastructureManifestId =
    messageType === "intent.deletion.execute" ? null : randomUUID();
  const releaseManifestId =
    messageType === "intent.release.execute" ? randomUUID() : null;
  if (infrastructureManifestId) {
    await dataSource.query(
      `INSERT INTO infrastructure_manifests (id, status)
       VALUES ($1, 'desired')`,
      [infrastructureManifestId],
    );
  }
  if (releaseManifestId) {
    await dataSource.query(
      `INSERT INTO release_manifests (id, status)
       VALUES ($1, 'desired')`,
      [releaseManifestId],
    );
  }
  const envelope = buildEnvelope({
    messageType,
    intentId,
    projectId,
    infrastructureManifestId,
    releaseManifestId,
  });
  await dataSource.query(
    `INSERT INTO deployment_intents (
       id, project_id, environment_name, classification, status,
       canonical_idempotency_key, infrastructure_manifest_id,
       release_manifest_id, pipeline_run_id, destroy_operation_id,
       created_at
     ) VALUES (
       $1, $2, 'production', $3, $4, $5, $6, $7, NULL, NULL, $8
     )`,
    [
      intentId,
      projectId,
      routes[messageType].classification,
      options.status || "enqueued",
      envelope.idempotency.canonicalKey,
      infrastructureManifestId,
      releaseManifestId,
      options.createdAt || new Date(),
    ],
  );
  if (options.setDeletionFence) {
    await dataSource.query(
      `UPDATE projects
       SET deletion_fence_token = 1,
           deletion_intent_id = $2,
           deletion_started_at = clock_timestamp()
       WHERE id = $1`,
      [projectId, intentId],
    );
  }
  return { envelope, projectId, intentId };
}

function claimInput(
  worker: V1WorkerCapabilityIdentity,
  envelope: DeployGuardWorkerEnvelopeV1,
  leaseTtlMs = 60_000,
) {
  return {
    workerId: worker.workerId,
    queueName: envelope.routing.queue,
    envelope,
    leaseTtlMs,
  };
}

async function intentStatus(intentId: string) {
  const [row] = await dataSource.query(
    `SELECT status, started_at AS "startedAt",
            completed_at AS "completedAt", failure_code AS "failureCode"
     FROM deployment_intents WHERE id = $1`,
    [intentId],
  );
  return row;
}

async function leaseRows(intentId: string) {
  return dataSource.query(
    `SELECT id, owner_worker_id AS "ownerWorkerId",
            fencing_token AS "fencingToken", status
     FROM project_operation_leases
     WHERE intent_id = $1 ORDER BY fencing_token`,
    [intentId],
  );
}

async function expectOwnershipError(
  action: () => Promise<unknown>,
  code: PreExecutionOwnershipError["code"],
) {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof PreExecutionOwnershipError && error.code === code,
  );
}

async function run() {
  await admin.initialize();
  try {
    await createSchema();
    const capabilities = new V1WorkerCapabilityService(dataSource);
    const runtime = new InactiveV1WorkerRuntimeService(
      dataSource,
      capabilities,
    );
    const ownership = new InactiveV1PreExecutionOwnershipService(
      dataSource,
      runtime,
    );
    for (const worker of Object.values(workers)) {
      await capabilities.register(worker);
    }

    const basic = await seedIntent("intent.release.execute");
    const first = await ownership.claim(
      claimInput(workers.releaseA, basic.envelope),
    );
    assert.equal(first.disposition, "claimed");
    assert.equal((await intentStatus(basic.intentId)).status, "running");
    assert.equal((await leaseRows(basic.intentId)).length, 1);
    if (first.disposition !== "claimed") throw new Error("Claim expected.");

    const duplicateSameWorker = await ownership.claim(
      claimInput(workers.releaseA, basic.envelope),
    );
    assert.equal(duplicateSameWorker.disposition, "already_owned");
    if (duplicateSameWorker.disposition !== "already_owned") {
      throw new Error("Existing ownership expected.");
    }
    assert.equal(
      duplicateSameWorker.lease.fencingToken,
      first.lease.fencingToken,
    );
    assert.equal((await leaseRows(basic.intentId)).length, 1);

    const duplicateOtherWorker = await ownership.claim(
      claimInput(workers.releaseB, basic.envelope),
    );
    assert.deepEqual(
      {
        disposition: duplicateOtherWorker.disposition,
        reason: duplicateOtherWorker.disposition === "idempotent_no_op"
          ? duplicateOtherWorker.reason
          : null,
      },
      {
        disposition: "idempotent_no_op",
        reason: "duplicate_delivery_owned_elsewhere",
      },
    );
    assert.equal((await leaseRows(basic.intentId)).length, 1);

    const secondLogicalAttempt = {
      ...basic.envelope,
      idempotency: {
        ...basic.envelope.idempotency,
        attempt: 2,
        replayOfJobId: `dg:v1:release:${basic.intentId}:execute:1`,
        payloadSha256: "0".repeat(64),
      },
    };
    secondLogicalAttempt.idempotency.payloadSha256 = canonicalSha256(
      workerEnvelopePayloadForHash(secondLogicalAttempt),
    );
    await expectOwnershipError(
      () => ownership.claim(
        claimInput(workers.releaseB, secondLogicalAttempt),
      ),
      "OPERATION_CONFLICT",
    );
    assert.equal((await leaseRows(basic.intentId)).length, 1);

    const concurrent = await seedIntent("intent.release.execute");
    const concurrentResults = await Promise.all([
      ownership.claim(claimInput(workers.releaseA, concurrent.envelope)),
      ownership.claim(claimInput(workers.releaseB, concurrent.envelope)),
    ]);
    assert.equal(
      concurrentResults.filter((result) => result.disposition === "claimed")
        .length,
      1,
    );
    assert.equal(
      concurrentResults.filter((result) =>
        result.disposition === "idempotent_no_op"
        && result.reason === "duplicate_delivery_owned_elsewhere"
      ).length,
      1,
    );
    assert.equal((await leaseRows(concurrent.intentId)).length, 1);
    assert.equal((await intentStatus(concurrent.intentId)).status, "running");

    const reclaim = await seedIntent("intent.release.execute");
    const oldClaim = await ownership.claim(
      claimInput(workers.releaseA, reclaim.envelope, 1_000),
    );
    if (oldClaim.disposition !== "claimed") throw new Error("Claim expected.");
    await dataSource.query(
      `UPDATE project_operation_leases
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [oldClaim.lease.leaseId],
    );
    const newClaim = await ownership.claim(
      claimInput(workers.releaseB, reclaim.envelope),
    );
    assert.equal(newClaim.disposition, "claimed");
    if (newClaim.disposition !== "claimed") throw new Error("Reclaim expected.");
    assert.ok(
      BigInt(newClaim.lease.fencingToken)
        > BigInt(oldClaim.lease.fencingToken),
    );
    const reclaimedRows = await leaseRows(reclaim.intentId);
    assert.deepEqual(
      reclaimedRows.map((row: { status: string }) => row.status),
      ["expired", "acquired"],
    );
    assert.equal(await ownership.renew({
      leaseId: oldClaim.lease.leaseId,
      workerId: workers.releaseA.workerId,
      fencingToken: oldClaim.lease.fencingToken,
    }), null);
    assert.equal(await ownership.complete({
      leaseId: oldClaim.lease.leaseId,
      workerId: workers.releaseA.workerId,
      fencingToken: oldClaim.lease.fencingToken,
    }), false);
    assert.equal(await ownership.fail({
      leaseId: oldClaim.lease.leaseId,
      workerId: workers.releaseA.workerId,
      fencingToken: oldClaim.lease.fencingToken,
      safeFailureCode: "STALE_OWNER",
    }), false);
    assert.equal(await ownership.release({
      leaseId: oldClaim.lease.leaseId,
      workerId: workers.releaseA.workerId,
      fencingToken: oldClaim.lease.fencingToken,
    }), false);
    const renewed = await ownership.renew({
      leaseId: newClaim.lease.leaseId,
      workerId: workers.releaseB.workerId,
      fencingToken: newClaim.lease.fencingToken,
    });
    assert.ok(renewed);
    assert.equal(renewed.status, "heartbeat_active");
    assert.equal(await ownership.complete({
      leaseId: newClaim.lease.leaseId,
      workerId: workers.releaseB.workerId,
      fencingToken: newClaim.lease.fencingToken,
    }), true);
    assert.equal((await intentStatus(reclaim.intentId)).status, "completed");

    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "no_op",
      "rejected",
    ]) {
      const terminal = await seedIntent("intent.release.execute", { status });
      const result = await ownership.claim(
        claimInput(workers.releaseA, terminal.envelope),
      );
      assert.equal(result.disposition, "idempotent_no_op");
      if (result.disposition === "idempotent_no_op") {
        assert.equal(result.reason, "intent_terminal");
      }
      assert.equal((await leaseRows(terminal.intentId)).length, 0);
    }

    const superseded = await seedIntent("intent.release.execute", {
      createdAt: new Date(Date.now() - 10_000),
    });
    await dataSource.query(
      `INSERT INTO deployment_intents (
         id, project_id, environment_name, classification, status,
         canonical_idempotency_key, created_at
       ) VALUES (
         $1, $2, 'production', 'release_only', 'completed', $3,
         clock_timestamp()
       )`,
      [randomUUID(), superseded.projectId, "f".repeat(64)],
    );
    const supersededResult = await ownership.claim(
      claimInput(workers.releaseA, superseded.envelope),
    );
    assert.equal(supersededResult.disposition, "idempotent_no_op");
    if (supersededResult.disposition === "idempotent_no_op") {
      assert.equal(supersededResult.reason, "intent_superseded");
    }
    assert.equal((await leaseRows(superseded.intentId)).length, 0);

    const released = await seedIntent("intent.release.execute");
    const releaseClaim = await ownership.claim(
      claimInput(workers.releaseA, released.envelope),
    );
    if (releaseClaim.disposition !== "claimed") throw new Error("Claim expected.");
    assert.equal(await ownership.release({
      leaseId: releaseClaim.lease.leaseId,
      workerId: workers.releaseA.workerId,
      fencingToken: releaseClaim.lease.fencingToken,
    }), true);
    assert.equal((await intentStatus(released.intentId)).status, "enqueued");
    assert.equal((await leaseRows(released.intentId))[0].status, "released");

    const failed = await seedIntent("intent.release.execute");
    const failureClaim = await ownership.claim(
      claimInput(workers.releaseA, failed.envelope),
    );
    if (failureClaim.disposition !== "claimed") throw new Error("Claim expected.");
    await assert.rejects(
      ownership.fail({
        leaseId: failureClaim.lease.leaseId,
        workerId: workers.releaseA.workerId,
        fencingToken: failureClaim.lease.fencingToken,
        safeFailureCode: "raw error with details",
      }),
      /OWNERSHIP_TRANSITION_CONFLICT/,
    );
    assert.equal((await intentStatus(failed.intentId)).status, "running");
    assert.equal(await ownership.fail({
      leaseId: failureClaim.lease.leaseId,
      workerId: workers.releaseA.workerId,
      fencingToken: failureClaim.lease.fencingToken,
      safeFailureCode: "PLACEHOLDER_FAILURE",
    }), true);
    const failedIntent = await intentStatus(failed.intentId);
    assert.equal(failedIntent.status, "failed");
    assert.equal(failedIntent.failureCode, "PLACEHOLDER_FAILURE");

    const rollback = await seedIntent("intent.release.execute");
    await dataSource.query(`
      CREATE FUNCTION reject_session6_2_running_transition()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${rollback.intentId}'::uuid
          AND NEW.status = 'running' THEN
          RAISE EXCEPTION 'simulated intent transition failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await dataSource.query(`
      CREATE TRIGGER reject_session6_2_running_transition
      BEFORE UPDATE ON deployment_intents
      FOR EACH ROW EXECUTE FUNCTION reject_session6_2_running_transition()
    `);
    await assert.rejects(
      ownership.claim(claimInput(workers.releaseA, rollback.envelope)),
      /simulated intent transition failure/,
    );
    assert.equal((await intentStatus(rollback.intentId)).status, "enqueued");
    assert.equal((await leaseRows(rollback.intentId)).length, 0);
    await dataSource.query(
      `DROP TRIGGER reject_session6_2_running_transition
       ON deployment_intents`,
    );
    await dataSource.query(
      `DROP FUNCTION reject_session6_2_running_transition()`,
    );

    const terminalRollback = await seedIntent("intent.release.execute");
    const terminalRollbackClaim = await ownership.claim(
      claimInput(workers.releaseA, terminalRollback.envelope),
    );
    if (terminalRollbackClaim.disposition !== "claimed") {
      throw new Error("Claim expected.");
    }
    await dataSource.query(`
      CREATE FUNCTION reject_session6_2_completed_transition()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = '${terminalRollback.intentId}'::uuid
          AND NEW.status = 'completed' THEN
          RAISE EXCEPTION 'simulated completion transition failure';
        END IF;
        RETURN NEW;
      END
      $$
    `);
    await dataSource.query(`
      CREATE TRIGGER reject_session6_2_completed_transition
      BEFORE UPDATE ON deployment_intents
      FOR EACH ROW EXECUTE FUNCTION reject_session6_2_completed_transition()
    `);
    await assert.rejects(
      ownership.complete({
        leaseId: terminalRollbackClaim.lease.leaseId,
        workerId: workers.releaseA.workerId,
        fencingToken: terminalRollbackClaim.lease.fencingToken,
      }),
      /simulated completion transition failure/,
    );
    assert.equal(
      (await leaseRows(terminalRollback.intentId))[0].status,
      "acquired",
    );
    assert.equal(
      (await intentStatus(terminalRollback.intentId)).status,
      "running",
    );

    const sharedProjectId = randomUUID();
    await dataSource.query(`INSERT INTO projects (id) VALUES ($1)`, [
      sharedProjectId,
    ]);
    const releaseLane = await seedIntent("intent.release.execute", {
      projectId: sharedProjectId,
      createdAt: new Date(Date.now() - 20_000),
    });
    const planLane = await seedIntent("intent.infrastructure.plan", {
      projectId: sharedProjectId,
      createdAt: new Date(Date.now() - 10_000),
    });
    const releaseLaneClaim = await ownership.claim(
      claimInput(workers.releaseA, releaseLane.envelope),
    );
    const planLaneClaim = await ownership.claim(
      claimInput(workers.infrastructureA, planLane.envelope),
    );
    assert.equal(releaseLaneClaim.disposition, "claimed");
    assert.equal(planLaneClaim.disposition, "claimed");
    if (
      releaseLaneClaim.disposition !== "claimed"
      || planLaneClaim.disposition !== "claimed"
    ) {
      throw new Error("Concurrent lane claims expected.");
    }
    assert.ok(
      BigInt(planLaneClaim.lease.fencingToken)
        > BigInt(releaseLaneClaim.lease.fencingToken),
    );
    const applyLane = await seedIntent("intent.infrastructure.apply", {
      projectId: sharedProjectId,
    });
    await expectOwnershipError(
      () => ownership.claim(
        claimInput(workers.infrastructureA, applyLane.envelope),
      ),
      "OPERATION_CONFLICT",
    );
    assert.equal((await leaseRows(applyLane.intentId)).length, 0);
    assert.equal((await intentStatus(applyLane.intentId)).status, "enqueued");

    const planned = await seedIntent("intent.release.execute", {
      status: "planned",
    });
    await expectOwnershipError(
      () => ownership.claim(claimInput(workers.releaseA, planned.envelope)),
      "INTENT_NOT_ENQUEUED",
    );
    assert.equal((await leaseRows(planned.intentId)).length, 0);

    const unfenced = await seedIntent("intent.release.execute");
    const unfencedEnvelope = {
      ...unfenced.envelope,
      execution: {
        ...unfenced.envelope.execution,
        fencingTokenRequired: false,
      },
      idempotency: {
        ...unfenced.envelope.idempotency,
        payloadSha256: "0".repeat(64),
      },
    };
    unfencedEnvelope.idempotency.payloadSha256 = canonicalSha256(
      workerEnvelopePayloadForHash(unfencedEnvelope),
    );
    await expectOwnershipError(
      () => ownership.claim(
        claimInput(workers.releaseA, unfencedEnvelope),
      ),
      "FENCING_REQUIRED",
    );
    assert.equal((await leaseRows(unfenced.intentId)).length, 0);

    console.log(
      "Inactive v1 pre-execution ownership PostgreSQL concurrency verification passed",
    );
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
    if (admin.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
