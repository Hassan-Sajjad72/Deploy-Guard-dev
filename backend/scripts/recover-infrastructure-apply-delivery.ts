import "reflect-metadata";
import { ConfigService } from "@nestjs/config";
import { DataSource, DataSourceOptions } from "typeorm";
import AppDataSource from "../src/data-source";
import { InfrastructureApplyDeliveryRecoveryService } from "../src/orchestration-contracts/infrastructure/infrastructure-apply-delivery-recovery.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function output(state: "prepared" | "blocked", safeCodes: string[]) {
  process.stdout.write(`${JSON.stringify({ state, safeCodes })}\n`);
}

void (async () => {
  const failedApplyIntentId = process.env.TWO_LANE_INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY_INTENT_ID || "";
  if (process.env.TWO_LANE_INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY_ENABLED !== "true" || !UUID.test(failedApplyIntentId)) {
    output("blocked", ["INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY_CONFIGURATION_INVALID"]);
    process.exitCode = 2;
    return;
  }
  const dataSource = new DataSource({
    ...AppDataSource.options,
    entities: [], migrations: [], synchronize: false, logging: false,
  } as DataSourceOptions);
  try {
    await dataSource.initialize();
    const result = await new InfrastructureApplyDeliveryRecoveryService(
      dataSource,
      new ConfigService(process.env),
    ).recover(failedApplyIntentId);
    output("prepared", [
      result.replayed
        ? "INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY_REUSED"
        : "INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY_PREPARED",
    ]);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "INFRASTRUCTURE_APPLY_DELIVERY_RECOVERY_FAILED";
    output("blocked", [code]);
    process.exitCode = 3;
  } finally {
    await dataSource.destroy().catch(() => undefined);
  }
})();
