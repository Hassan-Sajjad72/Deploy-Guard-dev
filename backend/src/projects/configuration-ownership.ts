export type ConfigurationOwner =
  | "platform"
  | "managed_service"
  | "external_service"
  | "user_required"
  | "user_optional"
  | "repository_default";

export type ReservedVariableCategory = "platform_managed" | "infrastructure_generated" | "runtime_secret" | "runtime_public" | "build_time_public";
export type ReservedVariableDefinition = {
  key: string;
  category: ReservedVariableCategory;
  delivery: "runtime" | "secret_reference";
  secret: boolean;
  source: string;
};

export const RESERVED_VARIABLE_REGISTRY: readonly ReservedVariableDefinition[] = [
  { key: "PORT", category: "platform_managed", delivery: "runtime", secret: false, source: "deployment contract" },
  { key: "HOST", category: "platform_managed", delivery: "runtime", secret: false, source: "deployment contract" },
  { key: "NODE_ENV", category: "platform_managed", delivery: "runtime", secret: false, source: "runtime policy" },
  { key: "AWS_REGION", category: "platform_managed", delivery: "runtime", secret: false, source: "platform region" },
  { key: "AWS_DEFAULT_REGION", category: "platform_managed", delivery: "runtime", secret: false, source: "platform region" },
  { key: "DEPLOYGUARD_PROJECT_ID", category: "platform_managed", delivery: "runtime", secret: false, source: "project identity" },
  { key: "DEPLOYGUARD_ENVIRONMENT", category: "platform_managed", delivery: "runtime", secret: false, source: "environment identity" },
  { key: "DEPLOYGUARD_OPERATION_ID", category: "platform_managed", delivery: "runtime", secret: false, source: "operation identity" },
  { key: "DEPLOYGUARD_APP_LOG_GROUP", category: "infrastructure_generated", delivery: "runtime", secret: false, source: "logging infrastructure" },
  { key: "DEPLOYGUARD_DATABASE_LOG_GROUP", category: "infrastructure_generated", delivery: "runtime", secret: false, source: "logging infrastructure" },
  { key: "DEPLOYGUARD_DEPLOYMENT_LOG_GROUP", category: "infrastructure_generated", delivery: "runtime", secret: false, source: "logging infrastructure" },
] as const;

const RESERVED_BY_KEY = new Map(RESERVED_VARIABLE_REGISTRY.map((item) => [item.key, item]));

export function reservedVariable(key: string, service?: ManagedServiceKind | null): ReservedVariableDefinition | null {
  const normalized = normalizeConfigurationKey(key);
  const exact = RESERVED_BY_KEY.get(normalized);
  if (exact) return exact;
  const alias = serviceAlias(normalized, service) || serviceAlias(normalized);
  if (alias) return { key: normalized, category: alias.secret ? "runtime_secret" : "infrastructure_generated", delivery: alias.secret ? "secret_reference" : "runtime", secret: alias.secret, source: `${alias.service} service binding` };
  if (isPlatformProjectProhibited(normalized) || /^(?:AWS_|GITHUB_|ACTIONS_|TF_|TF_VAR_)/.test(normalized)) {
    return { key: normalized, category: "platform_managed", delivery: "runtime", secret: isSecretConfigurationKey(normalized), source: "DeployGuard platform" };
  }
  return null;
}

export function platformRuntimeVariableNames(language?: string | null, runtimeType?: string | null) {
  return RESERVED_VARIABLE_REGISTRY
    .filter((item) => item.delivery === "runtime")
    .filter((item) => !["PORT", "HOST"].includes(item.key) || runtimeType === "server")
    .filter((item) => item.key !== "NODE_ENV" || language === "javascript")
    .map((item) => item.key);
}

export function reservedVariableError(key: string, service?: ManagedServiceKind | null) {
  const definition = reservedVariable(key, service);
  const normalized = normalizeConfigurationKey(key);
  return {
    code: "RESERVED_ENVIRONMENT_VARIABLE",
    message: `${normalized} is managed by DeployGuard and cannot be created, edited, deleted, or overridden through project environment APIs.`,
    key: normalized,
    category: definition?.category || "platform_managed",
    managedBy: "DeployGuard",
  };
}

