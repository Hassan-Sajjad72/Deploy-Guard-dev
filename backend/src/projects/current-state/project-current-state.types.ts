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
