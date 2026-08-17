import {
  DeploymentSideEffectReconciliationClassification,
} from "../entities/deployment-side-effect-reconciliation.entity";
import {
  V1HandlerSideEffectSnapshot,
} from "./v1-handler-side-effect.types";

export type V1SideEffectReconciliationLogicalIdentity = {
  sideEffectId: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  operationId: string;
  idempotencyKey: string;
  adapterId: string;
  inspectionFingerprint: string;
  effectRequestFingerprint: string;
};

export type V1SideEffectReconciliationIdentity =
  V1SideEffectReconciliationLogicalIdentity & {
  leaseId: string;
  workerId: string;
  fencingToken: string;
  };

export type V1SideEffectReconciliationSnapshot = {
  id: string;
  sideEffectId: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  operationId: string;
  idempotencyKey: string;
  adapterId: string;
  requestFingerprint: string;
  leaseId: string;
  workerId: string;
  fencingToken: string;
  classification: DeploymentSideEffectReconciliationClassification | null;
  safeEvidenceCode: string | null;
  evidenceFingerprint: string | null;
  resultFingerprint: string | null;
  externalReferenceHash: string | null;
  failureCode: string | null;
  inspectionStartedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
};

export type V1ReadOnlySideEffectEvidence =
  | {
      classification: "succeeded";
      safeEvidenceCode: string;
      evidenceFingerprint: string;
      resultFingerprint: string;
      externalReferenceHash?: string | null;
    }
  | {
      classification: "failed";
      safeFailureCode: string;
      evidenceFingerprint: string;
    }
  | {
      classification: "pending";
      safeEvidenceCode: string;
      evidenceFingerprint: string;
    }
  | {
      classification: "manual_review";
      safeFailureCode: string;
      evidenceFingerprint: string;
    };

export type V1ReadOnlySideEffectInspectionContext = {
  readonly readOnly: true;
  readonly sideEffect: V1HandlerSideEffectSnapshot;
  readonly signal: AbortSignal;
  readonly deadlineAt: Date;
  readonly intentId: string;
  readonly projectId: string;
  readonly environmentName: string;
  readonly leaseId: string;
  readonly workerId: string;
  readonly fencingToken: string;
  isLeaseTrusted(): boolean;
};

export interface V1ReadOnlySideEffectEvidenceAdapter {
  readonly policy:
    "deployguard.side-effect-reconciliation/read-only-v1";
  readonly adapterId: string;
  readonly effectType: string;
  inspect(
    context: V1ReadOnlySideEffectInspectionContext,
  ): Promise<V1ReadOnlySideEffectEvidence> | V1ReadOnlySideEffectEvidence;
}

export type V1SideEffectReconciliationRequest = {
  sideEffectId: string;
  operationId: string;
  idempotencyKey: string;
  inspectionFingerprint: string;
  timeoutMs: number;
  adapter: V1ReadOnlySideEffectEvidenceAdapter;
};

export type V1SideEffectReconciliationResult =
  | {
      disposition: "classified" | "replayed";
      classification: DeploymentSideEffectReconciliationClassification;
      sideEffect: V1HandlerSideEffectSnapshot;
      reconciliation: V1SideEffectReconciliationSnapshot;
    }
  | {
      disposition: "inspection_in_progress";
      sideEffect: V1HandlerSideEffectSnapshot;
      reconciliation: V1SideEffectReconciliationSnapshot;
    };

export interface V1SideEffectReconciliationBoundary {
  reconcile(
    request: V1SideEffectReconciliationRequest,
  ): Promise<V1SideEffectReconciliationResult>;
}

export class V1SideEffectReconciliationError extends Error {
  constructor(
    readonly code:
      | "SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID"
      | "SIDE_EFFECT_RECONCILIATION_OWNERSHIP_LOST"
      | "SIDE_EFFECT_RECONCILIATION_IDEMPOTENCY_CONFLICT"
      | "SIDE_EFFECT_RECONCILIATION_EFFECT_NOT_ELIGIBLE"
      | "SIDE_EFFECT_RECONCILIATION_TRANSITION_CONFLICT",
  ) {
    super(code);
    this.name = "V1SideEffectReconciliationError";
  }
}
