import { ExternalProvider, FailureOwner } from "../failure-ownership";
import type { ManagedDatabaseReconciliationFailureEvidence } from "../managed-database-reconciliation.error";

export const FAILURE_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const FAILURE_DIAGNOSTIC_CONFIDENCE = ["DETERMINISTIC", "HIGH", "UNVERIFIED"] as const;
export const FAILURE_RETRY_DECISIONS = ["SAFE_NOW", "SAFE_AFTER_FIX", "NOT_SAFE_YET", "INSUFFICIENT_EVIDENCE"] as const;

export type FailureDiagnosticConfidence = typeof FAILURE_DIAGNOSTIC_CONFIDENCE[number];
export type FailureRetryDecision = typeof FAILURE_RETRY_DECISIONS[number];

export type FailureEvidenceReference = {
  source: string;
  stage: string;
  eventId: string | null;
  timestamp: string;
  excerpt: string;
};

export type DeploymentFailureDiagnostic = {
  schemaVersion: typeof FAILURE_DIAGNOSTIC_SCHEMA_VERSION;
  operationId: string;
  deploymentAction: "deploy" | "rollback" | "destroy";
  sourceSha: string | null;
  terminalState: "failed";
  terminalFailureCode: string;
  rootCauseCode: string;
  failureOwner: FailureOwner;
  externalProvider: ExternalProvider | null;
  failureStage: string;
  serviceId: string | null;
  serviceName: string | null;
  affectedComponent: string;
  tool: string | null;
  toolErrorCode: string | null;
  summary: string;
  technicalReason: string;
  recommendedAction: string;
  remediationSteps: string[];
  retryDecision: FailureRetryDecision;
  completedStages: Array<{ stage: string; label: string }>;
  evidenceReferences: FailureEvidenceReference[];
  confidence: FailureDiagnosticConfidence;
  failedAt: string;
};

export type DeploymentFailureDiagnosticInput = {
  operationId: string;
  deploymentAction: "deploy" | "rollback" | "destroy";
  sourceSha?: string | null;
  failureStage: string;
  terminalFailureCode: string;
  failureOwner: FailureOwner;
  externalProvider?: ExternalProvider | null;
  serviceId?: string | null;
  serviceName?: string | null;
  errorMessage?: string | null;
  safeEvidence?: string | null;
  evidenceSource: string;
  evidenceEventId?: string | null;
  failedAt: Date;
  workflowStages?: unknown;
  managedDatabaseReconciliation?: ManagedDatabaseReconciliationFailureEvidence;
};

export function failureDiagnosticFromMetadata(metadata: Record<string, unknown> | null | undefined) {
  const value = metadata?.failureDiagnostic;
  if (!value || typeof value !== "object") return null;
  const diagnostic = value as Partial<DeploymentFailureDiagnostic>;
  return diagnostic.schemaVersion === FAILURE_DIAGNOSTIC_SCHEMA_VERSION
    && typeof diagnostic.rootCauseCode === "string"
    && typeof diagnostic.terminalFailureCode === "string"
    && typeof diagnostic.retryDecision === "string"
    ? diagnostic as DeploymentFailureDiagnostic
    : null;
}
