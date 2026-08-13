import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { TerraformRunnerService } from "../src/infrastructure/terraform-runner.service";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { ProjectReleaseLaneOwnership } from "../src/orchestration-contracts/entities/release-lane-ownership.entity";
import { V1InfrastructureManifestApplyService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-apply.service";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";

const safe = (state: string, safeCodes: readonly string[], detail: Record<string, unknown> = {}) => process.stdout.write(`${JSON.stringify({ state, safeCodes, ...detail })}\n`);

void (async () => {
  const manifestId = process.env.TWO_LANE_CANARY_APPLY_MANIFEST_ID || "";
  const planHash = process.env.TWO_LANE_CANARY_APPLY_PLAN_HASH || "";
  if (process.env.TWO_LANE_CANARY_APPLY_RECONCILE_ENABLED !== "true" || !manifestId || !planHash) {
    safe("blocked", ["CANARY_RECONCILIATION_CONFIGURATION_INVALID"]);
    process.exitCode = 2;
    return;
  }
  const options = AppDataSource.options as DataSourceOptions;
  const dataSource = new DataSource({ ...options, entities: [InfrastructureManifest, ProjectReleaseLaneOwnership], migrations: [], synchronize: false, logging: false } as DataSourceOptions);
  try {
    await dataSource.initialize();
    const config = new ConfigService(process.env);
    const result = await new V1InfrastructureManifestApplyService(dataSource, config, new TerraformRunnerService(config), new InactiveReleaseLaneOwnershipService(dataSource)).reconcile(manifestId, planHash);
    safe(result.state, result.safeCodes, { manifestRevision: result.revision, resourceCount: result.resourceCount, stateStatus: result.stateStatus, lockStatus: result.lockStatus, ownershipStatus: result.ownershipStatus });
    process.exitCode = result.state === "applied" ? 0 : 4;
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "CANARY_RECONCILIATION_RUNTIME_FAILED";
    safe("blocked", [code]);
    process.exitCode = 5;
  } finally { await dataSource.destroy().catch(() => undefined); }
})();
