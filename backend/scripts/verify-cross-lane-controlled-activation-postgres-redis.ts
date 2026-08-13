import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { CreateReleaseLaneOwnerships1760000043000 } from "../src/migrations/1760000043000-CreateReleaseLaneOwnerships";
import { AddReleaseLaneOwnershipCorrelation1760000044000 } from "../src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation";
import { CreatePipelineJobFinalities1760000046000 } from "../src/migrations/1760000046000-CreatePipelineJobFinalities";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import {
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { FrozenProtocolQueue } from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import {
  CrossLaneOwnershipClaim,
  CrossLaneOwnershipEnforcementError,
  CrossLaneOwnershipEnforcementService,
} from "../src/orchestration-contracts/release-lane/cross-lane-ownership-enforcement.service";
import { InactiveReleaseLaneCorrelationService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-correlation.service";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";
import { InactiveV1BullMqConsumerService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service";
import { V1WorkerCapabilityIdentity } from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types";
import { V1FencedInvocationResult } from "../src/orchestration-contracts/worker-runtime/v1-fenced-invocation.types";
import { PipelineJobFinalityService } from "../src/projects/pipeline/pipeline-job-finality.service";
import { ProjectPipelineJobFinality } from "../src/projects/pipeline/project-pipeline-job-finality.entity";
import {
  PipelineRunStatus,
  ProjectPipelineRun,
} from "../src/projects/project-pipeline-run.entity";
import { PipelineService } from "../src/projects/pipeline/pipeline.service";
import { createRedisConnection } from "../src/projects/pipeline/redis.config";
import { PreflightValidationStatus } from "../src/projects/project-preflight-report.entity";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const schema = `session8_17_activation_${suffix}`;
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
  migrations: [],
  synchronize: false,
  logging: false,
  extra: {
    ...(base.extra || {}),
    options: `-c search_path=${schema},public`,
  },
} as DataSourceOptions);

const redisConnection = createRedisConnection(new ConfigService({
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: "6379",
  REDIS_TLS: "false",
}));
const redisQueues: Array<Queue | FrozenProtocolQueue> = [];
const consumers: InactiveV1BullMqConsumerService[] = [];

class GateConfig {
  constructor(private readonly enabled: boolean) {}
  get(key: string) {
    if (key === "TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED") {
      return this.enabled ? "true" : undefined;
    }
    if (key === "LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED") {
      return "true";
    }
    return undefined;
  }
}

const projectIds = {
  race: "11111111-1111-4111-8111-111111111111",
  legacyBlocked: "22222222-2222-4222-8222-222222222222",
  v1Blocked: "33333333-3333-4333-8333-333333333333",
  finality: "44444444-4444-4444-8444-444444444444",
  cancellation: "55555555-5555-4555-8555-555555555555",
  rollback: "66666666-6666-4666-8666-666666666666",
  heartbeat: "77777777-7777-4777-8777-777777777777",
  disabled: "88888888-8888-4888-8888-888888888888",
  legacyAllowed: "99999999-9999-4999-8999-999999999999",
  approval: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  stateWait: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  completed: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};

function enforcement(enabled = true) {
  return new CrossLaneOwnershipEnforcementService(
    new GateConfig(enabled) as never,
    new InactiveReleaseLaneOwnershipService(dataSource),
    new InactiveReleaseLaneCorrelationService(dataSource),
  );
}

async function createSchema() {
  await dataSource.query(`
    CREATE TABLE projects (id uuid PRIMARY KEY);
    CREATE TABLE project_pipeline_runs (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL,
      status varchar(64) NOT NULL,
      current_stage varchar(160),
      triggered_by_user_id integer,
      metadata jsonb,
      completed_at timestamptz,
      failed_at timestamptz
    );
    CREATE TABLE project_pipeline_events (
      id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
      pipeline_run_id uuid NOT NULL,
      project_id uuid NOT NULL,
      stage varchar NOT NULL,
      status varchar NOT NULL,
      message text NOT NULL DEFAULT '',
      metadata jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      ingested_at timestamptz NOT NULL DEFAULT now(),
      duration_ms bigint,
      source varchar NOT NULL DEFAULT 'session8.17',
      sequence_number integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE project_rollback_records (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL
    );
    CREATE TABLE deployment_intents (
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      status varchar(32) NOT NULL
    );
    CREATE TABLE project_operation_leases (
      id uuid PRIMARY KEY,
      intent_id uuid,
      project_id uuid NOT NULL,
      environment_name varchar(64) NOT NULL,
      owner_worker_id varchar(160),
      fencing_token bigint,
      status varchar(24) NOT NULL,
      expires_at timestamptz NOT NULL
    );
  `);
  for (const projectId of Object.values(projectIds)) {
    await dataSource.query("INSERT INTO projects (id) VALUES ($1)", [projectId]);
  }
  const runner = dataSource.createQueryRunner();
  try {
    await new CreateReleaseLaneOwnerships1760000043000().up(runner);
    await new AddReleaseLaneOwnershipCorrelation1760000044000().up(runner);
    await new CreatePipelineJobFinalities1760000046000().up(runner);
  } finally {
    await runner.release();
  }
}

async function insertIntent(projectId: string, status = "enqueued") {
  const intentId = randomUUID();
  await dataSource.query(
    `INSERT INTO deployment_intents
       (id, project_id, environment_name, status)
     VALUES ($1, $2, 'dev', $3)`,
    [intentId, projectId, status],
  );
  return intentId;
}

async function insertRun(
  projectId: string,
  status: PipelineRunStatus,
  terminal?: "completed" | "failed",
) {
  const runId = randomUUID();
  await dataSource.query(
    `INSERT INTO project_pipeline_runs
       (id, project_id, status, completed_at, failed_at)
     VALUES ($1, $2, $3,
       CASE WHEN $4 = 'completed' THEN clock_timestamp() - interval '1 second' END,
       CASE WHEN $4 = 'failed' THEN clock_timestamp() - interval '1 second' END)`,
    [runId, projectId, status, terminal ?? null],
  );
  return runId;
}

async function activeOwnership(projectId: string) {
  const [row] = await dataSource.query(
    `SELECT owner_lane AS lane, lease_id AS "leaseId",
            fencing_token::text AS token, status
     FROM project_release_lane_ownerships
     WHERE project_id = $1 AND environment_name = 'dev'`,
    [projectId],
  );
  return row ?? null;
}

function releaseClaim(
  service: CrossLaneOwnershipEnforcementService,
  claim: CrossLaneOwnershipClaim,
  input: { intentId?: string; runId?: string },
) {
  if (input.intentId) {
    return service.releaseV1(claim, {
      intentId: input.intentId,
      operationLeaseId: null,
    });
  }
  if (input.runId) return service.releaseLegacyRun(claim, input.runId);
  return service.release(claim);
}

async function verifyTransactionalRace() {
  const intentId = await insertIntent(projectIds.race);
  const runId = randomUUID();
  const service = enforcement();
  const [legacy, v1] = await Promise.allSettled([
    service.acquireLegacy({
      projectId: projectIds.race,
      operationId: runId,
      actorId: "user:17",
      operationClass: "legacy_full_deployment_run",
    }),
    service.acquireV1({
      projectId: projectIds.race,
      environmentName: "dev",
      intentId,
      actorId: "worker:v1-race",
      requestFingerprint: "a".repeat(64),
    }),
  ]);
  assert.equal(
    [legacy, v1].filter((result) => result.status === "fulfilled").length,
    1,
    "same-scope legacy/v1 race must yield one owner",
  );
  const loser = [legacy, v1].find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  assert.ok(loser?.reason instanceof CrossLaneOwnershipEnforcementError);
  if (legacy.status === "fulfilled") {
    await service.release(legacy.value);
  } else if (v1.status === "fulfilled") {
    await releaseClaim(service, v1.value, { intentId });
  }
}

function pipelineService(
  projectId: string,
  queue: Queue,
  service: CrossLaneOwnershipEnforcementService,
) {
  const contractHash = "c".repeat(64);
  let queueCalls = 0;
  const runRepository = {
    findOne: async (input?: {
      where?: { id?: string; projectId?: string };
    }) => {
      const rows = await dataSource.query(
        `SELECT id, project_id AS "projectId", status,
                current_stage AS "currentStage", metadata,
                cross_lane_owner_lane AS "crossLaneOwnerLane",
                cross_lane_owner_environment_name AS "crossLaneOwnerEnvironmentName",
                cross_lane_owner_lease_id AS "crossLaneOwnerLeaseId",
                cross_lane_owner_actor_id AS "crossLaneOwnerActorId",
                cross_lane_owner_fencing_token::text AS "crossLaneOwnerFencingToken"
         FROM project_pipeline_runs
         WHERE project_id = $1
           AND ($2::uuid IS NULL OR id = $2)
         ORDER BY id LIMIT 1`,
        [
          input?.where?.projectId ?? projectId,
          input?.where?.id ?? null,
        ],
      );
      return rows[0] ?? null;
    },
    create: (value: Record<string, unknown>) => value,
    save: async (value: Record<string, unknown>) => {
      const id = String(value.id ?? randomUUID());
      const existing = await dataSource.query(
        "SELECT 1 FROM project_pipeline_runs WHERE id = $1",
        [id],
      );
      if (existing.length === 0) {
        await dataSource.query(
          `INSERT INTO project_pipeline_runs (id, project_id, status)
           VALUES ($1, $2, $3)`,
          [id, projectId, value.status],
        );
      } else {
        await dataSource.query(
          `UPDATE project_pipeline_runs
           SET status = $2, current_stage = $3, metadata = $4::jsonb
           WHERE id = $1`,
          [
            id,
            value.status,
            value.currentStage ?? null,
            JSON.stringify(value.metadata ?? null),
          ],
        );
      }
      return {
        ...value,
        id,
        projectId,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    remove: async (value: { id: string }) => {
      await dataSource.query(
        "DELETE FROM project_pipeline_runs WHERE id = $1",
        [value.id],
      );
    },
    update: async (
      criteria: { id: string },
      patch: Record<string, unknown>,
    ) => {
      const result = await dataSource.query(
        `UPDATE project_pipeline_runs
         SET status = $2, current_stage = $3, metadata = $4::jsonb
         WHERE id = $1`,
        [
          criteria.id,
          patch.status,
          patch.currentStage ?? null,
          JSON.stringify(patch.metadata ?? null),
        ],
      );
      return { affected: Array.isArray(result) ? Number(result[1] ?? 0) : 0 };
    },
  };
  const queueAdapter = {
    add: async (...args: Parameters<Queue["add"]>) => {
      queueCalls += 1;
      return queue.add(...args);
    },
  };
  const instance = new PipelineService(
    runRepository as never,
    {
      create: (value: unknown) => value,
      save: async (value: unknown) => value,
    } as never,
    {
      findOne: async () => ({
        id: randomUUID(),
        inputFingerprint: contractHash,
        validationStatus: PreflightValidationStatus.PASSED,
        errors: [],
      }),
    } as never,
    {
      requireForProject: async () => ({
        contractHash,
        detectionProfileId: randomUUID(),
      }),
      assertDeployable: () => undefined,
    } as never,
    queueAdapter as never,
    {
      getProjectEntityForManage: async () => ({
        id: projectId,
        repositoryUrl: "https://github.com/deployguard/fixture",
        repositoryFullName: "deployguard/fixture",
        targetBranch: "main",
      }),
    } as never,
    { record: async () => undefined } as never,
    {
      sanitize: (value: unknown) => String(value ?? ""),
      sanitizeMetadata: (value: unknown) => value,
    } as never,
    { recordUserAction: async () => undefined } as never,
    {
      createRunConfigurationSnapshot: async () => ({
        id: randomUUID(),
        configurationFingerprint: "f".repeat(64),
        createdAt: new Date(),
      }),
    } as never,
    { evaluate: async () => ({ eligible: false }) } as never,
    undefined,
    service,
  );
  return { instance, queueCalls: () => queueCalls };
}

async function verifyAcceptedLegacyReplayAndWaitResumes() {
  const service = enforcement();
  const prefix = `session8-17-legacy-allowed-${suffix}`;
  const queue = new Queue(`legacy-allowed-${suffix}`, {
    connection: redisConnection,
    prefix,
  });
  redisQueues.push(queue);
  const legacy = pipelineService(projectIds.legacyAllowed, queue, service);
  const first = await legacy.instance.startRun(
    { id: 17 } as never,
    projectIds.legacyAllowed,
    {},
  );
  const replay = await legacy.instance.startRun(
    { id: 17 } as never,
    projectIds.legacyAllowed,
    {},
  );
  assert.equal(replay.id, first.id);
  assert.equal(legacy.queueCalls(), 1);
  assert.equal((await queue.getJobCounts()).waiting, 1);
  const [run] = await dataSource.query(
    `SELECT id, project_id AS "projectId",
            cross_lane_owner_lane AS "crossLaneOwnerLane",
            cross_lane_owner_environment_name AS "crossLaneOwnerEnvironmentName",
            cross_lane_owner_lease_id AS "crossLaneOwnerLeaseId",
            cross_lane_owner_actor_id AS "crossLaneOwnerActorId",
            cross_lane_owner_fencing_token::text AS "crossLaneOwnerFencingToken"
     FROM project_pipeline_runs WHERE id = $1`,
    [first.id],
  );
  const claim = service.legacyClaimFromRun(run as ProjectPipelineRun);
  assert.equal(await service.releaseLegacyRun(claim, first.id), true);

  const approvalRunId = await insertRun(
    projectIds.approval,
    PipelineRunStatus.APPLY_DISABLED,
  );
  await dataSource.query(
    `UPDATE project_pipeline_runs
     SET current_stage = 'terraform_apply_approval_required',
         metadata = '{}'::jsonb
     WHERE id = $1`,
    [approvalRunId],
  );
  const approvalPrefix = `session8-17-approval-${suffix}`;
  const approvalQueue = new Queue(`legacy-approval-${suffix}`, {
    connection: redisConnection,
    prefix: approvalPrefix,
  });
  redisQueues.push(approvalQueue);
  const approval = pipelineService(
    projectIds.approval,
    approvalQueue,
    service,
  );
  (approval.instance as unknown as {
    terraformApprovalStates: {
      evaluate: () => Promise<Record<string, unknown>>;
    };
  }).terraformApprovalStates = {
    evaluate: async () => ({
      eligible: true,
      blockedReason: null,
      planFingerprint: "p".repeat(64),
      contractFingerprint: "c".repeat(64),
      terraformInputFingerprint: "t".repeat(64),
    }),
  };
  await approval.instance.approveTerraformApply(
    { id: 17 } as never,
    projectIds.approval,
    approvalRunId,
  );
  assert.equal(approval.queueCalls(), 1);
  assert.equal((await activeOwnership(projectIds.approval)).lane, "legacy");

  const stateRunId = await insertRun(
    projectIds.stateWait,
    PipelineRunStatus.WAITING_FOR_STATE_LOCK,
  );
  const stateClaim = await service.acquireLegacy({
    projectId: projectIds.stateWait,
    operationId: stateRunId,
    actorId: "worker:state-wait",
    operationClass: "legacy_state_lock_resume",
  });
  await service.linkLegacyRun(stateClaim, stateRunId);
  if (!stateClaim.enabled) throw new Error("Expected state-wait ownership");
  const firstToken = BigInt(stateClaim.fence.ownershipFencingToken);
  assert.equal(await service.releaseLegacyRun(stateClaim, stateRunId), true);
  const resumed = await service.acquireLegacy({
    projectId: projectIds.stateWait,
    operationId: stateRunId,
    actorId: "worker:state-wait",
    operationClass: "legacy_state_lock_resume",
  });
  if (!resumed.enabled) throw new Error("Expected state-wait resume ownership");
  assert.ok(BigInt(resumed.fence.ownershipFencingToken) > firstToken);
  await service.linkLegacyRun(resumed, stateRunId);
  assert.equal(await service.releaseLegacyRun(resumed, stateRunId), true);
}

async function verifyRealLegacyEntryBlockedBeforeRedisPublication() {
  const service = enforcement();
  const intentId = await insertIntent(projectIds.legacyBlocked);
  const v1 = await service.acquireV1({
    projectId: projectIds.legacyBlocked,
    environmentName: "dev",
    intentId,
    actorId: "worker:v1-holder",
    requestFingerprint: "b".repeat(64),
  });
  const prefix = `session8-17-legacy-${suffix}`;
  const queue = new Queue(`legacy-${suffix}`, {
    connection: redisConnection,
    prefix,
  });
  redisQueues.push(queue);
  const legacy = pipelineService(projectIds.legacyBlocked, queue, service);
  await assert.rejects(
    () => legacy.instance.startRun(
      { id: 17 } as never,
      projectIds.legacyBlocked,
      {},
    ),
    (error: unknown) => Boolean(
      error && typeof error === "object"
      && "getResponse" in error
      && typeof (error as { getResponse?: unknown }).getResponse === "function"
      && ((error as { getResponse: () => { code?: string } }).getResponse())
        .code === "LEGACY_DEPLOYMENT_EXECUTION_RETIRED",
    ),
  );
  assert.equal(legacy.queueCalls(), 0);
  assert.equal((await queue.getJobCounts()).waiting, 0);
  assert.equal(
    Number((await dataSource.query(
      "SELECT count(*) AS count FROM project_pipeline_runs WHERE project_id = $1",
      [projectIds.legacyBlocked],
    ))[0].count),
    0,
  );
  await releaseClaim(service, v1, { intentId });
}

function releaseEnvelope(input: {
  projectId: string;
  intentId: string;
}) {
  const infrastructureManifestId = randomUUID();
  const releaseManifestId = randomUUID();
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
      serviceVersion: "session8.17-test",
      gitSha: "test",
      producedAt: new Date().toISOString(),
    },
    identity: {
      intentId: input.intentId,
      projectId: input.projectId,
      environmentName: "dev",
      pipelineRunId: null,
      destroyOperationId: null,
      infrastructureManifestId,
      releaseManifestId,
    },
    routing: {
      lane: "release",
      operation: "execute",
      queue: "deployguard-release-v1",
    },
    idempotency: {
      canonicalKey: createHash("sha256")
        .update(`intent:${input.intentId}`)
        .digest("hex"),
      payloadSha256: "0".repeat(64),
      attempt: 1,
      replayOfJobId: null,
    },
    execution: {
      mode: "full",
      resumeFromStage: null,
      reusableCheckpointIds: [],
      invalidatedCheckpointIds: [],
      reasonCodes: ["SESSION_8_17_TEST"],
      fencingTokenRequired: true,
    },
    trace: {
      correlationId: input.intentId,
      causationId: null,
      actorUserId: 17,
    },
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  } as DeployGuardWorkerEnvelopeV1;
  envelope.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(envelope),
  );
  return envelope;
}