export function classifyConfigurationVariable(key: string, options: { secret?: boolean; scope?: "build" | "runtime" | "both"; service?: ManagedServiceKind | null } = {}) {
  const normalized = normalizeConfigurationKey(key);
  const reserved = reservedVariable(normalized, options.service);
  const publicBuild = isPublicFrontendConfigurationKey(normalized) && ["build", "both"].includes(options.scope || "runtime");
  const management = reserved?.category === "infrastructure_generated" || Boolean(serviceAlias(normalized, options.service) || serviceAlias(normalized))
    ? "infrastructure_generated" as const
    : reserved ? "platform_managed" as const : "user_defined" as const;
  const delivery = !publicBuild && (reserved?.secret || options.secret || isSecretConfigurationKey(normalized))
    ? "runtime_secret" as const
    : publicBuild
      ? "build_time_public" as const
      : "runtime_public" as const;
  return { key: normalized, management, delivery };
}

export function isPublicFrontendConfigurationKey(key: string) {
  return /^(VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*$/.test(normalizeConfigurationKey(key));
}

export type ManagedServiceKind = "postgres" | "mysql" | "redis" | "mongodb" | "storage";

export type ServiceAliasDefinition = {
  service: ManagedServiceKind;
  property: "host" | "port" | "username" | "password" | "database" | "url" | "path";
  aliases: readonly string[];
  secret: boolean;
};

export const SERVICE_ALIAS_GROUPS: readonly ServiceAliasDefinition[] = [
  { service: "postgres", property: "host", aliases: ["DB_HOST", "DATABASE_HOST", "POSTGRES_HOST", "PGHOST"], secret: false },
  { service: "postgres", property: "port", aliases: ["DB_PORT", "DATABASE_PORT", "POSTGRES_PORT", "PGPORT"], secret: false },
  { service: "postgres", property: "username", aliases: ["DB_USER", "DATABASE_USER", "POSTGRES_USER", "PGUSER"], secret: false },
  { service: "postgres", property: "password", aliases: ["DB_PASSWORD", "DATABASE_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD"], secret: true },
  { service: "postgres", property: "database", aliases: ["DB_NAME", "DATABASE_NAME", "POSTGRES_DB", "PGDATABASE"], secret: false },
  { service: "postgres", property: "url", aliases: ["DATABASE_URL", "POSTGRES_URL", "POSTGRESQL_URL"], secret: true },
  { service: "mysql", property: "host", aliases: ["DB_HOST", "DATABASE_HOST", "MYSQL_HOST"], secret: false },
  { service: "mysql", property: "port", aliases: ["DB_PORT", "DATABASE_PORT", "MYSQL_PORT"], secret: false },
  { service: "mysql", property: "username", aliases: ["DB_USER", "DATABASE_USER", "MYSQL_USER"], secret: false },
  { service: "mysql", property: "password", aliases: ["DB_PASSWORD", "DATABASE_PASSWORD", "MYSQL_PASSWORD"], secret: true },
  { service: "mysql", property: "database", aliases: ["DB_NAME", "DATABASE_NAME", "MYSQL_DATABASE"], secret: false },
  { service: "mysql", property: "url", aliases: ["DATABASE_URL", "MYSQL_URL"], secret: true },
  { service: "redis", property: "host", aliases: ["REDIS_HOST"], secret: false },
  { service: "redis", property: "port", aliases: ["REDIS_PORT"], secret: false },
  { service: "redis", property: "password", aliases: ["REDIS_PASSWORD"], secret: true },
  { service: "redis", property: "url", aliases: ["REDIS_URL"], secret: true },
  { service: "mongodb", property: "host", aliases: ["DB_HOST", "DATABASE_HOST", "MONGO_HOST", "MONGODB_HOST"], secret: false },
  { service: "mongodb", property: "port", aliases: ["DB_PORT", "DATABASE_PORT", "MONGO_PORT", "MONGODB_PORT"], secret: false },
  { service: "mongodb", property: "username", aliases: ["DB_USER", "DATABASE_USER", "MONGO_USER", "MONGODB_USER"], secret: false },
  { service: "mongodb", property: "password", aliases: ["DB_PASSWORD", "DATABASE_PASSWORD", "MONGO_PASSWORD", "MONGODB_PASSWORD"], secret: true },
  { service: "mongodb", property: "database", aliases: ["DB_NAME", "DATABASE_NAME", "MONGO_DB", "MONGODB_DATABASE"], secret: false },
  { service: "mongodb", property: "url", aliases: ["DATABASE_URL", "MONGO_URI", "MONGO_URL", "MONGODB_URI"], secret: true },
  { service: "storage", property: "path", aliases: ["UPLOAD_PATH", "UPLOAD_DIR", "STORAGE_PATH", "MEDIA_ROOT"], secret: false },
] as const;

const PLATFORM_PROJECT_PROHIBITED = new Set([
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
  "GOOGLE_AI_API_KEY", "GEMINI_API_KEY", "INFRACOST_API_KEY", "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET", "PROJECT_ENV_ENCRYPTION_KEY", "JWT_ENCRYPTION_KEY",
]);

export function normalizeConfigurationKey(key: string) {
  return key.trim().toUpperCase();
}

export function serviceAlias(key: string, service?: ManagedServiceKind | null) {
  const normalized = normalizeConfigurationKey(key);
  return SERVICE_ALIAS_GROUPS.find((group) => (!service || group.service === service) && group.aliases.includes(normalized));
}

export function aliasesFor(service: ManagedServiceKind, property: ServiceAliasDefinition["property"]) {
  return SERVICE_ALIAS_GROUPS.find((group) => group.service === service && group.property === property)?.aliases || [];
}

export function isPlatformProjectProhibited(key: string) {
  const normalized = normalizeConfigurationKey(key);
  return PLATFORM_PROJECT_PROHIBITED.has(normalized) || normalized.startsWith("DEPLOYGUARD_");
}

export function isSecretConfigurationKey(key: string) {
  const normalized = normalizeConfigurationKey(key);
  return /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|(?:DATABASE|POSTGRES(?:QL)?|MYSQL|REDIS|MONGO(?:DB)?)_(?:URL|URI)|CREDENTIAL|AUTH_KEY)/.test(normalized)
    || /(?:^|_)PASS(?:_|$)/.test(normalized);
}

