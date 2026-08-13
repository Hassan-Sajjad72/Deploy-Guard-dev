import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { InitialReleaseOneShotRunnerService } from "../src/orchestration-contracts/release-lane/initial-release-one-shot-runner.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function print(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main() {
  const intentId = process.env.TWO_LANE_FIRST_RELEASE_INTENT_ID;
  if (process.env.TWO_LANE_FIRST_RELEASE_EXECUTE_APPROVED !== "true"
    || !UUID.test(intentId ?? "")) {
    print({ state: "blocked", safeCodes: ["FIRST_RELEASE_EXECUTION_NOT_APPROVED"] });
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const result = await app.get(InitialReleaseOneShotRunnerService).run(intentId!);
    print({
      state: "completed",
      safeCodes: ["FIRST_RELEASE_HEALTHY"],
      applicationUrl: result.applicationUrl,
    });
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)
    ? error.message
    : "FIRST_RELEASE_EXECUTION_FAILED";
  print({ state: "blocked", safeCodes: [code] });
  process.exitCode = 2;
});
