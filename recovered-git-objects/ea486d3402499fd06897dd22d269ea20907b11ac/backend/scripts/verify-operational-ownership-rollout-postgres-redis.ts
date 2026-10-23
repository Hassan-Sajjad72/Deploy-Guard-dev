import "reflect-metadata";
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { INestApplication, LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Queue } from "bullmq";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import {
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { FrozenProtocolQueue } from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import {
  CrossLaneOwnershipClaim,
  CrossLaneOwnershipEnforcementService,
} from "../src/orchestration-contracts/release-lane/cross-lane-ownership-enforcement.service";
import { InactiveV1BullMqConsumerService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service";
import { V1WorkerCapabilityIdentity } from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types";
import {
  EMERGENCY_CLEANUP_QUEUE,
  LIFECYCLE_QUEUE,
} from "../src/infrastructure-lifecycle/lifecycle.queue";
import { PIPELINE_QUEUE } from "../src/projects/pipeline/pipeline.types";
import { createRedisConnection } from "../src/projects/pipeline/redis.config";
import { ConfigService } from "@nestjs/config";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `operational_9_1_${suffix}`;
const fixtureProjectId = "91000000-0000-4000-8000-000000000001";
const outsideProjectId = "91000000-0000-4000-8000-000000000002";
const redisPrefix = `deployguard-operational-9-1-${suffix}`;
const workerId = `operational-9.1-worker:${suffix}`;
const actorId = "rollout:fixture-operator";
const changedEnvironmentKeys = [
  "NODE_ENV",
  "TYPEORM_SYNCHRONIZE",
  "PGOPTIONS",
  "PIPELINE_QUEUE_NAME",
  "TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED",
  "TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED",
  "TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST",
  "TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST",
  "TWO_LANE_RELEASE_COMPOSITION_ENABLED",
  "LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED",
  "TERRAFORM_APPLY_ENABLED",
  "INFRACOST_ENABLED",
  "AWS_EC2_METADATA_DISABLED",
] as const;
const originalEnvironment = Object.fromEntries(
  changedEnvironmentKeys.map((key) => [key, process.env[key]]),
) as Record<(typeof changedEnvironmentKeys)[number], string | undefined>;

if (!/^[a-z0-9_]+$/.test(schema)) throw new Error("Unsafe schema");

class CapturedLogger implements LoggerService {
  readonly entries: string[] = [];
  log(message: unknown, ...optional: unknown[]) {
    this.capture("log", message, optional);
  }
  error(message: unknown, ...optional: unknown[]) {
    this.capture("error", message, optional);
  }
  warn(message: unknown, ...optional: unknown[]) {
    this.capture("warn", message, optional);
  }
  debug(message: unknown, ...optional: unknown[]) {
    this.capture("debug", message, optional);
  }
  verbose(message: unknown, ...optional: unknown[]) {
    this.capture("verbose", message, optional);
  }
  fatal(message: unknown, ...optional: unknown[]) {
    this.capture("fatal", message, optional);
  }
  private capture(level: string, message: unknown, optional: unknown[]) {
    const safe = [message, ...optional]
      .map((value) => typeof value === "string" ? value : JSON.stringify(value))
      .join(" ");
    this.entries.push(`${level}:${safe}`);
  }
}

const logger = new CapturedLogger();
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
let app: INestApplication | null = null;
let consumerSession: { stop(): Promise<void> } | null = null;
let frozenQueue: FrozenProtocolQueue | null = null;

function configureRuntime(enabled: boolean, synchronize: boolean) {
  Object.assign(process.env, {
    NODE_ENV: "test",
    TYPEORM_SYNCHRONIZE: synchronize ? "true" : "false",
    PGOPTIONS: `-c search_path=${schema},public`,
    PIPELINE_QUEUE_NAME: `operational-9-1-legacy-${suffix}`,
    TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED: enabled ? "true" : "false",
    TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED: enabled ? "true" : "false",
    TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST: fixtureProjectId,
    TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_RELEASE_COMPOSITION_ENABLED: "false",
    LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED: "true",
    TERRAFORM_APPLY_ENABLED: "false",
    INFRACOST_ENABLED: "false",
    AWS_EC2_METADATA_DISABLED: "true",
  });
}

async function startNormalBackend(enabled: boolean, synchronize: boolean) {
  configureRuntime(enabled, synchronize);
  const { AppModule } = await import("../src/app.module");
  const instance = await NestFactory.create(AppModule, {
    logger,
    abortOnError: false,
  });
  await instance.listen(0, "127.0.0.1");
  return instance;
}

async function closeNormalBackend(instance: INestApplication | null) {
  if (!instance) return;
  for (const token of [PIPELINE_QUEUE, LIFECYCLE_QUEUE, EMERGENCY_CLEANUP_QUEUE]) {
    let queue: Queue | null = null;
    try {
      queue = instance.get<Queue>(token, { strict: false });
      await bounded(queue.close(), 2_000);
    } catch {
      // A missing optional queue is inert.
    }
    if (queue) await queue.disconnect().catch(() => undefined);
  }
  try {
    await bounded(instance.close(), 5_000);
  } catch {
    const dataSource = instance.get(DataSource, { strict: false });
    if (dataSource.isInitialized) {
      await bounded(dataSource.destroy(), 3_000).catch(() => undefined);
    }
  }
}

async function seedFixture(dataSource: DataSource) {
  const [user] = await dataSource.query(
    `INSERT INTO users (github_id, name, email, role)
     VALUES ($1, 'Operational fixture', $2, 'developer')
     RETURNING id`,
    [`operational-9-1-${suffix}`, `operational-${suffix}@example.invalid`],
  );
  for (const [id, name] of [
    [fixtureProjectId, "Operational ownership fixture"],
    [outsideProjectId, "Non-allowlisted fixture"],
  ]) {
    await dataSource.query(
      `INSERT INTO projects (
         id, owner_user_id, name, repository_url, repository_provider,
         repository_full_name, target_branch, environment_name, status, visibility
       ) VALUES ($1, $2, $3, $4, 'github', $5, 'main', 'dev', 'created', 'private')`,
      [
        id,
        user.id,
        name,
        `https://example.invalid/${id}`,
        `fixture/${id}`,
      ],
    );
  }
  return Number(user.id);
}

async function insertRun(
  dataSource: DataSource,
  userId: number,
  status = "queued",
) {
  const runId = randomUUID();
  await dataSource.query(
    `INSERT INTO project_pipeline_runs (
       id, project_id, triggered_by_user_id, repository_url,
       repository_full_name, target_branch, status, current_stage
     ) VALUES ($1, $2, $3, $4, $5, 'main', $6, 'validate_inputs')`,
    [
      runId,
      fixtureProjectId,
      userId,
      `https://example.invalid/${fixtureProjectId}`,
      `fixture/${fixtureProjectId}`,
      status,
    ],
  );
  return runId;
}

async function insertIntent(dataSource: DataSource, userId: number) {
  const intentId = randomUUID();
  const key = digest(`intent:${intentId}`);
  await dataSource.query(
    `INSERT INTO deployment_intents (
       id, schema_version, project_id, environment_name, requested_by_user_id,
       kind, classification, status, client_idempotency_key,
       canonical_idempotency_key, request_fingerprint, request_payload
     ) VALUES ($1, 1, $2, 'dev', $3, 'deploy', 'release_only', 'enqueued',
       $4, $5, $6, '{}'::jsonb)`,
    [intentId, fixtureProjectId, userId, `fixture-${intentId}`, key, key],
  );
  return intentId;
}

function releaseEnvelope(intentId: string): DeployGuardWorkerEnvelopeV1 {
  const envelope: DeployGuardWorkerEnvelopeV1 = {
    protocol: {
      name: "deployguard.worker",
      schemaVersion: 1,
      messageType: "intent.release.execute",
      minimumWorkerProtocol: 1,
      maximumWorkerProtocol: 1,
    },
    producer: {
      service: "deployguard-outbox-dispatcher",
      serviceVersion: "operational-9.1",
      gitSha: "fixture",
      producedAt: new Date().toISOString(),
    },
    identity: {
      intentId,
      projectId: fixtureProjectId,
      environmentName: "dev",
      pipelineRunId: null,
      destroyOperationId: null,
      infrastructureManifestId: randomUUID(),
      releaseManifestId: randomUUID(),
    },
    routing: {
      lane: "release",
      operation: "execute",
      queue: "deployguard-release-v1",
    },
    idempotency: {
      canonicalKey: digest(`intent:${intentId}`),
      payloadSha256: "0".repeat(64),
      attempt: 1,
      replayOfJobId: null,
    },
    execution: {
      mode: "full",
      resumeFromStage: null,
      reusableCheckpointIds: [],
      invalidatedCheckpointIds: [],
      reasonCodes: ["OPERATIONAL_9_1_FIXTURE"],
      fencingTokenRequired: true,
    },
    trace: {
      correlationId: intentId,
      causationId: null,
      actorUserId: null,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  envelope.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(envelope),
  );
  return envelope;
}

function capability(): V1WorkerCapabilityIdentity {
  return {
    workerId,
    role: "release",
    supportedMessageTypes: ["intent.release.execute"],
    serviceVersion: "operational-9.1",
    gitSha: "fixture",
    heartbeatTtlMs: 5_000,
    metadata: { runtime: "isolated-normal-backend" },
  };
}

async function waitForJobFailure(queue: FrozenProtocolQueue, jobId: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && await job.getState() === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for blocked fixture job");
}

async function markCompletedWithFinality(
  dataSource: DataSource,
  runId: string,
) {
  await dataSource.query(
    `UPDATE project_pipeline_runs
     SET status = 'completed', completed_at = clock_timestamp()
     WHERE id = $1`,
    [runId],
  );
  await dataSource.query(
    `INSERT INTO project_pipeline_events (
       pipeline_run_id, project_id, stage, status, message,
       metadata, occurred_at, ingested_at, source, sequence_number
     ) VALUES (
       $1, $2, 'stable_release', 'success', 'terminal fixture evidence',
       NULL, clock_timestamp(), clock_timestamp(), 'operational_9_1', 1
     )`,
    [runId, fixtureProjectId],
  );
  await dataSource.query(
    `INSERT INTO project_pipeline_job_finalities (
       pipeline_run_id, project_id, bullmq_job_id, decision, evidence_hash
     ) VALUES ($1, $2, $3, 'completed', $4)`,
    [
      runId,
      fixtureProjectId,
      `operational-job-${runId}`,
      digest(`${fixtureProjectId}:${runId}:completed`),
    ],
  );
}

async function expireOwnership(dataSource: DataSource) {
  await dataSource.query(
    `UPDATE project_release_lane_ownerships
     SET status = 'heartbeat_active',
         heartbeat_at = clock_timestamp() - interval '2 minutes',
         expires_at = clock_timestamp() - interval '1 minute'
     WHERE project_id = $1 AND environment_name = 'dev'`,
    [fixtureProjectId],
  );
}

async function verifyRuntime() {
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  app = await startNormalBackend(true, true);
  const dataSource = app.get(DataSource);
  const enforcement = app.get(CrossLaneOwnershipEnforcementService);
  const userId = await seedFixture(dataSource);

  assert.deepEqual(enforcement.rolloutStatus(), {
    state: "allowlisted",
    projectAllowlistCount: 1,
    environmentAllowlistCount: 1,
  });
  assert.equal(
    enforcement.isEnabledForScope(fixtureProjectId, "dev"),
    true,
  );
  assert.equal(
    enforcement.isEnabledForScope(outsideProjectId, "dev"),
    false,
  );
  assert.deepEqual(
    await enforcement.acquireLegacy({
      projectId: outsideProjectId,
      operationId: randomUUID(),
      actorId,
      operationClass: "legacy_full_deployment_run",
    }),
    { enabled: false },
  );
  assert.equal(
    Number((await dataSource.query(
      `SELECT count(*)::int AS count
       FROM project_release_lane_ownerships WHERE project_id = $1`,
      [outsideProjectId],
    ))[0].count),
    0,
  );

  const activeRunId = await insertRun(dataSource, userId);
  const legacyClaim = await enforcement.acquireLegacy({
    projectId: fixtureProjectId,
    operationId: activeRunId,
    actorId,
    operationClass: "legacy_full_deployment_run",
    leaseTtlMs: 5_000,
  });
  await enforcement.linkLegacyRun(legacyClaim, activeRunId);
  const heartbeat = enforcement.startHeartbeat(legacyClaim, {
    leaseTtlMs: 5_000,
    intervalMs: 250,
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(heartbeat.isTrusted(), true);
  assert.equal(await heartbeat.stop(), true);
  const active = await enforcement.inspect(fixtureProjectId, "dev");
  assert.equal(active.enabled, true);
  assert.equal(active.enabled && active.ownership?.ownerLane, "legacy");
  assert.equal(
    active.enabled && active.ownership?.hasLegacyRunCorrelation,
    true,
  );

  const intentId = await insertIntent(dataSource, userId);
  const envelope = releaseEnvelope(intentId);
  const connection = createRedisConnection(new ConfigService({
    REDIS_HOST: process.env.REDIS_HOST ?? "127.0.0.1",
    REDIS_PORT: process.env.REDIS_PORT ?? "6379",
    REDIS_PASSWORD: process.env.REDIS_PASSWORD ?? "",
    REDIS_TLS: process.env.REDIS_TLS ?? "false",
  }));
  frozenQueue = new FrozenProtocolQueue("deployguard-release-v1", {
    connection,
    prefix: redisPrefix,
  });
  const consumer = app.get(InactiveV1BullMqConsumerService);
  consumerSession = await consumer.start({
    capability: capability(),
    connection,
    prefix: redisPrefix,
    concurrency: 1,
    leaseTtlMs: 2_000,
    leaseHeartbeatIntervalMs: 500,
    retryDelayMs: 25,
    heartbeatIntervalMs: 500,
  });
  const jobId = workerEnvelopeJobId(envelope);
  await frozenQueue.add(envelope.protocol.messageType, envelope, {
    jobId,
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  });
  const blockedJob = await waitForJobFailure(frozenQueue, jobId);
  assert.equal(await blockedJob.getState(), "failed");
  assert.equal(
    Number((await dataSource.query(
      `SELECT count(*)::int AS count FROM project_operation_leases
       WHERE project_id = $1`,
      [fixtureProjectId],
    ))[0].count),
    0,
    "v1 must be blocked before its operation lease",
  );
  assert.equal(
    Number((await dataSource.query(
      `SELECT count(*)::int AS count FROM project_release_lane_ownerships
       WHERE project_id = $1 AND status IN ('acquired','heartbeat_active')`,
      [fixtureProjectId],
    ))[0].count),
    1,
  );
  await consumerSession.stop();
  consumerSession = null;
  await frozenQueue.obliterate({ force: true });
  await frozenQueue.close();
  frozenQueue = null;
  assert.equal(await enforcement.releaseLegacyRun(legacyClaim, activeRunId), true);
  await dataSource.query(
    `UPDATE project_pipeline_runs
     SET status = 'completed', completed_at = clock_timestamp()
     WHERE id = $1`,
    [activeRunId],
  );
  await dataSource.query(
    `UPDATE deployment_intents
     SET status = 'failed', failure_code = 'CROSS_LANE_BLOCKED_BY_LEGACY'
     WHERE id = $1`,
    [intentId],
  );

  const recoverableRunId = await insertRun(dataSource, userId);
  const recoverableClaim = await enforcement.acquireLegacy({
    projectId: fixtureProjectId,
    operationId: recoverableRunId,
    actorId,
    operationClass: "legacy_full_deployment_run",
    leaseTtlMs: 5_000,
  });
  await enforcement.linkLegacyRun(recoverableClaim, recoverableRunId);
  await markCompletedWithFinality(dataSource, recoverableRunId);
  await expireOwnership(dataSource);
  const recovered = await enforcement.recoverLegacyRunAfterDurableFinality({
    claim: recoverableClaim,
    pipelineRunId: recoverableRunId,
  });
  assert.deepEqual(recovered, { enabled: true, disposition: "recovered" });
  assert.deepEqual(
    await enforcement.recoverLegacyRunAfterDurableFinality({
      claim: recoverableClaim,
      pipelineRunId: recoverableRunId,
    }),
    { enabled: true, disposition: "already_recovered" },
  );

  const retainedRunId = await insertRun(dataSource, userId);
  const retainedClaim = await enforcement.acquireLegacy({
    projectId: fixtureProjectId,
    operationId: retainedRunId,
    actorId,
    operationClass: "legacy_full_deployment_run",
    leaseTtlMs: 5_000,
  });
  await enforcement.linkLegacyRun(retainedClaim, retainedRunId);
  await dataSource.query(
    `UPDATE project_pipeline_runs SET status = 'cancelled' WHERE id = $1`,
    [retainedRunId],
  );
  await expireOwnership(dataSource);
  assert.deepEqual(
    await enforcement.recoverLegacyRunAfterDurableFinality({
      claim: retainedClaim,
      pipelineRunId: retainedRunId,
    }),
    { enabled: true, disposition: "not_terminal" },
  );
  const beforeRestart = Number((await dataSource.query(
    "SELECT count(*)::int AS count FROM project_release_lane_ownerships",
  ))[0].count);

  await closeNormalBackend(app);
  app = null;
  app = await startNormalBackend(false, false);
  const restartedDataSource = app.get(DataSource);
  const restartedEnforcement = app.get(CrossLaneOwnershipEnforcementService);
  assert.equal(restartedEnforcement.rolloutStatus().state, "disabled");
  assert.deepEqual(
    await restartedEnforcement.inspect(fixtureProjectId, "dev"),
    { enabled: false },
  );
  assert.equal(
    Number((await restartedDataSource.query(
      "SELECT count(*)::int AS count FROM project_release_lane_ownerships",
    ))[0].count),
    beforeRestart,
    "gate rollback must retain ownership history",
  );

  const crossLaneLogs = logger.entries.filter((entry) =>
    entry.includes("CrossLaneOwnershipEnforcementService")
    || entry.includes("event=acquire")
    || entry.includes("event=heartbeat")
    || entry.includes("event=correlated")
    || entry.includes("event=release")
    || entry.includes("event=recovery")
  );
  assert.ok(crossLaneLogs.some((entry) => entry.includes("event=acquire")));
  assert.ok(crossLaneLogs.some((entry) => entry.includes("event=heartbeat")));
  assert.ok(crossLaneLogs.some((entry) => entry.includes("event=correlated")));
  assert.ok(crossLaneLogs.some((entry) => entry.includes("event=release")));
  assert.ok(crossLaneLogs.some((entry) => entry.includes("event=recovery")));
  const forbidden = [
    /password/i,
    /credential/i,
    /lease_id/i,
    /actor_id/i,
    /queue payload/i,
    /repository/i,
    /arn:aws/i,
  ];
  for (const entry of crossLaneLogs) {
    assert.equal(
      forbidden.some((pattern) => pattern.test(entry)),
      false,
      `ownership diagnostic leaked forbidden material: ${entry}`,
    );
  }

  const mainSource = readFileSync(resolve(__dirname, "../src/main.ts"), "utf8");
  assert.equal(mainSource.includes("PipelineWorkerService"), false);
  assert.equal(mainSource.includes("InactiveV1BullMqConsumerService"), false);
  const workerSource = readFileSync(
    resolve(__dirname, "../src/pipeline.worker.ts"),
    "utf8",
  );
  assert.ok(workerSource.includes("PipelineWorkerService"));

  console.log("Operational rollout 9.1 verification passed.");
  console.log(`  schema=${schema}`);
  console.log("  normal Nest starts=2 (allowlisted enabled, then disabled)");
  console.log("  cloud-capable workers started=0");
  console.log("  explicit v1 fixture consumers started=1");
  console.log("  non-allowlisted ownership writes=0");
  console.log("  durable-finality recoveries=1");
  console.log("  status-only cancellation recoveries=0");
  console.log(`  sanitized ownership diagnostics=${crossLaneLogs.length}`);
}

async function cleanup() {
  if (consumerSession) await consumerSession.stop().catch(() => undefined);
  if (frozenQueue) {
    await frozenQueue.obliterate({ force: true }).catch(() => undefined);
    await frozenQueue.close().catch(() => undefined);
  }
  await closeNormalBackend(app).catch(() => undefined);
  if (admin.isInitialized) {
    await admin.query("SET lock_timeout = '2s'; SET statement_timeout = '5s'")
      .catch(() => undefined);
    await bounded(
      admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
      6_000,
    ).catch(() => undefined);
    await bounded(admin.destroy(), 3_000).catch(() => undefined);
  }
  for (const key of changedEnvironmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("bounded_shutdown_timeout")), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

verifyRuntime()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    for (const entry of logger.entries.filter((value) =>
      value.startsWith("error:") || value.startsWith("fatal:")
    )) {
      console.error(entry);
    }
    process.exitCode = 1;
  })
  .finally(cleanup)
  .then(() => process.exit(process.exitCode ?? 0));
