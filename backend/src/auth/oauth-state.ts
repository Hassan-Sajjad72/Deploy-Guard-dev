const STATE_PATTERN = /^[a-f0-9]{48}$/;
const MAX_PENDING_STATES = 5;

/**
 * The OAuth state cookie is allowed to contain a small set of one-time
 * requests. This prevents a second legitimate sign-in tab from invalidating
 * the callback already in progress in the first tab.
 */
export function appendOAuthState(cookieValue: string | undefined, state: string): string {
  const states = parseOAuthStates(cookieValue).filter((value) => value !== state);
  return [...states, state].slice(-MAX_PENDING_STATES).join(".");
}

/** Returns the remaining valid states, or null when this callback was not started by this browser. */
export function consumeOAuthState(cookieValue: string | undefined, state: string): string[] | null {
  const states = parseOAuthStates(cookieValue);
  if (!STATE_PATTERN.test(state) || !states.includes(state)) return null;
  return states.filter((value) => value !== state);
}

export function parseOAuthStates(cookieValue: string | undefined): string[] {
  if (!cookieValue) return [];
  let decoded: string;
  try {
    decoded = decodeURIComponent(cookieValue);
  } catch {
    return [];
  }
  return [...new Set(decoded.split(".").filter((value) => STATE_PATTERN.test(value)))];
}
