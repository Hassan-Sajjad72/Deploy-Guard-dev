const ALWAYS_BLOCKING_STATES = new Set(["queued", "running", "reconciling", "blocked"]);
const SAME_SOURCE_TERMINAL_STATES = new Set(["completed", "cancelled"]);

export function releaseLaneBlocksStart(currentState) {
  const releaseLane = currentState?.releaseLane;
  if (ALWAYS_BLOCKING_STATES.has(releaseLane?.state)) return true;
  if (!SAME_SOURCE_TERMINAL_STATES.has(releaseLane?.state)) return false;
  const intentCommit = releaseLane?.intent?.sourceCommitShortSha;
  const contractCommit = currentState?.deploymentContract?.commitSha;
  return typeof intentCommit === "string"
    && typeof contractCommit === "string"
    && contractCommit.toLowerCase().startsWith(intentCommit.toLowerCase());
}
