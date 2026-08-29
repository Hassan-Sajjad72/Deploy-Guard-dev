const BLOCKING_STATES = new Set(["preparing", "queued", "building", "deploying", "verifying", "platform_attention"]);

export function releaseLaneBlocksStart(currentState) {
  return BLOCKING_STATES.has(currentState?.developerState)
    || !["deploy", "redeploy"].includes(currentState?.developerAction);
}
