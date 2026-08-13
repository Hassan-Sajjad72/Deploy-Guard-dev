import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { LaterReleaseOneShotRunnerService } from "../src/orchestration-contracts/release-lane/later-release-one-shot-runner.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  const intentId = process.env.TWO_LANE_LATER_RELEASE_INTENT_ID;
  if (!UUID.test(intentId ?? "")) {
    process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: ["LATER_RELEASE_INTENT_ID_INVALID"] })}\n`);
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const runner = app.get(LaterReleaseOneShotRunnerService);
    process.stdout.write(`${JSON.stringify(await runner.readiness(intentId!))}\n`);
  } finally {
    await app.close();
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: ["LATER_RELEASE_READINESS_FAILED"] })}\n`);
  process.exitCode = 2;
});
