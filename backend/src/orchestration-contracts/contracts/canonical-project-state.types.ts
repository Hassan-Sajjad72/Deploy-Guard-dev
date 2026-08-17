import { DeploymentClassification, ExecutionLane } from "./deployment-intent.types";

export type CanonicalStageV1 = {
  stage: string;
  status: string;
  label: string;
  required: boolean;
  occurredAt: string | null;
};

export type CanonicalProjectStateV1 = {
  schemaVersion: 1;
  projectionRevision: number;
  generatedAt: string;
  etag: string;
  project: {
    id: string;
    name: string;
    environmentName: string;
    repositoryFullName: string | null;
    branch: string | null;
  };
  desired: {
    infrastructureManifestId: string | null;
    infrastructureRevision: number | null;
    releaseManifestId: string | null;
    releaseRevision: number | null;
  };
  applied: {
    infrastructureManifestId: string | null;
    infrastructureRevision: number | null;
    stableReleaseManifestId: string | null;
    stableReleaseRevision: number | null;
  };
  operation: {
    intentId: string | null;
    classification: DeploymentClassification | null;
    lane: ExecutionLane | null;
    runId: string | null;
    status: string;
    stage: string | null;
    active: boolean;
    stale: boolean;
    leaseExpiresAt: string | null;
  };
  infrastructure: {
    status: string;
    manifestId: string | null;
    stateKey: string | null;
    resourceCount: number | null;
    lastReconciledAt: string | null;
  };
  release: {
    status: string;
    manifestId: string | null;
    commitSha: string | null;
    imageDigest: string | null;
    taskDefinitionArn: string | null;
    liveUrl: string | null;
    healthVerifiedAt: string | null;
  };
  stateSafety: Record<string, unknown>;
  recovery: {
    currentIssue: Record<string, unknown> | null;
    previousDeploymentIssue: Record<string, unknown> | null;
    canResume: boolean;
    resumeIntentKind: "retry" | "resume" | null;
  };
  progress: {
    percentage: number;
    completed: number;
    total: number;
    currentStage: string | null;
    stages: CanonicalStageV1[];
  };
  primaryAction: {
    type: string;
    label: string;
    href: string | null;
    method: "GET" | "POST" | "PATCH" | "DELETE" | null;
    enabled: boolean;
    disabledReason: string | null;
  };
  evidence: {
    sourceTimestamps: Record<string, string | null>;
    winningSources: Record<string, string>;
    cloudVerificationStatus: string;
  };
  compatibility: {
    legacyProjectionIncluded: boolean;
    minimumFrontendSchemaVersion: number;
  };
};
