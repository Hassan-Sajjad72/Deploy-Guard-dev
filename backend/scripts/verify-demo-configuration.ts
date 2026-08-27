import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { resolveBackendEnvFile } from "../src/config/backend-env-file";
import { getFinopsConfig } from "../src/finops/finops.config";
import { getStateManagementConfig } from "../src/state-management/state-management.config";

function parseEnv(path: string) {
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    values[key] = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

const backendRoot = resolve(__dirname, "..");
const repositoryRoot = resolve(backendRoot, "..");
const expectedEnv = resolve(backendRoot, ".env");
assert.equal(resolveBackendEnvFile(backendRoot), expectedEnv);
assert.equal(resolveBackendEnvFile(repositoryRoot), expectedEnv);

const values = parseEnv(expectedEnv);
const config = new ConfigService(values);
const finops = getFinopsConfig(config);
assert.equal(finops.mockMode, false);
assert.equal(finops.infracostEnabled, true);
assert.equal(finops.bypassCostGate, false);
const costBypass = getFinopsConfig(new ConfigService({
  FINOPS_MOCK_MODE: "false",
  INFRACOST_ENABLED: "true",
  COST_GATE_MODE: "bypass",
}));
assert.equal(costBypass.mockMode, true, "Cost-gate bypass must prevent Infracost execution");

const state = getStateManagementConfig(config);
assert.equal(state.mockMode, false);
assert.equal(state.bucket, "deployguard-state-bucket");
assert.equal(state.region, values.TERRAFORM_STATE_REGION || values.AWS_REGION);
assert.equal(state.prefix, "projects");
assert.equal(state.useLockfile, true);

assert.equal(values.TERRAFORM_APPLY_ENABLED, "true");
assert.equal(values.TERRAFORM_APPLY_REQUIRES_APPROVAL, "true");
assert.equal(values.AI_ASSISTANT_ENABLED, "true");
assert.equal(values.AI_PROVIDER, "google");
assert.equal(values.GEMINI_MODEL, "gemini-3.1-flash-lite");
assert.notEqual(values.GOOGLE_AI_API_KEY, "your_google_ai_api_key_here");

async function verifyNestConfigLoading() {
  const keys = [
    "FINOPS_MOCK_MODE",
    "INFRACOST_ENABLED",
    "COST_GATE_MODE",
    "AI_ASSISTANT_ENABLED",
    "GOOGLE_AI_API_KEY",
    "STATE_MOCK_MODE",
    "TERRAFORM_STATE_BUCKET",
    "TERRAFORM_APPLY_REQUIRES_APPROVAL",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  keys.forEach((key) => delete process.env[key]);
  try {
    await ConfigModule.forRoot({ isGlobal: true, envFilePath: expectedEnv });
    for (const key of keys) assert.equal(process.env[key], values[key], `${key} must load from backend/.env`);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

verifyNestConfigLoading()
  .then(() => console.log("Demo environment loading and policy configuration verification passed (secret values withheld)."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
