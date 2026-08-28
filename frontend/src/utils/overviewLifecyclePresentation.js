import { projectStatePresentation } from "./projectStatePresentation.js";

const FALLBACK_STATES = {
  ready: "READY",
  live: "LIVE",
  destroying: "DESTROYING",
  destroyed: "DESTROYED",
  failed_application: "FAILED",
};

/**
 * Overview actions are derived from the canonical current-state response.
 * No operation history, URL presence, or client-reconstructed workflow state
 * is allowed to add a lifecycle action here.
 */
export function canonicalOverviewState(currentState) {
  return projectStatePresentation(currentState).state
    || currentState?.stateAuthority?.state
    || FALLBACK_STATES[currentState?.developerState]
    || "DEPLOYING";
}

function latestOperationFailed(currentState) {
  return !currentState?.stateAuthority?.activeOperation
    && currentState?.stateAuthority?.latestCompletedOperation?.outcome === "failed";
}

export function latestOverviewOperationType(currentState) {
  const type = currentState?.latestAttempt?.operationType
    || currentState?.stateAuthority?.activeOperation?.type
    || currentState?.stateAuthority?.latestCompletedOperation?.type;
  return ["deploy", "destroy", "rollback"].includes(type) ? type : "deploy";
}

export function overviewLifecycleCopy(currentState) {
  const canonicalState = canonicalOverviewState(currentState);
  const state = latestOperationFailed(currentState) ? "FAILED" : canonicalState;
  const operationType = latestOverviewOperationType(currentState);
  const failedPhase = currentState?.progress?.phase;
  const copy = {
    READY: ["Ready to Deploy", "Repository and branch are configured. No deployment has started yet."],
    DEPLOYING: operationType === "rollback"
      ? ["Rollback in progress", "GitHub Actions is processing the current rollback. Actions are unavailable until it reconciles."]
      : ["Deployment in progress", "GitHub Actions is processing the current deployment. Actions are unavailable until it reconciles."],
    FAILED: operationType === "destroy"
      ? ["Destroy failed", "Review the failed pipeline evidence before retrying this destroy operation."]
      : operationType === "rollback"
        ? ["Rollback failed", "Review the failed pipeline evidence before retrying this rollback."]
        : currentState?.latestAttempt?.workflowRunId
          ? [failedPhase === "build" ? "Railpack Build failed" : "Deployment failed", "GitHub Actions reported a failed deployment. Review the persisted pipeline evidence before retrying."]
          : ["Deployment could not start", "DeployGuard failed while starting the GitHub Actions deployment. No GitHub Actions run was created."],
    LIVE: ["Application is live", "The latest release passed its verified health check."],
    DESTROYING: ["Infrastructure is being destroyed", "Destroy is in progress. Application infrastructure is being removed and may become unavailable during cleanup."],
    DESTROYED: ["Infrastructure destroyed", "The previous deployment history is retained and this project can deploy again."],
    BLOCKED: ["Deployment needs attention", "DeployGuard cannot safely continue until the reported issue is resolved."],
  };
  const [title, fallbackMessage] = copy[state] || ["Deployment status", "Current deployment state is unavailable."];
  const runtimeStillLive = canonicalState === "LIVE" && state === "FAILED";
  const message = state === "DESTROYING"
    ? fallbackMessage
    : runtimeStillLive
      ? `${fallbackMessage} The previously verified application remains live.`
      : currentState?.developerMessage || fallbackMessage;
  return { title, message };
}

export function overviewLifecycleActions(currentState, canManage = false) {
  const state = latestOperationFailed(currentState) ? "FAILED" : canonicalOverviewState(currentState);
  if (state === "READY") return canManage ? [{ kind: "command", command: "deploy", label: "Deploy" }] : [];
  if (state === "DESTROYED") return canManage ? [{ kind: "command", command: "deploy", label: "Deploy Again" }] : [];
  if (state === "DEPLOYING" || state === "DESTROYING") return [{ kind: "link", target: "pipeline", label: "View progress" }];
  if (state === "FAILED") return [
    { kind: "link", target: "pipeline", label: "View Pipeline" },
    ...(canManage && currentState?.canRetry ? [{
      kind: "command",
      command: "retry",
      label: latestOverviewOperationType(currentState) === "destroy"
        ? "Retry Failed Destroy"
        : latestOverviewOperationType(currentState) === "rollback"
          ? "Retry Failed Rollback"
          : "Retry Failed Deployment",
    }] : []),
  ];
  if (state === "LIVE") return [
    ...(currentState?.stableUrl ? [{ kind: "external", href: currentState.stableUrl, label: "Open Application" }] : []),
    ...(canManage ? [
      { kind: "command", command: "redeploy", label: "Redeploy" },
      ...(currentState?.stableRelease?.rollbackAvailable
        ? [{ kind: "command", command: "rollback", label: "Rollback application" }]
        : [{ kind: "disabled", command: "rollback", label: "Rollback application", reason: "No previous successful release is available." }]),
      { kind: "command", command: "destroy", label: "Destroy Infrastructure" },
    ] : []),
  ];
  return [{ kind: "link", target: "pipeline", label: "View Pipeline" }];
}
