import { approveNormalV1Cost, deployNormalV1 } from "../api/projectApi.js";

export const NORMAL_RELEASE_ACTIONS = new Set([
  "deploy",
  "redeploy",
  "approve_cost",
]);

export function normalReleaseActionError(result, fallback) {
  const safeCode = result?.safeCodes?.[0];
  if (!safeCode) return fallback;
  if (/DISABLED|CONFIGURATION_INVALID/.test(safeCode)) {
    return "Deployment is not enabled for this project and environment.";
  }
  if (/ACTOR_NOT_ALLOWED|PROJECT_INELIGIBLE/.test(safeCode)) {
    return "You cannot deploy this project or environment.";
  }
  if (/ALREADY|NOT_UNIQUE|CONFLICT|MALFORMED|STALE/.test(safeCode)) {
    return "Deployment evidence changed or conflicts with the current operation. Refresh before continuing.";
  }
  if (/CLAIM|LEASE|OWNER|RUNNING|RECONCIL/.test(safeCode)) {
    return "This deployment is already progressing or being reconciled. Refresh to see its current state.";
  }
  if (/OUTBOX|DISPATCH|UNAVAILABLE/.test(safeCode)) {
    return "Deployment could not be queued safely. Refresh before trying again.";
  }
  return fallback;
}

export async function executeNormalReleaseAction(
  projectId,
  currentState,
) {
  const type = currentState?.developerAction;
  if (!NORMAL_RELEASE_ACTIONS.has(type)) {
    throw new Error("This deployment action is not available.");
  }
  const response = type === "approve_cost"
    ? await approveNormalV1Cost(projectId)
    : await deployNormalV1(projectId);
  const deployment = response?.deployment;
  if (!["accepted", "no_op"].includes(deployment?.state)) {
    throw new Error(deployment?.message || "Deployment is unavailable.");
  }
  return deployment.message;
}
