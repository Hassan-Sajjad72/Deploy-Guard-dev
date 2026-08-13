import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { LaterReleaseOneShotRunnerService } from "../src/orchestration-contracts/release-lane/later-release-one-shot-runner.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  const intentId = process.env.TWO_LANE_LATER_RELEASE_INTENT_ID;
  if (process.env.TWO_LANE_LATER_RELEASE_EXECUTE_APPROVED !== "true" || !UUID.test(intentId ?? "")) {
    process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: ["LATER_RELEASE_EXECUTION_NOT_APPROVED"] })}\n`);
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const result = await app.get(LaterReleaseOneShotRunnerService).run(intentId!);
    process.stdout.write(`${JSON.stringify({ state: result.disposition, safeCodes: ["LATER_RELEASE_ONE_SHOT_RESULT"] })}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)
    ? error.message : "LATER_RELEASE_EXECUTION_FAILED";
  process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: [code] })}\n`);
  process.exitCode = 2;
});
