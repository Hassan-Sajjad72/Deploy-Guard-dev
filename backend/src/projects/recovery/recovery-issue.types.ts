export type RecoverySeverity = "info" | "warning" | "blocker" | "critical";
export type RecoveryCategory =
  | "source" | "build" | "runtime" | "database" | "storage" | "network"
  | "health" | "security" | "cost" | "terraform" | "cleanup" | "auth" | "unknown";
export type RecoveryEvidenceSource =
  | "preflight" | "cloudwatch" | "ecs" | "alb" | "terraform" | "trivy"
  | "github" | "docker" | "database" | "efs" | "settings";

export type RecoveryEvidence = {
  source: RecoveryEvidenceSource;
  message: string;
  timestamp?: string;
};

export type RecoveryIssue = {
  code: string;
  title: string;
  severity: RecoverySeverity;
  category: RecoveryCategory;
  rootCause: string;
  simpleExplanation: string;
  detectedEvidence: RecoveryEvidence[];
  requiredAction: string;
  primaryActionLabel: string;
  primaryActionRoute: string;
  primaryActionMode: "modal" | "focused_settings" | "recovery_center" | "external";
  focusSection: string | null;
  resumeFromStage: string;
  canResume: boolean;
  requiresFullRerun: boolean;
  affectedStages: string[];
  safeToRetry: boolean;
  developerDetails: Record<string, unknown>;
};
