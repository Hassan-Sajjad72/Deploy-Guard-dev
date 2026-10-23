import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InfrastructureSpecV1 } from "../src/orchestration-contracts/contracts/infrastructure-manifest.types";
import { ReleaseSpecV1 } from "../src/orchestration-contracts/contracts/release-manifest.types";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import {
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { CreateWorkerCapabilityRegistry1760000037000 } from "../src/migrations/1760000037000-CreateWorkerCapabilityRegistry";
import {
  FrozenProtocolQueue,
} from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import { createRedisConnection } from "../src/projects/pipeline/redis.config";
import { InactiveV1BullMqConsumerService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service";
import { InactiveV1ExecutionLeaseHeartbeatService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-execution-lease-heartbeat.service";
import { InactiveV1FencedInvocationService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service";
import { InactiveV1PreExecutionOwnershipService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-pre-execution-ownership.service";
import { InactiveV1WorkerRuntimeService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.service";
import {
  V1WorkerCapabilityIdentity,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types";
import {
  V1FencedPlaceholderHandler,
  V1FencedPlaceholderHandlerContext,
  V1FencedPlaceholderOutcome,
} from "../src/orchestration-contracts/worker-runtime/v1-fenced-invocation.types";
import {
  buildV1FencedPlaceholderHandlerRegistry,
  V1_FENCED_PLACEHOLDER_HANDLERS,
} from "../src/orchestration-contracts/worker-runtime/v1-placeholder-handlers";
import { V1WorkerCapabilityService } from "../src/orchestration-contracts/worker-runtime/v1-worker-capability.service";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session6_4_consumer_test_${suffix}`;
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
const redisConfig = new ConfigService({
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: "6379",
  REDIS_TLS: "false",
});
const redisConnection = createRedisConnection(redisConfig);
const queues: FrozenProtocolQueue[] = [];
const consumers: InactiveV1BullMqConsumerService[] = [];

const infrastructureSpec: InfrastructureSpecV1 = {
  region: "us-east-1",
  terraformTemplateVersion: "session6.4",
  network: {
    topology: "managed_vpc",
    availabilityZoneCount: 2,
    publicSubnets: true,
    privateSubnets: true,
    natMode: "single",
  },
  registry: {
    managedEcrRepository: true,
    immutableTags: true,
    lifecyclePolicyHash: null,
  },
  ecsFoundation: {
    clusterMode: "shared_project",
    serviceName: "session-6-4",
    launchType: "fargate",
    capacityProviders: ["FARGATE"],
  },
  ingress: {
    enabled: true,
    protocol: "HTTP",
    containerPort: 3000,
    targetGroupPort: 3000,
    healthCheckPath: "/health",
    healthCheckProtocol: "HTTP",
  },
  database: {
    mode: "none",
    engine: null,
    tierRevision: null,
    persistence: false,
    externalTlsRequired: null,
  },
  storage: {
    efsRequired: false,
    accessPointRequired: false,
    encrypted: true,
    backupRequired: false,
  },
  discovery: {
    cloudMapRequired: false,
    namespace: null,
  },
  observability: {
    cloudWatchLogs: true,
    cloudWatchMetrics: true,
    prometheus: false,
  },
  iamPolicyRevision: "v1",
  tags: { managedBy: "DeployGuard" },
};
const releaseSpec: ReleaseSpecV1 = {
  source: {
    repositoryFullName: "deployguard/session-6-4",
    branch: "main",
    commitSha: "a".repeat(40),
    appRoot: ".",
  },
  build: {
    dockerStrategy: "generated",
    dockerTemplate: "node-server",
    buildCommand: "npm run build",
    outputDirectory: null,
    buildArgumentNames: [],
  },
  runtime: {
    imageUri: null,
    imageDigest: null,
    command: "node dist/main.js",
    containerPort: 3000,
    cpu: 256,
    memory: 512,
    plainVariableNames: ["NODE_ENV"],
    secretReferenceNames: ["DATABASE_URL"],
    serviceBindingRevisions: [],
  },
  health: {
    path: "/health",
    expectedPort: 3000,
    gracePeriodSeconds: 30,
  },
};

function workerIdentity(label: string): V1WorkerCapabilityIdentity {
  return {
    workerId: `${label}:${suffix}`,
    role: "release",
    supportedMessageTypes: ["intent.release.execute"],
    serviceVersion: "session6.4-test",
    gitSha: "test",
    heartbeatTtlMs: 30_000,
    metadata: { runtime: "inactive-v1-consumer" },
  };
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
      schema_version integer NOT NULL,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      revision bigint NOT NULL,
      parent_manifest_id uuid,
      created_by_intent_id uuid,
      created_by_user_id integer,
      origin varchar(32) NOT NULL,
      status varchar(32) NOT NULL,
      spec_hash char(64) NOT NULL,
      terraform_template_version varchar(128) NOT NULL,
      state_backend varchar(16) NOT NULL,
      state_key varchar(512) NOT NULL,
      desired_spec jsonb NOT NULL,
      change_set jsonb NOT NULL,
      requires_terraform boolean NOT NULL
    )
  `);
  await dataSource.query(`
    CREATE TABLE release_manifests (
      id uuid PRIMARY KEY,
      schema_version integer NOT NULL,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      revision bigint NOT NULL,
      parent_manifest_id uuid,
      previous_stable_manifest_id uuid,
      infrastructure_manifest_id uuid NOT NULL,
      created_by_intent_id uuid,
      pipeline_run_id uuid,
      deployment_contract_id uuid,
      configuration_snapshot_id uuid,
      origin varchar(32) NOT NULL,
      status varchar(32) NOT NULL,
      spec_hash char(64) NOT NULL,
      repository_full_name varchar NOT NULL,
      branch varchar NOT NULL,
      commit_sha varchar NOT NULL,
      app_root varchar NOT NULL,
      deployment_contract_hash char(64) NOT NULL,
      configuration_fingerprint char(64) NOT NULL,
      build_fingerprint char(64) NOT NULL,
      runtime_fingerprint char(64) NOT NULL,
      release_spec jsonb NOT NULL
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
  intentId: string;
  projectId: string;
  infrastructureManifestId: string;
  releaseManifestId: string;
}) {
  const canonicalKey = createHash("sha256")
    .update(`intent:${input.intentId}`)
    .digest("hex");
  const envelope = {
    protocol: {
      name: "deployguard.worker",
      schemaVersion: 1,
      messageType: "intent.release.execute",
      minimumWorkerProtocol: 1,
      maximumWorkerProtocol: 1,
    },
    producer: {
      service: "deployguard-outbox-dispatcher",
      serviceVersion: "session6.4-test",
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
      lane: "release",
      operation: "execute",
      queue: "deployguard-release-v1",
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
      reasonCodes: ["SESSION_6_4_TEST"],
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

async function seedIntent(status = "enqueued", createdAt = new Date()) {
  const projectId = randomUUID();
  const intentId = randomUUID();
  const infrastructureManifestId = randomUUID();
  const releaseManifestId = randomUUID();
  await dataSource.query(`INSERT INTO projects (id) VALUES ($1)`, [projectId]);
  await dataSource.query(
    `INSERT INTO infrastructure_manifests (
       id, schema_version, project_id, environment_name, revision,
       parent_manifest_id, created_by_intent_id, created_by_user_id,
       origin, status, spec_hash, terraform_template_version,
       state_backend, state_key, desired_spec, change_set,
       requires_terraform
     ) VALUES (
       $1, 1, $2, 'production', 1, NULL, NULL, 1,
       'planner', 'desired', $3, 'session6.4', 's3',
       $4, $5::jsonb, $6::jsonb, true
     )`,
    [
      infrastructureManifestId,
      projectId,
      canonicalSha256(infrastructureSpec),
      `projects/${projectId}/terraform.tfstate`,
      JSON.stringify(infrastructureSpec),
      JSON.stringify({
        fromManifestId: null,
        changedPaths: [],
        categories: [],
        destructivePaths: [],
        requiresApproval: false,
        reasonCodes: ["SESSION_6_4_TEST"],
      }),
    ],
  );
  await dataSource.query(
    `INSERT INTO release_manifests (
       id, schema_version, project_id, environment_name, revision,
       parent_manifest_id, previous_stable_manifest_id,
       infrastructure_manifest_id, created_by_intent_id, pipeline_run_id,
       deployment_contract_id, configuration_snapshot_id, origin, status,
       spec_hash, repository_full_name, branch, commit_sha, app_root,
       deployment_contract_hash, configuration_fingerprint,
       build_fingerprint, runtime_fingerprint, release_spec
     ) VALUES (
       $1, 1, $2, 'production', 1, NULL, NULL, $3, NULL, NULL,
       NULL, NULL, 'planner', 'desired', $4, $5, $6, $7, $8,
       $9, $10, $11, $12, $13::jsonb
     )`,
    [
      releaseManifestId,
      projectId,
      infrastructureManifestId,
      canonicalSha256(releaseSpec),
      releaseSpec.source.repositoryFullName,
      releaseSpec.source.branch,
      releaseSpec.source.commitSha,
      releaseSpec.source.appRoot,
      "b".repeat(64),
      "c".repeat(64),
      "d".repeat(64),
      "e".repeat(64),
      JSON.stringify(releaseSpec),
    ],
  );
  const envelope = buildEnvelope({
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
       $1, $2, 'production', 'release_only', $3, $4, $5, $6,
       NULL, NULL, $7
     )`,
    [
      intentId,
      projectId,
      status,
      envelope.idempotency.canonicalKey,
      infrastructureManifestId,
      releaseManifestId,
      createdAt,
    ],
  );
  return { envelope, projectId, intentId };
}

function registry(
  invoke?: (
    context: V1FencedPlaceholderHandlerContext<"intent.release.execute">,
  ) => Promise<V1FencedPlaceholderOutcome> | V1FencedPlaceholderOutcome,
) {
  if (!invoke) return buildV1FencedPlaceholderHandlerRegistry();
  const replacement: V1FencedPlaceholderHandler<
    "intent.release.execute"
  > = {
    messageType: "intent.release.execute",
    sideEffectPolicy: "deployguard.side-effect/v1",
    invoke,
  };
  return buildV1FencedPlaceholderHandlerRegistry(
    V1_FENCED_PLACEHOLDER_HANDLERS.map((handler) =>
      handler.messageType === "intent.release.execute"
        ? replacement
        : handler
    ) as readonly V1FencedPlaceholderHandler[],
  );
}

function services(
  handlers = registry(),
) {
  const capabilities = new V1WorkerCapabilityService(dataSource);
  const runtime = new InactiveV1WorkerRuntimeService(
    dataSource,
    capabilities,
  );
  const ownership = new InactiveV1PreExecutionOwnershipService(
    dataSource,
    runtime,
  );
  const leaseHeartbeat = new InactiveV1ExecutionLeaseHeartbeatService(
    ownership,
  );
  const invocation = new InactiveV1FencedInvocationService(
    dataSource,
    ownership,
    handlers,
    leaseHeartbeat,
  );
  const consumer = new InactiveV1BullMqConsumerService(
    invocation,
    capabilities,
  );
  consumers.push(consumer);
  return { capabilities, ownership, invocation, consumer };
}

function queue(prefix: string) {
  const value = new FrozenProtocolQueue("deployguard-release-v1", {
    connection: redisConnection,
    prefix,
    skipMetasUpdate: false,
  });
  queues.push(value);
  return value;
}

async function addJob(
  value: FrozenProtocolQueue,
  envelope: DeployGuardWorkerEnvelopeV1,
  data: unknown = envelope,
  name = envelope.protocol.messageType,
) {
  return value.add(name, data as DeployGuardWorkerEnvelopeV1, {
    jobId: workerEnvelopeJobId(envelope),
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  });
}

async function waitForState(
  value: FrozenProtocolQueue,
  jobId: string,
  expected: string | string[],
  timeoutMs = 8_000,
) {
  const expectedStates = Array.isArray(expected) ? expected : [expected];
  const deadline = Date.now() + timeoutMs;
  do {
    const job = await value.getJob(jobId);
    const state = job ? await job.getState() : "missing";
    if (expectedStates.includes(state)) return job!;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  const job = await value.getJob(jobId);
  throw new Error(
    `Timed out waiting for ${expectedStates.join(",")}; got ${
      job ? await job.getState() : "missing"
    }.`,
  );
}

function startInput(
  capability: V1WorkerCapabilityIdentity,
  prefix: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    capability,
    connection: redisConnection,
    prefix,
    concurrency: 1,
    leaseTtlMs: 1_000,
    leaseHeartbeatIntervalMs: 200,
    retryDelayMs: 50,
    heartbeatIntervalMs: 500,
    ...overrides,
  };
}

async function intentRow(intentId: string) {
  const [row] = await dataSource.query(
    `SELECT status, failure_code AS "failureCode",
            failure_message AS "failureMessage"
     FROM deployment_intents WHERE id = $1`,
    [intentId],
  );
  return row;
}

async function leaseRows(intentId: string) {
  return dataSource.query(
    `SELECT id, owner_worker_id AS "ownerWorkerId",
            fencing_token AS "fencingToken", status,
            acquired_at AS "acquiredAt",
            heartbeat_at AS "heartbeatAt",
            expires_at AS "expiresAt"
     FROM project_operation_leases
     WHERE intent_id = $1 ORDER BY fencing_token`,
    [intentId],
  );
}

async function run() {
  await admin.initialize();
  try {
    await createSchema();

    const explicitPrefix = `session6-4-explicit-${suffix}`;
    const explicitQueue = queue(explicitPrefix);
    const explicitFixture = await seedIntent();
    const explicitJobId = workerEnvelopeJobId(explicitFixture.envelope);
    await addJob(explicitQueue, explicitFixture.envelope);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      await (await explicitQueue.getJob(explicitJobId))!.getState(),
      "waiting",
    );

    const explicitServices = services();
    assert.equal(explicitServices.consumer.isStarted(), false);
    const explicitSession = await explicitServices.consumer.start(
      startInput(workerIdentity("explicit"), explicitPrefix),
    );
    assert.equal(explicitSession.isActive(), true);
    assert.deepEqual(
      explicitSession.queueNames,
      ["deployguard-release-v1"],
    );
    await waitForState(explicitQueue, explicitJobId, "completed");
    assert.equal((await intentRow(explicitFixture.intentId)).status, "completed");
    assert.equal(
      (await leaseRows(explicitFixture.intentId))[0].status,
      "released",
    );
    assert.equal(explicitSession.lastFailureCode(), null);
    await explicitSession.stop();
    assert.equal(explicitSession.isActive(), false);
    assert.equal(explicitServices.consumer.isStarted(), false);

    const stoppedFixture = await seedIntent();
    const stoppedJobId = workerEnvelopeJobId(stoppedFixture.envelope);
    await addJob(explicitQueue, stoppedFixture.envelope);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      await (await explicitQueue.getJob(stoppedJobId))!.getState(),
      "waiting",
    );

    const gracefulPrefix = `session6-4-graceful-${suffix}`;
    const gracefulQueue = queue(gracefulPrefix);
    let handlerStarted!: () => void;
    let releaseHandler!: () => void;
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const gracefulServices = services(registry(async () => {
      handlerStarted();
      await blocked;
      return { outcome: "success" };
    }));
    const gracefulFixture = await seedIntent();
    const gracefulJobId = workerEnvelopeJobId(gracefulFixture.envelope);
    await addJob(gracefulQueue, gracefulFixture.envelope);
    const gracefulSession = await gracefulServices.consumer.start(
      startInput(workerIdentity("graceful"), gracefulPrefix),
    );
    await started;
    let stopResolved = false;
    const gracefulStop = gracefulSession.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(stopResolved, false);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const activeGracefulLease = (
      await leaseRows(gracefulFixture.intentId)
    )[0];
    assert.equal(activeGracefulLease.status, "heartbeat_active");
    assert.ok(
      new Date(activeGracefulLease.heartbeatAt).getTime()
        > new Date(activeGracefulLease.acquiredAt).getTime(),
    );
    assert.ok(
      new Date(activeGracefulLease.expiresAt).getTime() > Date.now(),
    );
    releaseHandler();
    await gracefulStop;
    assert.equal(stopResolved, true);
    assert.equal(
      (await intentRow(gracefulFixture.intentId)).status,
      "completed",
    );
    assert.equal(
      await (await gracefulQueue.getJob(gracefulJobId))!.getState(),
      "completed",
    );

    const retryPrefix = `session6-4-retry-${suffix}`;
    const retryQueue = queue(retryPrefix);
    let retryInvocations = 0;
    const retryServices = services(registry(() => {
      retryInvocations += 1;
      return retryInvocations === 1
        ? { outcome: "retryable" }
        : { outcome: "success" };
    }));
    const retryFixture = await seedIntent();
    const retryJobId = workerEnvelopeJobId(retryFixture.envelope);
    await addJob(retryQueue, retryFixture.envelope);
    const retrySession = await retryServices.consumer.start(
      startInput(workerIdentity("retry"), retryPrefix),
    );
    const retriedJob = await waitForState(
      retryQueue,
      retryJobId,
      "completed",
    );
    assert.equal(retryInvocations, 2);
    assert.ok(retriedJob.attemptsStarted >= 2);
    assert.equal((await intentRow(retryFixture.intentId)).status, "completed");
    assert.deepEqual(
      (await leaseRows(retryFixture.intentId)).map(
        (row: { status: string }) => row.status,
      ),
      ["released", "released"],
    );
    assert.equal((await retryQueue.getJobs(["completed"])).length, 1);
    await retrySession.stop();

    const crashPrefix = `session6-4-crash-${suffix}`;
    const crashQueue = queue(crashPrefix);
    let crashHandlerCount = 0;
    const crashServices = services(registry(() => {
      crashHandlerCount += 1;
      return { outcome: "success" };
    }));
    const crashedOwner = workerIdentity("crashed-owner");
    await crashServices.capabilities.register(crashedOwner);
    const crashFixture = await seedIntent();
    const oldClaim = await crashServices.ownership.claim({
      workerId: crashedOwner.workerId,
      queueName: crashFixture.envelope.routing.queue,
      envelope: crashFixture.envelope,
      leaseTtlMs: 1_000,
    });
    assert.equal(oldClaim.disposition, "claimed");
    if (oldClaim.disposition !== "claimed") {
      throw new Error("Crash ownership fixture was not claimed.");
    }
    const crashJobId = workerEnvelopeJobId(crashFixture.envelope);
    await addJob(crashQueue, crashFixture.envelope);
    const replacementSession = await crashServices.consumer.start(
      startInput(workerIdentity("replacement"), crashPrefix),
    );
    await waitForState(crashQueue, crashJobId, "delayed");
    assert.equal(crashHandlerCount, 0);
    assert.equal((await intentRow(crashFixture.intentId)).status, "running");
    await dataSource.query(
      `UPDATE project_operation_leases
       SET expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [oldClaim.lease.leaseId],
    );
    await waitForState(crashQueue, crashJobId, "completed");
    assert.equal(crashHandlerCount, 1);
    assert.equal((await intentRow(crashFixture.intentId)).status, "completed");
    const crashLeases = await leaseRows(crashFixture.intentId);
    assert.deepEqual(
      crashLeases.map((row: { status: string }) => row.status),
      ["expired", "released"],
    );
    assert.ok(
      BigInt(crashLeases[1].fencingToken)
        > BigInt(crashLeases[0].fencingToken),
    );
    await replacementSession.stop();

    const lossPrefix = `session6-5-ownership-loss-${suffix}`;
    const lossQueue = queue(lossPrefix);
    let lossHandlerStarted!: () => void;
    const lossStarted = new Promise<void>((resolve) => {
      lossHandlerStarted = resolve;
    });
    let lossHandlerCount = 0;
    let trustedAfterLoss = true;
    const lossServices = services(registry(async (context) => {
      lossHandlerCount += 1;
      lossHandlerStarted();
      if (!context.execution.signal.aborted) {
        await new Promise<void>((resolve) => {
          context.execution.signal.addEventListener(
            "abort",
            () => resolve(),
            { once: true },
          );
        });
      }
      trustedAfterLoss = context.execution.isLeaseTrusted();
      return { outcome: "success" };
    }));
    const lossFixture = await seedIntent();
    const lossJobId = workerEnvelopeJobId(lossFixture.envelope);
    await addJob(lossQueue, lossFixture.envelope);
    const lossWorker = workerIdentity("heartbeat-owner");
    const lossSession = await lossServices.consumer.start(
      startInput(lossWorker, lossPrefix, {
        leaseHeartbeatIntervalMs: 100,
      }),
    );
    await lossStarted;
    const firstLossLease = (await leaseRows(lossFixture.intentId))[0];
    await dataSource.query(
      `UPDATE project_operation_leases
       SET status = 'expired',
           expires_at = clock_timestamp() - interval '1 second',
           updated_at = clock_timestamp()
       WHERE id = $1`,
      [firstLossLease.id],
    );
    const replacementWorker = workerIdentity("heartbeat-replacement");
    await lossServices.capabilities.register(replacementWorker);
    const replacementClaim = await lossServices.ownership.claim({
      workerId: replacementWorker.workerId,
      queueName: lossFixture.envelope.routing.queue,
      envelope: lossFixture.envelope,
      leaseTtlMs: 1_000,
    });
    assert.equal(replacementClaim.disposition, "claimed");
    if (replacementClaim.disposition !== "claimed") {
      throw new Error("Heartbeat replacement claim was not acquired.");
    }
    await waitForState(lossQueue, lossJobId, "delayed");
    assert.equal(lossHandlerCount, 1);
    assert.equal(trustedAfterLoss, false);
    assert.equal((await intentRow(lossFixture.intentId)).status, "running");
    const ownershipLossLeases = await leaseRows(lossFixture.intentId);
    assert.deepEqual(
      ownershipLossLeases.map((row: { status: string }) => row.status),
      ["expired", "acquired"],
    );
    assert.ok(
      BigInt(ownershipLossLeases[1].fencingToken)
        > BigInt(ownershipLossLeases[0].fencingToken),
    );
    await lossSession.stop();

    const rawHeartbeatError =
      "postgres://worker:secret@private-host/session-6-5";
    const heartbeatFailurePrefix =
      `session6-5-heartbeat-failure-${suffix}`;
    const heartbeatFailureQueue = queue(heartbeatFailurePrefix);
    const heartbeatFailureServices = services(registry(async (context) => {
      if (!context.execution.signal.aborted) {
        await new Promise<void>((resolve) => {
          context.execution.signal.addEventListener(
            "abort",
            () => resolve(),
            { once: true },
          );
        });
      }
      return { outcome: "success" };
    }));
    heartbeatFailureServices.ownership.renew = async () => {
      throw new Error(rawHeartbeatError);
    };
    const heartbeatFailureFixture = await seedIntent();
    const heartbeatFailureJobId = workerEnvelopeJobId(
      heartbeatFailureFixture.envelope,
    );
    await addJob(
      heartbeatFailureQueue,
      heartbeatFailureFixture.envelope,
    );
    const heartbeatFailureSession =
      await heartbeatFailureServices.consumer.start(
        startInput(
          workerIdentity("heartbeat-failure"),
          heartbeatFailurePrefix,
          { leaseHeartbeatIntervalMs: 100 },
        ),
      );
    const heartbeatFailedJob = await waitForState(
      heartbeatFailureQueue,
      heartbeatFailureJobId,
      "failed",
    );
    assert.equal(
      heartbeatFailedJob.failedReason,
      "EXECUTION_HEARTBEAT_FAILED",
    );
    assert.equal(
      heartbeatFailedJob.stacktrace.join("\n").includes(rawHeartbeatError),
      false,
    );
    const heartbeatFailedIntent = await intentRow(
      heartbeatFailureFixture.intentId,
    );
    assert.equal(heartbeatFailedIntent.status, "failed");
    assert.equal(
      heartbeatFailedIntent.failureCode,
      "EXECUTION_HEARTBEAT_FAILED",
    );
    assert.equal(heartbeatFailedIntent.failureMessage, null);
    await heartbeatFailureSession.stop();

    const cancellationServices = services(registry(async (context) => {
      if (!context.execution.signal.aborted) {
        await new Promise<void>((resolve) => {
          context.execution.signal.addEventListener(
            "abort",
            () => resolve(),
            { once: true },
          );
        });
      }
      return { outcome: "success" };
    }));
    const cancellationWorker = workerIdentity("execution-cancellation");
    await cancellationServices.capabilities.register(cancellationWorker);
    const cancellationFixture = await seedIntent();
    const cancellation = new AbortController();
    const cancelledInvocation = cancellationServices.invocation.invoke({
      workerId: cancellationWorker.workerId,
      queueName: cancellationFixture.envelope.routing.queue,
      envelope: cancellationFixture.envelope,
      leaseTtlMs: 1_000,
      leaseHeartbeatIntervalMs: 100,
      abortSignal: cancellation.signal,
    });
    while ((await leaseRows(cancellationFixture.intentId)).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    cancellation.abort();
    const cancelledResult = await cancelledInvocation;
    assert.equal(cancelledResult.disposition, "released");
    if (cancelledResult.disposition === "released") {
      assert.equal(cancelledResult.reason, "execution_cancelled");
    }
    assert.equal(
      (await intentRow(cancellationFixture.intentId)).status,
      "enqueued",
    );
    assert.equal(
      (await leaseRows(cancellationFixture.intentId))[0].status,
      "released",
    );

    const terminalPrefix = `session6-4-terminal-${suffix}`;
    const terminalQueue = queue(terminalPrefix);
    const terminalServices = services();
    const terminalFixture = await seedIntent("completed");
    const terminalJobId = workerEnvelopeJobId(terminalFixture.envelope);
    await addJob(terminalQueue, terminalFixture.envelope);
    const terminalSession = await terminalServices.consumer.start(
      startInput(workerIdentity("terminal"), terminalPrefix),
    );
    const terminalJob = await waitForState(
      terminalQueue,
      terminalJobId,
      "completed",
    );
    assert.equal(terminalJob.returnvalue.disposition, "idempotent_no_op");
    if (terminalJob.returnvalue.disposition === "idempotent_no_op") {
      assert.equal(terminalJob.returnvalue.reason, "intent_terminal");
    }
    assert.equal((await leaseRows(terminalFixture.intentId)).length, 0);
    await terminalSession.stop();

    const supersededPrefix = `session6-4-superseded-${suffix}`;
    const supersededQueue = queue(supersededPrefix);
    const supersededServices = services();
    const supersededFixture = await seedIntent(
      "enqueued",
      new Date(Date.now() - 10_000),
    );
    await dataSource.query(
      `INSERT INTO deployment_intents (
         id, project_id, environment_name, classification, status,
         canonical_idempotency_key, created_at
       ) VALUES (
         $1, $2, 'production', 'release_only', 'completed', $3,
         clock_timestamp()
       )`,
      [randomUUID(), supersededFixture.projectId, "f".repeat(64)],
    );
    const supersededJobId = workerEnvelopeJobId(
      supersededFixture.envelope,
    );
    await addJob(supersededQueue, supersededFixture.envelope);
    const supersededSession = await supersededServices.consumer.start(
      startInput(workerIdentity("superseded"), supersededPrefix),
    );
    const supersededJob = await waitForState(
      supersededQueue,
      supersededJobId,
      "completed",
    );
    assert.equal(
      supersededJob.returnvalue.disposition,
      "idempotent_no_op",
    );
    if (supersededJob.returnvalue.disposition === "idempotent_no_op") {
      assert.equal(
        supersededJob.returnvalue.reason,
        "intent_superseded",
      );
    }
    assert.equal((await leaseRows(supersededFixture.intentId)).length, 0);
    await supersededSession.stop();

    const failurePrefix = `session6-4-failure-${suffix}`;
    const failureQueue = queue(failurePrefix);
    const failureServices = services(registry(() => ({
      outcome: "terminal_failure",
      safeFailureCode: "PLACEHOLDER_TERMINAL",
    })));
    const failureFixture = await seedIntent();
    const failureJobId = workerEnvelopeJobId(failureFixture.envelope);
    await addJob(failureQueue, failureFixture.envelope);
    const failureSession = await failureServices.consumer.start(
      startInput(workerIdentity("failure"), failurePrefix),
    );
    const failedJob = await waitForState(
      failureQueue,
      failureJobId,
      "failed",
    );
    assert.equal(failedJob.failedReason, "PLACEHOLDER_TERMINAL");
    const failedIntent = await intentRow(failureFixture.intentId);
    assert.equal(failedIntent.status, "failed");
    assert.equal(failedIntent.failureCode, "PLACEHOLDER_TERMINAL");
    assert.equal(failedIntent.failureMessage, null);
    await failureSession.stop();

    const malformedPrefix = `session6-4-malformed-${suffix}`;
    const malformedQueue = queue(malformedPrefix);
    const malformedServices = services();
    const malformedFixture = await seedIntent();
    const malformedJobId = workerEnvelopeJobId(malformedFixture.envelope);
    await addJob(
      malformedQueue,
      malformedFixture.envelope,
      {
        ...malformedFixture.envelope,
        unexpectedMutableField: true,
      },
    );
    const malformedSession = await malformedServices.consumer.start(
      startInput(workerIdentity("malformed"), malformedPrefix),
    );
    const malformedJob = await waitForState(
      malformedQueue,
      malformedJobId,
      "failed",
    );
    assert.equal(malformedJob.failedReason, "CONSUMER_JOB_REJECTED");
    assert.equal(
      malformedJob.stacktrace.join("\n").includes("unexpectedMutableField"),
      false,
    );
    assert.equal(
      (await intentRow(malformedFixture.intentId)).status,
      "enqueued",
    );
    assert.equal((await leaseRows(malformedFixture.intentId)).length, 0);
    await malformedSession.stop();

    console.log(
      "Inactive v1 BullMQ consumer isolated PostgreSQL/Redis verification passed",
    );
  } finally {
    await Promise.allSettled(consumers.map((consumer) => consumer.stop()));
    for (const value of queues) {
      try {
        await value.obliterate({ force: true });
      } finally {
        await value.close();
      }
    }
    if (dataSource.isInitialized) await dataSource.destroy();
    if (admin.isInitialized) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.destroy();
      }
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
