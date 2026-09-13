export const DEVELOPER_DEPLOYMENT_PHASES = Object.freeze([
  { key: "source", label: "Prepare Source" },
  { key: "build", label: "Build Application" },
  { key: "publish", label: "Publish Image" },
  { key: "deploy", label: "Deploy Runtime" },
  { key: "verify", label: "Verify Application" },
  { key: "finalize", label: "Finalize Release" },
]);

export const DEVELOPER_ROLLBACK_PHASES = Object.freeze([
  { key: "source", label: "Prepare Rollback" },
  { key: "build", label: "Restore Release" },
  { key: "publish", label: "Update Runtime" },
  { key: "deploy", label: "Verify Application" },
  { key: "verify", label: "Finalize Rollback" },
]);

export const DEVELOPER_DESTROY_PHASES = Object.freeze([
  { key: "prepare", label: "Prepare" },
  { key: "destroy", label: "Destroy Infrastructure" },
  { key: "verify", label: "Verify Deletion" },
  { key: "finalize", label: "Finalize Cleanup" },
]);

const ACTIVE_STATES = new Set(["preparing", "queued", "building", "deploying", "verifying", "destroying"]);

export function deploymentPhasePresentation(currentState) {
  const destroy = currentState?.deploymentAction === "destroy"
    || currentState?.developerState === "destroying"
    || currentState?.developerState === "destroyed"
    || currentState?.stateAuthority?.activeOperation?.type === "destroy";
  const rollback = currentState?.deploymentAction === "rollback"
    || currentState?.latestAttempt?.operationType === "rollback"
    || currentState?.stateAuthority?.activeOperation?.type === "rollback";
  const phases = destroy ? DEVELOPER_DESTROY_PHASES : rollback ? DEVELOPER_ROLLBACK_PHASES : DEVELOPER_DEPLOYMENT_PHASES;
  const reportedKey = !destroy && currentState?.progress?.phase === "prepare" ? "source" : currentState?.progress?.phase || null;
  const currentKey = destroy && ["build", "deploy"].includes(reportedKey) ? "destroy"
    : destroy && currentState?.latestAttempt?.outcome === "completed" ? "finalize"
      : reportedKey;
  let currentIndex = phases.findIndex((phase) => phase.key === currentKey);
  const completed = currentState?.developerState === "live"
    || currentState?.latestAttempt?.outcome === "completed";
  const failed = currentState?.developerState === "failed_application";
  const attention = currentState?.developerState === "platform_attention"
    && currentState?.latestAttempt?.outcome === "blocked";
  const active = ACTIVE_STATES.has(currentState?.developerState);
  const evidence = Array.isArray(currentState?.latestAttempt?.workflowStages) ? currentState.latestAttempt.workflowStages : [];
  const lifecycleKeys = {
    source: ["checkout_exact_application_source", "configure_aws_credentials_through_oidc", "validate_immutable_release_input", "install_pinned_railpack"],
    build: ["build_immutable_railpack_image", "build_immutable_railpack_images", "build_and_push_immutable_railpack_image", "validate_application_runtime"],
    publish: ["publish_immutable_image_to_ecr", "publish_immutable_images_to_ecr", "install_trivy_scanner", "scan_exact_immutable_service_images"],
    deploy: ["install_terraform", "materialize_release_runtime"],
    verify: ["verify_alb_health_and_write_result"],
    finalize: ["publish_verified_release_result", "project_delete_cleanup"],
    destroy: ["install_terraform", "materialize_release_runtime"],
  };

  function evidenceStatus(phase) {
    const entries = evidence.filter((entry) => lifecycleKeys[phase]?.includes(entry?.key));
    if (!entries.length) return null;
    if (entries.some((entry) => entry.status === "failed")) return "failed";
    if (entries.some((entry) => entry.status === "running")) return "running";
    if (entries.some((entry) => entry.status === "passed")) return "passed";
    return "waiting";
  }

  if (completed || currentState?.developerState === "destroyed") {
    return phases.map((phase) => ({ ...phase, status: "passed" }));
  }
  if (currentState?.developerState === "ready") {
    return phases.map((phase) => ({ ...phase, status: "waiting" }));
  }

  if (!destroy) {
    const evidenceStatuses = phases.map((phase) => evidenceStatus(phase.key));
    const terminalEvidenceIndex = evidenceStatuses.findIndex((status) => status === "failed");
    const runningEvidenceIndex = evidenceStatuses.findIndex((status) => status === "running");
    if (failed && terminalEvidenceIndex >= 0) currentIndex = terminalEvidenceIndex;
    else if (active && runningEvidenceIndex >= 0) currentIndex = runningEvidenceIndex;
    else if (active) {
      const furthestPassedIndex = evidenceStatuses.reduce((highest, status, index) => status === "passed" ? index : highest, -1);
      currentIndex = Math.max(currentIndex, furthestPassedIndex);
    }
  }

  return phases.map((phase, index) => ({
    ...phase,
    status: currentIndex < 0 || index > currentIndex
      ? "waiting"
      : index < currentIndex
        ? "passed"
        : failed
          ? "failed"
          : attention
            ? "attention"
            : active
              ? "running"
              : "waiting",
  }));
}

export function deploymentProgressPercentage(phases) {
  if (!Array.isArray(phases) || phases.length < 2) return 0;
  if (phases.every((phase) => phase.status === "passed")) return 100;
  const currentIndex = phases.findIndex((phase) => ["running", "failed", "attention"].includes(phase.status));
  const lastPassedIndex = phases.reduce((highest, phase, index) => phase.status === "passed" ? index : highest, -1);
  const index = currentIndex >= 0 ? currentIndex : lastPassedIndex;
  return index < 0 ? 0 : Math.round((index / (phases.length - 1)) * 100);
}

export function failureTroubleshootingProjection(operations = [], sessions = []) {
  const candidates = operations.filter((operation) => ["failed", "dispatch_failed"].includes(operation?.status) && operation?.aiAnalysisEligible === true);
  const candidateIds = new Set(candidates.map((operation) => operation.id));
  return {
    candidates,
    sessions: sessions.filter((session) => candidateIds.has(session?.pipelineRunId)),
  };
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
      return { kind: "link", label: "Provide Configuration", href: `/projects/${projectId}/settings` };
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
