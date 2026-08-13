import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { InfracostService } from "../src/finops/infracost.service";
import { TerraformRunnerService } from "../src/infrastructure/terraform-runner.service";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { V1InfrastructureManifestPlanService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-plan.service";
import { V1InfrastructureManifestRevisionService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-revision.service";
import { V1InfrastructurePlanReviewService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-plan-review.service";

const PROJECT_ID = "fc0d5f53-8b6d-401a-b532-966dd4f7eff8";
const PARENT_MANIFEST_ID = "2eb05634-718b-4a19-99a2-3e3d38eb132a";
const EXPECTED_ACCOUNT = "563149050793";

function safe(state: string, safeCodes: readonly string[], detail: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ state, safeCodes, ...detail })}\n`);
}

function configured() {
  const value = (key: string) => process.env[key] || "";
  return value("TWO_LANE_REMOTE_CANARY_PLAN_ENABLED") === "true"
    && value("TWO_LANE_CANARY_COST_MODE") === "deferred_canary"
    && value("TWO_LANE_CANARY_COST_DEFERRED_ACKNOWLEDGED") === "true"
    && value("TWO_LANE_CANARY_PROJECT_ID") === PROJECT_ID
    && value("TWO_LANE_CANARY_ENVIRONMENT") === "dev"
    && value("TWO_LANE_CANARY_EXPECTED_AWS_ACCOUNT") === EXPECTED_ACCOUNT
    && value("STATE_MOCK_MODE") === "false"
    && value("TERRAFORM_STATE_USE_LOCKFILE") === "true"
    && Boolean(value("TERRAFORM_STATE_BUCKET"))
    && value("TERRAFORM_STATE_REGION") === "us-east-1"
    && Boolean(value("TERRAFORM_WORKING_BASE_DIR"));
}

void (async () => {
  if (!configured()) {
    safe("blocked", ["CANARY_PLAN_CONFIGURATION_INVALID"]);
    process.exitCode = 2;
    return;
  }
  const options = AppDataSource.options as DataSourceOptions;
  const dataSource = new DataSource({ ...options, entities: [InfrastructureManifest], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
  try {
    await dataSource.initialize();
    const config = new ConfigService(process.env);
    const revisions = new V1InfrastructureManifestRevisionService(dataSource);
    const created = await revisions.createRetryAfterFailedRemotePlan({
      projectId: PROJECT_ID,
      environmentName: "dev",
      parentManifestId: PARENT_MANIFEST_ID,
    });
    if (created.revision !== "4" || created.stateKey !== `projects/${PROJECT_ID}/dev/v1/4.tfstate`) {
      safe("blocked", ["CANARY_MANIFEST_REVISION_SCOPE_INVALID"]);
      process.exitCode = 3;
      return;
    }
    const terraform = new TerraformRunnerService(config);
    const plan = await new V1InfrastructureManifestPlanService(dataSource, config, terraform).plan(created.manifestId);
    if (plan.state !== "planned") {
      safe("blocked", [plan.safeCode || "CANARY_PLAN_NOT_COMPLETED"], { manifestRevision: plan.revision });
      process.exitCode = 4;
      return;
    }
    const review = await new V1InfrastructurePlanReviewService(dataSource, config, terraform, new InfracostService(config)).review(created.manifestId);
    safe(review.approvalReady ? "ready" : "blocked", review.safeCodes, {
      manifestRevision: review.revision,
      planHash: review.planHash,
      actions: review.resourceSummary ? {
        create: review.resourceSummary.create,
        update: review.resourceSummary.update,
        replace: review.resourceSummary.replace,
        delete: review.resourceSummary.delete,
      } : null,
      resourceTypes: review.resourceSummary?.resourceTypes || [],
      costState: review.costEstimate.state,
    });
    process.exitCode = review.approvalReady ? 0 : 5;
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "CANARY_PLAN_RUNTIME_FAILED";
    safe("blocked", [code]);
    process.exitCode = 6;
  } finally {
    await dataSource.destroy().catch(() => undefined);
  }
})();
