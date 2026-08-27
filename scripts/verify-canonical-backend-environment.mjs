import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { authoritativeDatabaseConfiguration, assertAuthoritativeDatabaseReachable } from "./authoritative-database.mjs";
import { canonicalBackendEnvFile, loadCanonicalBackendEnvironment } from "./canonical-backend-env.mjs";

const root = process.cwd();
const envFile = canonicalBackendEnvFile(root);
const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const dotenv = requireBackend("dotenv");
const canonical = dotenv.parse(readFileSync(envFile));
const composeKeys = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SNS_REGION",
  "SNS_TOPIC_ARN",
  "NOTIFICATION_DELIVERY_ENABLED",
];
const databaseKeys = [
  "DATABASE_HOST",
  "DATABASE_PORT",
  "DATABASE_USERNAME",
  "DATABASE_PASSWORD",
  "DATABASE_NAME",
];
const keys = [...composeKeys, ...databaseKeys];

const previous = new Map(keys.map((key) => [key, process.env[key]]));
try {
  // Reproduce the former source of drift: an ambient value had precedence in
  // product:start but Compose had already injected backend/.env.
  process.env.AWS_REGION = "ambient-value-must-not-win";
  loadCanonicalBackendEnvironment(root);
  for (const key of composeKeys) {
    assert.equal(process.env[key], canonical[key], `product:start must load canonical ${key}`);
  }

  const database = authoritativeDatabaseConfiguration();
  assert.equal(database.host, canonical.DATABASE_HOST, "backend must use canonical DATABASE_HOST");
  assert.equal(String(database.port), canonical.DATABASE_PORT, "backend must use canonical DATABASE_PORT");
  assert.notEqual(database.port, 5433, "the obsolete Compose PostgreSQL port must never be the AWS product endpoint");
  await assertAuthoritativeDatabaseReachable();

  const startup = readFileSync("scripts/local-product.mjs", "utf8");
  assert.match(startup, /const supportServices = \["prometheus", "grafana"\]/);
  assert.doesNotMatch(startup, /const supportServices = \[[^\]]*postgres/);
  assert.match(startup, /assertAuthoritativeDatabaseReachable\(\)/);
  const dataSource = readFileSync("backend/src/data-source.ts", "utf8");
  const appModule = readFileSync("backend/src/app.module.ts", "utf8");
  assert.doesNotMatch(dataSource, /process\.env\.DB_PORT|process\.env\.DB_HOST/);
  assert.doesNotMatch(appModule, /config\.get<string>\("DB_PORT"|config\.get<string>\("DB_HOST"/);

  const compose = JSON.parse(execFileSync(
    "docker",
    ["compose", "--env-file", envFile, "config", "--format", "json"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ));
  const composeEnvironment = compose.services?.backend?.environment || {};
  for (const key of composeKeys) {
    assert.equal(composeEnvironment[key], canonical[key], `Compose backend must receive canonical ${key}`);
  }
  assert.equal(compose.services?.prometheus?.depends_on, undefined, "monitoring must not make product:start depend on the obsolete Compose backend/PostgreSQL chain");
} finally {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log("Canonical Compose/product-start AWS and SNS environment contract passed (values withheld).");
