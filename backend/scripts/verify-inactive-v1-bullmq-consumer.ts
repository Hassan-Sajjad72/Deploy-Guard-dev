import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import {
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import {
  assertFrozenBullMqAdapterCompatibility,
  VERIFIED_BULLMQ_VERSION,
} from "../src/orchestration-contracts/outbox/frozen-bullmq-job.adapter";
import {
  canonicalizeV1ConsumerStart,
  expectedV1ConsumerMessages,
  expectedV1ConsumerQueues,
  validateFrozenV1ConsumerJob,
  v1ConsumerResultNeedsRetry,
} from "../src/orchestration-contracts/worker-runtime/v1-bullmq-consumer.pure";
import {
  V1WorkerCapabilityIdentity,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types";

const projectId = "846665b9-ce31-405d-a131-b84457d80932";
const intentId = "8879d4af-9384-4199-b38b-1d9225bcd413";
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
    intentId,
    projectId,
    environmentName: "production",
    pipelineRunId: null,
    destroyOperationId: null,
    infrastructureManifestId: "11111111-1111-4111-8111-111111111111",
    releaseManifestId: "22222222-2222-4222-8222-222222222222",
  },
  routing: {
    lane: "release",
    operation: "execute",
    queue: "deployguard-release-v1",
  },
  idempotency: {
    canonicalKey: createHash("sha256").update("session6.4").digest("hex"),
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
    correlationId: intentId,
    causationId: null,
    actorUserId: 1,
  },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
} as DeployGuardWorkerEnvelopeV1;
envelope.idempotency.payloadSha256 = canonicalSha256(
  workerEnvelopePayloadForHash(envelope),
);

const releaseCapability: V1WorkerCapabilityIdentity = {
  workerId: "session6.4-release-worker",
  role: "release" as const,
  supportedMessageTypes: ["intent.release.execute"],
  serviceVersion: "session6.4",
  gitSha: "test",
  heartbeatTtlMs: 30_000,
};
const canonical = canonicalizeV1ConsumerStart({
  capability: releaseCapability,
  connection: { host: "127.0.0.1", port: 6379 },
  prefix: "session6-4-test",
  scope: {
    projectIds: [projectId],
    environmentNames: ["production"],
  },
});
assert.deepEqual(canonical.queueNames, ["deployguard-release-v1"]);
assert.equal(canonical.concurrency, 1);
assert.equal(canonical.leaseTtlMs, 60_000);
assert.equal(canonical.leaseHeartbeatIntervalMs, 20_000);
assert.equal(canonical.retryDelayMs, 1_000);
assert.deepEqual(canonical.scope, {
  projectIds: [projectId],
  environmentNames: ["production"],
});

const infrastructure = canonicalizeV1ConsumerStart({
  capability: {
    ...releaseCapability,
    workerId: "session6.4-infrastructure-worker",
    role: "infrastructure",
    supportedMessageTypes: [
      "intent.infrastructure.plan",
      "intent.infrastructure.apply",
    ],
  },
  connection: { host: "127.0.0.1", port: 6379 },
  prefix: "session6-4-test",
});
assert.deepEqual(
  infrastructure.capability.supportedMessageTypes,
  ["intent.infrastructure.apply", "intent.infrastructure.plan"],
);
assert.deepEqual(
  expectedV1ConsumerMessages("infrastructure"),
  ["intent.infrastructure.apply", "intent.infrastructure.plan"],
);
assert.deepEqual(
  expectedV1ConsumerQueues("infrastructure"),
  ["deployguard-infrastructure-v1"],
);
const planOnlyInfrastructure = canonicalizeV1ConsumerStart({
  capability: {
    ...releaseCapability,
    workerId: "session6.4-infrastructure-plan-worker",
    role: "infrastructure",
    supportedMessageTypes: ["intent.infrastructure.plan"],
  },
  connection: { host: "127.0.0.1", port: 6379 },
  prefix: "session6-4-test",
  exactMessageTypes: ["intent.infrastructure.plan"],
  scope: { projectIds: [projectId], environmentNames: ["dev"] },
});
assert.deepEqual(planOnlyInfrastructure.messageTypes, ["intent.infrastructure.plan"]);
const applyOnlyInfrastructure = canonicalizeV1ConsumerStart({
  capability: {
    ...releaseCapability,
    workerId: "session6.4-infrastructure-apply-worker",
    role: "infrastructure",
    supportedMessageTypes: ["intent.infrastructure.apply"],
  },
  connection: { host: "127.0.0.1", port: 6379 },
  prefix: "session6-4-test",
  exactMessageTypes: ["intent.infrastructure.apply"],
  scope: { projectIds: [projectId], environmentNames: ["dev"] },
});
assert.deepEqual(applyOnlyInfrastructure.messageTypes, ["intent.infrastructure.apply"]);

assert.throws(
  () => canonicalizeV1ConsumerStart({
    capability: {
      ...releaseCapability,
      workerId: "session6.4-deletion-worker",
      role: "deletion",
      supportedMessageTypes: ["intent.deletion.execute"],
    },
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "session6-4-test",
    scope: { projectIds: [projectId], environmentNames: ["dev"] },
  }),
  /CONSUMER_ROLE_NOT_IMPLEMENTED/,
);

