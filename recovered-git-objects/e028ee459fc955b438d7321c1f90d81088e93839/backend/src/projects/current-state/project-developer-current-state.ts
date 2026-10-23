import {
  DeveloperAction,
  DeveloperProgressPhase,
  DeveloperProjectCurrentState,
  DeveloperState,
} from "./project-current-state.types";

type JsonRecord = Record<string, unknown>;

const ACTIVE_STATES = new Set(["prepared", "queued", "running", "reconciling"]);
const RETRYABLE_PRE_EXECUTION_CODES = new Set([
  "FIRST_RELEASE_PRE_EXECUTION_RETRY_READY",
]);
const PLATFORM_CONFLICT_CODES = new Set([
  "NORMAL_RELEASE_LANE_LEGACY_ACTIVITY_CONFLICT",
  "NORMAL_RELEASE_LANE_STABLE_IDENTITY_CONFLICT",
  "NORMAL_FIRST_RELEASE_STABLE_LINEAGE_CONFLICT",
  "NORMAL_FIRST_RELEASE_APPLY_CONTINUATION_CONFLICT",
]);
const PHASE_LABELS: Record<Exclude<DeveloperProgressPhase, null>, string> = {
  analyze: "Analyze",
  build: "Build",
  prepare: "Prepare",
  deploy: "Deploy",
  verify: "Verify",
};

/**
 * Pure, fail-closed projection from the internal evidence graph to the only
 * state shape ordinary developer pages may consume.
 */
