import {
  DeploymentIntentKind,
  DeploymentClassification,
  PlannerDecisionV1,
} from "../contracts/deployment-intent.types";

export type AuthenticatedPlannerActorV1 = {
  userId: number;
  role: "admin" | "developer" | "readonly";
};

export type TransactionalDeploymentPlannerInputV1 = {
  actor: AuthenticatedPlannerActorV1;
  projectId: string;
  environmentName: string;
  kind: DeploymentIntentKind;
  idempotencyKey: string;
  requestedCommitSha?: string;
  /** Exact applied foundation permitted only for an initial one-shot release. */
  initialReleaseInfrastructureManifestId?: string;
  /**
   * An immutable first-release draft created while the foundation was planned.
   * Supplying it is the only way the normal release lane may create a release
   * delivery for an applied foundation that has no stable release yet.
   */
  initialReleaseDraftId?: string;
  sourcePipelineRunId?: string;
  recoveryCode?: string;
  /**
   * Narrowly scoped evidence for a terminal release that failed before any
   * downstream mutation. The planner re-validates the durable portion under
   * its serializable advisory lock before creating a replacement.
   */
  preMutationRecovery?: {
    failedIntentId: string;
    evidenceHash: string;
  };
  /** Reject before persistence unless the planner reaches this exact lane. */
  requiredClassification?: DeploymentClassification;
};

export type SanitizedDeploymentIntentV1 = {
  id: string;
  schemaVersion: 1;
  projectId: string;
  environmentName: string;
  requestedByUserId: number | null;
  kind: DeploymentIntentKind;
  classification: string | null;
  status: string;
  requestFingerprint: string;
  infrastructureManifestId: string | null;
  releaseManifestId: string | null;
  sourcePipelineRunId: string | null;
  pipelineRunId: string | null;
  receivedAt: string;
  plannedAt: string | null;
};

export type TransactionalDeploymentPlannerResultV1 = {
  intent: SanitizedDeploymentIntentV1;
  decision: PlannerDecisionV1;
  replayed: boolean;
};

export class PlannerIdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_KEY_REUSED";
  readonly statusCode = 409;

  constructor() {
    super("The idempotency key was already used for a different deployment request.");
    this.name = "PlannerIdempotencyConflictError";
  }
}

export class PlannerClassificationNotAllowedError extends Error {
  readonly code = "PLANNER_CLASSIFICATION_NOT_ALLOWED";

  constructor(readonly classification: DeploymentClassification) {
    super("The requested deployment lane is not eligible for this operation.");
    this.name = "PlannerClassificationNotAllowedError";
  }
}
