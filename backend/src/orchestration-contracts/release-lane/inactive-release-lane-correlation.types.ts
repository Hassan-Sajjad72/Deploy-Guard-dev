import { ReleaseLaneOwner } from "../entities/release-lane-ownership.entity";

/** Exact independent cross-lane fence; never substitute an operation fence. */
export type ReleaseLaneCorrelationFence = {
  projectId: string;
  environmentName: string;
  lane: ReleaseLaneOwner;
  ownershipLeaseId: string;
  actorId: string;
  ownershipFencingToken: string;
};

export type V1OperationFence = {
  operationLeaseId: string;
  operationWorkerId: string;
  operationFencingToken: string;
};

export type ReleaseLaneCorrelationDisposition =
  | "linked"
  | "already_linked"
  | "cleared"
  | "already_cleared"
  | "ownership_lost"
  | "operation_lost"
  | "correlation_conflict"
  | "identity_mismatch";

export type ReleaseLaneCorrelationResult = {
  disposition: ReleaseLaneCorrelationDisposition;
};

export class ReleaseLaneCorrelationError extends Error {
  constructor(readonly code: "CORRELATION_INPUT_INVALID" | "CORRELATION_TRANSACTION_CONFLICT") {
    super(code);
    this.name = "ReleaseLaneCorrelationError";
  }
}
