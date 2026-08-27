import { createRequire } from "node:module";

const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const { Client } = requireBackend("pg");

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`DeployGuard canonical database configuration is missing ${name} in backend/.env.`);
  return value;
}

/** The local AWS product has one explicit control-plane database endpoint. */
export function authoritativeDatabaseConfiguration() {
  const port = Number(required("DATABASE_PORT"));
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("DeployGuard canonical DATABASE_PORT must be a valid TCP port.");
  }
  return {
    host: required("DATABASE_HOST"),
    port,
    user: required("DATABASE_USERNAME"),
    password: required("DATABASE_PASSWORD"),
    database: required("DATABASE_NAME"),
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
  };
}

export async function assertAuthoritativeDatabaseReachable() {
  const config = authoritativeDatabaseConfiguration();
  const client = new Client({ ...config, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    const result = await client.query("SELECT current_database() AS database");
    if (result.rows[0]?.database !== config.database) {
      throw new Error(`PostgreSQL endpoint ${config.host}:${config.port} selected database ${String(result.rows[0]?.database || "unknown")}, not configured ${config.database}.`);
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Configured PostgreSQL endpoint ${config.host}:${config.port}/${config.database} is unavailable: ${reason}`);
  } finally {
    await client.end().catch(() => undefined);
  }
  return config;
}
