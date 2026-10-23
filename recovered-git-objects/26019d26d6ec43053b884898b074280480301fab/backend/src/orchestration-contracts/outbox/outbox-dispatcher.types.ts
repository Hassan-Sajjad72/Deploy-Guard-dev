import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";

export const OUTBOX_JOB_PUBLISHER = Symbol("OUTBOX_JOB_PUBLISHER");

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
  | { status: "dead_letter"; outboxId: string; reason: "INVALID_WORKER_ENVELOPE" }
  | { status: "retryable"; outboxId: string; reason: "REDIS_DELIVERY_UNAVAILABLE" }
  | { status: "published"; outboxId: string; jobId: string }
  | { status: "ownership_lost"; outboxId: string; jobId?: string };

export interface OutboxJobPublisher {
  publish(
    envelope: DeployGuardWorkerEnvelopeV1,
    deterministicJobId: string,
  ): Promise<{ jobId: string }>;
}
