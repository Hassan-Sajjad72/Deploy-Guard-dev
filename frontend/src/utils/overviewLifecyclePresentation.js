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
  return currentState?.stateAuthority?.state || FALLBACK_STATES[currentState?.developerState] || "DEPLOYING";
}

export function latestOverviewOperationType(currentState) {
  const type = currentState?.latestAttempt?.operationType
    || currentState?.stateAuthority?.activeOperation?.type
    || currentState?.stateAuthority?.latestCompletedOperation?.type;
  return ["deploy", "destroy", "rollback"].includes(type) ? type : "deploy";
}

export function overviewLifecycleCopy(currentState) {
  const state = canonicalOverviewState(currentState);
  const operationType = latestOverviewOperationType(currentState);
  const copy = {
    READY: ["Ready to Deploy", "Analysis and pre-flight are complete. No deployment has started yet."],
    DEPLOYING: ["Deployment in progress", "GitHub Actions is processing the current deployment. Actions are unavailable until it reconciles."],
    FAILED: operationType === "destroy"
      ? ["Destroy failed", "Review the failed pipeline evidence before retrying this destroy operation."]
      : operationType === "rollback"
        ? ["Rollback failed", "Review the failed pipeline evidence before retrying this rollback."]
        : ["Deployment failed", "Review the failed pipeline evidence before retrying this deployment."],
    LIVE: ["Application is live", "The latest release passed its verified health check."],
    DESTROYING: ["Infrastructure is being destroyed", "GitHub Actions is removing project-scoped infrastructure."],
    DESTROYED: ["Infrastructure destroyed", "The previous deployment history is retained and this project can deploy again."],
    BLOCKED: ["Deployment needs attention", "DeployGuard cannot safely continue until the reported issue is resolved."],
  };
  const [title, fallbackMessage] = copy[state] || ["Deployment status", "Current deployment state is unavailable."];
  return { title, message: currentState?.developerMessage || fallbackMessage };
}

export function overviewLifecycleActions(currentState, canManage = false) {
  const state = canonicalOverviewState(currentState);
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
