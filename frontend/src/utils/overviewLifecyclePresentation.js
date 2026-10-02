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

export function failureRecoveryCommand(operation, canRetry = false) {
  const diagnosis = operation?.diagnosis;
  const retryDecision = diagnosis?.retryDecision;
  if (canRetry && (!diagnosis || retryDecision === "SAFE_NOW")) return "retry";
  const operationType = operation?.operationType || operation?.deploymentAction || "deploy";
  const failureOwner = diagnosis?.failureOwner || operation?.failureOwner;
  return operationType === "deploy" && retryDecision === "SAFE_AFTER_FIX" && failureOwner === "REPOSITORY_APPLICATION"
    ? "deploy_fixed"
    : null;
}

function deploymentFailureCopy(phase, workflowRunId) {
  if (!workflowRunId) return ["Deployment could not start", "DeployGuard could not start the build on GitHub Actions."];
  if (phase === "source") return ["Source preparation failed", "The deployment stopped before your app was built."];
  if (phase === "build") return ["Build failed", "Your app could not be built, so nothing was published."];
  if (phase === "deploy") return ["Deployment failed", "The new release could not be started on AWS."];
  if (phase === "verify") return ["Health check failed", "The new release started but did not pass its health check."];
  if (phase === "finalize") return ["Release could not be finalized", "The release ran, but its final evidence could not be recorded."];
  return ["Deployment failed", "The deployment did not complete."];
}

export function overviewLifecycleCopy(currentState) {
  const canonicalState = canonicalOverviewState(currentState);
  const state = latestOperationFailed(currentState) ? "FAILED" : canonicalState;
  const operationType = latestOverviewOperationType(currentState);
  const failedPhase = currentState?.progress?.phase;
  const copy = {
    READY: ["Ready to deploy", "Repository and branch are configured. No deployment has started yet."],
    DEPLOYING: operationType === "rollback"
      ? ["Rollback in progress", "Restoring the previous release. Other actions are paused until it finishes."]
      : ["Deployment in progress", "Building and starting your app. Other actions are paused until it finishes."],
    FAILED: operationType === "destroy"
      ? ["Destroy failed", "Some infrastructure may remain. Review what went wrong before retrying."]
      : operationType === "rollback"
        ? ["Rollback failed", "The previous release could not be restored. Review what went wrong before retrying."]
        : deploymentFailureCopy(failedPhase, currentState?.latestAttempt?.workflowRunId),
    LIVE: ["Live", "The current release passed its health check."],
    DESTROYING: ["Infrastructure is being destroyed", "Your app is being taken offline and its AWS resources removed."],
    DESTROYED: ["Infrastructure destroyed", "Deployment history is kept. You can deploy again at any time."],
    BLOCKED: ["Needs attention", "DeployGuard cannot safely continue until the reported issue is resolved."],
  };
  const [title, fallbackMessage] = copy[state] || ["State unknown", "The current deployment state could not be determined."];
  const runtimeStillLive = canonicalState === "LIVE" && state === "FAILED";
  const message = runtimeStillLive
    ? `${fallbackMessage} The previously verified release remains live.`
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
  if (state === "DESTROYED") return canManage ? [{ kind: "command", command: "deploy", label: "Deploy again" }] : [];
  if (state === "DEPLOYING" || state === "DESTROYING") return [{ kind: "link", target: "pipeline", label: "View progress" }];
  if (state === "FAILED") {
    const recoveryCommand = canManage ? failureRecoveryCommand(currentState?.latestAttempt, currentState?.canRetry) : null;
    return [
      { kind: "link", target: "pipeline", label: "View deployments" },
      ...(recoveryCommand ? [{
        kind: "command",
        command: recoveryCommand,
        label: recoveryCommand === "deploy_fixed"
          ? "Deploy fixed commit"
          : latestOverviewOperationType(currentState) === "destroy"
            ? "Retry destroy"
            : latestOverviewOperationType(currentState) === "rollback"
              ? "Retry rollback"
              : "Retry deployment",
      }] : []),
    ];
  }
  if (state === "LIVE") return [
    ...(currentState?.stableUrl ? [{ kind: "external", href: currentState.stableUrl, label: "Open app" }] : []),
    ...(canManage ? [
      { kind: "command", command: "redeploy", label: "Redeploy" },
      ...(currentState?.stableRelease?.rollbackAvailable
        ? [{ kind: "command", command: "rollback", label: "Roll back" }]
        : [{ kind: "disabled", command: "rollback", label: "Roll back", reason: "No previous successful release is available." }]),
      { kind: "command", command: "destroy", label: "Destroy infrastructure" },
    ] : []),
  ];
  return [{ kind: "link", target: "pipeline", label: "View deployments" }];
}