export function projectDeveloperCurrentState(input: unknown): DeveloperProjectCurrentState {
  const detailed = record(input);
  const releaseLane = record(detailed.releaseLane);
  const intent = record(releaseLane.intent);
  const operation = record(intent.operation);
  const stableEvidence = record(releaseLane.stableRelease);
  const contract = record(detailed.deploymentContract);
  const repositoryEvidence = record(detailed.repository);
  const requirements = record(detailed.deploymentRequirements);
  const availability = record(detailed.normalV1Availability);
  const approval = record(detailed.approvalState);
  const infrastructurePlanning = record(intent.infrastructurePlanning);
  const infrastructureReview = record(infrastructurePlanning.review);
  const automaticApproval = record(infrastructureReview.approval);
  const existingState = record(detailed.existingState);
  const existingStateClassification = string(existingState.classification);
  const existingStateBlocksDeveloper = detailed.localExecutionAuthorized !== true
    && ["adoptable", "safe_residue", "ambiguous"]
      .includes(existingStateClassification || "");
  const safeCodes = strings(releaseLane.safeCodes);
  const phases = records(operation.phases);
  const stableRelease = sanitizedStableRelease(stableEvidence);
  const stableUrl = stableRelease && !existingStateBlocksDeveloper
    ? safeUrl(stableEvidence.url)
    : null;
  const commit = safeSha(contract.commitSha) || safeSha(intent.sourceCommitShortSha);
  const missingConfiguration = uniqueSorted([
    ...strings(requirements.unresolvedInputKeys),
    ...strings(contract.missingEnvVars),
    ...(!string(contract.buildCommand) && contract.deployable === false ? ["BUILD_COMMAND"] : []),
    ...(!string(contract.startCommand) && contract.deployable === false ? ["START_COMMAND"] : []),
  ]);
  const progress = developerProgress(phases, number(detailed.progressPercentage));
  const reportedConflict = safeCodes.some((code) => PLATFORM_CONFLICT_CODES.has(code));
  const laneState = string(releaseLane.state);
  const preExecutionRetryReady = safeCodes.some((code) =>
    RETRYABLE_PRE_EXECUTION_CODES.has(code));
  let latestAttempt = sanitizedLatestAttempt(operation, intent, progress.phase, laneState, reportedConflict);
  const conflict = reportedConflict || hasStableLatestIdentityConflict(stableRelease, latestAttempt);
  if (conflict && latestAttempt) latestAttempt = { ...latestAttempt, status: "platform_attention", outcome: "blocked" };
  const estimatedCost = sanitizedCost(intent, approval);
  const failure = applicationFailure(detailed, operation, phases);
  const repository = string(detailed.repositoryFullName) || string(repositoryEvidence.fullName);
  const branch = string(detailed.branch) || string(repositoryEvidence.branch);
  const canManage = detailed.canManage === true;
  const sameStableSource = Boolean(
    stableRelease?.commit && commit
      && (commit.toLowerCase().startsWith(stableRelease.commit.toLowerCase())
        || stableRelease.commit.toLowerCase().startsWith(commit.toLowerCase())),
  );

  let developerState: DeveloperState;
  let developerAction: DeveloperAction;
  let developerMessage: string;
  let applicationError: DeveloperProjectCurrentState["applicationError"] = null;
  let canRetry = false;

  if (existingStateBlocksDeveloper || conflict || availability.mode === "configuration_required" || laneState === "disabled"
    || ["operator_required", "platform_attention"].includes(String(automaticApproval.state))) {
    developerState = "platform_attention";
    developerAction = "none";
    developerMessage = stableRelease
      ? "The platform needs attention. Your previous stable deployment is unchanged."
      : "The platform is preparing your deployment. No action is required.";
  } else if (!repository || !branch) {
    developerState = "configuration_required";
    developerAction = "provide_configuration";
    developerMessage = "Connect an accessible repository and branch to continue.";
    applicationError = { category: "repository", message: developerMessage };
  } else if (availability.state === "unsupported" || (contract.deployable === false && missingConfiguration.length === 0)) {
    developerState = "unsupported";
    developerAction = "none";
    developerMessage = "This repository type is not yet supported.";
  } else if (missingConfiguration.length > 0) {
    developerState = "configuration_required";
    developerAction = "provide_configuration";
    developerMessage = "Provide the required application configuration to continue.";
    applicationError = { category: "configuration", message: developerMessage };
  } else if (automaticApproval.state === "owner_required"
    || (approval.gate === "cost_gate" && approval.required === true)) {
    developerState = "approval_required";
    developerAction = "approve_cost";
    developerMessage = "Review and approve the estimated cost to continue.";
  } else if (failure) {
    developerState = "failed_application";
    developerAction = stableRelease ? "redeploy" : "deploy";
    developerMessage = failure.message;
    applicationError = failure;
    canRetry = true;
  } else if (laneState === "blocked" || laneState === "cancelled") {
    if (preExecutionRetryReady) {
      developerState = "ready";
      developerAction = stableRelease ? "redeploy" : "deploy";
      developerMessage = "This project is ready to deploy.";
    } else {
      developerState = "platform_attention";
      developerAction = "none";
      developerMessage = "The platform is reviewing deployment evidence. No action is required.";
    }
  } else if (laneState === "queued") {
    developerState = "queued";
    developerAction = "none";
    developerMessage = "Your deployment is queued.";
  } else if (laneState === "running" || laneState === "reconciling") {
    developerState = stateForPhase(progress.phase, laneState === "reconciling" ? "verifying" : "deploying");
    developerAction = "none";
    developerMessage = laneState === "reconciling"
      ? "DeployGuard is verifying the deployment. No action is required."
      : `${progress.label} is in progress.`;
  } else if (laneState === "prepared") {
    developerState = "preparing";
    developerAction = "none";
    developerMessage = "DeployGuard is preparing the deployment. No action is required.";
  } else if (stableRelease && sameStableSource) {
    developerState = "live";
    developerAction = stableUrl ? "open_application" : "none";
    developerMessage = stableUrl ? "The latest release is live." : "The latest release is stable.";
  } else {
    developerState = "ready";
    developerAction = stableRelease ? "redeploy" : "deploy";
    developerMessage = stableRelease
      ? "A newer source revision is ready to deploy."
      : "This project is ready to deploy.";
  }

  if (!canManage && ["deploy", "redeploy", "provide_configuration", "approve_cost"].includes(developerAction)) {
    developerAction = "none";
    if (developerState === "approval_required") {
      developerMessage = "The project owner must approve the estimated cost to continue.";
    }
  }

  return {
    developerState,
    developerAction,
    developerMessage,
    progress: developerState === "live"
      ? { percentage: 100, phase: "verify", label: "Live" }
      : progress,
    repository,
    branch,
    commit,
    latestAttempt,
    stableRelease,
    stableUrl,
    estimatedCost,
    missingConfiguration,
    applicationError,
    canRetry,
  };
}

function hasStableLatestIdentityConflict(
  stable: DeveloperProjectCurrentState["stableRelease"],
  latest: DeveloperProjectCurrentState["latestAttempt"],
): boolean {
  if (!stable || !latest?.releaseRevision || !latest.commit) return false;
  if (stable.revision !== latest.releaseRevision) return false;
  const stableCommit = stable.commit.toLowerCase();
  const latestCommit = latest.commit.toLowerCase();
  return !stableCommit.startsWith(latestCommit) && !latestCommit.startsWith(stableCommit);
}

function developerProgress(phases: JsonRecord[], fallback: number | null): DeveloperProjectCurrentState["progress"] {
  const normalized = phases
    .map((phase) => ({ key: phaseKey(phase.key), status: string(phase.status) }))
    .filter((phase): phase is { key: Exclude<DeveloperProgressPhase, null>; status: string | null } => Boolean(phase.key));
  const current = normalized.find((phase) => phase.status === "running")
    || normalized.find((phase) => !["passed", "skipped"].includes(phase.status || ""))
    || normalized.at(-1);
  const percentage = normalized.length
    ? Math.round((normalized.filter((phase) => phase.status === "passed").length / normalized.length) * 100)
    : clamp(fallback || 0);
  return {
    percentage,
    phase: current?.key || null,
    label: current?.key ? PHASE_LABELS[current.key] : "Ready",
  };
}

