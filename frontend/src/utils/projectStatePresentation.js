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
