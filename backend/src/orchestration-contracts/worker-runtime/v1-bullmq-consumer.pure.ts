import {
  DeployGuardWorkerEnvelopeV1,
} from "../contracts/worker-envelope.types";
import {
  validateWorkerEnvelopeV1,
  workerEnvelopeJobId,
} from "../contracts/worker-envelope.validator";
import {
  assertFrozenQueueRouting,
  isFrozenBullMqJobId,
} from "../outbox/outbox-dispatcher.pure";
import {
  ExecutableV1MessageType,
  ExecutableV1WorkerRole,
  V1WorkerCapabilityIdentity,
} from "./inactive-v1-worker-runtime.types";
import {
  InactiveV1BullMqConsumerError,
  InactiveV1BullMqConsumerStartInput,
} from "./v1-bullmq-consumer.types";
import {
  canonicalizeV1WorkerCapability,
} from "./v1-worker-capability.pure";
import {
  canonicalExecutionLeaseHeartbeatInterval,
} from "./v1-execution-lease-heartbeat.pure";

const ROLE_MESSAGES: Record<
  ExecutableV1WorkerRole,
  readonly ExecutableV1MessageType[]
> = {
  release: ["intent.release.execute"],
  infrastructure: [
    "intent.infrastructure.apply",
    "intent.infrastructure.plan",
  ],
  deletion: ["intent.deletion.execute"],
};

const ROLE_QUEUES: Record<ExecutableV1WorkerRole, readonly string[]> = {
  release: ["deployguard-release-v1"],
  infrastructure: ["deployguard-infrastructure-v1"],
  deletion: ["deployguard-deletion-v1"],
};

const PREFIX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENVIRONMENT = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type CanonicalV1ConsumerStart = {
  capability: V1WorkerCapabilityIdentity;
  connection: InactiveV1BullMqConsumerStartInput["connection"];
  prefix: string;
  queueNames: readonly string[];
  messageTypes: readonly ExecutableV1MessageType[];
  concurrency: number;
  leaseTtlMs: number;
  leaseHeartbeatIntervalMs: number;
  retryDelayMs: number;
  heartbeatIntervalMs: number | undefined;
  scope:
    | Readonly<{
      mode?: "canary" | "shared";
      projectIds: readonly string[];
      environmentNames: readonly string[];
    }>
    | null;
};

export function canonicalizeV1ConsumerStart(
  input: InactiveV1BullMqConsumerStartInput,
): CanonicalV1ConsumerStart {
  try {
    const capability = canonicalizeV1WorkerCapability(input.capability);
    // The frozen protocol reserves deletion routing, but no normal-v1
    // deletion handler or supervised process exists yet. Reject the role
    // before a heartbeat or BullMQ Worker can be created; a placeholder must
    // never be mistaken for successful resource deletion.
    if (capability.role === "deletion") {
      throw new InactiveV1BullMqConsumerError(
        "CONSUMER_ROLE_NOT_IMPLEMENTED",
      );
    }
    const defaultMessages = ROLE_MESSAGES[capability.role];
    const expectedMessages = input.exactMessageTypes === undefined
      ? defaultMessages
      : canonicalExactMessageTypes(
        capability.role,
        input.exactMessageTypes,
        defaultMessages,
      );
    if (
      capability.supportedMessageTypes.length !== expectedMessages.length
      || capability.supportedMessageTypes.some(
        (message, index) => message !== expectedMessages[index],
      )
    ) {
      throw new Error("Consumer must support its complete frozen queue.");
    }
    if (
      !input.connection
      || typeof input.connection !== "object"
      || !PREFIX.test(input.prefix)
    ) {
      throw new Error("Consumer connection boundary is invalid.");
    }
    const concurrency = input.concurrency ?? 1;
    const leaseTtlMs = input.leaseTtlMs ?? 60_000;
    const leaseHeartbeatIntervalMs =
      canonicalExecutionLeaseHeartbeatInterval(
        leaseTtlMs,
        input.leaseHeartbeatIntervalMs,
      );
    const retryDelayMs = input.retryDelayMs ?? 1_000;
    if (
      !Number.isInteger(concurrency)
      || concurrency < 1
      || concurrency > 32
      || !Number.isInteger(leaseTtlMs)
      || leaseTtlMs < 1_000
      || leaseTtlMs > 15 * 60_000
      || !Number.isInteger(retryDelayMs)
      || retryDelayMs < 10
      || retryDelayMs > 60_000
    ) {
      throw new Error("Consumer execution limits are invalid.");
    }
    if (
      input.heartbeatIntervalMs !== undefined
      && (
        !Number.isInteger(input.heartbeatIntervalMs)
        || input.heartbeatIntervalMs < 100
        || input.heartbeatIntervalMs >= capability.heartbeatTtlMs
      )
    ) {
      throw new Error("Consumer heartbeat interval is invalid.");
    }
    const scope = input.scope === undefined
      ? null
      : canonicalScope(input.scope);
    return {
      capability,
      connection: input.connection,
      prefix: input.prefix,
      queueNames: ROLE_QUEUES[capability.role],
      messageTypes: expectedMessages,
      concurrency,
      leaseTtlMs,
      leaseHeartbeatIntervalMs,
      retryDelayMs,
      heartbeatIntervalMs: input.heartbeatIntervalMs,
      scope,
    };
  } catch (error) {
    if (error instanceof InactiveV1BullMqConsumerError) throw error;
    throw new InactiveV1BullMqConsumerError("CONSUMER_CONFIG_INVALID");
  }
}

