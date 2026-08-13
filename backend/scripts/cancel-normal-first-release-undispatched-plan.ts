import AppDataSource from "../src/data-source";
import { TerminalOutboxPolicyService } from
  "../src/orchestration-contracts/outbox/terminal-outbox-policy.service";
import { NormalFirstReleaseUndispatchedPlanCancellationService } from
  "../src/orchestration-contracts/release-lane/normal-first-release-undispatched-plan-cancellation.service";

const required = (key: string) => {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`FIRST_RELEASE_PLAN_CANCELLATION_${key}_REQUIRED`);
  return value;
};

async function main() {
  if (process.env.NORMAL_V1_UNDISPATCHED_PLAN_RECOVERY_ENABLED !== "true") {
    throw new Error("FIRST_RELEASE_PLAN_CANCELLATION_DISABLED");
  }
  await AppDataSource.initialize();
  try {
    const service = new NormalFirstReleaseUndispatchedPlanCancellationService(
      AppDataSource,
      new TerminalOutboxPolicyService(),
    );
    const result = await service.cancel({
      projectId: required("NORMAL_V1_RECOVERY_PROJECT_ID"),
      environmentName: "dev",
      intentId: required("NORMAL_V1_RECOVERY_INTENT_ID"),
      infrastructureManifestId: required("NORMAL_V1_RECOVERY_INFRASTRUCTURE_MANIFEST_ID"),
      initialReleaseDraftId: required("NORMAL_V1_RECOVERY_INITIAL_RELEASE_DRAFT_ID"),
      outboxId: required("NORMAL_V1_RECOVERY_OUTBOX_ID"),
      draftHash: required("NORMAL_V1_RECOVERY_DRAFT_HASH"),
    });
    process.stdout.write(`${JSON.stringify({
      state: "cancelled",
      safeCode: result.safeCode,
      auditRecorded: result.auditRecorded,
      replayed: result.replayed,
    })}\n`);
  } finally {
    await AppDataSource.destroy();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "FIRST_RELEASE_PLAN_CANCELLATION_FAILED"}\n`);
  process.exitCode = 1;
});