function sanitizedLatestAttempt(
  operation: JsonRecord,
  intent: JsonRecord,
  phase: DeveloperProgressPhase,
  laneState: string | null,
  conflict: boolean,
): DeveloperProjectCurrentState["latestAttempt"] {
  const latest = record(operation.latestAttempt);
  const releaseRevision = string(latest.releaseRevision) || string(intent.releaseManifestRevision);
  const commit = safeSha(latest.sourceCommitShortSha) || safeSha(intent.sourceCommitShortSha);
  const occurredAt = iso(latest.lastMeaningfulAt) || iso(intent.lastMeaningfulAt);
  if (!releaseRevision && !commit && !occurredAt) return null;
  const raw = string(operation.terminalResult) || string(latest.status) || "preparing";
  const status: DeveloperState = raw === "live" || raw === "completed"
    ? "live"
    : raw === "failed" || raw === "blocked" || raw === "cancelled"
      ? "platform_attention"
      : raw === "queued"
        ? "queued"
        : raw === "running" || raw === "reconciling"
          ? stateForPhase(phase, raw === "reconciling" ? "verifying" : "deploying")
          : "preparing";
  const outcome = conflict || laneState === "blocked"
    ? "blocked"
    : laneState === "cancelled"
      ? "cancelled"
      : laneState === "completed"
        ? "completed"
        : null;
  return { status, outcome, releaseRevision, commit, occurredAt };
}

function sanitizedStableRelease(value: JsonRecord): DeveloperProjectCurrentState["stableRelease"] {
  if (value.status !== "stable") return null;
  const revision = string(value.revision);
  const commit = safeSha(value.sourceCommitShortSha);
  const promotedAt = iso(value.promotedAt);
  if (!revision || !commit || !promotedAt) return null;
  return { revision, commit, promotedAt, rollbackAvailable: Boolean(value.rollbackLineage) };
}

function sanitizedCost(intent: JsonRecord, approval: JsonRecord): DeveloperProjectCurrentState["estimatedCost"] {
  const planning = record(intent.infrastructurePlanning);
  const review = record(planning.review);
  const automaticApproval = record(review.approval);
  const cost = record(review.costEstimate);
  if (!Object.keys(cost).length && approval.gate !== "cost_gate" && !automaticApproval.state) return null;
  const monthly = number(cost.monthlyCost);
  const status = automaticApproval.state === "owner_required"
    || (approval.gate === "cost_gate" && approval.required === true)
    ? "approval_required"
    : cost.state === "real" && monthly !== null
      ? "estimated"
      : "unavailable";
  return { status, currency: string(cost.currency), monthly };
}

function applicationFailure(
  detailed: JsonRecord,
  operation: JsonRecord,
  phases: JsonRecord[],
): DeveloperProjectCurrentState["applicationError"] {
  const failureClass = string(detailed.failureClass);
  const failedPhase = phases.find((phase) => phase.status === "failed");
  const failedKey = phaseKey(failedPhase?.key);
  if (failureClass === "application_health_failed" || failedKey === "verify") {
    return { category: "health", message: "The application did not become healthy. Check its port, health path, and startup behavior." };
  }
  if (failureClass === "runtime_deployment_failed") {
    return { category: "runtime", message: "The application could not start. Check its start command and runtime configuration." };
  }
  if (failedKey === "build") {
    return { category: "build", message: "The application build failed. Check the build command and repository dependencies." };
  }
  return operation.terminalResult === "failed" && failedKey === "analyze"
    ? { category: "configuration", message: "The application could not be analyzed. Check its repository and build configuration." }
    : null;
}

function stateForPhase(phase: DeveloperProgressPhase, fallback: DeveloperState): DeveloperState {
  if (phase === "build") return "building";
  if (phase === "deploy") return "deploying";
  if (phase === "verify") return "verifying";
  if (phase === "analyze" || phase === "prepare") return "preparing";
  return fallback;
}

function phaseKey(value: unknown): Exclude<DeveloperProgressPhase, null> | null {
  return ["analyze", "build", "prepare", "deploy", "verify"].includes(String(value))
    ? value as Exclude<DeveloperProgressPhase, null>
    : null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function records(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function string(value: unknown): string | null {
  const result = typeof value === "string" ? value.trim() : "";
  return result || null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(string).filter((item): item is string => Boolean(item)) : [];
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function safeSha(value: unknown): string | null {
  const result = string(value);
  return result && /^[a-f0-9]{7,64}$/i.test(result) ? result : null;
}

function iso(value: unknown): string | null {
  const result = string(value);
  return result && Number.isFinite(Date.parse(result)) ? new Date(result).toISOString() : null;
}

function safeUrl(value: unknown): string | null {
  const result = string(value);
  if (!result) return null;
  try {
    const parsed = new URL(result);
    return ["http:", "https:"].includes(parsed.protocol) && parsed.hostname ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter((value) => /^[A-Z][A-Z0-9_]{0,127}$/.test(value)))].sort();
}
