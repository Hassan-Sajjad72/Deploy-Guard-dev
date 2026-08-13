import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { V1UndispatchedIntentCancellationService } from "../src/orchestration-contracts/release-lane/v1-undispatched-intent-cancellation.service";

const APPROVED_INTENT_ID = "47d109bf-08db-43a3-a42c-2bee7a66b2dd";
const APPROVED_PROJECT_ID = "fc0d5f53-8b6d-401a-b532-966dd4f7eff8";
const APPROVED_INFRASTRUCTURE_MANIFEST_ID = "7945437c-6b00-4cd5-9964-8d0268149056";
const APPROVED_RELEASE_MANIFEST_ID = "6e18c389-ca66-4bf5-b90d-0e8d94e2ae11";

async function main() {
  if (process.env.TWO_LANE_APPROVED_UNDISPATCHED_INTENT_CANCELLATION !== "true") {
    throw new Error("APPROVED_UNDISPATCHED_INTENT_CANCELLATION_NOT_ENABLED");
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const result = await app.get(V1UndispatchedIntentCancellationService).cancel({
      intentId: APPROVED_INTENT_ID,
      projectId: APPROVED_PROJECT_ID,
      environmentName: "dev",
      infrastructureManifestId: APPROVED_INFRASTRUCTURE_MANIFEST_ID,
      releaseManifestId: APPROVED_RELEASE_MANIFEST_ID,
    });
    process.stdout.write(`${JSON.stringify({
      state: "cancelled",
      safeCode: result.safeCode,
      auditRecorded: result.auditRecorded,
    })}\n`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 1;
});
