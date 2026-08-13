import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { DeployGuardWorkerEnvelopeV1 } from "../src/orchestration-contracts/contracts/worker-envelope.types";
import {
  workerEnvelopePayloadForHash,
} from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import {
  assertFrozenQueueRouting,
  workerRoleForMessageType,
} from "../src/orchestration-contracts/outbox/outbox-dispatcher.pure";
import {
  EXECUTABLE_V1_MESSAGE_TYPES,
  ExecutableV1MessageType,
  V1PlaceholderHandler,
  V1WorkerIntentSnapshot,
} from "../src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types";
import { canonicalizeV1WorkerCapability } from "../src/orchestration-contracts/worker-runtime/v1-worker-capability.pure";
import {
  buildV1PlaceholderHandlerRegistry,
  V1_PLACEHOLDER_HANDLERS,
} from "../src/orchestration-contracts/worker-runtime/v1-placeholder-handlers";

const intent: V1WorkerIntentSnapshot = {
  id: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  environmentName: "production",
  classification: "release_only",
  status: "enqueued",
  canonicalIdempotencyKey: "a".repeat(64),
  infrastructureManifestId: "33333333-3333-4333-8333-333333333333",
  releaseManifestId: "44444444-4444-4444-8444-444444444444",
  pipelineRunId: null,
  destroyOperationId: null,
};

const routes: Record<
  ExecutableV1MessageType,
  {
    lane: DeployGuardWorkerEnvelopeV1["routing"]["lane"];
    operation: DeployGuardWorkerEnvelopeV1["routing"]["operation"];
    queue: string;
  }
> = {
  "intent.release.execute": {
    lane: "release",
    operation: "execute",
    queue: "deployguard-release-v1",
  },
  "intent.infrastructure.plan": {
    lane: "infrastructure",
    operation: "plan",
    queue: "deployguard-infrastructure-v1",
  },
  "intent.infrastructure.apply": {
    lane: "infrastructure",
    operation: "apply",
    queue: "deployguard-infrastructure-v1",
  },
  "intent.deletion.execute": {
    lane: "deletion",
    operation: "destroy",
    queue: "deployguard-deletion-v1",
  },
};

function envelopeFor(
  messageType: ExecutableV1MessageType,
): DeployGuardWorkerEnvelopeV1 {
  const route = routes[messageType];
  const envelope = {
    protocol: {
      name: "deployguard.worker",
      schemaVersion: 1,
      messageType,
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
      intentId: intent.id,
      projectId: intent.projectId,
      environmentName: intent.environmentName,
      pipelineRunId: null,
      destroyOperationId: null,
      infrastructureManifestId: intent.infrastructureManifestId,
      releaseManifestId: intent.releaseManifestId,
    },
    routing: route,
    idempotency: {
      canonicalKey: intent.canonicalIdempotencyKey,
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
      correlationId: intent.id,
      causationId: null,
      actorUserId: 1,
    },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  } as DeployGuardWorkerEnvelopeV1;
  envelope.idempotency.payloadSha256 = canonicalSha256(
    workerEnvelopePayloadForHash(envelope),
  );
  return envelope;
}

assert.deepEqual(EXECUTABLE_V1_MESSAGE_TYPES, [
  "intent.release.execute",
  "intent.infrastructure.plan",
  "intent.infrastructure.apply",
  "intent.deletion.execute",
]);

const registry = buildV1PlaceholderHandlerRegistry();
assert.equal(registry.size, 4);
for (const messageType of EXECUTABLE_V1_MESSAGE_TYPES) {
  const envelope = envelopeFor(messageType);
  assert.equal(assertFrozenQueueRouting(envelope), routes[messageType].queue);
  assert.equal(
    workerRoleForMessageType(messageType),
    routes[messageType].lane,
  );
  const handler = registry.get(messageType);
  assert.ok(handler);
  const result = handler.handle({
    workerId: "release-worker:test",
    queueName: routes[messageType].queue,
    messageType,
    envelope: envelope as never,
    intent,
  });
  assert.deepEqual(result, {
    disposition: "placeholder_routed",
    handler: messageType,
    workerId: "release-worker:test",
    intentId: intent.id,
    projectId: intent.projectId,
    messageType,
  });
}

assert.throws(
  () => buildV1PlaceholderHandlerRegistry([
    V1_PLACEHOLDER_HANDLERS[0],
    V1_PLACEHOLDER_HANDLERS[0],
    ...V1_PLACEHOLDER_HANDLERS.slice(1),
  ] as readonly V1PlaceholderHandler[]),
  /Duplicate v1 placeholder handler/,
);
assert.throws(
  () => buildV1PlaceholderHandlerRegistry(
    V1_PLACEHOLDER_HANDLERS.slice(1) as readonly V1PlaceholderHandler[],
  ),
  /Missing v1 placeholder handler/,
);

const capability = canonicalizeV1WorkerCapability({
  workerId: "release-worker:test",
  role: "release",
  supportedMessageTypes: [
    "intent.release.execute",
    "intent.release.execute",
  ],
  serviceVersion: "session6.1",
  gitSha: "abc123",
  heartbeatTtlMs: 30_000,
  metadata: { runtime: "inactive-v1" },
});
assert.deepEqual(capability.supportedMessageTypes, [
  "intent.release.execute",
]);
assert.throws(
  () => canonicalizeV1WorkerCapability({
    ...capability,
    role: "infrastructure",
  }),
  /role does not match/,
);
assert.throws(
  () => canonicalizeV1WorkerCapability({
    ...capability,
    heartbeatTtlMs: 999,
  }),
  /TTL is invalid/,
);
assert.throws(
  () => canonicalizeV1WorkerCapability({
    ...capability,
    metadata: { accessToken: "must-not-be-stored" },
  }),
  /not a permitted secret reference field/i,
);

const runtimeRoot = join(
  process.cwd(),
  "src",
  "orchestration-contracts",
  "worker-runtime",
);
const placeholderSource = readFileSync(
  join(runtimeRoot, "v1-placeholder-handlers.ts"),
  "utf8",
);
const runtimeSource = readFileSync(
  join(runtimeRoot, "inactive-v1-worker-runtime.service.ts"),
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
for (const source of [placeholderSource, runtimeSource]) {
  assert.doesNotMatch(
    source,
    /from ["'][^"']*(terraform|ecs|aws|docker|pipeline-worker|pipeline\.worker)/i,
  );
  assert.doesNotMatch(source, /\bnew\s+Worker\s*\(/);
  assert.doesNotMatch(
    source,
    /OnModuleInit|OnApplicationBootstrap|@Cron|setInterval/,
  );
}
assert.doesNotMatch(moduleSource, /\bnew\s+Worker\s*\(/);
assert.doesNotMatch(
  moduleSource,
  /OnModuleInit|OnApplicationBootstrap|@Cron|ScheduleModule/,
);

console.log("Inactive v1 worker runtime pure verification passed");
