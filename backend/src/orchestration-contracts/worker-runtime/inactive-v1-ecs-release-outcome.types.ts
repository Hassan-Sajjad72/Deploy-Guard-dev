import {
  V1EcsReleaseManifestStore,
  V1EcsReleaseMutationClient,
  V1EcsReleaseMutationExecution,
  V1EcsReleaseRevisionIdentity,
} from "./inactive-v1-ecs-release-mutation.types";
import {
  V1EcsRolloutHealthVerificationResult,
  V1EcsRolloutHealthVerifier,
} from "./inactive-v1-ecs-rollout-health.types";
import { V1HandlerSideEffectBoundary } from "./v1-handler-side-effect.types";

export type V1EcsReleaseOutcomeFence = {
  intentId: string;
  leaseId: string;
  workerId: string;
  fencingToken: string;
};

export type V1EcsReleaseOutcomeInput = {
  revision: V1EcsReleaseRevisionIdentity;
  idempotencyKey: string;
  rollbackOperationId: string;
  timeoutMs: number;
  candidateDeadlineAt: Date;
  rollbackDeadlineAt: Date;
  execution: V1EcsReleaseMutationExecution;
  sideEffects: V1HandlerSideEffectBoundary;
  fence: V1EcsReleaseOutcomeFence;
};

export type V1EcsRollbackTarget = {
  rollbackManifestId: string;
  rollbackRevision: string;
  previousStable: V1EcsReleaseRevisionIdentity & {
    taskDefinitionArn: string;
  };
  clusterArn: string;
  serviceArn: string;
  inputFingerprint: string;
};

export type V1EcsRollbackPreparation =
  | {
      disposition: "rollback_prepared" | "rollback_replayed";
      target: V1EcsRollbackTarget;
    }
  | {
      disposition: "rollback_target_missing";
      safeCode:
        | "ECS_PREVIOUS_STABLE_RELEASE_MISSING"
        | "ECS_PREVIOUS_STABLE_INFRASTRUCTURE_MISMATCH";
    };

export interface V1EcsReleaseOutcomeStore {
  promoteCandidate(input: {
    revision: V1EcsReleaseRevisionIdentity;
    idempotencyKey: string;
    inputFingerprint: string;
    verification: V1EcsRolloutHealthVerificationResult;
    fence: V1EcsReleaseOutcomeFence;
  }): Promise<{ disposition: "promoted" | "replayed" }>;
  prepareRollback(input: {
    revision: V1EcsReleaseRevisionIdentity;
    idempotencyKey: string;
    inputFingerprint: string;
    candidateVerification: V1EcsRolloutHealthVerificationResult;
    fence: V1EcsReleaseOutcomeFence;
  }): Promise<V1EcsRollbackPreparation>;
  finalizeRollback(input: {
    revision: V1EcsReleaseRevisionIdentity;
    rollbackManifestId: string;
    rollbackRevision: string;
    previousStableManifestId: string;
    idempotencyKey: string;
    inputFingerprint: string;
    verification: V1EcsRolloutHealthVerificationResult;
    fence: V1EcsReleaseOutcomeFence;
  }): Promise<{ disposition: "rolled_back" | "replayed" }>;
}

export type V1EcsReleaseOutcomeDependencies = {
  manifests: V1EcsReleaseManifestStore;
  outcomes: V1EcsReleaseOutcomeStore;
  mutationClient: V1EcsReleaseMutationClient;
  verifier: V1EcsRolloutHealthVerifier;
};

export type V1EcsReleaseOutcomeResult =
  | {
      disposition: "candidate_promoted";
      verification: V1EcsRolloutHealthVerificationResult;
      replayed: boolean;
    }
  | {
      disposition: "candidate_progressing";
      verification: V1EcsRolloutHealthVerificationResult;
    }
  | {
      disposition: "manual_review_required";
      verification: V1EcsRolloutHealthVerificationResult;
    }
  | {
      disposition: "rollback_target_missing";
      verification: V1EcsRolloutHealthVerificationResult;
      safeCode:
        | "ECS_PREVIOUS_STABLE_RELEASE_MISSING"
        | "ECS_PREVIOUS_STABLE_INFRASTRUCTURE_MISMATCH";
    }
  | {
      disposition: "rollback_verification_pending";
      verification: V1EcsRolloutHealthVerificationResult;
    }
  | {
      disposition: "rollback_completed";
      verification: V1EcsRolloutHealthVerificationResult;
      replayed: boolean;
    }
  | {
      disposition: "rollback_reconciliation_required";
      safeCode: string;
    }
  | {
      disposition: "rollback_failed";
      safeCode: string;
    };

export class V1EcsReleaseOutcomeError extends Error {
  constructor(
    readonly code:
      | "ECS_RELEASE_OUTCOME_CONTRACT_INVALID"
      | "ECS_RELEASE_OUTCOME_OWNERSHIP_LOST"
      | "ECS_RELEASE_OUTCOME_IDEMPOTENCY_CONFLICT"
      | "ECS_RELEASE_OUTCOME_TRANSITION_CONFLICT",
  ) {
    super(code);
    this.name = "V1EcsReleaseOutcomeError";
  }
}
