import {
  DeploymentSideEffectReconciliationClassification,
} from "../entities/deployment-side-effect-reconciliation.entity";
import {
  SideEffectReconciliationLeaseStatus,
} from "../entities/deployment-side-effect-reconciliation-lease.entity";
import {
  V1SideEffectReconciliationRequest,
  V1SideEffectReconciliationResult,
} from "./v1-side-effect-reconciliation.types";

export type V1SideEffectReconciliationLeaseSnapshot = {
  id: string;
  sideEffectId: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  ownerWorkerId: string;
  fencingToken: string;
  status: SideEffectReconciliationLeaseStatus;
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type V1SideEffectReconciliationCoordinatorInput = {
  workerId: string;
  leaseTtlMs: number;
  abortSignal?: AbortSignal;
  request: V1SideEffectReconciliationRequest;
};

export type V1SideEffectReconciliationCoordinatorResult =
  | {
      disposition: "coordinated";
      lease: V1SideEffectReconciliationLeaseSnapshot;
      result: V1SideEffectReconciliationResult;
    }
  | {
      disposition: "terminal_evidence_replayed";
      sideEffectId: string;
      reconciliationId: string;
      classification: DeploymentSideEffectReconciliationClassification;
      safeEvidenceCode: string | null;
      evidenceFingerprint: string;
      resultFingerprint: string | null;
      externalReferenceHash: string | null;
      failureCode: string | null;
    }
  | {
      disposition: "inspection_in_progress";
      sideEffectId: string;
    }
  | {
      disposition: "effect_not_eligible";
      sideEffectId: string;
    };

export class V1SideEffectReconciliationCoordinatorError extends Error {
  constructor(
    readonly code:
      | "RECONCILIATION_COORDINATOR_CONTRACT_INVALID"
      | "RECONCILIATION_COORDINATOR_IDEMPOTENCY_CONFLICT"
      | "RECONCILIATION_COORDINATOR_TRANSITION_CONFLICT",
  ) {
    super(code);
    this.name = "V1SideEffectReconciliationCoordinatorError";
  }
}
