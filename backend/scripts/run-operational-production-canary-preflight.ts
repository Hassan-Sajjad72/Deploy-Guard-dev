import "reflect-metadata";
import { existsSync, readFileSync } from "node:fs";
import { NestFactory } from "@nestjs/core";
import { resolveBackendEnvFile } from "../src/config/backend-env-file";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-[1-9][0-9]*$/;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,159}$/;
const IDENTIFIER = /^[A-Za-z0-9_./:@+=,-]{1,512}$/;
const IAM_PRINCIPAL = /^arn:(?:aws|aws-us-gov|aws-cn):iam::[0-9]{12}:(?:role|user)\/[A-Za-z0-9+=,.@_\/-]{1,512}$/;

type SafeOutput = {
  state: "ready" | "blocked";
  safeCodes: readonly string[];
};

function envFileValues(): Record<string, string> {
  const path = resolveBackendEnvFile();
  if (!existsSync(path)) return {};
  return Object.fromEntries(
    readFileSync(path, "utf8").split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1].startsWith("#")) return [];
      const value = match[2].replace(/^(['"])(.*)\1$/, "$2");
      return [[match[1], value]];
    }),
  );
}

function values() {
  const file = envFileValues();
  return (key: string) => process.env[key] ?? file[key];
}

function exactOne(value: string | undefined, pattern: RegExp, expected?: string) {
  if (typeof value !== "string") return false;
  const values = value.split(",").map((item) => item.trim());
  return values.length === 1 && Boolean(values[0]) && pattern.test(values[0])
    && (!expected || values[0] === expected);
}

function validateConfiguration(): boolean {
  const get = values();
  const project = get("TWO_LANE_RELEASE_PROJECT_ALLOWLIST");
  return get("TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED") === "true"
    && get("TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED") === "true"
    && get("TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED") === "true"
    && get("TWO_LANE_RELEASE_COMPOSITION_ENABLED") === "true"
    && get("TWO_LANE_RELEASE_COMPOSITION_MODE") === "production_canary"
    && get("TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED") === "true"
    && get("TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_MODE") === "read_only"
    && typeof get("TWO_LANE_RELEASE_WORKER_ID") === "string"
    && WORKER_ID.test(get("TWO_LANE_RELEASE_WORKER_ID")!)
    && exactOne(project, UUID)
    && exactOne(get("TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST"), UUID, project)
    && exactOne(get("TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST"), /^dev$/, "dev")
    && exactOne(get("TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST"), /^dev$/, "dev")
    && typeof get("AWS_REGION") === "string"
    && REGION.test(get("AWS_REGION")!)
    && [
      "TWO_LANE_CANARY_ECR_REPOSITORY",
      "TWO_LANE_CANARY_ECS_CLUSTER",
      "TWO_LANE_CANARY_ECS_SERVICE",
      "TWO_LANE_CANARY_TARGET_GROUP",
    ].every((key) => typeof get(key) === "string" && IDENTIFIER.test(get(key)!))
    && typeof get("TWO_LANE_CANARY_IAM_PRINCIPAL_ARN") === "string"
    && IAM_PRINCIPAL.test(get("TWO_LANE_CANARY_IAM_PRINCIPAL_ARN")!);
}

function print(output: SafeOutput) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

void (async () => {
  if (!validateConfiguration()) {
    print({ state: "blocked", safeCodes: ["CANARY_CONFIGURATION_INVALID"] });
    process.exitCode = 2;
    return;
  }

  let app: Awaited<ReturnType<typeof NestFactory.create>> | null = null;
  try {
    const { AppModule } = await import("../src/app.module");
    const {
      ProductionV1ReleaseCanaryPreflightService,
    } = await import("../src/orchestration-contracts/release-lane/production-v1-release-canary-preflight.service");
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.init();
    const result = await app.get(ProductionV1ReleaseCanaryPreflightService).run();
    print({ state: result.state === "ready" ? "ready" : "blocked", safeCodes: result.safeCodes });
    process.exitCode = result.state === "ready" ? 0 : 3;
  } catch {
    print({ state: "blocked", safeCodes: ["CANARY_PREFLIGHT_RUNTIME_FAILED"] });
    process.exitCode = 4;
  } finally {
    await app?.close().catch(() => undefined);
  }
})();
