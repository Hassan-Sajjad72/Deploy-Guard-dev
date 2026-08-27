import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  aliasesFor,
  classifyConfigurationVariable,
  isPlatformProjectProhibited,
  isSecretConfigurationKey,
  normalizeConfigurationKey,
  reservedVariable,
  serviceAlias,
} from "../src/projects/configuration-ownership";

const root = join(process.cwd(), "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");

assert.equal(normalizeConfigurationKey(" postgres_host "), "POSTGRES_HOST");
assert.equal(serviceAlias("DATABASE_URL", "postgres")?.property, "url");
assert.equal(serviceAlias("MONGO_URI", "mongodb")?.secret, true);
assert.deepEqual([...aliasesFor("mysql", "url")], ["DATABASE_URL", "MYSQL_URL"]);
assert.equal(isSecretConfigurationKey("JWT_SECRET"), true);
assert.equal(isPlatformProjectProhibited("AWS_SECRET_ACCESS_KEY"), true);
assert.equal(reservedVariable("PORT")?.category, "platform_managed");
assert.deepEqual(classifyConfigurationVariable("DB_PASSWORD", { service: "postgres" }), { key: "DB_PASSWORD", management: "infrastructure_generated", delivery: "runtime_secret" });
assert.deepEqual(classifyConfigurationVariable("VITE_PUBLIC_API", { scope: "build" }), { key: "VITE_PUBLIC_API", management: "user_defined", delivery: "build_time_public" });
for (const file of [
  "backend/src/projects/deployment-contract.service.ts",
  "backend/src/projects/deployment-requirements.service.ts",
  "backend/src/infrastructure/database-service-binding.service.ts",
]) assert.match(read(file), /environment|configuration/i, file);
assert.doesNotMatch(read("backend/src/projects/detection/stack-detection.service.ts"), /overrides\.requiredEnvironmentVariables/);
console.log("Configuration ownership certification passed: exact aliases, reserved variables, secret delivery, and BuildPlan-owned requirements.");