export function managedAliasError(key: string, service: ManagedServiceKind) {
  const label = service === "postgres" ? "PostgreSQL" : service === "mysql" ? "MySQL" : service === "mongodb" ? "MongoDB" : service;
  return `${normalizeConfigurationKey(key)} is managed by DeployGuard for the attached ${label} service.`;
}

export type RepositoryEnvironmentEvidence = {
  key?: unknown;
  detectedDefault?: unknown;
  secret?: unknown;
};

export function provenRepositoryOwnedVariableKeys(evidence: readonly RepositoryEnvironmentEvidence[]) {
  return new Set(evidence
    .filter((item) => typeof item.detectedDefault === "string" && item.detectedDefault.trim() && item.secret !== true)
    .map((item) => normalizeConfigurationKey(String(item.key || "")))
    .filter(Boolean));
}

export function ignoredSubmittedVariableNames(
  keys: readonly string[],
  options: { service?: ManagedServiceKind | null; managedService?: boolean; repositoryOwnedKeys?: ReadonlySet<string> } = {},
) {
  return [...new Set(keys.map(normalizeConfigurationKey).filter((key) => {
    if (options.repositoryOwnedKeys?.has(key)) return true;
    const alias = serviceAlias(key, options.service);
    if (options.managedService && alias) return true;
    return Boolean(reservedVariable(key, options.service) && !alias);
  }))].sort();
}

export function partitionSubmittedEnvironmentVariables<T extends { key: string }>(
  variables: readonly T[],
  options: Parameters<typeof ignoredSubmittedVariableNames>[1] = {},
) {
  const ignoredVariableNames = ignoredSubmittedVariableNames(variables.map((item) => item.key), options);
  return {
    accepted: variables.filter((item) => !ignoredVariableNames.includes(normalizeConfigurationKey(item.key))),
    ignoredVariableNames,
  };
}
