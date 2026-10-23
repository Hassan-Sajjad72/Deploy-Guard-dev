import {
  DeploymentIntentKind,
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
  sourcePipelineRunId?: string;
  recoveryCode?: string;
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
