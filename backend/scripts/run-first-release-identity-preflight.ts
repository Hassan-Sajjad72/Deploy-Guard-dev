import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { ProductionV1FirstReleaseIdentityPreflightService } from "../src/orchestration-contracts/release-lane/production-v1-first-release-identity-preflight.service";

function print(value: { state: string; safeCodes: readonly string[] }) {
  process.stdout.write(`${JSON.stringify({ state: value.state, safeCodes: value.safeCodes })}\n`);
}

function configured() {
  const get = (key: string) => process.env[key];
  return get("TWO_LANE_RELEASE_COMPOSITION_ENABLED") === "true"
    && get("TWO_LANE_RELEASE_COMPOSITION_MODE") === "production_canary"
    && get("TWO_LANE_FIRST_RELEASE_BOOTSTRAP_ENABLED") === "true"
    && get("TWO_LANE_FIRST_RELEASE_PREFLIGHT_ENABLED") === "true"
    && get("TWO_LANE_FIRST_RELEASE_PREFLIGHT_MODE") === "read_only"
    && Boolean(get("TWO_LANE_FIRST_RELEASE_INFRASTRUCTURE_MANIFEST_ID"))
    && Boolean(get("TWO_LANE_FIRST_RELEASE_INFRASTRUCTURE_REVISION"));
}

async function main() {
  if (!configured()) { print({ state: "disabled", safeCodes: ["FIRST_RELEASE_IDENTITY_PREFLIGHT_DISABLED"] }); return; }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try { print(await app.get(ProductionV1FirstReleaseIdentityPreflightService).run()); }
  finally { await app.close(); }
}

main().catch(() => { print({ state: "blocked", safeCodes: ["FIRST_RELEASE_IDENTITY_PREFLIGHT_RUNTIME_FAILED"] }); process.exitCode = 2; });
