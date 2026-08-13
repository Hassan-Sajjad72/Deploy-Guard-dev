import { DeploymentSideEffectStatus } from "../entities/deployment-side-effect.entity";

export type V1HandlerSideEffectIdentity = {
  intentId: string;
  projectId: string;
  environmentName: string;
  operationId: string;
  idempotencyKey: string;
  effectType: string;
  inputFingerprint: string;
  leaseId: string;
  workerId: string;
  fencingToken: string;
};

export type V1HandlerSideEffectSnapshot = {
  id: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  operationId: string;
  effectType: string;
  idempotencyKey: string;
  requestFingerprint: string;
  leaseId: string;
  workerId: string;
  fencingToken: string;
  status: DeploymentSideEffectStatus;
  safeResultCode: string | null;
  resultFingerprint: string | null;
  externalReferenceHash: string | null;
  failureCode: string | null;
  reconciliationRequired: boolean;
  attemptStartedAt: Date | null;
  deadlineAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type V1HandlerSideEffectExecutorContext =
  V1HandlerSideEffectIdentity & {
    readonly signal: AbortSignal;
    readonly deadlineAt: Date;
    isLeaseTrusted(): boolean;
  };

export type V1HandlerSideEffectOutcome =
  | {
      outcome: "succeeded";
      safeResultCode: string;
      resultFingerprint: string;
      externalReferenceHash?: string | null;
    }
  | {
      outcome: "failed";
      safeFailureCode: string;
    }
  | {
      outcome: "uncertain";
      safeFailureCode: string;
    };

export type V1HandlerSideEffectResult =
  | {
      disposition: "executed" | "replayed";
      effect: V1HandlerSideEffectSnapshot;
    }
  | {
      disposition: "in_progress";
      effect: V1HandlerSideEffectSnapshot;
    }
  | {
      disposition: "failed";
      effect: V1HandlerSideEffectSnapshot;
    }
  | {
      disposition: "reconciliation_required";
      reason:
        | "effect_outcome_uncertain"
        | "execution_cancelled"
        | "execution_timed_out"
        | "ownership_lost";
      effect: V1HandlerSideEffectSnapshot;
    };

export type V1HandlerSideEffectRequest = {
  operationId: string;
  idempotencyKey: string;
  effectType: string;
  inputFingerprint: string;
  timeoutMs: number;
  perform(
    context: V1HandlerSideEffectExecutorContext,
  ): Promise<V1HandlerSideEffectOutcome>;
};

export interface V1HandlerSideEffectBoundary {
  execute(
    request: V1HandlerSideEffectRequest,
  ): Promise<V1HandlerSideEffectResult>;
  finalizationStatus():
    | { allowed: true; safeFailureCode: null }
    | { allowed: false; safeFailureCode: string };
}

export class V1HandlerSideEffectSafetyError extends Error {
  constructor(
    readonly code:
      | "SIDE_EFFECT_CONTRACT_INVALID"
      | "SIDE_EFFECT_IDEMPOTENCY_CONFLICT"
      | "SIDE_EFFECT_OWNERSHIP_LOST"
      | "SIDE_EFFECT_TRANSITION_CONFLICT",
  ) {
    super(code);
    this.name = "V1HandlerSideEffectSafetyError";
  }
}