function canonicalExactMessageTypes(
  role: ExecutableV1WorkerRole,
  value: readonly ExecutableV1MessageType[],
  defaultMessages: readonly ExecutableV1MessageType[],
) {
  // Separately gated infrastructure planning and apply workers consume one
  // frozen message each. All other roles retain their complete contract.
  if (
    role !== "infrastructure"
    || value.length !== 1
    || !["intent.infrastructure.plan", "intent.infrastructure.apply"].includes(value[0])
    || !defaultMessages.includes(value[0])
  ) {
    throw new Error("Unsupported partial consumer queue contract.");
  }
  return Object.freeze([value[0]] as const);
}

function canonicalScope(
  scope: NonNullable<InactiveV1BullMqConsumerStartInput["scope"]>,
) {
  const mode = scope.mode ?? "canary";
  const projectIds = [...new Set(scope.projectIds)].sort();
  const environmentNames = [...new Set(scope.environmentNames)].sort();
  if (
    !["canary", "shared"].includes(mode)
    || environmentNames.length !== 1
    || (mode === "canary" && projectIds.length !== 1)
    || (mode === "shared" && projectIds.length !== 0)
    || projectIds.some((projectId) => !UUID.test(projectId))
    || !ENVIRONMENT.test(environmentNames[0])
  ) {
    throw new Error("Consumer scope is invalid.");
  }
  return Object.freeze({
    ...(scope.mode ? { mode } : {}),
    projectIds: Object.freeze(projectIds),
    environmentNames: Object.freeze(environmentNames),
  });
}

export function validateFrozenV1ConsumerJob(input: {
  queueName: string;
  jobName: string;
  jobId: string | undefined;
  data: unknown;
  capability: V1WorkerCapabilityIdentity;
}): DeployGuardWorkerEnvelopeV1 & {
  protocol: DeployGuardWorkerEnvelopeV1["protocol"] & {
    messageType: ExecutableV1MessageType;
  };
} {
  try {
    const envelope = validateWorkerEnvelopeV1(input.data);
    const queueName = assertFrozenQueueRouting(envelope);
    const messageType =
      envelope.protocol.messageType as ExecutableV1MessageType;
    if (
      queueName !== input.queueName
      || envelope.routing.queue !== input.queueName
      || input.jobName !== messageType
      || !input.jobId
      || !isFrozenBullMqJobId(input.jobId)
      || input.jobId !== workerEnvelopeJobId(envelope)
      || !input.capability.supportedMessageTypes.includes(messageType)
    ) {
      throw new Error("Job does not match the frozen consumer route.");
    }
    return envelope as DeployGuardWorkerEnvelopeV1 & {
      protocol: DeployGuardWorkerEnvelopeV1["protocol"] & {
        messageType: ExecutableV1MessageType;
      };
    };
  } catch {
    throw new InactiveV1BullMqConsumerError("CONSUMER_JOB_REJECTED");
  }
}

export function assertV1ConsumerJobScope(
  scope: CanonicalV1ConsumerStart["scope"],
  envelope: DeployGuardWorkerEnvelopeV1,
) {
  if (!scope) return;
  const sharedEvidencePresent = Boolean(
    envelope.identity.workspaceId
    && envelope.authorization
    && envelope.expectations,
  );
  if (
    !scope.environmentNames.includes(envelope.identity.environmentName)
    || (scope.mode === "shared" && !sharedEvidencePresent)
    || (scope.mode !== "shared"
      && !scope.projectIds.includes(envelope.identity.projectId))
  ) {
    throw new InactiveV1BullMqConsumerError(
      "CONSUMER_JOB_SCOPE_NOT_ALLOWED",
    );
  }
}

export function v1ConsumerResultNeedsRetry(
  result: {
    disposition: string;
    reason?: string;
  },
) {
  return result.disposition === "released"
    || (
      result.disposition === "idempotent_no_op"
      && (
        result.reason === "duplicate_delivery_already_owned"
        || result.reason === "duplicate_delivery_owned_elsewhere"
        || result.reason === "ownership_lost"
      )
    );
}

export function expectedV1ConsumerMessages(
  role: ExecutableV1WorkerRole,
) {
  return ROLE_MESSAGES[role];
}

export function expectedV1ConsumerQueues(role: ExecutableV1WorkerRole) {
  return ROLE_QUEUES[role];
}
