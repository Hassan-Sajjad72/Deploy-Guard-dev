import { NestFactory } from "@nestjs/core";
import { AppModule } from "../src/app.module";
import { TransactionalDeploymentPlannerService } from "../src/orchestration-contracts/planner/transactional-deployment-planner.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function output(value: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function input() {
  const projectId = process.env.TWO_LANE_RELEASE_PROJECT_ALLOWLIST;
  const manifestId = process.env.TWO_LANE_FIRST_RELEASE_INFRASTRUCTURE_MANIFEST_ID;
  const revision = process.env.TWO_LANE_FIRST_RELEASE_INFRASTRUCTURE_REVISION;
  const actorUserId = Number(process.env.TWO_LANE_FIRST_RELEASE_REQUESTED_BY_USER_ID);
  const idempotencyKey = process.env.TWO_LANE_FIRST_RELEASE_INTENT_IDEMPOTENCY_KEY;
  const enabled = process.env.TWO_LANE_FIRST_RELEASE_PREPARE_ENABLED === "true";
  if (!enabled || !UUID.test(projectId ?? "") || !UUID.test(manifestId ?? "")
    || revision !== "4" || !Number.isInteger(actorUserId) || actorUserId < 1
    || typeof idempotencyKey !== "string" || !idempotencyKey.trim()
    || process.env.TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST !== "dev") return null;
  return { projectId, manifestId, actorUserId, idempotencyKey };
}

async function main() {
  const prepared = input();
  if (!prepared) {
    output({ state: "blocked", safeCodes: ["INITIAL_RELEASE_PREPARE_CONFIGURATION_INVALID"] });
    return;
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  try {
    const planner = app.get(TransactionalDeploymentPlannerService);
    const result = await planner.plan({
      actor: { userId: prepared.actorUserId, role: "developer" },
      projectId: prepared.projectId,
      environmentName: "dev",
      kind: "deploy",
      idempotencyKey: prepared.idempotencyKey,
      initialReleaseInfrastructureManifestId: prepared.manifestId,
    });
    output({
      state: result.replayed ? "replayed" : "prepared",
      safeCodes: result.decision.classification === "release_only"
        && result.intent.releaseManifestId === null
        ? ["INITIAL_RELEASE_INTENT_PREPARED"]
        : ["INITIAL_RELEASE_PLANNER_UNEXPECTED_RESULT"],
      intentId: result.intent.id,
    });
  } finally {
    await app.close();
  }
}

main().catch(() => {
  output({ state: "blocked", safeCodes: ["INITIAL_RELEASE_PREPARE_FAILED"] });
  process.exitCode = 2;
});
