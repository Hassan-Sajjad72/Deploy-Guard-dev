export const DEPLOYMENT_INTENT_KINDS = [
  "deploy",
  "retry",
  "resume",
  "plan",
  "apply",
  "rollback",
  "destroy",
  "cleanup",
  "legacy_import",
] as const;

export const DEPLOYMENT_CLASSIFICATIONS = [
  "release_only",
  "infrastructure_change",
  "no_op",
  "unsafe_or_unknown",
  "deletion",
] as const;

export const DEPLOYMENT_INTENT_STATUSES = [
  "received",
  "planned",
  "enqueued",
  "running",
  "plan_completed",
  "completed",
  "failed",
  "cancelled",
  "no_op",
  "rejected",
] as const;

export type DeploymentIntentKind = typeof DEPLOYMENT_INTENT_KINDS[number];
export type DeploymentClassification = typeof DEPLOYMENT_CLASSIFICATIONS[number];
export type DeploymentIntentStatus = typeof DEPLOYMENT_INTENT_STATUSES[number];
export type ExecutionLane = "release" | "infrastructure" | "deletion";

export type PlannerDecisionV1 = {
  schemaVersion: 1;
  intentId: string;
  classification: DeploymentClassification;
  reasonCodes: string[];
  currentAppliedInfrastructureManifestId: string | null;
  desiredInfrastructureManifestId: string | null;
  currentStableReleaseManifestId: string | null;
  desiredReleaseManifestId: string | null;
  infrastructureChangedPaths: string[];
  releaseChangedPaths: string[];
  approvalRequired: boolean;
  executionLane: "none" | ExecutionLane;
  blockedReasons: Array<{ code: string; message: string; source: string }>;
};
