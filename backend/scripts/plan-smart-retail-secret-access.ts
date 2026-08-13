import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import AppDataSource from "../src/data-source";
import { InfracostService } from "../src/finops/infracost.service";
import { TerraformRunnerService } from "../src/infrastructure/terraform-runner.service";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { V1InfrastructureManifestPlanService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-plan.service";
import { V1InfrastructurePlanReviewService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-plan-review.service";

const PROJECT_ID = "5a294142-f12c-4ffc-ab9a-c4b096ebd659";
const PARENT_ID = "010b670a-9263-4b18-ae6f-26192e10cadd";
const EXPECTED_ACCOUNT = "563149050793";

function safe(state: "planned" | "blocked", safeCodes: readonly string[], detail: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ state, safeCodes, ...detail })}\n`);
}

function configured() {
  const value = (key: string) => process.env[key] || "";
  return value("SMART_RETAIL_SECRET_ACCESS_PLAN_ENABLED") === "true"
    && value("SMART_RETAIL_SECRET_ACCESS_PLAN_PROJECT_ID") === PROJECT_ID
    && value("SMART_RETAIL_SECRET_ACCESS_PLAN_ENVIRONMENT") === "dev"
    && value("TWO_LANE_REMOTE_CANARY_PLAN_ENABLED") === "true"
    && value("TWO_LANE_CANARY_COST_MODE") === "deferred_canary"
    && value("TWO_LANE_CANARY_COST_DEFERRED_ACKNOWLEDGED") === "true"
    && value("TWO_LANE_CANARY_PROJECT_ID") === PROJECT_ID
    && value("TWO_LANE_CANARY_ENVIRONMENT") === "dev"
    && value("TWO_LANE_CANARY_EXPECTED_AWS_ACCOUNT") === EXPECTED_ACCOUNT
    && value("STATE_MOCK_MODE") === "false"
    && value("TERRAFORM_STATE_USE_LOCKFILE") === "true"
    && Boolean(value("TERRAFORM_STATE_BUCKET"))
    && value("TERRAFORM_STATE_REGION") === "us-east-1";
}

void (async () => {
  if (!configured()) {
    safe("blocked", ["SECRET_ACCESS_REMOTE_PLAN_CONFIGURATION_INVALID"]);
    process.exitCode = 2;
    return;
  }
  try {
    await AppDataSource.initialize();
    const manifest = await AppDataSource.getRepository(InfrastructureManifest).findOne({
      where: {
        projectId: PROJECT_ID,
        environmentName: "dev",
        revision: "2",
        parentManifestId: PARENT_ID,
      },
    });
    if (!manifest || manifest.desiredSpec.iamPolicyRevision !== "v2"
      || manifest.changeSet.changedPaths.length !== 1
      || manifest.changeSet.changedPaths[0] !== "iamPolicyRevision"
      || manifest.changeSet.categories.length !== 1
      || manifest.changeSet.categories[0] !== "iam"
      || manifest.changeSet.destructivePaths.length !== 0) {
      throw new Error("SECRET_ACCESS_MANIFEST_SCOPE_INVALID");
    }
    const config = new ConfigService(process.env);
    const terraform = new TerraformRunnerService(config);
    const result = await new V1InfrastructureManifestPlanService(
      AppDataSource,
      config,
      terraform,
    ).plan(manifest.id);
    if (result.state !== "planned" || !result.planSummary
      || result.planSummary.create !== 1
      || result.planSummary.update !== 0
      || result.planSummary.replace !== 0
      || result.planSummary.delete !== 0
      || result.planSummary.resourceTypes.length !== 1
      || result.planSummary.resourceTypes[0] !== "aws_iam_role_policy") {
      throw new Error(result.safeCode || "SECRET_ACCESS_PLAN_DIFF_INVALID");
    }
    const review = await new V1InfrastructurePlanReviewService(
      AppDataSource,
      config,
      terraform,
      new InfracostService(config),
    ).review(manifest.id);
    if (!review.approvalReady || review.costEstimate.state !== "deferred"
      || review.safeCodes.length !== 1 || review.safeCodes[0] !== "COST_ESTIMATE_DEFERRED") {
      throw new Error("SECRET_ACCESS_PLAN_REVIEW_INVALID");
    }
    safe("planned", review.safeCodes, {
      manifestRevision: review.revision,
      planHash: review.planHash,
      create: review.resourceSummary?.create,
      update: review.resourceSummary?.update,
      replace: review.resourceSummary?.replace,
      delete: review.resourceSummary?.delete,
      resourceTypes: review.resourceSummary?.resourceTypes,
      referenceCount: 3,
      stateKey: result.stateKey,
      replayed: result.replayed,
    });
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "SECRET_ACCESS_REMOTE_PLAN_FAILED";
    safe("blocked", [code]);
    process.exitCode = 3;
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
})();
