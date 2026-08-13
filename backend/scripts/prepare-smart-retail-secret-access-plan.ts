import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import AppDataSource from "../src/data-source";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { OrchestrationOutbox } from "../src/orchestration-contracts/entities/orchestration-outbox.entity";
import { TransactionalDeploymentPlannerService } from "../src/orchestration-contracts/planner/transactional-deployment-planner.service";

const PROJECT_ID = "5a294142-f12c-4ffc-ab9a-c4b096ebd659";
const COMMIT_SHA = "b91850a6e90d24a6f5fce3863b1930b2a0e6972b";
const EXPECTED_PARENT_ID = "010b670a-9263-4b18-ae6f-26192e10cadd";
const HASH = /^[0-9a-f]{64}$/;

function safe(state: "prepared" | "blocked", safeCode: string, detail: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ state, safeCode, ...detail })}\n`);
}

void (async () => {
  if (process.env.SMART_RETAIL_SECRET_ACCESS_PLAN_ENABLED !== "true"
    || process.env.SMART_RETAIL_SECRET_ACCESS_PLAN_PROJECT_ID !== PROJECT_ID
    || process.env.SMART_RETAIL_SECRET_ACCESS_PLAN_ENVIRONMENT !== "dev"
    || process.env.IAM_POLICY_REVISION !== "v2"
    || process.env.STATE_MOCK_MODE !== "false") {
    safe("blocked", "SECRET_ACCESS_PLAN_SCOPE_DISABLED");
    process.exitCode = 2;
    return;
  }
  try {
    await AppDataSource.initialize();
    const manifests = AppDataSource.getRepository(InfrastructureManifest);
    const parent = await manifests.findOneBy({
      id: EXPECTED_PARENT_ID,
      projectId: PROJECT_ID,
      environmentName: "dev",
      status: "applied",
    });
    if (!parent?.terraformOutputs || !HASH.test(parent.terraformOutputsHash || "")
      || canonicalSha256(parent.terraformOutputs) !== parent.terraformOutputsHash
      || parent.desiredSpec.iamPolicyRevision !== "v1") {
      throw new Error("SECRET_ACCESS_PARENT_EVIDENCE_INVALID");
    }
    const planner = new TransactionalDeploymentPlannerService(
      AppDataSource,
      new ConfigService(process.env),
    );
    const planned = await planner.plan({
      actor: { userId: 1, role: "admin" },
      projectId: PROJECT_ID,
      environmentName: "dev",
      kind: "plan",
      requestedCommitSha: COMMIT_SHA,
      idempotencyKey: `secret-access:v2:${parent.id}:${parent.terraformOutputsHash}`,
      requiredClassification: "infrastructure_change",
    });
    const manifestId = planned.decision.desiredInfrastructureManifestId;
    if (!manifestId || manifestId === parent.id
      || planned.decision.currentAppliedInfrastructureManifestId !== parent.id
      || planned.decision.infrastructureChangedPaths.length !== 1
      || planned.decision.infrastructureChangedPaths[0] !== "iamPolicyRevision"
      || planned.decision.desiredReleaseManifestId !== null) {
      throw new Error("SECRET_ACCESS_PLANNER_DECISION_INVALID");
    }
    const manifest = await manifests.findOneByOrFail({ id: manifestId });
    const outboxes = await AppDataSource.getRepository(OrchestrationOutbox).find({
      where: { intentId: planned.intent.id },
    });
    if (manifest.revision !== "2" || manifest.parentManifestId !== parent.id
      || manifest.status !== "desired"
      || manifest.desiredSpec.iamPolicyRevision !== "v2"
      || manifest.stateBackend !== "s3"
      || manifest.stateKey !== `projects/${PROJECT_ID}/dev/v1/2.tfstate`
      || outboxes.length !== 1
      || outboxes[0].eventType !== "intent.infrastructure.plan"
      || outboxes[0].status !== "pending"
      || outboxes[0].attemptCount !== 0
      || outboxes[0].claimedBy !== null
      || outboxes[0].claimExpiresAt !== null
      || outboxes[0].publishedAt !== null) {
      throw new Error("SECRET_ACCESS_PLAN_CHAIN_INVALID");
    }
    safe("prepared", "SECRET_ACCESS_PLAN_PREPARED", {
      manifestRevision: manifest.revision,
      intentStatus: planned.intent.status,
      outboxStatus: outboxes[0].status,
      replayed: planned.replayed,
    });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "SECRET_ACCESS_PLAN_PREPARATION_FAILED";
    safe("blocked", code);
    process.exitCode = 3;
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
})();
