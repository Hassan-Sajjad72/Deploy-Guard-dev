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

export function overviewFailureOwnershipLabel(currentState) {
  const failed = canonicalOverviewState(currentState) === "FAILED" || latestOperationFailed(currentState);
  return failed && currentState?.latestAttempt?.failureOwner === "REPOSITORY_APPLICATION"
    ? "Repository failure"
    : null;
}

export function latestOverviewOperationType(currentState) {
  const type = currentState?.latestAttempt?.operationType
    || currentState?.stateAuthority?.activeOperation?.type
    || currentState?.stateAuthority?.latestCompletedOperation?.type;
  return ["deploy", "destroy", "rollback"].includes(type) ? type : "deploy";
}

function deploymentFailureCopy(phase, workflowRunId) {
  if (!workflowRunId) return ["Deployment could not start", "DeployGuard could not create a GitHub Actions run."];
  if (phase === "source") return ["Prepare Source failed", "Deployment stopped before the application build started."];
  if (phase === "build") return ["Build Application failed", "Build stopped before image publication. View Pipeline for technical evidence."];
  if (phase === "deploy") return ["Deploy Runtime failed", "Runtime deployment did not complete. View Pipeline for technical evidence."];
  if (phase === "verify") return ["Verify Application failed", "Release verification did not complete. View Pipeline for technical evidence."];
  if (phase === "finalize") return ["Finalize Release failed", "Terminal release evidence validation did not complete. View Pipeline for technical evidence."];
  return ["Deployment failed", "The deployment did not complete. View Pipeline for technical evidence."];
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
        : deploymentFailureCopy(failedPhase, currentState?.latestAttempt?.workflowRunId),
    LIVE: ["Application is live", "The latest release passed its verified health check."],
    DESTROYING: ["Infrastructure is being destroyed", "Destroy is in progress. Application infrastructure is being removed and may become unavailable during cleanup."],
    DESTROYED: ["Infrastructure destroyed", "The previous deployment history is retained and this project can deploy again."],
    BLOCKED: ["Deployment needs attention", "DeployGuard cannot safely continue until the reported issue is resolved."],
  };
  const [title, fallbackMessage] = copy[state] || ["Deployment status", "Current deployment state is unavailable."];
  const runtimeStillLive = canonicalState === "LIVE" && state === "FAILED";
  const message = runtimeStillLive
    ? `${fallbackMessage} The previously verified application remains live.`
    : fallbackMessage;
  return { title, message };
}

/** Compact canonical copy for Dashboard and Overview; never renders run evidence. */
export function conciseProjectSummary(currentState) {
  return overviewLifecycleCopy(currentState).message;
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
