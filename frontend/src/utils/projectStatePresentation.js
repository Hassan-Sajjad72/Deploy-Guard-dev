/**
 * The sole browser-side translation of the backend current-state contract.
 * Pages receive presentation data here; they do not reconstruct lifecycle
 * state from individual infrastructure, log, or historical-operation APIs.
 */
const TERMINAL_OPERATION_STATUSES = new Set([
  "completed", "cancelled", "failed", "failed_application", "destroyed", "live", "succeeded",
]);

function activeOperation(currentState) {
  const operation = currentState?.stateAuthority?.activeOperation || null;
  if (!operation) return null;
  return TERMINAL_OPERATION_STATUSES.has(String(operation.status || "").toLowerCase()) ? null : operation;
}

export function projectStatePresentation(currentState) {
  const operation = activeOperation(currentState);
  const authoritativeState = currentState?.stateAuthority?.state || fallbackState(currentState?.developerState);
  const state = operation
    ? operation.type === "destroy" ? "DESTROYING" : "DEPLOYING"
    : authoritativeState;
  return {
    state,
    active: Boolean(operation),
    headline: currentState?.stateAuthority?.reason || currentState?.developerMessage || "Project state is unavailable.",
    operation,
    runtime: currentState?.stateAuthority?.runtime || null,
    infrastructure: currentState?.stateAuthority?.infrastructure || null,
    health: currentState?.stateAuthority?.applicationHealth || null,
    monitoring: currentState?.stateAuthority?.monitoring || null,
    reconciliation: currentState?.stateAuthority?.reconciliation || null,
  };
}

function fallbackState(developerState) {
  if (developerState === "ready") return "READY";
  if (developerState === "live") return "LIVE";
  if (developerState === "destroying") return "DESTROYING";
  if (developerState === "destroyed") return "DESTROYED";
  if (developerState === "failed_application") return "FAILED";
  if (["preparing", "queued", "building", "deploying", "verifying"].includes(developerState)) return "DEPLOYING";
  return "BLOCKED";
}

/*
 * Chip tone for an authoritative project state. A destroyed project has no
 * runtime, so it reads as neutral rather than as a successful operation.
 */
export function projectStateTone(state) {
  if (state === "LIVE") return "success";
  if (state === "DEPLOYING" || state === "DESTROYING") return "info";
  if (state === "FAILED") return "danger";
  if (state === "BLOCKED") return "warning";
  return "neutral";
}

const STATE_LABELS = {
  READY: "Ready",
  DEPLOYING: "Deploying",
  FAILED: "Failed",
  LIVE: "Live",
  DESTROYING: "Destroying",
  DESTROYED: "Destroyed",
  BLOCKED: "Blocked",
};

/** The one user-facing word for each authoritative state. */
export function projectStateLabel(state) {
  return STATE_LABELS[state] || "Unknown";
}

/**
 * True when the runtime is still serving a verified release but the most
 * recent operation failed. The state stays LIVE; the failure is secondary.
 */
export function liveWithFailedLatest(currentState) {
  const authority = currentState?.stateAuthority;
  return authority?.state === "LIVE"
    && !authority?.activeOperation
    && authority?.latestCompletedOperation?.outcome === "failed";
}
