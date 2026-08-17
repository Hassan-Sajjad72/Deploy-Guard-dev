import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";

export const OUTBOX_JOB_PUBLISHER = Symbol("OUTBOX_JOB_PUBLISHER");

export class OutboxIntentTransitionConflictError extends Error {
  constructor() {
    super("Outbox delivery requires exactly one planned intent transition.");
    this.name = "OutboxIntentTransitionConflictError";
  }
}

export type OutboxDeliveryClaimV1 = {
  outboxId: string;
  intentId: string;
  ownerId: string;
  fencingToken: string;
  deliveryAttempt: number;
  leaseExpiresAt: Date;
  envelope: DeployGuardWorkerEnvelopeV1;
  deterministicJobId: string;
};

export type OutboxDispatchResultV1 =
  | { status: "idle" }
  | { status: "blocked"; outboxId: string; reason: "WORKER_PROTOCOL_UNAVAILABLE" }
  | {
      status: "dead_letter";
      outboxId: string;
      reason: "INVALID_WORKER_ENVELOPE" | "TERMINAL_INTENT_NOT_DISPATCHABLE";
    }
  | {
      status: "retryable";
      outboxId: string;
      reason: "REDIS_DELIVERY_UNAVAILABLE" | "INTENT_TRANSITION_CONFLICT";
    }
  | { status: "published"; outboxId: string; jobId: string }
  | { status: "ownership_lost"; outboxId: string; jobId?: string };

export interface OutboxJobPublisher {
  publish(
    envelope: DeployGuardWorkerEnvelopeV1,
    deterministicJobId: string,
  ): Promise<{ jobId: string }>;
}
