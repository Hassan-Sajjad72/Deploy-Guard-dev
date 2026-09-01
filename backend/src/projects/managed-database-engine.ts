export type ManagedDatabaseEngine = "postgres" | "mysql" | "mongodb";

export type ManagedDatabaseEngineProfile = {
  engine: ManagedDatabaseEngine;
  label: string;
  image: string;
  port: number;
  dataPath: string;
  healthCheck: string[];
  initializationEnvironment: Array<{
    name: string;
    valueSource: "databaseName" | "databaseUser";
  }>;
  initializationSecretNames: string[];
  urlScheme: "postgresql" | "mysql" | "mongodb";
  urlQuery: string;
};

export const MANAGED_DATABASE_ENGINE_PROFILES: Record<ManagedDatabaseEngine, ManagedDatabaseEngineProfile> = {
  postgres: {
    engine: "postgres",
    label: "PostgreSQL",
    image: "postgres:16",
    port: 5432,
    dataPath: "/var/lib/postgresql/data",
    healthCheck: ["CMD-SHELL", "pg_isready -U $POSTGRES_USER -d $POSTGRES_DB"],
    initializationEnvironment: [
      { name: "POSTGRES_DB", valueSource: "databaseName" },
      { name: "POSTGRES_USER", valueSource: "databaseUser" },
    ],
    initializationSecretNames: ["POSTGRES_PASSWORD"],
    urlScheme: "postgresql",
    urlQuery: "",
  },
  mysql: {
    engine: "mysql",
    label: "MySQL",
    image: "mysql:8",
    port: 3306,
    dataPath: "/var/lib/mysql",
    healthCheck: ["CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -u\"$MYSQL_USER\" -p\"$MYSQL_PASSWORD\" --silent"],
    initializationEnvironment: [
      { name: "MYSQL_DATABASE", valueSource: "databaseName" },
      { name: "MYSQL_USER", valueSource: "databaseUser" },
    ],
    initializationSecretNames: ["MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD"],
    urlScheme: "mysql",
    urlQuery: "",
  },
  mongodb: {
    engine: "mongodb",
    label: "MongoDB",
    image: "mongo:8",
    port: 27017,
    dataPath: "/data/db",
    healthCheck: ["CMD-SHELL", "mongosh --quiet --username \"$MONGO_INITDB_ROOT_USERNAME\" --password \"$MONGO_INITDB_ROOT_PASSWORD\" --authenticationDatabase admin --eval 'db.adminCommand({ ping: 1 })' >/dev/null"],
    initializationEnvironment: [
      { name: "MONGO_INITDB_DATABASE", valueSource: "databaseName" },
      { name: "MONGO_INITDB_ROOT_USERNAME", valueSource: "databaseUser" },
    ],
    initializationSecretNames: ["MONGO_INITDB_ROOT_PASSWORD"],
    urlScheme: "mongodb",
    urlQuery: "?authSource=admin",
  },
};

export function isSupportedManagedDatabaseEngine(value: unknown): value is ManagedDatabaseEngine {
  return value === "postgres" || value === "mysql" || value === "mongodb";
}

export function managedDatabaseEngine(value: unknown): ManagedDatabaseEngine | null {
  const normalized = String(value || "").trim().toLowerCase();
  if (/^(?:postgres|postgresql)$/.test(normalized)) return "postgres";
  if (normalized === "mysql") return "mysql";
  if (/^(?:mongo|mongodb)$/.test(normalized)) return "mongodb";
  return null;
}

export function managedDatabaseProfile(value: unknown): ManagedDatabaseEngineProfile | null {
  const engine = managedDatabaseEngine(value);
  return engine ? MANAGED_DATABASE_ENGINE_PROFILES[engine] : null;
}
