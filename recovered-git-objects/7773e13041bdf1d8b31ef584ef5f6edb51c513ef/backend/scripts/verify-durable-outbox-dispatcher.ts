import { strict as assert } from "node:assert";
import {
  assertFrozenQueueRouting,
  isFrozenBullMqJobId,
  outboxRetryDelayMs,
  workerRoleForMessageType,
} from "../src/orchestration-contracts/outbox/outbox-dispatcher.pure";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import { workerEnvelopeJobId } from "../src/orchestration-contracts/contracts/worker-envelope.validator";

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
    intentId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    environmentName: "production",
    pipelineRunId: null,
    destroyOperationId: null,
    infrastructureManifestId: "33333333-3333-4333-8333-333333333333",
    releaseManifestId: "44444444-4444-4444-8444-444444444444",
  },
  routing: {
    lane: "release",
    operation: "execute",
    queue: "deployguard-release-v1",
  },
  idempotency: {
    canonicalKey: "a".repeat(64),
    payloadSha256: "b".repeat(64),
    attempt: 1,
    replayOfJobId: null,
  },
  execution: {
    mode: "full",
    resumeFromStage: null,
    reusableCheckpointIds: [],
    invalidatedCheckpointIds: [],
    reasonCodes: ["RELEASE_SPEC_CHANGED"],
    fencingTokenRequired: true,
  },
  trace: {
    correlationId: "11111111-1111-4111-8111-111111111111",
    causationId: null,
    actorUserId: 1,
  },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
} as DeployGuardWorkerEnvelopeV1;

assert.equal(workerRoleForMessageType("intent.release.execute"), "release");
assert.equal(workerRoleForMessageType("intent.infrastructure.plan"), "infrastructure");
assert.equal(workerRoleForMessageType("intent.infrastructure.apply"), "infrastructure");
assert.equal(workerRoleForMessageType("intent.deletion.execute"), "deletion");
assert.equal(assertFrozenQueueRouting(envelope), "deployguard-release-v1");
assert.throws(
  () => assertFrozenQueueRouting({
    ...envelope,
    routing: { ...envelope.routing, queue: "pipelineQueue" },
  }),
  /frozen lane routing/,
);

const jobId = workerEnvelopeJobId(envelope);
assert.equal(
  jobId,
  "dg:v1:release:11111111-1111-4111-8111-111111111111:execute:1",
);
assert.equal(isFrozenBullMqJobId(jobId), true);
assert.equal(isFrozenBullMqJobId("legacy-job"), false);
assert.equal(outboxRetryDelayMs(1, 1000, 60_000), 1000);
assert.equal(outboxRetryDelayMs(4, 1000, 60_000), 8000);
assert.equal(outboxRetryDelayMs(20, 1000, 60_000), 60_000);

console.log("Durable outbox dispatcher pure protocol verification passed");
