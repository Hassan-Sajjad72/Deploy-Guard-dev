import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import {
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import {
  FrozenProtocolQueue,
} from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import { CreateWorkerCapabilityRegistry1760000037000 } from "../src/migrations/1760000037000-CreateWorkerCapabilityRegistry";
import { createRedisConnection } from "../src/projects/pipeline/redis.config";
import { InactiveV1WorkerRuntimeService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.service";
import {
  ExecutableV1MessageType,
  InactiveV1WorkerRuntimeError,
  V1WorkerCapabilityIdentity,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types";
import { V1WorkerCapabilityService } from "../src/orchestration-contracts/worker-runtime/v1-worker-capability.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session6_1_worker_test_${suffix}`;
const redisPrefix = `session6-1-${suffix}`;
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

const workerCapabilities: Record<
  "release" | "infrastructure" | "deletion",
  V1WorkerCapabilityIdentity
> = {
  release: {
    workerId: `release-worker:${suffix}`,
    role: "release",
    supportedMessageTypes: ["intent.release.execute"],
    serviceVersion: "session6.1-test",
    gitSha: "test",
    heartbeatTtlMs: 30_000,
    metadata: { runtime: "inactive-v1" },
  },
  infrastructure: {
    workerId: `infrastructure-worker:${suffix}`,
    role: "infrastructure",
    supportedMessageTypes: [
      "intent.infrastructure.plan",
      "intent.infrastructure.apply",
    ],
    serviceVersion: "session6.1-test",
    gitSha: "test",
    heartbeatTtlMs: 30_000,
    metadata: { runtime: "inactive-v1" },
  },
  deletion: {
    workerId: `deletion-worker:${suffix}`,
    role: "deletion",
    supportedMessageTypes: ["intent.deletion.execute"],
    serviceVersion: "session6.1-test",
    gitSha: "test",
    heartbeatTtlMs: 30_000,
    metadata: { runtime: "inactive-v1" },
  },
};

const queues = new Map<string, FrozenProtocolQueue>();
const redisConfig = new ConfigService({
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: "6379",
  REDIS_TLS: "false",
});

function queue(name: string) {
  const existing = queues.get(name);
  if (existing) return existing;
  const created = new FrozenProtocolQueue(name, {
    connection: createRedisConnection(redisConfig),
    prefix: redisPrefix,
    skipMetasUpdate: false,
  });
  queues.set(name, created);
  return created;
}

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
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
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
      serviceVersion: "session6.1-test",
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
      reasonCodes: ["SESSION_6_1_TEST"],
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
    status?: string;
    createdAt?: Date;
    setDeletionFence?: boolean;
  } = {},
) {
  const projectId = randomUUID();
  const intentId = randomUUID();
  const infrastructureManifestId =
    messageType === "intent.deletion.execute" ? null : randomUUID();
  const releaseManifestId =
    messageType === "intent.release.execute" ? randomUUID() : null;
  await dataSource.query(
    `INSERT INTO projects (
       id, deletion_fence_token, deletion_intent_id, deletion_started_at
     ) VALUES ($1, $2, $3, $4)`,
    [
      projectId,
      options.setDeletionFence ? "1" : null,
      options.setDeletionFence ? intentId : null,
      options.setDeletionFence ? new Date() : null,
    ],
  );
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
       release_manifest_id, pipeline_run_id, destroy_operation_id, created_at
     ) VALUES ($1, $2, 'production', $3, $4, $5, $6, $7, NULL, NULL, $8)`,
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
  return { envelope, projectId, intentId };
}

async function expectRuntimeError(
  action: () => Promise<unknown>,
  code: InactiveV1WorkerRuntimeError["code"],
) {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof InactiveV1WorkerRuntimeError && error.code === code,
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

    for (const identity of Object.values(workerCapabilities)) {
      const registered = await capabilities.register(identity);
      assert.equal(registered.minimumProtocol, 1);
      assert.equal(registered.maximumProtocol, 1);
      assert.ok(registered.expiresAt > registered.heartbeatAt);
    }

    const maintainedCapability: V1WorkerCapabilityIdentity = {
      ...workerCapabilities.release,
      workerId: `heartbeat-worker:${suffix}`,
      heartbeatTtlMs: 1_000,
    };
    const maintained = await capabilities.startHeartbeatSession(
      maintainedCapability,
      150,
    );
    const [maintainedBefore] = await dataSource.query(
      `SELECT heartbeat_at AS "heartbeatAt"
       FROM worker_capabilities WHERE worker_id = $1`,
      [maintainedCapability.workerId],
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    const [maintainedAfter] = await dataSource.query(
      `SELECT heartbeat_at AS "heartbeatAt"
       FROM worker_capabilities WHERE worker_id = $1`,
      [maintainedCapability.workerId],
    );
    assert.ok(
      new Date(maintainedAfter.heartbeatAt) > new Date(maintainedBefore.heartbeatAt),
      "an explicitly started session maintains its heartbeat",
    );
    assert.equal(maintained.isActive(), true);
    assert.equal(maintained.lastFailureCode(), null);
    await maintained.stop();
    assert.equal(maintained.isActive(), false);

    const releaseBefore = await capabilities.requireLiveCompatible(
      workerCapabilities.release.workerId,
      "intent.release.execute",
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const releaseHeartbeat = await capabilities.heartbeat(
      workerCapabilities.release,
    );
    assert.ok(releaseHeartbeat);
    assert.ok(
      releaseHeartbeat.heartbeatAt >= releaseBefore.heartbeatAt,
      "heartbeat renews using database time",
    );
    assert.ok(releaseHeartbeat.expiresAt > releaseBefore.expiresAt);

    for (const messageType of Object.keys(routes) as ExecutableV1MessageType[]) {
      const route = routes[messageType];
      const seeded = await seedIntent(messageType, {
        setDeletionFence: messageType === "intent.deletion.execute",
      });
      const deterministicJobId = workerEnvelopeJobId(seeded.envelope);
      const physicalJob = await queue(route.queue).add(
        messageType,
        seeded.envelope,
        {
          jobId: deterministicJobId,
          attempts: 1,
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
      assert.equal(physicalJob.id, deterministicJobId);
      const result = await runtime.route({
        workerId: workerCapabilities[route.role].workerId,
        queueName: route.queue,
        envelope: physicalJob.data,
      });
      assert.equal(result.disposition, "placeholder_routed");
      if (result.disposition === "placeholder_routed") {
        assert.equal(result.handler, messageType);
        assert.equal(result.messageType, messageType);
      }
      assert.equal(
        await physicalJob.getState(),
        "waiting",
        "no BullMQ Worker consumed the job",
      );
    }

    const stale = await seedIntent("intent.release.execute");
    await dataSource.query(
      `UPDATE worker_capabilities
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE worker_id = $1`,
      [workerCapabilities.release.workerId],
    );
    assert.equal(
      await capabilities.heartbeat(workerCapabilities.release),
      null,
      "an expired capability cannot revive through heartbeat",
    );
    await expectRuntimeError(
      () => runtime.route({
        workerId: workerCapabilities.release.workerId,
        queueName: routes["intent.release.execute"].queue,
        envelope: stale.envelope,
      }),
      "WORKER_CAPABILITY_UNAVAILABLE",
    );
    await capabilities.register(workerCapabilities.release);

    const incompatible = await seedIntent("intent.infrastructure.plan");
    await expectRuntimeError(
      () => runtime.route({
        workerId: workerCapabilities.release.workerId,
        queueName: routes["intent.infrastructure.plan"].queue,
        envelope: incompatible.envelope,
      }),
      "WORKER_CAPABILITY_UNAVAILABLE",
    );

    const wrongQueue = await seedIntent("intent.release.execute");
    await expectRuntimeError(
      () => runtime.route({
        workerId: workerCapabilities.release.workerId,
        queueName: "deployguard-infrastructure-v1",
        envelope: wrongQueue.envelope,
      }),
      "WORKER_QUEUE_MISMATCH",
    );
    await expectRuntimeError(
      () => runtime.route({
        workerId: workerCapabilities.release.workerId,
        queueName: routes["intent.release.execute"].queue,
        envelope: {
          ...wrongQueue.envelope,
          protocol: {
            ...wrongQueue.envelope.protocol,
            schemaVersion: 2,
          },
        },
      }),
      "WORKER_ENVELOPE_INVALID",
    );
    const wrongMessageRoute = {
      ...wrongQueue.envelope,
      protocol: {
        ...wrongQueue.envelope.protocol,
        messageType: "intent.infrastructure.plan" as const,
      },
      idempotency: {
        ...wrongQueue.envelope.idempotency,
        payloadSha256: "0".repeat(64),
      },
    };
    wrongMessageRoute.idempotency.payloadSha256 = canonicalSha256(
      workerEnvelopePayloadForHash(wrongMessageRoute),
    );
    await expectRuntimeError(
      () => runtime.route({
        workerId: workerCapabilities.infrastructure.workerId,
        queueName: routes["intent.release.execute"].queue,
        envelope: wrongMessageRoute,
      }),
      "WORKER_QUEUE_MISMATCH",
    );

    const unsupportedApply = await seedIntent("intent.infrastructure.apply");
    await dataSource.query(
      `UPDATE worker_capabilities
       SET supported_message_types = '["intent.infrastructure.plan"]'::jsonb
       WHERE worker_id = $1`,
      [workerCapabilities.infrastructure.workerId],
    );
    await expectRuntimeError(
      () => runtime.route({
        workerId: workerCapabilities.infrastructure.workerId,
        queueName: routes["intent.infrastructure.apply"].queue,
        envelope: unsupportedApply.envelope,
      }),
      "WORKER_CAPABILITY_UNAVAILABLE",
    );
    await capabilities.register(workerCapabilities.infrastructure);

    const identityMismatch = await seedIntent("intent.release.execute");
    const mismatchedEnvelope = {
      ...identityMismatch.envelope,
      identity: {
        ...identityMismatch.envelope.identity,
        projectId: randomUUID(),
      },
      idempotency: {
        ...identityMismatch.envelope.idempotency,
        payloadSha256: "0".repeat(64),
      },
    };
    mismatchedEnvelope.idempotency.payloadSha256 = canonicalSha256(
      workerEnvelopePayloadForHash(mismatchedEnvelope),
    );
    await expectRuntimeError(
      () => runtime.route({
        workerId: workerCapabilities.release.workerId,
        queueName: routes["intent.release.execute"].queue,
        envelope: mismatchedEnvelope,
      }),
      "INTENT_IDENTITY_MISMATCH",
    );

    const terminal = await seedIntent("intent.release.execute", {
      status: "completed",
    });
    const terminalResult = await runtime.route({
      workerId: workerCapabilities.release.workerId,
      queueName: routes["intent.release.execute"].queue,
      envelope: terminal.envelope,
    });
    assert.deepEqual(
      {
        disposition: terminalResult.disposition,
        reason: terminalResult.disposition === "idempotent_no_op"
          ? terminalResult.reason
          : null,
      },
      { disposition: "idempotent_no_op", reason: "intent_terminal" },
    );

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
    const supersededResult = await runtime.route({
      workerId: workerCapabilities.release.workerId,
      queueName: routes["intent.release.execute"].queue,
      envelope: superseded.envelope,
    });
    assert.deepEqual(
      {
        disposition: supersededResult.disposition,
        reason: supersededResult.disposition === "idempotent_no_op"
          ? supersededResult.reason
          : null,
      },
      { disposition: "idempotent_no_op", reason: "intent_superseded" },
    );

    const concurrentLane = await seedIntent("intent.release.execute", {
      createdAt: new Date(Date.now() - 10_000),
    });
    await dataSource.query(
      `INSERT INTO deployment_intents (
         id, project_id, environment_name, classification, status,
         canonical_idempotency_key, created_at
       ) VALUES (
         $1, $2, 'production', 'infrastructure_change', 'planned', $3,
         clock_timestamp()
       )`,
      [randomUUID(), concurrentLane.projectId, "e".repeat(64)],
    );
    const concurrentLaneResult = await runtime.route({
      workerId: workerCapabilities.release.workerId,
      queueName: routes["intent.release.execute"].queue,
      envelope: concurrentLane.envelope,
    });
    assert.equal(
      concurrentLaneResult.disposition,
      "placeholder_routed",
      "an allowed infrastructure-plan lane does not supersede a release",
    );

    const fencedRelease = await seedIntent("intent.release.execute", {
      setDeletionFence: true,
    });
    await expectRuntimeError(
      () => runtime.route({
        workerId: workerCapabilities.release.workerId,
        queueName: routes["intent.release.execute"].queue,
        envelope: fencedRelease.envelope,
      }),
      "DELETION_FENCE_ACTIVE",
    );
    const unfencedDeletion = await seedIntent("intent.deletion.execute");
    await expectRuntimeError(
      () => runtime.route({
        workerId: workerCapabilities.deletion.workerId,
        queueName: routes["intent.deletion.execute"].queue,
        envelope: unfencedDeletion.envelope,
      }),
      "DELETION_FENCE_MISSING",
    );

    const rows = await dataSource.query(
      `SELECT status, COUNT(*)::integer AS count
       FROM deployment_intents
       GROUP BY status`,
    );
    assert.ok(
      rows.some((row: { status: string; count: number }) =>
        row.status === "enqueued" && row.count >= 4
      ),
      "placeholder routing leaves intent status unchanged",
    );
    const leaseRows = await dataSource.query(
      `SELECT COUNT(*)::integer AS count
       FROM information_schema.tables
       WHERE table_schema = $1
         AND table_name = 'project_operation_leases'`,
      [schema],
    );
    assert.equal(
      leaseRows[0].count,
      0,
      "the inactive runtime does not create operation leases",
    );
  } finally {
    await Promise.all([...queues.values()].map(async (item) => {
      try {
        await item.obliterate({ force: true });
      } catch {
        // Each test uses a unique Redis prefix; cleanup is best effort on failure.
      }
      await item.close();
    }));
    if (dataSource.isInitialized) await dataSource.destroy();
    if (admin.isInitialized) {
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.destroy();
    }
  }
}

run()
  .then(() => {
    console.log(
      "Inactive v1 worker runtime isolated PostgreSQL/Redis verification passed",
    );
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
