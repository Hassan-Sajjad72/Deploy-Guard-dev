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

    const dispatcherA = new DurableOutboxDispatcherService(dataSource, publisher, configA);
    const dispatcherB = new DurableOutboxDispatcherService(dataSource, publisher, configB);
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
       SET minimum_protocol = 1, maximum_protocol = 1
       WHERE worker_id = 'release-worker'`,
    );
    await dataSource.query(
      `UPDATE orchestration_outbox SET available_at = clock_timestamp() WHERE id = $1`,
      [first.outboxId],
    );
    const concurrent = await Promise.all([dispatcherA.dispatchOne(), dispatcherB.dispatchOne()]);
    assert.equal(concurrent.filter((result) => result.status === "published").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "idle").length, 1);
    assert.deepEqual(await allQueueJobIds(inspectionQueue), [first.jobId]);
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
    assert.deepEqual(idsAfterRecovery, [first.jobId, crash.jobId].sort());
    assert.equal(new Set(idsAfterRecovery).size, 2);

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
      [first.jobId, crash.jobId, retry.jobId].sort(),
    );

    console.log("Durable outbox dispatcher PostgreSQL and Redis verification passed");
  } finally {
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