for (const invalid of [
  {
    capability: {
      ...releaseCapability,
      supportedMessageTypes: [],
    },
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "session6-4-test",
  },
  {
    capability: {
      ...infrastructure.capability,
      supportedMessageTypes: ["intent.infrastructure.plan"],
    },
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "session6-4-test",
  },
  {
    capability: releaseCapability,
    connection: null,
    prefix: "session6-4-test",
  },
  {
    capability: releaseCapability,
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "invalid:prefix",
  },
  {
    capability: releaseCapability,
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "session6-4-test",
    concurrency: 0,
  },
  {
    capability: releaseCapability,
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "session6-4-test",
    retryDelayMs: 9,
  },
  {
    capability: releaseCapability,
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "session6-4-test",
    leaseTtlMs: 1_000,
    leaseHeartbeatIntervalMs: 500,
  },
  {
    capability: releaseCapability,
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "session6-4-test",
    exactMessageTypes: ["intent.release.execute"],
  },
  {
    capability: releaseCapability,
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "session6-4-test",
    scope: {
      projectIds: [projectId, "11111111-1111-4111-8111-111111111111"],
      environmentNames: ["production"],
    },
  },
  {
    capability: releaseCapability,
    connection: { host: "127.0.0.1", port: 6379 },
    prefix: "session6-4-test",
    scope: {
      projectIds: [projectId],
      environmentNames: ["dev", "production"],
    },
  },
]) {
  assert.throws(
    () => canonicalizeV1ConsumerStart(invalid as never),
    /CONSUMER_CONFIG_INVALID/,
  );
}

const validJob = {
  queueName: "deployguard-release-v1",
  jobName: "intent.release.execute",
  jobId: workerEnvelopeJobId(envelope),
  data: envelope,
  capability: canonical.capability,
};
assert.equal(
  validateFrozenV1ConsumerJob(validJob).identity.intentId,
  intentId,
);
for (const invalid of [
  { ...validJob, queueName: "deployguard-infrastructure-v1" },
  { ...validJob, jobName: "intent.infrastructure.plan" },
  { ...validJob, jobId: undefined },
  { ...validJob, jobId: `dg:v1:release:${projectId}:execute:1` },
  {
    ...validJob,
    data: {
      ...envelope,
      idempotency: {
        ...envelope.idempotency,
        payloadSha256: "f".repeat(64),
      },
    },
  },
]) {
  assert.throws(
    () => validateFrozenV1ConsumerJob(invalid),
    /CONSUMER_JOB_REJECTED/,
  );
}

assert.equal(v1ConsumerResultNeedsRetry({
  disposition: "released",
  reason: "handler_retryable",
}), true);
for (const reason of [
  "duplicate_delivery_already_owned",
  "duplicate_delivery_owned_elsewhere",
  "ownership_lost",
]) {
  assert.equal(v1ConsumerResultNeedsRetry({
    disposition: "idempotent_no_op",
    reason,
  }), true);
}
for (const reason of ["intent_terminal", "intent_superseded"]) {
  assert.equal(v1ConsumerResultNeedsRetry({
    disposition: "idempotent_no_op",
    reason,
  }), false);
}
assert.equal(v1ConsumerResultNeedsRetry({ disposition: "completed" }), false);
assert.equal(v1ConsumerResultNeedsRetry({ disposition: "failed" }), false);

assert.equal(assertFrozenBullMqAdapterCompatibility(), VERIFIED_BULLMQ_VERSION);

const runtimeRoot = join(
  process.cwd(),
  "src",
  "orchestration-contracts",
  "worker-runtime",
);
const consumerSource = readFileSync(
  join(runtimeRoot, "inactive-v1-bullmq-consumer.service.ts"),
  "utf8",
);
const pureSource = readFileSync(
  join(runtimeRoot, "v1-bullmq-consumer.pure.ts"),
  "utf8",
);
const moduleSource = readFileSync(
  join(
    process.cwd(),
    "src",
    "orchestration-contracts",
    "orchestration-contracts.module.ts",
  ),
  "utf8",
);
assert.match(consumerSource, /autorun:\s*false/);
assert.match(consumerSource, /async start\s*\(/);
assert.match(consumerSource, /worker\.close\(\)/);
assert.doesNotMatch(
  `${consumerSource}\n${pureSource}\n${moduleSource}`,
  /OnModuleInit|OnApplicationBootstrap|@Cron|ScheduleModule/,
);
assert.doesNotMatch(moduleSource, /\.start\s*\(/);
assert.doesNotMatch(
  consumerSource,
  /ConfigService|createRedisConnection|REDIS_HOST|REDIS_PORT/,
);
assert.doesNotMatch(
  `${consumerSource}\n${pureSource}`,
  /from ["'][^"']*(terraform|ecs|aws|docker|pipeline-worker|pipeline\.worker)/i,
);
assert.doesNotMatch(
  `${consumerSource}\n${pureSource}`,
  /Controller|@aws-sdk|child_process/,
);

console.log("Inactive v1 BullMQ consumer pure verification passed");
