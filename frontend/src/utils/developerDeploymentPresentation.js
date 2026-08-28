export const DEVELOPER_DEPLOYMENT_PHASES = Object.freeze([
  { key: "source", label: "Source / Dispatch" },
  { key: "build", label: "Railpack Build" },
  { key: "publish", label: "Publish Image" },
  { key: "deploy", label: "Deploy Runtime" },
  { key: "verify", label: "Verify" },
]);

export const DEVELOPER_DESTROY_PHASES = Object.freeze([
  { key: "prepare", label: "Prepare" },
  { key: "destroy", label: "Destroy" },
  { key: "verify", label: "Verify" },
]);

const ACTIVE_STATES = new Set(["preparing", "queued", "building", "deploying", "verifying", "destroying"]);

export function deploymentPhasePresentation(currentState) {
  const destroy = currentState?.deploymentAction === "destroy"
    || currentState?.developerState === "destroying"
    || currentState?.developerState === "destroyed"
    || currentState?.stateAuthority?.activeOperation?.type === "destroy";
  const phases = destroy ? DEVELOPER_DESTROY_PHASES : DEVELOPER_DEPLOYMENT_PHASES;
  const reportedKey = currentState?.progress?.phase === "prepare" ? "source" : currentState?.progress?.phase || null;
  const currentKey = destroy && ["build", "deploy"].includes(reportedKey) ? "destroy" : reportedKey;
  const currentIndex = phases.findIndex((phase) => phase.key === currentKey);
  const completed = currentState?.developerState === "live"
    || currentState?.latestAttempt?.outcome === "completed";
  const failed = currentState?.developerState === "failed_application";
  const attention = currentState?.developerState === "platform_attention"
    && currentState?.latestAttempt?.outcome === "blocked";
  const active = ACTIVE_STATES.has(currentState?.developerState);

  return phases.map((phase, index) => {
    let status = "waiting";
    if (currentState?.developerState === "destroyed") {
      status = destroy ? "passed" : index < 2 ? "passed" : "waiting";
    } else if (currentState?.developerState === "ready") {
      status = "waiting";
    } else if (completed) status = "passed";
    else if (currentIndex >= 0 && index === currentIndex && failed) status = "failed";
    else if (currentIndex >= 0 && index === currentIndex && attention) status = "attention";
    else if (currentIndex >= 0 && index === currentIndex && active) status = "running";
    return { ...phase, status };
  });
}

export function deploymentActionPresentation(currentState, projectId) {
  switch (currentState?.developerAction) {
    case "deploy":
      return { kind: "command", label: "Deploy" };
    case "deploy_again":
      return { kind: "command", label: "Deploy Again" };
    case "redeploy":
      return { kind: "command", label: "Redeploy" };
    case "approve_cost":
      return { kind: "command", label: "Approve Cost" };
    case "provide_configuration":
      return { kind: "link", label: "Provide Configuration", href: `/projects/${projectId}/requirements` };
    case "open_application":
      return currentState?.stableUrl
        ? { kind: "external", label: "Open Application", href: currentState.stableUrl }
        : null;
    default:
      return null;
  }
}

export function deploymentCostPresentation(estimatedCost) {
  if (!estimatedCost) {
    return {
      label: "Pending",
      detail: "Estimated during deployment preparation.",
    };
  }
  if (estimatedCost.status === "approval_required") {
    return {
      label: "Approval required",
      detail: monthlyCost(estimatedCost) || "Review the deployment estimate to continue.",
    };
  }
  if (estimatedCost.status === "estimated") {
    return {
      label: monthlyCost(estimatedCost) || "Estimated",
      detail: "Estimated monthly platform cost.",
    };
  }
  return {
    label: "Unavailable",
    detail: "The platform is reviewing cost evidence.",
  };
}

function monthlyCost(cost) {
  if (typeof cost?.monthly !== "number" || !Number.isFinite(cost.monthly)) return null;
  const currency = typeof cost.currency === "string" && cost.currency ? cost.currency : "USD";
  return `${new Intl.NumberFormat(undefined, { style: "currency", currency }).format(cost.monthly)}/month`;
}
