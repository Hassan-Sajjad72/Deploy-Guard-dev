import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import {
  NormalReleaseLaneConvergenceService,
} from "../src/orchestration-contracts/release-lane/normal-release-lane-convergence.service";

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
    abortOnError: false,
  });
  try {
    const result = await app.get(
      NormalReleaseLaneConvergenceService,
    ).reconcileExact(
      process.env.TWO_LANE_RELEASE_PROJECT_ALLOWLIST ?? "",
      process.env.TWO_LANE_NORMAL_RELEASE_RECONCILE_INTENT_ID ?? "",
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.state !== "resumed") process.exitCode = 2;
  } finally {
    await app.close();
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({
    state: "blocked",
    safeCodes: ["NORMAL_RELEASE_CONVERGENCE_FAILED"],
  })}\n`);
  process.exitCode = 2;
});
