const TERMINAL_LABELS = {
  live: "Live",
  failed: "Failed",
};

function human(value) {
  return String(value || "not started").replaceAll("_", " ");
}

/**
 * One frontend projection for the sanitized normal-v1 operation and stable
 * release already carried by project current-state/workspace-summary.
 */
export function normalReleaseView(currentState) {
  const releaseLane = currentState?.releaseLane;
  const operation = releaseLane?.intent?.operation || null;
  const stableRelease = releaseLane?.stableRelease || null;
  if (!operation && !stableRelease) return null;

  const phases = Array.isArray(operation?.phases) ? operation.phases : [];
  const passedPhases = phases.filter((phase) => phase.status === "passed").length;
  const activePhase = phases.find((phase) => phase.status === "running")
    || phases.find((phase) => ["failed", "waiting", "not_started"].includes(phase.status))
    || phases.at(-1)
    || null;
  const status = operation?.terminalResult
    || operation?.latestAttempt?.status
    || (stableRelease?.status === "stable" ? "live" : releaseLane?.state)
    || "not_started";
  const progress = phases.length
    ? Math.round((passedPhases / phases.length) * 100)
    : stableRelease?.status === "stable" ? 100 : 0;

  return {
    operation,
    stableRelease,
    status,
    statusLabel: TERMINAL_LABELS[status] || human(status),
    progress,
    phaseLabel: activePhase?.label || (stableRelease ? "Stable release" : "Release prepared"),
    summary: operation
      ? `Release ${operation.latestAttempt?.releaseRevision || "—"} · ${TERMINAL_LABELS[status] || human(status)}`
      : `Release ${stableRelease?.revision || "—"} · stable`,
    stableUrl: stableRelease?.status === "stable" ? stableRelease.url || null : null,
  };
}