function capability(): V1WorkerCapabilityIdentity {
  return {
    workerId: `session8.17-worker:${suffix}`,
    role: "release",
    supportedMessageTypes: ["intent.release.execute"],
    serviceVersion: "session8.17-test",
    gitSha: "test",
    heartbeatTtlMs: 30_000,
    metadata: { runtime: "controlled-activation" },
  };
}

function consumer(
  service: CrossLaneOwnershipEnforcementService,
  onInvoke: (intentId: string) => Promise<void> | void,
) {
  const invocation = {
    invoke: async (input: {
      workerId: string;
      envelope: DeployGuardWorkerEnvelopeV1;
    }): Promise<V1FencedInvocationResult> => {
      await onInvoke(input.envelope.identity.intentId);
      return {
        disposition: "idempotent_no_op",
        reason: "intent_terminal",
        workerId: input.workerId,
        intentId: input.envelope.identity.intentId,
        projectId: input.envelope.identity.projectId,
        messageType: "intent.release.execute",
      };
    },
  };
  const capabilities = {
    startHeartbeatSession: async () => ({
      isActive: () => true,
      lastFailureCode: () => null,
      stop: async () => undefined,
    }),
  };
  const value = new InactiveV1BullMqConsumerService(
    invocation as never,
    capabilities as never,
    undefined,
    service,
  );
  consumers.push(value);
  return value;
}

