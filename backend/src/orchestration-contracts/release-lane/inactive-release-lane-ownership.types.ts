import { ReleaseLaneOwner, ReleaseLaneOwnershipStatus } from "../entities/release-lane-ownership.entity";

export type ReleaseLaneOwnershipSnapshot = {
  projectId: string;
  environmentName: string;
  ownerLane: ReleaseLaneOwner;
  leaseId: string;
  fencingToken: string;
  status: ReleaseLaneOwnershipStatus;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  releasedAt: Date | null;
};

export type ReleaseLaneOwnershipResult =
  | { disposition: "acquired" | "already_owned"; ownership: ReleaseLaneOwnershipSnapshot }
  | {
      disposition:
        | "blocked_by_legacy"
        | "blocked_by_v1"
        | "expired_not_recoverable"
        | "ownership_lost"
        | "idempotency_conflict";
    };

export class ReleaseLaneOwnershipError extends Error {
  constructor(
    readonly code:
      | "OWNERSHIP_INPUT_INVALID"
      | "OWNERSHIP_TRANSACTION_CONFLICT",
  ) {
    super(code);
    this.name = "ReleaseLaneOwnershipError";
  }
}
