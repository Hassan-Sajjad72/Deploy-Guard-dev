import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { TerraformRunnerService } from "../src/infrastructure/terraform-runner.service";
import { InfrastructureManifest } from "../src/orchestration-contracts/entities/infrastructure-manifest.entity";
import { ProjectReleaseLaneOwnership } from "../src/orchestration-contracts/entities/release-lane-ownership.entity";
import { V1InfrastructureManifestApplyService } from "../src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-apply.service";
import { InactiveReleaseLaneOwnershipService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service";

const EXACT_MANIFEST_ID = "a157c854-c9bb-42a0-a3b3-bbb5f7d376e0";
const EXACT_PLAN_HASH = "fa27b4ab918ea6c271b63cfc5d737dcdd6d2894a701544a72c19add6744de532";

void (async () => {
  if (process.env.TWO_LANE_CANARY_APPLY_MANIFEST_ID !== EXACT_MANIFEST_ID
    || process.env.TWO_LANE_CANARY_APPLY_PLAN_HASH !== EXACT_PLAN_HASH
    || process.env.TWO_LANE_CANARY_APPLY_ENABLED !== "true") {
    throw new Error("CANARY_SECRET_ACCESS_RECOVERY_CONFIGURATION_INVALID");
  }
  const options = AppDataSource.options as DataSourceOptions;
  const dataSource = new DataSource({
    ...options,
    entities: [InfrastructureManifest, ProjectReleaseLaneOwnership],
    migrations: [],
    synchronize: false,
    logging: false,
  } as DataSourceOptions);
  try {
    await dataSource.initialize();
    const config = new ConfigService(process.env);
    const service = new V1InfrastructureManifestApplyService(
      dataSource,
      config,
      new TerraformRunnerService(config),
      new InactiveReleaseLaneOwnershipService(dataSource),
    );
    const result = await service.reconcileSecretAccessAddonAppliedState(
      EXACT_MANIFEST_ID,
      EXACT_PLAN_HASH,
    );
    process.stdout.write(`${JSON.stringify({
      state: result.state,
      manifestRevision: result.revision,
      resourceCount: result.resourceCount,
      stateStatus: result.stateStatus,
      lockStatus: result.lockStatus,
      ownershipStatus: result.ownershipStatus,
      safeCodes: result.safeCodes,
    })}\n`);
    process.exitCode = result.state === "applied" ? 0 : 3;
  } finally {
    await dataSource.destroy().catch(() => undefined);
  }
})().catch((error) => {
  const sqlState = typeof error === "object" && error !== null
    && "driverError" in error
    && typeof (error as { driverError?: { code?: unknown } }).driverError?.code === "string"
    ? (error as { driverError: { code: string } }).driverError.code
    : "";
  const constraint = typeof error === "object" && error !== null
    && "driverError" in error
    && typeof (error as { driverError?: { constraint?: unknown } }).driverError?.constraint === "string"
    ? (error as { driverError: { constraint: string } }).driverError.constraint.replace(/[^A-Za-z0-9_]/g, "")
    : "";
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : /^[0-9A-Z]{5}$/.test(sqlState)
      ? `CANARY_SECRET_ACCESS_RECOVERY_SQLSTATE_${sqlState}${constraint ? `_${constraint}` : ""}`
      : "CANARY_SECRET_ACCESS_RECOVERY_RUNTIME_FAILED";
  process.stdout.write(`${JSON.stringify({ state: "blocked", safeCodes: [code] })}\n`);
  process.exitCode = 2;
});
