import {
  dispatchNormalFirstReleaseInfrastructurePlan,
  dispatchNormalReleaseLane,
  prepareNormalReleaseLane,
} from "../api/projectApi.js";

export const NORMAL_RELEASE_ACTIONS = new Set([
  "deploy",
  "redeploy",
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

async function dispatchRelease(projectId) {
  const response = await dispatchNormalReleaseLane(projectId);
  if (response?.releaseLane?.state !== "dispatched") {
    throw new Error(normalReleaseActionError(response?.releaseLane, "Release dispatch is unavailable."));
  }
  return "Release prepared and queued for controlled execution.";
}

async function prepareAndDispatch(projectId) {
  const response = await prepareNormalReleaseLane(projectId);
  const prepared = response?.releaseLane;
  if (prepared?.state === "no_op") {
    return "This exact source and configuration are already live.";
  }
  if (prepared?.state !== "prepared") {
    throw new Error(normalReleaseActionError(prepared, "Release preparation is unavailable."));
  }
  if (!prepared.firstRelease) {
    return dispatchRelease(projectId);
  }
  const dispatched = await dispatchNormalFirstReleaseInfrastructurePlan(projectId);
  if (dispatched?.infrastructurePlan?.state !== "dispatched") {
    throw new Error(normalReleaseActionError(dispatched?.infrastructurePlan, "Infrastructure plan dispatch is unavailable."));
  }
  return "Foundation prepared and queued for Terraform planning.";
}

export async function executeNormalReleaseAction(
  projectId,
  currentState,
) {
  const type = currentState?.developerAction;
  if (!NORMAL_RELEASE_ACTIONS.has(type)) {
    throw new Error("This deployment action is not available.");
  }
  return prepareAndDispatch(projectId);
}
