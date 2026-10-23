import { DeployGuardWorkerEnvelopeV1, WorkerMessageType } from "../contracts/worker-envelope.types";

const QUEUES = {
  release: "deployguard-release-v1",
  infrastructure: "deployguard-infrastructure-v1",
  deletion: "deployguard-deletion-v1",
} as const;

export function workerRoleForMessageType(messageType: WorkerMessageType) {
  if (messageType === "intent.release.execute") return "release" as const;
  if (messageType === "intent.infrastructure.plan" || messageType === "intent.infrastructure.apply") {
    return "infrastructure" as const;
  }
  if (messageType === "intent.deletion.execute") return "deletion" as const;
  return "outbox_dispatcher" as const;
}

export function assertFrozenQueueRouting(envelope: DeployGuardWorkerEnvelopeV1) {
  const expected = QUEUES[envelope.routing.lane];
  if (envelope.routing.queue !== expected) {
    throw new Error("Worker envelope queue does not match the frozen lane routing.");
  }
  const role = workerRoleForMessageType(envelope.protocol.messageType);
  if (role !== envelope.routing.lane && envelope.protocol.messageType !== "outbox.reconcile") {
    throw new Error("Worker envelope message type does not match its execution lane.");
  }
  return expected;
}

export function outboxRetryDelayMs(attemptCount: number, baseMs: number, maximumMs: number) {
  const exponent = Math.max(0, Math.min(10, attemptCount - 1));
  return Math.min(maximumMs, Math.max(1, baseMs) * (2 ** exponent));
}

export function isFrozenBullMqJobId(value: string) {
  return /^dg:v1:(release|infrastructure|deletion):[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:(execute|plan|apply|destroy):[1-9][0-9]*$/i.test(value);
}
