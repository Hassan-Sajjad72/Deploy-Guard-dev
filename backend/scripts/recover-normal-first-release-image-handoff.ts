import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { NormalFirstReleaseImageHandoffRecoveryService } from "../src/orchestration-contracts/release-lane/normal-first-release-image-handoff-recovery.service";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  const projectId = process.env.TWO_LANE_RELEASE_PROJECT_ALLOWLIST ?? "";
  const intentId = process.env.TWO_LANE_FIRST_RELEASE_RECOVERY_INTENT_ID ?? "";
  if (!UUID.test(projectId) || !UUID.test(intentId)) {
    throw new Error("FIRST_RELEASE_IMAGE_HANDOFF_SCOPE_INVALID");
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  try {
    const result = await app
      .get(NormalFirstReleaseImageHandoffRecoveryService)
      .recoverExact(projectId, intentId);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  const safeCode = error instanceof Error
    && /^[A-Z0-9_]{3,128}$/.test(error.message)
    ? error.message
    : "FIRST_RELEASE_IMAGE_HANDOFF_RECOVERY_FAILED";
  process.stdout.write(`${JSON.stringify({
    state: "blocked",
    safeCode,
  })}\n`);
  process.exitCode = 2;
});
