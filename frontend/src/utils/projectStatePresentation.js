/**
 * The sole browser-side translation of the backend current-state contract.
 * Pages receive presentation data here; they do not reconstruct lifecycle
 * state from individual infrastructure, log, or historical-operation APIs.
 */
const ACTIVE = new Set(["DEPLOYING", "DESTROYING"]);

export function projectStatePresentation(currentState) {
  const state = currentState?.stateAuthority?.state || fallbackState(currentState?.developerState);
  return {
    state,
    active: ACTIVE.has(state),
    headline: currentState?.stateAuthority?.reason || currentState?.developerMessage || "Project state is unavailable.",
    operation: currentState?.stateAuthority?.activeOperation || null,
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
