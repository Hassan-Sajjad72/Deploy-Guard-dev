const TERMINAL_LABELS = {
  live: "Live",
  failed: "Failed",
};

function human(value) {
  return String(value || "not started").replaceAll("_", " ");
}

/**
 * One frontend projection for the sanitized deployment operation and stable
 * release already carried by project current-state/workspace-summary.
 */
export function normalReleaseView(currentState) {
  const latestAttempt = currentState?.latestAttempt || null;
  const stableRelease = currentState?.stableRelease || null;
  if (!latestAttempt && !stableRelease) return null;
  const status = currentState?.developerState || latestAttempt?.status || "ready";
  const progress = Number(currentState?.progress?.percentage || (stableRelease ? 100 : 0));

  return {
    operation: latestAttempt,
    stableRelease,
    status,
    statusLabel: TERMINAL_LABELS[status] || human(status),
    progress,
    phaseLabel: currentState?.progress?.label || (stableRelease ? "Stable release" : "Ready"),
    summary: latestAttempt
      ? `Attempt ${latestAttempt.attempt || "—"} · ${TERMINAL_LABELS[latestAttempt.status] || human(latestAttempt.status)}`
      : `Release ${stableRelease?.revision || "—"} · stable`,
    stableUrl: stableRelease ? currentState?.stableUrl || null : null,
  };
}
