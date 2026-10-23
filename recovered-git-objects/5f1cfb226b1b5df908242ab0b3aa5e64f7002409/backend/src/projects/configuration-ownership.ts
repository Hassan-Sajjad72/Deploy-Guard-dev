export type ConfigurationOwner =
  | "platform"
  | "managed_service"
  | "external_service"
  | "user_required"
  | "user_optional"
  | "repository_default";

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
  { service: "mongodb", property: "host", aliases: ["MONGO_HOST", "MONGODB_HOST"], secret: false },
  { service: "mongodb", property: "port", aliases: ["MONGO_PORT", "MONGODB_PORT"], secret: false },
  { service: "mongodb", property: "username", aliases: ["MONGO_USER", "MONGODB_USER"], secret: false },
  { service: "mongodb", property: "password", aliases: ["MONGO_PASSWORD", "MONGODB_PASSWORD"], secret: true },
  { service: "mongodb", property: "database", aliases: ["MONGO_DB", "MONGODB_DATABASE"], secret: false },
  { service: "mongodb", property: "url", aliases: ["MONGO_URL", "MONGODB_URI"], secret: true },
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
  return /(SECRET|TOKEN|PASSWORD|PRIVATE|API_KEY|DATABASE_URL|POSTGRES_URL|POSTGRESQL_URL|MYSQL_URL|REDIS_URL|MONGODB_URI|CREDENTIAL|AUTH_KEY)/.test(normalizeConfigurationKey(key));
}

export function managedAliasError(key: string, service: ManagedServiceKind) {
  const label = service === "postgres" ? "PostgreSQL" : service === "mysql" ? "MySQL" : service;
  return `${normalizeConfigurationKey(key)} is managed by DeployGuard for the attached ${label} service. Switch the service provider to external to supply your own value.`;
}
