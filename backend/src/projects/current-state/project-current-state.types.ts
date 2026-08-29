export type CurrentStateStatus =
  | "not_started"
  | "waiting"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "skipped"
  | "requires_approval"
  | "disabled_by_config"
  | "warning"
  | "unavailable";

export type PipelineStageStatus =
  | "not_started"
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "warning"
  | "unavailable"
  | "skipped"
  | "requires_approval"
  | "disabled_by_config";

export type ProjectModuleState = {
  status: CurrentStateStatus;
  label: string;
  message: string;
  action: string | null;
  actionLabel: string | null;
  href: string;
  required: boolean;
  lastUpdatedAt: Date | null;
};

export type ResolvedPipelineStage = {
  stage: string;
  label: string;
  status: PipelineStageStatus;
  required: boolean;
  startedAt: Date | null;
  endedAt: Date | null;
  durationMs: number | null;
  message: string;
  error: string | null;
  blockedByStage: string | null;
  blockedReason: string | null;
  canRetry: boolean;
  canSkip: boolean;
  source: string;
  diagnosticCode?: string | null;
  internalStageKey?: string;
  userFacingStageKey?: string;
  userFacingStageName?: string;
};

export type ResolvedLifecycleStage = ResolvedPipelineStage & {
  order: number;
  technicalStages: string[];
};

export type NextAction = {
  type: string;
  label: string;
  message: string;
  description: string;
  href: string;
  method: "GET" | "POST" | "PATCH";
  enabled: boolean;
  disabledReasons: string[];
  disabledReason: string | null;
};

export type DeveloperState =
  | "ready"
  | "destroyed"
  | "destroying"
  | "preparing"
  | "queued"
  | "building"
  | "deploying"
  | "verifying"
  | "live"
  | "configuration_required"
  | "approval_required"
  | "failed_application"
  | "platform_attention"
  | "unsupported";

export type DeveloperAction =
  | "deploy"
  | "deploy_again"
  | "redeploy"
  | "provide_configuration"
  | "approve_cost"
  | "open_application"
  | "none";

export type DeveloperProgressPhase =
  | "source"
  | "build"
  | "prepare"
  | "deploy"
  | "verify"
  | null;

/**
 * The product-facing evidence envelope.  These fields deliberately describe
 * what DeployGuard knows, including when an external fact is unavailable.
 */
export type ProjectStateAuthority = {
  state: "READY" | "DEPLOYING" | "FAILED" | "LIVE" | "DESTROYING" | "DESTROYED" | "BLOCKED";
  reason: string;
  activeOperation: {
    id: string;
    type: "deploy" | "destroy" | "rollback";
    status: string;
    stage: string | null;
    startedAt: string | null;
    workflowRunId: string | null;
  } | null;
  latestCompletedOperation: {
    id: string;
    type: "deploy" | "destroy" | "rollback";
    completedAt: string | null;
    outcome: "succeeded" | "failed" | "destroyed";
  } | null;
  infrastructure: {
    exists: boolean | null;
    status: "active" | "destroyed" | "not_provisioned" | "provisioning_failed" | "unknown";
    source: "github_actions" | "infrastructure_record" | "unavailable";
    observedAt: string | null;
  };
  applicationHealth: {
    status: "healthy" | "pending" | "failed" | "unavailable";
    source: "github_actions_health_verification" | "github_actions" | "unavailable";
    observedAt: string | null;
  };
  monitoring: {
    available: boolean;
    status: "available" | "unavailable" | "not_deployed";
    reason: string;
  };
  reconciliation: {
    lastReconciledAt: string | null;
    freshness: "current" | "stale" | "unavailable";
    source: "github_actions" | "unavailable";
  };
};

export type DeveloperProjectCurrentState = {
  /** Single state contract consumed by all product views. */
  stateAuthority?: ProjectStateAuthority;
  infrastructureEvidence?: {
    source: "github_actions" | "infrastructure_record" | "unavailable";
    lastUpdatedAt: string | null;
    freshness: "current" | "stale" | "unavailable";
    region: string;
    executionEngine: "github_actions";
    resources: Array<{ type: "ECR" | "ECS Fargate" | "ALB"; status: "active" | "destroyed" | "unavailable" }>;
    ecr: null | { repository: string; imageTag: string | null; imageDigest: string | null };
    ecs: null | { cluster: string; service: string; taskDefinitionRevision: number | null; desiredCount: number; runningCount: number; pendingCount: number };
    alb: null | { name: string; status: string; targetHealth: string[]; endpoint: string | null };
    terraformState: { status: "active" | "destroyed" | "unavailable"; storage: "encrypted_s3" | "unavailable"; key: string | null; lastApplyAt: string | null; lastDestroyAt: string | null };
    cost: { status: "estimated" | "approval_required" | "unavailable"; currency: string | null; monthly: number | null; source: "infracost" | "unavailable"; generationId: string | null; releaseId: string | null; operationId: string | null; estimatedAt?: string | null; unavailableReason?: string | null; breakdown?: Array<{ name: string; service: string | null; monthly: number }> };
    persistentStorage: null | { type: "EFS"; status: string; encrypted: boolean; backupEnabled: boolean; region: string | null };
  };
  developerState: DeveloperState;
  developerAction: DeveloperAction;
  developerMessage: string;
  progress: {
    percentage: number;
    phase: DeveloperProgressPhase;
    label: string;
  };
  repository: string | null;
  branch: string | null;
  commit: string | null;
  latestAttempt: {
    operationId?: string | null;
    generationId?: string | null;
    workflowRunId?: string | null;
    operationType: "deploy" | "destroy" | "rollback";
    status: DeveloperState;
    outcome: "completed" | "cancelled" | "blocked" | null;
    /** Immutable operation ordinal. It is intentionally distinct from a release revision. */
    attempt: string | null;
    message: string | null;
    releaseRevision: string | null;
    commit: string | null;
    occurredAt: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    workflowStages?: Array<{ key: string; status: "passed" | "failed" | "running" | "skipped" }>;
  } | null;
  stableRelease: {
    id?: string | null;
    operationId?: string | null;
    revision: string;
    generationId: string | null;
    commit: string;
    promotedAt: string;
    rollbackAvailable: boolean;
  } | null;
  stableUrl: string | null;
  estimatedCost: {
    status: "estimated" | "approval_required" | "unavailable";
    source: "infracost" | "unavailable";
    currency: string | null;
    monthly: number | null;
    generationId: string | null;
    releaseId: string | null;
    operationId: string | null;
    estimatedAt: string;
    unavailableReason: string | null;
    breakdown: Array<{ name: string; service: string | null; monthly: number }>;
  } | null;
  missingConfiguration: string[];
  advisories?: string[];
  applicationError: {
    category: "repository" | "configuration" | "build" | "runtime" | "health";
    message: string;
  } | null;
  /**
   * Exact AWS deletion succeeded but final control-plane erasure is still
   * retryable. Historical release data must not be treated as a LIVE runtime.
   */
  destroyCleanupIncomplete?: boolean;
  canRetry: boolean;
  generationState?: {
    liveGenerationId: string | null;
    candidateGenerationId: string | null;
    generations: Array<{
      id: string;
      ordinal: number;
      status: "deploying" | "live" | "failed" | "retired" | "cleanup_pending" | "cleaned";
      terraformStateKey: string;
    }>;
  };
};