async function addFrozenJob(
  queue: FrozenProtocolQueue,
  envelope: DeployGuardWorkerEnvelopeV1,
) {
  return queue.add(envelope.protocol.messageType, envelope, {
    jobId: workerEnvelopeJobId(envelope),
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  });
}

async function waitForState(
  queue: FrozenProtocolQueue,
  jobId: string,
  expected: "completed" | "failed",
) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job && await job.getState() === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const job = await queue.getJob(jobId);
  throw new Error(
    `Timed out waiting for ${expected}; got ${
      job ? await job.getState() : "missing"
    }`,
  );
}

async function verifyInactiveV1ConsumerBoundary() {
  const service = enforcement();
  const legacyRunId = await insertRun(
    projectIds.v1Blocked,
    PipelineRunStatus.QUEUED,
  );
  const legacy = await service.acquireLegacy({
    projectId: projectIds.v1Blocked,
    operationId: legacyRunId,
    actorId: "user:18",
    operationClass: "legacy_full_deployment_run",
  });
  await service.linkLegacyRun(legacy, legacyRunId);
  const blockedIntentId = await insertIntent(projectIds.v1Blocked);
  const blockedEnvelope = releaseEnvelope({
    projectId: projectIds.v1Blocked,
    intentId: blockedIntentId,
  });
  const blockedPrefix = `session8-17-v1-blocked-${suffix}`;
  const blockedQueue = new FrozenProtocolQueue("deployguard-release-v1", {
    connection: redisConnection,
    prefix: blockedPrefix,
  });
  redisQueues.push(blockedQueue);
  let blockedInvocations = 0;
  const blockedConsumer = consumer(service, () => {
    blockedInvocations += 1;
  });
  const blockedSession = await blockedConsumer.start({
    capability: capability(),
    connection: redisConnection,
    prefix: blockedPrefix,
    concurrency: 1,
    leaseTtlMs: 5_000,
    leaseHeartbeatIntervalMs: 1_000,
    retryDelayMs: 25,
    heartbeatIntervalMs: 500,
  });
  await addFrozenJob(blockedQueue, blockedEnvelope);
  await waitForState(
    blockedQueue,
    workerEnvelopeJobId(blockedEnvelope),
    "failed",
  );
  assert.equal(blockedInvocations, 0, "blocked v1 must not invoke its handler");
  await blockedSession.stop();
  await service.releaseLegacyRun(legacy, legacyRunId);

  const allowedProjectId = projectIds.disabled;
  const allowedIntentId = await insertIntent(allowedProjectId);
  const allowedEnvelope = releaseEnvelope({
    projectId: allowedProjectId,
    intentId: allowedIntentId,
  });
  const allowedPrefix = `session8-17-v1-allowed-${suffix}`;
  const allowedQueue = new FrozenProtocolQueue("deployguard-release-v1", {
    connection: redisConnection,
    prefix: allowedPrefix,
  });
  redisQueues.push(allowedQueue);
  let sawCrossLaneBeforeInvocation = false;
  const allowedConsumer = consumer(service, async () => {
    const row = await activeOwnership(allowedProjectId);
    sawCrossLaneBeforeInvocation =
      row?.lane === "v1"
      && ["acquired", "heartbeat_active"].includes(row.status);
  });
  const allowedSession = await allowedConsumer.start({
    capability: capability(),
    connection: redisConnection,
    prefix: allowedPrefix,
    concurrency: 1,
    leaseTtlMs: 5_000,
    leaseHeartbeatIntervalMs: 1_000,
    retryDelayMs: 25,
    heartbeatIntervalMs: 500,
  });
  await addFrozenJob(allowedQueue, allowedEnvelope);
  await waitForState(
    allowedQueue,
    workerEnvelopeJobId(allowedEnvelope),
    "completed",
  );
  assert.equal(sawCrossLaneBeforeInvocation, true);
  assert.equal((await activeOwnership(allowedProjectId)).status, "released");
  await allowedSession.stop();
}

