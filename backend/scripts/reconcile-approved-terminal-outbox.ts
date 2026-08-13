import AppDataSource from "../src/data-source";
import { TerminalOutboxPolicyService } from "../src/orchestration-contracts/outbox/terminal-outbox-policy.service";
import {
  TerminalOutboxReconciliationService,
} from "../src/orchestration-contracts/release-lane/terminal-outbox-reconciliation.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function main() {
  const input = {
    intentId: process.env.TWO_LANE_TERMINAL_OUTBOX_INTENT_ID ?? "",
    outboxId: process.env.TWO_LANE_TERMINAL_OUTBOX_OUTBOX_ID ?? "",
    projectId: process.env.TWO_LANE_TERMINAL_OUTBOX_PROJECT_ID ?? "",
    environmentName: process.env.TWO_LANE_TERMINAL_OUTBOX_ENVIRONMENT,
    infrastructureRevision: Number(process.env.TWO_LANE_TERMINAL_OUTBOX_INFRASTRUCTURE_REVISION),
    releaseRevision: Number(process.env.TWO_LANE_TERMINAL_OUTBOX_RELEASE_REVISION),
  };
  if (process.env.TWO_LANE_TERMINAL_OUTBOX_RECONCILIATION_APPROVED !== "true"
    || !UUID.test(input.intentId) || !UUID.test(input.outboxId) || !UUID.test(input.projectId)
    || input.environmentName !== "dev"
    || !Number.isSafeInteger(input.infrastructureRevision)
    || !Number.isSafeInteger(input.releaseRevision)) {
    process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: ["TERMINAL_OUTBOX_RECONCILIATION_NOT_APPROVED"] })}\n`);
    return;
  }
  if (!AppDataSource.isInitialized) await AppDataSource.initialize();
  try {
    const result = await new TerminalOutboxReconciliationService(
      AppDataSource,
      new TerminalOutboxPolicyService(),
    ).reconcile({
      intentId: input.intentId,
      outboxId: input.outboxId,
      projectId: input.projectId,
      environmentName: "dev",
      infrastructureRevision: input.infrastructureRevision,
      releaseRevision: input.releaseRevision,
    });
    process.stdout.write(`${JSON.stringify({ state: result.state, safeCodes: [result.safeCode] })}\n`);
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^[A-Z0-9_]{3,128}$/.test(error.message)
    ? error.message
    : "TERMINAL_OUTBOX_RECONCILIATION_FAILED";
  process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: [code] })}\n`);
  process.exitCode = 2;
});
