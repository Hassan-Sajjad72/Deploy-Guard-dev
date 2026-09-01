const TERMINAL_OPERATION_STATUSES = new Set(["completed", "failed", "dispatch_failed", "cancelled"]);

export function pipelineStageDurationEnd(stage, operation, now = new Date().toISOString()) {
  if (stage?.completedAt) return stage.completedAt;
  if (stage?.status !== "running") return null;
  if (!TERMINAL_OPERATION_STATUSES.has(String(operation?.status || "").toLowerCase())) return now;
  return operation?.completedAt || operation?.failedAt || null;
}
