import { DeploymentIntentStatus } from "../contracts/deployment-intent.types";
import {
  DeployGuardWorkerEnvelopeV1,
  WorkerMessageType,
} from "../contracts/worker-envelope.types";
import { WorkerRole } from "../entities/worker-capability.entity";

export const EXECUTABLE_V1_MESSAGE_TYPES = [
  "intent.release.execute",
  "intent.infrastructure.plan",
  "intent.infrastructure.apply",
  "intent.deletion.execute",
] as const satisfies readonly WorkerMessageType[];

export type ExecutableV1MessageType =
  typeof EXECUTABLE_V1_MESSAGE_TYPES[number];
export type ExecutableV1WorkerRole = Extract<
  WorkerRole,
  "release" | "infrastructure" | "deletion"
>;

export type V1WorkerCapabilityIdentity = {
  workerId: string;
  role: ExecutableV1WorkerRole;
  supportedMessageTypes: ExecutableV1MessageType[];
  serviceVersion: string;
  gitSha: string;
  heartbeatTtlMs: number;
  metadata?: Record<string, unknown>;
};

export type V1WorkerCapabilitySnapshot = {
  workerId: string;
  role: ExecutableV1WorkerRole;
  minimumProtocol: 1;
  maximumProtocol: 1;
  supportedMessageTypes: ExecutableV1MessageType[];
  serviceVersion: string;
  gitSha: string;
  startedAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  metadata: Record<string, unknown>;
};

export type V1WorkerHeartbeatSession = {
  readonly workerId: string;
  isActive(): boolean;
  lastFailureCode(): "CAPABILITY_EXPIRED" | "HEARTBEAT_FAILED" | null;
  stop(): Promise<void>;
};

export type V1WorkerIntentSnapshot = {
  id: string;
  projectId: string;
  environmentName: string;
  classification:
    | "release_only"
    | "infrastructure_change"
    | "deletion";
  status: DeploymentIntentStatus;
  canonicalIdempotencyKey: string;
  /** Present for fenced infrastructure-plan continuation; legacy test snapshots need not carry it. */
  requestFingerprint?: string;
  infrastructureManifestId: string | null;
  releaseManifestId: string | null;
  pipelineRunId: string | null;
  destroyOperationId: string | null;
};

export type V1PlaceholderHandlerContext<
  TMessage extends ExecutableV1MessageType = ExecutableV1MessageType,
> = {
  workerId: string;
  queueName: string;
  messageType: TMessage;
  envelope: DeployGuardWorkerEnvelopeV1 & {
    protocol: DeployGuardWorkerEnvelopeV1["protocol"] & {
      messageType: TMessage;
    };
  };
  intent: V1WorkerIntentSnapshot;
};

export type V1PlaceholderHandlerResult<
  TMessage extends ExecutableV1MessageType = ExecutableV1MessageType,
> = {
  disposition: "placeholder_routed";
  handler: TMessage;
  workerId: string;
  intentId: string;
  projectId: string;
  messageType: TMessage;
};

export interface V1PlaceholderHandler<
  TMessage extends ExecutableV1MessageType = ExecutableV1MessageType,
> {
  readonly messageType: TMessage;
  handle(
    context: V1PlaceholderHandlerContext<TMessage>,
  ): V1PlaceholderHandlerResult<TMessage>;
}

export type InactiveV1WorkerRuntimeResult =
  | V1PlaceholderHandlerResult
  | V1WorkerIdempotentNoOp;

export type V1WorkerIdempotentNoOp = {
  disposition: "idempotent_no_op";
  reason: "intent_terminal" | "intent_superseded";
  workerId: string;
  intentId: string;
  projectId: string;
  messageType: ExecutableV1MessageType;
};

export type V1ValidatedWorkerRequest = {
  disposition: "validated";
  workerId: string;
  queueName: string;
  messageType: ExecutableV1MessageType;
  envelope: DeployGuardWorkerEnvelopeV1 & {
    protocol: DeployGuardWorkerEnvelopeV1["protocol"] & {
      messageType: ExecutableV1MessageType;
    };
  };
  intent: V1WorkerIntentSnapshot;
};

export type InactiveV1WorkerValidationResult =
  | V1ValidatedWorkerRequest
  | V1WorkerIdempotentNoOp;

export class InactiveV1WorkerRuntimeError extends Error {
  constructor(
    readonly code:
      | "WORKER_CAPABILITY_INVALID"
      | "WORKER_CAPABILITY_UNAVAILABLE"
      | "WORKER_ENVELOPE_INVALID"
      | "WORKER_QUEUE_MISMATCH"
      | "WORKER_AUTHORIZATION_INVALID"
      | "INTENT_NOT_FOUND"
      | "INTENT_IDENTITY_MISMATCH"
      | "INTENT_CLASSIFICATION_MISMATCH"
      | "DELETION_FENCE_ACTIVE"
      | "DELETION_FENCE_MISSING"
      | "PLACEHOLDER_HANDLER_UNAVAILABLE",
  ) {
    super(code);
    this.name = "InactiveV1WorkerRuntimeError";
  }
}
