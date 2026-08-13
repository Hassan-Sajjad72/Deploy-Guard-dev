import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { TransactionalDeploymentPlannerService } from "../src/orchestration-contracts/planner/transactional-deployment-planner.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT = /^[0-9a-f]{40}$/i;

function input() {
  const projectId = process.env.TWO_LANE_RELEASE_PROJECT_ALLOWLIST;
  const actorUserId = Number(process.env.TWO_LANE_LATER_RELEASE_REQUESTED_BY_USER_ID);
  const idempotencyKey = process.env.TWO_LANE_LATER_RELEASE_INTENT_IDEMPOTENCY_KEY;
  const commitSha = process.env.TWO_LANE_LATER_RELEASE_COMMIT_SHA;
  if (process.env.TWO_LANE_LATER_RELEASE_PREPARE_ENABLED !== "true"
    || process.env.TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST !== "dev"
    || !UUID.test(projectId ?? "") || !Number.isInteger(actorUserId) || actorUserId < 1
    || typeof idempotencyKey !== "string" || !idempotencyKey.trim()
    || !COMMIT.test(commitSha ?? "")) return null;
  return { projectId, actorUserId, idempotencyKey, commitSha };
}

async function main() {
  const request = input();
  if (!request) {
    process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: ["LATER_RELEASE_PREPARE_CONFIGURATION_INVALID"] })}\n`);
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const planner = app.get(TransactionalDeploymentPlannerService);
    const result = await planner.plan({
      actor: { userId: request.actorUserId, role: "developer" },
      projectId: request.projectId,
      environmentName: "dev",
      kind: "deploy",
      idempotencyKey: request.idempotencyKey,
      requestedCommitSha: request.commitSha,
    });
    const safeCode = result.decision.classification === "release_only"
      ? "LATER_RELEASE_INTENT_PREPARED"
      : result.decision.classification === "infrastructure_change"
        ? "LATER_RELEASE_INFRASTRUCTURE_REVIEW_REQUIRED"
        : "LATER_RELEASE_PLANNER_BLOCKED";
    process.stdout.write(`${JSON.stringify({
      state: result.replayed ? "replayed" : "prepared",
      safeCodes: [safeCode],
      intentId: result.intent.id,
    })}\n`);
  } finally {
    await app.close();
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: ["LATER_RELEASE_DETECTION_OR_PLANNING_FAILED"] })}\n`);
  process.exitCode = 2;
});
