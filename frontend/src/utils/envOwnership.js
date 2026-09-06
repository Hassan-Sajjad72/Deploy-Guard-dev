const PLATFORM_MANAGED_KEYS = new Set(["PORT", "HOST", "NODE_ENV"]);
const PLATFORM_MANAGED_PREFIX = /^(?:AWS_|GITHUB_|ACTIONS_|TF_|DEPLOYGUARD_)/;

export const MANAGED_DATABASE_ALIASES = Object.freeze({
  postgres: Object.freeze(["DB_HOST", "DATABASE_HOST", "POSTGRES_HOST", "PGHOST", "DB_PORT", "DATABASE_PORT", "POSTGRES_PORT", "PGPORT", "DB_USER", "DATABASE_USER", "POSTGRES_USER", "PGUSER", "DB_PASSWORD", "DATABASE_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD", "DB_NAME", "DATABASE_NAME", "POSTGRES_DB", "PGDATABASE", "DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL"]),
  mysql: Object.freeze(["DB_HOST", "DATABASE_HOST", "MYSQL_HOST", "DB_PORT", "DATABASE_PORT", "MYSQL_PORT", "DB_USER", "DATABASE_USER", "MYSQL_USER", "DB_PASSWORD", "DATABASE_PASSWORD", "MYSQL_PASSWORD", "DB_NAME", "DATABASE_NAME", "MYSQL_DATABASE", "DATABASE_URL", "MYSQL_URL"]),
  mongodb: Object.freeze(["DB_HOST", "DATABASE_HOST", "MONGO_HOST", "MONGODB_HOST", "DB_PORT", "DATABASE_PORT", "MONGO_PORT", "MONGODB_PORT", "DB_USER", "DATABASE_USER", "MONGO_USER", "MONGODB_USER", "DB_PASSWORD", "DATABASE_PASSWORD", "MONGO_PASSWORD", "MONGODB_PASSWORD", "DB_NAME", "DATABASE_NAME", "MONGO_DB", "MONGODB_DATABASE", "DATABASE_URL", "MONGO_URI", "MONGO_URL", "MONGODB_URI"]),
});

export function managedDatabaseAliases(engine) {
  return MANAGED_DATABASE_ALIASES[engine] || [];
}

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
