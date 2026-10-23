type Summary = {
  project: { id: string; name: string; createdAt: Date | string; activity?: { lastViewedAt?: Date | string | null; lastMeaningfulActivityAt?: Date | string | null; lastRoute?: string | null; pinned?: boolean } | null };
  currentState: Record<string, any> | null;
};

const time = (value: unknown) => value ? new Date(value as string).getTime() || 0 : 0;
export const needsAttention = (summary: Summary) => {
  const state = summary.currentState;
  return Boolean(state && (
    ["failed", "blocked", "paused"].includes(state.overallStatus) ||
    state.adminActionRequired ||
    ["unhealthy", "stale_live_record", "failed"].includes(state.deploymentStatus)
  ));
};

export function rankWorkspaceSummaries(summaries: Summary[], userId?: number) {
  const meaningful = [...summaries].sort((left, right) => {
    const leftPinned = Boolean(left.project.activity?.pinned);
    const rightPinned = Boolean(right.project.activity?.pinned);
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    return time(right.project.activity?.lastMeaningfulActivityAt || right.project.createdAt) - time(left.project.activity?.lastMeaningfulActivityAt || left.project.createdAt);
  });
  const active = meaningful.filter(({ currentState }) => currentState?.activitySnapshot?.isActive === true);
  const activePipelineForUser = active.filter(({ currentState }) =>
    currentState?.activitySnapshot?.activityType === "deployment" &&
    (userId == null || Number(currentState.activitySnapshot.triggeredByUserId) === userId)
  );
  const attention = meaningful.filter(needsAttention).sort((left, right) =>
    time(right.currentState?.lastFailureAt || right.project.activity?.lastMeaningfulActivityAt) -
    time(left.currentState?.lastFailureAt || left.project.activity?.lastMeaningfulActivityAt)
  );
  const recentlyViewed = [...summaries]
    .filter(({ project }) => project.activity?.lastViewedAt)
    .sort((left, right) => time(right.project.activity?.lastViewedAt) - time(left.project.activity?.lastViewedAt));
  const live = meaningful.filter(({ currentState }) => currentState?.deploymentStatus === "live" && currentState?.healthStatus === "healthy" && currentState?.cloudVerificationStatus === "verified");
  const continueWorking = activePipelineForUser[0] || meaningful[0] || null;
  return { ordered: [...active, ...meaningful.filter((item) => !active.includes(item))], active, attention, recentlyViewed, live, continueWorking };
}
