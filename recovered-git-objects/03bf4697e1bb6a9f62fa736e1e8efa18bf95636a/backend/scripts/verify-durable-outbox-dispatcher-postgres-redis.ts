import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { createRedisConnection } from "../src/projects/pipeline/redis.config";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import {
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { DeploymentIntent } from "../src/orchestration-contracts/entities/deployment-intent.entity";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { OrchestrationOutbox } from "../src/orchestration-contracts/entities/orchestration-outbox.entity";
import { ProjectOperationLease } from "../src/orchestration-contracts/entities/project-operation-lease.entity";
import { ProjectStateRevision } from "../src/orchestration-contracts/entities/project-state-revision.entity";
import { ReleaseManifest } from "../src/orchestration-contracts/entities/release-manifest.entity";
import { WorkerCapability } from "../src/orchestration-contracts/entities/worker-capability.entity";
import { CreateTwoLaneManifestsAndStateRevisions1760000034000 } from "../src/migrations/1760000034000-CreateTwoLaneManifestsAndStateRevisions";
import { CreateDeploymentIntentsOutboxAndOperationLeases1760000035000 } from "../src/migrations/1760000035000-CreateDeploymentIntentsOutboxAndOperationLeases";
import { CreateWorkerCapabilityRegistry1760000037000 } from "../src/migrations/1760000037000-CreateWorkerCapabilityRegistry";
import { AddOutboxDeliveryFencing1760000038000 } from "../src/migrations/1760000038000-AddOutboxDeliveryFencing";
import { BullMqOutboxPublisher } from "../src/orchestration-contracts/outbox/bullmq-outbox.publisher";
import { DurableOutboxDispatcherService } from "../src/orchestration-contracts/outbox/durable-outbox-dispatcher.service";
import { TerminalOutboxPolicyService } from "../src/orchestration-contracts/outbox/terminal-outbox-policy.service";
import {
  FrozenProtocolQueue,
  VERIFIED_BULLMQ_VERSION,
} from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import { OutboxJobPublisher } from "../src/orchestration-contracts/outbox/outbox-dispatcher.types";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session5_outbox_test_${suffix}`;
const redisPrefix = `session5-${suffix}`;
if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe test schema identifier.");

const projectId = "99999999-9999-4999-8999-999999999999";
const intentIds = [
  "11111111-1111-4111-8111-111111111111",
  "12222222-2222-4222-8222-222222222222",
  "13333333-3333-4333-8333-333333333333",
  "14444444-4444-4444-8444-444444444444",
  "16666666-6666-4666-8666-666666666666",
  "17777777-7777-4777-8777-777777777777",
  "18888888-8888-4888-8888-888888888888",
  "19999999-9999-4999-8999-999999999999",
];
const queueName = "deployguard-release-v1";
const entities = [
  InfrastructureManifest,
  ReleaseManifest,
  DeploymentIntent,
  OrchestrationOutbox,
  ProjectOperationLease,
  ProjectStateRevision,
  WorkerCapability,
];

const admin = new DataSource({
  ...AppDataSource.options,
  entities: [],
  migrations: [],
  synchronize: false,
  logging: false,
} as DataSourceOptions);
const baseOptions = AppDataSource.options as DataSourceOptions & { extra?: Record<string, unknown> };
const dataSource = new DataSource({
  ...baseOptions,
  schema,
  entities,
  migrations: [],
  synchronize: false,
  logging: false,
  extra: {
    ...(baseOptions.extra || {}),
    options: `-c search_path=${schema},public`,
  },
} as DataSourceOptions);

const migrations = [
  new CreateTwoLaneManifestsAndStateRevisions1760000034000(),
  new CreateDeploymentIntentsOutboxAndOperationLeases1760000035000(),
  new CreateWorkerCapabilityRegistry1760000037000(),
  new AddOutboxDeliveryFencing1760000038000(),
];

class FailingPublisher implements OutboxJobPublisher {
  async publish(): Promise<{ jobId: string }> {
    throw new Error("simulated Redis transport failure containing no credentials");
  }
}

function config(dispatcherId: string) {
  return new ConfigService({
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: "6379",
    REDIS_TLS: "false",
    OUTBOX_BULLMQ_PREFIX: redisPrefix,
    OUTBOX_DISPATCHER_ID: dispatcherId,
    OUTBOX_DELIVERY_LEASE_MS: "30000",
    OUTBOX_CAPABILITY_RETRY_MS: "5",
    OUTBOX_RETRY_BASE_MS: "5",
    OUTBOX_RETRY_MAX_MS: "25",
  });
}

function buildEnvelope(intentId: string) {
  const envelope = {
    protocol: {
      name: "deployguard.worker",
      schemaVersion: 1,
      messageType: "intent.release.execute",
      minimumWorkerProtocol: 1,
      maximumWorkerProtocol: 1,
    },
    producer: {
      service: "deployguard-api",
      serviceVersion: "session5-test",
      gitSha: "test",
      producedAt: new Date().toISOString(),
    },
    identity: {
      intentId,
      projectId,
      environmentName: "production",
      pipelineRunId: null,
      destroyOperationId: null,
      infrastructureManifestId: null,
      releaseManifestId: null,
    },
    routing: {
      lane: "release",
      operation: "execute",
      queue: queueName,
    },
    idempotency: {
      canonicalKey: createHash("sha256").update(`key:${intentId}`).digest("hex"),
      payloadSha256: "0".repeat(64),
      attempt: 1,
      replayOfJobId: null,
    },
    execution: {
      mode: "full",
      resumeFromStage: null,
      reusableCheckpointIds: [],
      invalidatedCheckpointIds: [],
      reasonCodes: ["SESSION_5_TEST"],
      fencingTokenRequired: true,
    },
    trace: {
      correlationId: intentId,
      causationId: null,
      actorUserId: 1,
    },
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  } as DeployGuardWorkerEnvelopeV1;
  envelope.idempotency.payloadSha256 = canonicalSha256(workerEnvelopePayloadForHash(envelope));
  return envelope;
}

async function createLegacyShape() {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query(`CREATE TABLE users (id integer PRIMARY KEY)`);
    await runner.query(`
      CREATE TABLE projects (
        id uuid PRIMARY KEY,
        deletion_fence_token bigint,
        deletion_intent_id uuid,
        deletion_started_at timestamptz
      )
    `);
    await runner.query(`CREATE TABLE project_pipeline_runs (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_deployment_contracts (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_configuration_snapshots (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_deployments (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_stable_releases (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE project_infrastructure_environments (id uuid PRIMARY KEY)`);
    await runner.query(`CREATE TABLE infrastructure_destroy_operations (id uuid PRIMARY KEY)`);
    for (const migration of migrations) await migration.up(runner);
    await new AddOutboxDeliveryFencing1760000038000().up(runner);
    await new AddOutboxDeliveryFencing1760000038000().down(runner);
    await new AddOutboxDeliveryFencing1760000038000().up(runner);
  } finally {
    await runner.release();
  }
}

async function seedIntentOutbox(intentId: string) {
  const envelope = buildEnvelope(intentId);
  const canonicalKey = createHash("sha256").update(`canonical:${intentId}`).digest("hex");
  const requestFingerprint = createHash("sha256").update(`request:${intentId}`).digest("hex");
  await dataSource.query(
    `INSERT INTO deployment_intents (
       id, project_id, environment_name, requested_by_user_id, kind,
       classification, status, client_idempotency_key, canonical_idempotency_key,
       request_fingerprint, request_payload, decision
     ) VALUES (
       $1, $2, 'production', 1, 'deploy', 'release_only', 'planned',
       $5, $3, $4, '{}'::jsonb, '{}'::jsonb
     )`,
    [intentId, projectId, canonicalKey, requestFingerprint, `session5:${intentId}`],
  );
  const [row] = await dataSource.query(
    `INSERT INTO orchestration_outbox (
       intent_id, aggregate_type, aggregate_id, event_type, worker_envelope,
       payload_sha256, status, attempt_count, available_at
     ) VALUES (
       $1, 'deployment_intent', $1, $2, $3::jsonb, $4,
       'pending', 0, clock_timestamp()
     )
     RETURNING id`,
    [
      intentId,
      envelope.protocol.messageType,
      JSON.stringify(envelope),
      envelope.idempotency.payloadSha256,
    ],
  );
  return { outboxId: row.id as string, envelope, jobId: workerEnvelopeJobId(envelope) };
}

async function outbox(outboxId: string) {
  const [row] = await dataSource.query(
    `SELECT status, attempt_count AS "attemptCount", claimed_by AS "claimedBy",
            claim_expires_at AS "claimExpiresAt",
            claim_fencing_token AS "claimFencingToken",
            published_job_id AS "publishedJobId", last_error AS "lastError"
     FROM orchestration_outbox WHERE id = $1`,
    [outboxId],
  );
  return row;
}

async function allQueueJobIds(queue: Queue) {
  const jobs = await queue.getJobs([
    "wait",
    "waiting-children",
    "active",
    "delayed",
    "completed",
    "failed",
    "paused",
  ] as never);
  return jobs.map((job) => job.id).filter(Boolean).sort();
}

async function main() {
  let publisher: BullMqOutboxPublisher | null = null;
  let inspectionQueue: Queue | null = null;
  let adapterQueue: FrozenProtocolQueue | null = null;
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  try {
    await dataSource.initialize();
    await createLegacyShape();
    await dataSource.query(`INSERT INTO users (id) VALUES (1)`);
    await dataSource.query(`INSERT INTO projects (id) VALUES ($1)`, [projectId]);

    const configA = config("dispatcher-a");
    const configB = config("dispatcher-b");
    publisher = new BullMqOutboxPublisher(configA);
    inspectionQueue = new Queue(queueName, {
      connection: createRedisConnection(configA),
      prefix: redisPrefix,
    });
    await inspectionQueue.waitUntilReady();
    await inspectionQueue.obliterate({ force: true });
    adapterQueue = new FrozenProtocolQueue("session5-frozen-adapter-v1", {
      connection: createRedisConnection(configA),
      prefix: redisPrefix,
    });
    await adapterQueue.waitUntilReady();
    await adapterQueue.obliterate({ force: true });
    assert.equal(VERIFIED_BULLMQ_VERSION, "5.79.2");
    const adapterEnvelope = buildEnvelope("15555555-5555-4555-8555-555555555555");
    const adapterJobId = workerEnvelopeJobId(adapterEnvelope);
    const adapterJob = await adapterQueue.add(
      adapterEnvelope.protocol.messageType,
      adapterEnvelope,
      { jobId: adapterJobId },
    );
    assert.equal(adapterJob.id, adapterJobId);
    await assert.rejects(
      adapterQueue.add(
        adapterEnvelope.protocol.messageType,
        adapterEnvelope,
        { jobId: "dg:v1:release:not-a-uuid:execute:1" },
      ),
      /requires a valid deterministic v1 job ID/,
    );
    await assert.rejects(
      adapterQueue.add(adapterEnvelope.protocol.messageType, adapterEnvelope),
      /requires a valid deterministic v1 job ID/,
    );

    const dispatcherA = new DurableOutboxDispatcherService(dataSource, publisher, configA);
    const dispatcherB = new DurableOutboxDispatcherService(dataSource, publisher, configB);
    const terminalOutbox = new TerminalOutboxPolicyService();
    const first = await seedIntentOutbox(intentIds[0]);

    await dataSource.query(
      `INSERT INTO worker_capabilities (
         worker_id, role, minimum_protocol, maximum_protocol,
         supported_message_types, service_version, git_sha, expires_at
       ) VALUES (
         'release-worker', 'release', 1, 1,
         '["intent.release.execute"]'::jsonb, 'test', 'test',
         clock_timestamp() - interval '1 minute'
       )`,
    );
    const stale = await dispatcherA.dispatchOne();
    assert.equal(stale.status, "blocked");
    assert.deepEqual(await outbox(first.outboxId), {
      status: "pending",
      attemptCount: 0,
      claimedBy: null,
      claimExpiresAt: null,
      claimFencingToken: "0",
      publishedJobId: null,
      lastError: "WORKER_PROTOCOL_UNAVAILABLE",
    });
    assert.deepEqual(await allQueueJobIds(inspectionQueue), []);

    await dataSource.query(
      `UPDATE worker_capabilities
       SET minimum_protocol = 2, maximum_protocol = 2,
           expires_at = clock_timestamp() + interval '5 minutes'
       WHERE worker_id = 'release-worker'`,
    );
    await dataSource.query(
      `UPDATE orchestration_outbox SET available_at = clock_timestamp() WHERE id = $1`,
      [first.outboxId],
    );
    const incompatible = await dispatcherA.dispatchOne();
    assert.equal(incompatible.status, "blocked");
    assert.deepEqual(await allQueueJobIds(inspectionQueue), []);

    await dataSource.query(
      `UPDATE worker_capabilities
       SET role = 'infrastructure', minimum_protocol = 1, maximum_protocol = 1
       WHERE worker_id = 'release-worker'`,
    );
    await dataSource.query(
      `UPDATE orchestration_outbox SET available_at = clock_timestamp() WHERE id = $1`,
      [first.outboxId],
    );
    const wrongRole = await dispatcherA.dispatchOne();
    assert.equal(wrongRole.status, "blocked");
    assert.deepEqual(await allQueueJobIds(inspectionQueue), []);

    await dataSource.query(
      `UPDATE worker_capabilities
       SET role = 'release',
           supported_message_types = '["intent.infrastructure.plan"]'::jsonb
       WHERE worker_id = 'release-worker'`,
    );
    await dataSource.query(
      `UPDATE orchestration_outbox SET available_at = clock_timestamp() WHERE id = $1`,
      [first.outboxId],
    );
    const wrongMessage = await dispatcherA.dispatchOne();
    assert.equal(wrongMessage.status, "blocked");
    assert.deepEqual(await allQueueJobIds(inspectionQueue), []);

    await dataSource.query(
      `UPDATE worker_capabilities
       SET supported_message_types = '["intent.release.execute"]'::jsonb
       WHERE worker_id = 'release-worker'`,
    );

    // An authenticated normal-workflow bridge must target only its exact
    // prepared outbox, never the dispatcher-wide pending scan. Concurrent
    // activation still produces one durable frozen job.
    const exact = await seedIntentOutbox(intentIds[6]);
    const exactTarget = {
      outboxId: exact.outboxId,
      intentId: intentIds[6],
      projectId,
      environmentName: "production",
    };
    const exactConcurrent = await Promise.all([
      dispatcherA.dispatchExact(exactTarget),
      dispatcherB.dispatchExact(exactTarget),
    ]);
    assert.equal(
      exactConcurrent.filter((result) => result.status === "published").length,
      1,
    );
    assert.equal(
      exactConcurrent.filter((result) => result.status === "idle").length,
      1,
    );
    assert.deepEqual(await allQueueJobIds(inspectionQueue), [exact.jobId]);
    const exactRow = await outbox(exact.outboxId);
    assert.equal(exactRow.status, "published");
    assert.equal(exactRow.publishedJobId, exact.jobId);
    const [exactIntent] = await dataSource.query(
      `SELECT status FROM deployment_intents WHERE id = $1`,
      [intentIds[6]],
    );
    assert.equal(exactIntent.status, "enqueued");

    await dataSource.query(
      `UPDATE orchestration_outbox SET available_at = clock_timestamp() WHERE id = $1`,
      [first.outboxId],
    );
    const concurrent = await Promise.all([dispatcherA.dispatchOne(), dispatcherB.dispatchOne()]);
    assert.equal(concurrent.filter((result) => result.status === "published").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "idle").length, 1);
    assert.deepEqual(await allQueueJobIds(inspectionQueue), [exact.jobId, first.jobId].sort());
    const firstRow = await outbox(first.outboxId);
    assert.equal(firstRow.status, "published");
    assert.equal(firstRow.publishedJobId, first.jobId);
    const [firstIntent] = await dataSource.query(
      `SELECT status FROM deployment_intents WHERE id = $1`,
      [intentIds[0]],
    );
    assert.equal(firstIntent.status, "enqueued");

    const crash = await seedIntentOutbox(intentIds[1]);
    const staleClaim = await dispatcherA.claimNext();
    assert.ok(staleClaim && !("blocked" in staleClaim) && !("deadLetter" in staleClaim));
    if (!staleClaim || "blocked" in staleClaim || "deadLetter" in staleClaim) {
      throw new Error("Expected a delivery claim.");
    }
    const firstPublish = await publisher.publish(staleClaim.envelope, staleClaim.deterministicJobId);
    assert.equal(firstPublish.jobId, crash.jobId);
    await dataSource.query(
      `UPDATE orchestration_outbox
       SET claim_expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [crash.outboxId],
    );
    const recoveredClaim = await dispatcherB.claimNext();
    assert.ok(recoveredClaim && !("blocked" in recoveredClaim) && !("deadLetter" in recoveredClaim));
    if (!recoveredClaim || "blocked" in recoveredClaim || "deadLetter" in recoveredClaim) {
      throw new Error("Expected a recovered delivery claim.");
    }
    assert.equal(
      BigInt(recoveredClaim.fencingToken) > BigInt(staleClaim.fencingToken),
      true,
    );
    assert.equal(await dispatcherA.completeDelivery(staleClaim, staleClaim.deterministicJobId), false);
    const replayPublish = await publisher.publish(
      recoveredClaim.envelope,
      recoveredClaim.deterministicJobId,
    );
    assert.equal(await dispatcherB.completeDelivery(recoveredClaim, replayPublish.jobId), true);
    const idsAfterRecovery = await allQueueJobIds(inspectionQueue);
    assert.deepEqual(idsAfterRecovery, [exact.jobId, first.jobId, crash.jobId].sort());
    assert.equal(new Set(idsAfterRecovery).size, 3);

    const retry = await seedIntentOutbox(intentIds[2]);
    const failingDispatcher = new DurableOutboxDispatcherService(
      dataSource,
      new FailingPublisher(),
      config("dispatcher-failure"),
    );
    const failed = await failingDispatcher.dispatchOne();
    assert.equal(failed.status, "retryable");
    const failedRow = await outbox(retry.outboxId);
    assert.equal(failedRow.status, "failed");
    assert.equal(failedRow.claimedBy, null);
    assert.equal(failedRow.lastError, "REDIS_DELIVERY_UNAVAILABLE");
    assert.equal(String(failedRow.lastError).includes("simulated Redis"), false);
    await dataSource.query(
      `UPDATE orchestration_outbox SET available_at = clock_timestamp() WHERE id = $1`,
      [retry.outboxId],
    );
    const retried = await dispatcherB.dispatchOne();
    assert.equal(retried.status, "published");
    assert.deepEqual(
      await allQueueJobIds(inspectionQueue),
      [exact.jobId, first.jobId, crash.jobId, retry.jobId].sort(),
    );

    const transitionConflict = await seedIntentOutbox(intentIds[3]);
    await dataSource.query(
      `UPDATE deployment_intents SET status = 'cancelled' WHERE id = $1`,
      [intentIds[3]],
    );
    const conflictResult = await dispatcherA.dispatchExact({
      outboxId: transitionConflict.outboxId,
      intentId: intentIds[3],
      projectId,
      environmentName: "production",
    });
    assert.deepEqual(conflictResult, {
      status: "dead_letter",
      outboxId: transitionConflict.outboxId,
      reason: "TERMINAL_INTENT_NOT_DISPATCHABLE",
    });
    const conflictRow = await outbox(transitionConflict.outboxId);
    assert.equal(conflictRow.status, "dead_letter");
    assert.equal(conflictRow.publishedJobId, null);
    assert.equal(conflictRow.lastError, "INTENT_CANCELLED_BEFORE_OUTBOX_DISPATCH");
    const [conflictIntent] = await dataSource.query(
      `SELECT status, enqueued_at AS "enqueuedAt"
       FROM deployment_intents WHERE id = $1`,
      [intentIds[3]],
    );
    assert.equal(conflictIntent.status, "cancelled");
    assert.equal(conflictIntent.enqueuedAt, null);
    assert.deepEqual(
      await allQueueJobIds(inspectionQueue),
      [exact.jobId, first.jobId, crash.jobId, retry.jobId].sort(),
    );

    const repeatedTerminalization = await dataSource.transaction(
      "SERIALIZABLE",
      (manager) => terminalOutbox.terminalizeUndispatched(manager, {
        intentId: intentIds[3],
        intentStatus: "cancelled",
      }),
    );
    assert.equal(repeatedTerminalization.transitionedCount, 0);

    const race = await seedIntentOutbox(intentIds[4]);
    const [terminalized, raceDispatch] = await Promise.all([
      dataSource.transaction("SERIALIZABLE", (manager) =>
        terminalOutbox.transitionIntentToTerminal(manager, {
          intentId: intentIds[4],
          expectedStatus: "planned",
          status: "cancelled",
          failureCode: "TEST_TERMINAL_RACE",
          failureMessage: null,
        })),
      dispatcherB.dispatchOne(),
    ]);
    assert.equal(
      Number(terminalized) + Number(raceDispatch.status === "published"),
      1,
    );
    const [raceIntent] = await dataSource.query(
      `SELECT status FROM deployment_intents WHERE id = $1`,
      [intentIds[4]],
    );
    const raceRow = await outbox(race.outboxId);
    if (terminalized) {
      assert.equal(raceIntent.status, "cancelled");
      assert.equal(raceRow.status, "dead_letter");
      assert.equal(raceRow.publishedJobId, null);
      assert.deepEqual(
        await allQueueJobIds(inspectionQueue),
        [exact.jobId, first.jobId, crash.jobId, retry.jobId].sort(),
      );
    } else {
      assert.equal(raceDispatch.status, "published");
      assert.equal(raceIntent.status, "enqueued");
      assert.equal(raceRow.status, "published");
      assert.equal(raceRow.publishedJobId, race.jobId);
    }

    const terminalAfterClaim = await seedIntentOutbox(intentIds[5]);
    const provisionalClaim = await dispatcherA.claimNext();
    assert.ok(provisionalClaim && !("blocked" in provisionalClaim) && !("deadLetter" in provisionalClaim));
    if (!provisionalClaim || "blocked" in provisionalClaim || "deadLetter" in provisionalClaim) {
      throw new Error("Expected a provisional outbox claim.");
    }
    assert.equal(provisionalClaim.intentId, intentIds[5]);
    await dataSource.query(
      `UPDATE deployment_intents SET status = 'cancelled' WHERE id = $1`,
      [intentIds[5]],
    );
    assert.equal(
      await dispatcherA.completeDelivery(
        provisionalClaim,
        provisionalClaim.deterministicJobId,
      ),
      false,
    );
    const terminalAfterClaimRow = await outbox(terminalAfterClaim.outboxId);
    assert.equal(terminalAfterClaimRow.status, "dead_letter");
    assert.equal(
      terminalAfterClaimRow.lastError,
      "INTENT_CANCELLED_BEFORE_OUTBOX_DISPATCH",
    );
    assert.equal(terminalAfterClaimRow.publishedJobId, null);

    const malformedExact = await seedIntentOutbox(intentIds[7]);
    await dataSource.query(
      `UPDATE orchestration_outbox
       SET worker_envelope = '{"unexpected":"malformed"}'::jsonb
       WHERE id = $1`,
      [malformedExact.outboxId],
    );
    assert.deepEqual(
      await dispatcherA.dispatchExact({
        outboxId: malformedExact.outboxId,
        intentId: intentIds[7],
        projectId,
        environmentName: "production",
      }),
      {
        status: "dead_letter",
        outboxId: malformedExact.outboxId,
        reason: "INVALID_WORKER_ENVELOPE",
      },
    );
    const malformedExactRow = await outbox(malformedExact.outboxId);
    assert.equal(malformedExactRow.status, "dead_letter");
    assert.equal(malformedExactRow.publishedJobId, null);

    const rollbackRunner = dataSource.createQueryRunner();
    await rollbackRunner.connect();
    try {
      await assert.rejects(
        new AddOutboxDeliveryFencing1760000038000().down(rollbackRunner),
        /Refusing to remove outbox delivery fencing while delivery history exists/,
      );
      const [fencingColumn] = await rollbackRunner.query(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = $1
           AND table_name = 'orchestration_outbox'
           AND column_name = 'claim_fencing_token'`,
        [schema],
      );
      assert.equal(fencingColumn.column_name, "claim_fencing_token");
    } finally {
      await rollbackRunner.release();
    }

    console.log("Durable outbox dispatcher PostgreSQL and Redis verification passed");
  } finally {
    if (adapterQueue) {
      try {
        await adapterQueue.obliterate({ force: true });
      } catch {
        // The isolated prefix is unique; cleanup is best-effort after a failed assertion.
      }
      await adapterQueue.close();
    }
    if (inspectionQueue) {
      try {
        await inspectionQueue.obliterate({ force: true });
      } catch {
        // The isolated prefix is unique; cleanup is best-effort after a failed assertion.
      }
      await inspectionQueue.close();
    }
    if (publisher) await publisher.onModuleDestroy();
    if (dataSource.isInitialized) await dataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