async function verifyFencingHeartbeatAndCrashRules() {
  const service = enforcement();
  const missing = {
    id: randomUUID(),
    projectId: projectIds.heartbeat,
  } as ProjectPipelineRun;
  assert.throws(
    () => service.legacyClaimFromRun(missing),
    (error: unknown) =>
      error instanceof CrossLaneOwnershipEnforcementError
      && error.code === "CROSS_LANE_OWNERSHIP_LOST",
  );

  const claim = await service.acquireLegacy({
    projectId: projectIds.heartbeat,
    operationId: randomUUID(),
    actorId: "worker:heartbeat",
    operationClass: "legacy_worker_execution",
    leaseTtlMs: 5_000,
  });
  if (!claim.enabled) throw new Error("Expected enabled heartbeat claim");
  assert.equal(await service.renew(claim, 5_000), true);
  const stale = {
    enabled: true as const,
    fence: {
      ...claim.fence,
      ownershipFencingToken: String(
        BigInt(claim.fence.ownershipFencingToken) + 1n,
      ),
    },
  };
  assert.equal(await service.renew(stale, 5_000), false);
  assert.equal(await service.release(stale), false);

  const heartbeat = service.startHeartbeat(claim, {
    leaseTtlMs: 5_000,
    intervalMs: 250,
  });
  await dataSource.query(
    `UPDATE project_release_lane_ownerships
     SET status = 'expired', expires_at = clock_timestamp() - interval '1 second'
     WHERE project_id = $1`,
    [projectIds.heartbeat],
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(await heartbeat.stop(), false);
  assert.equal(await service.release(claim), false);

  const replacement = await service.acquireLegacy({
    projectId: projectIds.heartbeat,
    operationId: randomUUID(),
    actorId: "worker:replacement",
    operationClass: "legacy_worker_execution",
    leaseTtlMs: 5_000,
  });
  if (!replacement.enabled) throw new Error("Expected replacement claim");
  assert.ok(
    BigInt(replacement.fence.ownershipFencingToken)
      > BigInt(claim.fence.ownershipFencingToken),
  );
  assert.equal(await service.release(replacement), true);
}

async function acquireLinkedRun(
  projectId: string,
  status: PipelineRunStatus,
  terminal?: "completed" | "failed",
) {
  const service = enforcement();
  const runId = await insertRun(projectId, status, terminal);
  const claim = await service.acquireLegacy({
    projectId,
    operationId: runId,
    actorId: `worker:${runId}`,
    operationClass: "legacy_worker_execution",
  });
  await service.linkLegacyRun(claim, runId);
  return { service, runId, claim };
}

async function verifyDurableTerminalAndNonTerminalRules() {
  const retrying = await acquireLinkedRun(
    projectIds.finality,
    PipelineRunStatus.FAILED,
    "failed",
  );
  await dataSource.query(
    `INSERT INTO project_pipeline_events
       (pipeline_run_id, project_id, stage, status, occurred_at)
     VALUES ($1, $2, 'docker_build', 'failed', clock_timestamp())`,
    [retrying.runId, projectIds.finality],
  );
  const finality = new PipelineJobFinalityService(
    dataSource,
    new GateConfig(true) as never,
    dataSource.getRepository(ProjectPipelineJobFinality),
    undefined,
    retrying.service,
  );
  const notExhausted = await finality.recordFailedAfterRetriesExhausted({
    pipelineRunId: retrying.runId,
    bullmqJobId: "session8-17-retry",
    queueState: "failed",
    attemptsMade: 1,
    configuredAttempts: 2,
  });
  assert.equal((notExhausted as { disposition: string }).disposition, "not_eligible");
  assert.equal((await activeOwnership(projectIds.finality)).status, "acquired");
  const exhausted = await finality.recordFailedAfterRetriesExhausted({
    pipelineRunId: retrying.runId,
    bullmqJobId: "session8-17-retry",
    queueState: "failed",
    attemptsMade: 2,
    configuredAttempts: 2,
  });
  assert.equal((exhausted as { disposition: string }).disposition, "recorded");
  assert.equal((await activeOwnership(projectIds.finality)).status, "released");

  const completed = await acquireLinkedRun(
    projectIds.completed,
    PipelineRunStatus.COMPLETED,
    "completed",
  );
  await dataSource.query(
    `INSERT INTO project_pipeline_events
       (pipeline_run_id, project_id, stage, status, occurred_at)
     VALUES ($1, $2, 'completed', 'success', clock_timestamp())`,
    [completed.runId, projectIds.completed],
  );
  const completedFinality = new PipelineJobFinalityService(
    dataSource,
    new GateConfig(true) as never,
    dataSource.getRepository(ProjectPipelineJobFinality),
    undefined,
    completed.service,
  );
  const completedResult = await completedFinality.recordCompleted({
    pipelineRunId: completed.runId,
    bullmqJobId: "session8-17-completed",
  });
  assert.equal(
    (completedResult as { disposition: string }).disposition,
    "recorded",
  );
  assert.equal((await activeOwnership(projectIds.completed)).status, "released");

  const cancelled = await acquireLinkedRun(
    projectIds.cancellation,
    PipelineRunStatus.CANCELLED,
  );
  assert.equal((await activeOwnership(projectIds.cancellation)).status, "acquired");
  const cancelledFinality = await finality.recordCompleted({
    pipelineRunId: cancelled.runId,
    bullmqJobId: "session8-17-cancelled",
  });
  assert.equal(
    (cancelledFinality as { disposition: string }).disposition,
    "not_eligible",
  );
  assert.equal(
    (await activeOwnership(projectIds.cancellation)).status,
    "acquired",
    "accepted cancellation must not prove active work stopped",
  );

  const rollbackId = randomUUID();
  await dataSource.query(
    "INSERT INTO project_rollback_records (id, project_id) VALUES ($1, $2)",
    [rollbackId, projectIds.rollback],
  );
  const rollback = await enforcement().acquireLegacy({
    projectId: projectIds.rollback,
    operationId: rollbackId,
    actorId: `legacy-rollback:${rollbackId}`,
    operationClass: "legacy_rollback",
  });
  await enforcement().linkLegacyRollback(rollback, rollbackId);
  assert.equal(
    await enforcement().releaseLegacyRollback(rollback, rollbackId),
    true,
    "durably successful rollback may release",
  );
  const uncertainRollbackId = randomUUID();
  await dataSource.query(
    "INSERT INTO project_rollback_records (id, project_id) VALUES ($1, $2)",
    [uncertainRollbackId, projectIds.rollback],
  );
  const uncertain = await enforcement().acquireLegacy({
    projectId: projectIds.rollback,
    operationId: uncertainRollbackId,
    actorId: `legacy-rollback:${uncertainRollbackId}`,
    operationClass: "legacy_rollback",
  });
  await enforcement().linkLegacyRollback(uncertain, uncertainRollbackId);
  assert.equal((await activeOwnership(projectIds.rollback)).status, "acquired");
}

async function verifyDisabledAndStaticExclusions() {
  const disabled = enforcement(false);
  const before = Number((await dataSource.query(
    "SELECT count(*) AS count FROM project_release_lane_ownerships",
  ))[0].count);
  assert.deepEqual(await disabled.acquireLegacy({
    projectId: projectIds.disabled,
    operationId: randomUUID(),
    actorId: "user:disabled",
    operationClass: "legacy_full_deployment_run",
  }), { enabled: false });
  assert.equal(
    Number((await dataSource.query(
      "SELECT count(*) AS count FROM project_release_lane_ownerships",
    ))[0].count),
    before,
  );

  const worker = readFileSync(resolve(
    __dirname,
    "../src/projects/pipeline/pipeline-worker.service.ts",
  ), "utf8");
  const consumerSource = readFileSync(resolve(
    __dirname,
    "../src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service.ts",
  ), "utf8");
  const invocationSource = readFileSync(resolve(
    __dirname,
    "../src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service.ts",
  ), "utf8");
  const lifecycle = readFileSync(resolve(
    __dirname,
    "../src/infrastructure-lifecycle/infrastructure-lifecycle.service.ts",
  ), "utf8");
  assert.doesNotMatch(
    worker.slice(worker.indexOf("function releasesCrossLaneOwnership")),
    /PipelineRunStatus\.(FAILED|STORAGE_FAILED|CANCELLED|ROLLBACK_FAILED|ECS_DEPLOYMENT_FAILED)/,
  );
  assert.ok(
    consumerSource.indexOf("await this.acquireCrossLane(")
      < consumerSource.indexOf("await this.invocation.invoke("),
  );
  assert.ok(
    invocationSource.indexOf("await this.ownership.claim(")
      < invocationSource.indexOf("await this.crossLane?.attachV1OperationLease("),
  );
  assert.match(
    consumerSource,
    /if \(envelope\.routing\.lane === "deletion"\) return \{ enabled: false \}/,
  );
  assert.doesNotMatch(lifecycle, /CrossLaneOwnershipEnforcementService/);
}

async function cleanup() {
  await Promise.allSettled(consumers.map((value) => value.stop()));
  for (const queue of redisQueues) {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
  }
}

async function main() {
  await admin.initialize();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await dataSource.initialize();
  try {
    await createSchema();
    await verifyTransactionalRace();
    // Legacy replay/resume mutation was retired. The next regression proves
    // the real command boundary remains unreachable before Redis publication.
    await verifyRealLegacyEntryBlockedBeforeRedisPublication();
    await verifyInactiveV1ConsumerBoundary();
    await verifyFencingHeartbeatAndCrashRules();
    await verifyDurableTerminalAndNonTerminalRules();
    await verifyDisabledAndStaticExclusions();
    console.log(
      "Session 8.17 controlled cross-lane activation PostgreSQL/Redis verification passed",
    );
  } finally {
    await cleanup();
    if (dataSource.isInitialized) await dataSource.destroy();
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.destroy();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
