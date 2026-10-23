import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { canonicalBackendEnvFile, loadCanonicalBackendEnvironment } from "./canonical-backend-env.mjs";

const root = process.cwd();
const envFile = canonicalBackendEnvFile(root);
const requireBackend = createRequire(new URL("../backend/package.json", import.meta.url));
const dotenv = requireBackend("dotenv");
const canonical = dotenv.parse(readFileSync(envFile));
const keys = [
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SNS_REGION",
  "SNS_TOPIC_ARN",
  "NOTIFICATION_DELIVERY_ENABLED",
];

const previous = new Map(keys.map((key) => [key, process.env[key]]));
try {
  // Reproduce the former source of drift: an ambient value had precedence in
  // product:start but Compose had already injected backend/.env.
  process.env.AWS_REGION = "ambient-value-must-not-win";
  loadCanonicalBackendEnvironment(root);
  for (const key of keys) {
    assert.equal(process.env[key], canonical[key], `product:start must load canonical ${key}`);
  }

  const compose = JSON.parse(execFileSync(
    "docker",
    ["compose", "--env-file", envFile, "config", "--format", "json"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ));
  const composeEnvironment = compose.services?.backend?.environment || {};
  for (const key of keys) {
    assert.equal(composeEnvironment[key], canonical[key], `Compose backend must receive canonical ${key}`);
  }
} finally {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

console.log("Canonical Compose/product-start AWS and SNS environment contract passed (values withheld).");
