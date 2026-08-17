type Summary = {
  project: { id: string; name: string; createdAt: Date | string; activity?: { lastViewedAt?: Date | string | null; lastMeaningfulActivityAt?: Date | string | null; lastRoute?: string | null; pinned?: boolean } | null };
  currentState: Record<string, any> | null;
};

const time = (value: unknown) => value ? new Date(value as string).getTime() || 0 : 0;
export const needsAttention = (summary: Summary) => {
  return Boolean(summary.currentState && [
    "configuration_required",
    "approval_required",
    "failed_application",
    "platform_attention",
    "unsupported",
  ].includes(summary.currentState.developerState));
};

export function rankWorkspaceSummaries(summaries: Summary[], _userId?: number) {
  const meaningful = [...summaries].sort((left, right) => {
    const leftPinned = Boolean(left.project.activity?.pinned);
    const rightPinned = Boolean(right.project.activity?.pinned);
    if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
    return time(right.project.activity?.lastMeaningfulActivityAt || right.project.createdAt) - time(left.project.activity?.lastMeaningfulActivityAt || left.project.createdAt);
  });
  const active = meaningful.filter(({ currentState }) => [
    "preparing",
    "queued",
    "building",
    "deploying",
    "verifying",
  ].includes(currentState?.developerState));
  const attention = meaningful.filter(needsAttention).sort((left, right) =>
    time(right.currentState?.latestAttempt?.occurredAt || right.project.activity?.lastMeaningfulActivityAt) -
    time(left.currentState?.latestAttempt?.occurredAt || left.project.activity?.lastMeaningfulActivityAt)
  );
  const recentlyViewed = [...summaries]
    .filter(({ project }) => project.activity?.lastViewedAt)
    .sort((left, right) => time(right.project.activity?.lastViewedAt) - time(left.project.activity?.lastViewedAt));
  const live = meaningful.filter(({ currentState }) => currentState?.developerState === "live" && Boolean(currentState?.stableRelease));
  const continueWorking = active[0] || meaningful[0] || null;
  return { ordered: [...active, ...meaningful.filter((item) => !active.includes(item))], active, attention, recentlyViewed, live, continueWorking };
}
