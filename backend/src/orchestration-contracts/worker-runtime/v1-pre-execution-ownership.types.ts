import { ExecutionLane } from "../contracts/deployment-intent.types";
import { InactiveV1WorkerRuntimeResult } from "./inactive-v1-worker-runtime.types";

export type PreExecutionLeaseScope =
  | "execute"
  | "plan"
  | "apply"
  | "destroy";

export type PreExecutionOperation = {
  lane: ExecutionLane;
  scope: PreExecutionLeaseScope;
};

export type PreExecutionLeaseSnapshot = {
  leaseId: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  lane: ExecutionLane;
  scope: PreExecutionLeaseScope;
  ownerWorkerId: string;
  fencingToken: string;
  status: "acquired" | "heartbeat_active";
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
};

export type PreExecutionOwnershipResult =
  | {
      disposition: "claimed" | "already_owned";
      intentStatus: "running";
      logicalJobId: string;
      lease: PreExecutionLeaseSnapshot;
    }
  | Extract<
      InactiveV1WorkerRuntimeResult,
      { disposition: "idempotent_no_op" }
    >
  | {
      disposition: "idempotent_no_op";
      reason: "duplicate_delivery_owned_elsewhere";
      workerId: string;
      intentId: string;
      projectId: string;
      messageType:
        | "intent.release.execute"
        | "intent.infrastructure.plan"
        | "intent.infrastructure.apply"
        | "intent.deletion.execute";
    };

export class PreExecutionOwnershipError extends Error {
  constructor(
    readonly code:
      | "LEASE_TTL_INVALID"
      | "FENCING_REQUIRED"
      | "INTENT_NOT_ENQUEUED"
      | "INTENT_STATE_CHANGED"
      | "OPERATION_CONFLICT"
      | "OWNERSHIP_TRANSITION_CONFLICT",
  ) {
    super(code);
    this.name = "PreExecutionOwnershipError";
  }
}
