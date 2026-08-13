import { strict as assert } from "node:assert";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import {
  validateWorkerEnvelopeV1,
  workerEnvelopeJobId,
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";

const now = new Date("2026-07-23T12:00:00.000Z");
const envelope: DeployGuardWorkerEnvelopeV1 = {
  protocol: {
    name: "deployguard.worker",
    schemaVersion: 1,
    messageType: "intent.release.execute",
    minimumWorkerProtocol: 1,
    maximumWorkerProtocol: 1,
  },
  producer: {
    service: "deployguard-api",
    serviceVersion: "1.0.0",
    gitSha: "a".repeat(40),
    producedAt: now.toISOString(),
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
    canonicalKey: "b".repeat(64),
    payloadSha256: "",
    attempt: 1,
    replayOfJobId: null,
  },
  execution: {
    mode: "full",
    resumeFromStage: null,
    reusableCheckpointIds: [],
    invalidatedCheckpointIds: [],
    reasonCodes: ["NEW_RELEASE"],
    fencingTokenRequired: true,
  },
  trace: {
    correlationId: "correlation-1",
    causationId: null,
    actorUserId: 1,
  },
  expiresAt: "2026-07-23T12:10:00.000Z",
};
envelope.idempotency.payloadSha256 = canonicalSha256(
  workerEnvelopePayloadForHash(envelope),
);

assert.equal(validateWorkerEnvelopeV1(envelope, now), envelope);
assert.equal(
  workerEnvelopeJobId(envelope),
  `dg:v1:release:${envelope.identity.intentId}:execute:1`,
);
assert.equal(workerEnvelopeJobId(envelope), workerEnvelopeJobId({ ...envelope }));

assert.throws(
  () => validateWorkerEnvelopeV1({
    ...envelope,
    protocol: { ...envelope.protocol, schemaVersion: 2 },
  }, now),
  /Unsupported worker protocol/,
);
assert.throws(
  () => validateWorkerEnvelopeV1({
    ...envelope,
    protocol: { ...envelope.protocol, messageType: "unknown.message" },
  }, now),
  /Unsupported worker message type/,
);
assert.throws(
  () => validateWorkerEnvelopeV1({
    ...envelope,
    idempotency: { ...envelope.idempotency, payloadSha256: "c".repeat(64) },
  }, now),
  /payload hash mismatch/,
);
assert.throws(
  () => validateWorkerEnvelopeV1({
    ...envelope,
    expiresAt: "2026-07-23T11:59:59.000Z",
  }, now),
  /expired/,
);
assert.throws(
  () => validateWorkerEnvelopeV1({ ...envelope, extra: true }, now),
  /invalid shape/,
);

console.log("Worker envelope v1 verification passed");
