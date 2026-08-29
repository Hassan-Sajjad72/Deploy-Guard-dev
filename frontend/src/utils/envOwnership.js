const PLATFORM_MANAGED_KEYS = new Set(["PORT", "HOST", "NODE_ENV"]);
const PLATFORM_MANAGED_PREFIX = /^(?:AWS_|GITHUB_|ACTIONS_|TF_|DEPLOYGUARD_)/;

export function classifySubmittedEnvironmentKey(key, reservedKeys = [], repositoryOwnedKeys = []) {
  const normalized = String(key || "").trim().toUpperCase();
  const reserved = new Set(reservedKeys.map((item) => String(item).trim().toUpperCase()));
  const repositoryOwned = new Set(repositoryOwnedKeys.map((item) => String(item).trim().toUpperCase()));
  if (repositoryOwned.has(normalized)) return { key: normalized, management: "repository_owned" };
  if (reserved.has(normalized)) return { key: normalized, management: "backend_managed" };
  if (PLATFORM_MANAGED_KEYS.has(normalized) || PLATFORM_MANAGED_PREFIX.test(normalized)) {
    return { key: normalized, management: "platform_managed" };
  }
  return { key: normalized, management: "application" };
}

export function ignoredEnvironmentNotice(names) {
  return [...new Set(names)].sort().map((key) => `${key} is managed by DeployGuard and was ignored.`);
}
