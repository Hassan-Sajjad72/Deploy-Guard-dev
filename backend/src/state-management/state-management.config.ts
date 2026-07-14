import { ConfigService } from "@nestjs/config";

export type StateManagementConfig = {
  bucket: string;
  prefix: string;
  lockTable: string;
  region: string;
  heartbeatIntervalSeconds: number;
  staleAfterSeconds: number;
  monitorIntervalSeconds: number;
  resourceDropWarningPercent: number;
  orphanAutoRecovery: boolean;
  forceReleaseEnabled: boolean;
  mockMode: boolean;
};

export function getStateManagementConfig(config: ConfigService): StateManagementConfig {
  return {
    bucket: config.get<string>("DEPLOYGUARD_TF_STATE_BUCKET", ""),
    prefix: config.get<string>("DEPLOYGUARD_TF_STATE_PREFIX", "deployguard/state"),
    lockTable: config.get<string>("DEPLOYGUARD_TF_LOCK_TABLE", "deployguard-terraform-locks"),
    region: config.get<string>("AWS_REGION", "us-east-1"),
    heartbeatIntervalSeconds: Number(config.get<string>("STATE_LOCK_HEARTBEAT_INTERVAL_SECONDS", "30")),
    staleAfterSeconds: Number(config.get<string>("STATE_LOCK_STALE_AFTER_SECONDS", "300")),
    monitorIntervalSeconds: Number(config.get<string>("STATE_LOCK_MONITOR_INTERVAL_SECONDS", "60")),
    resourceDropWarningPercent: Number(config.get<string>("STATE_RESOURCE_DROP_WARNING_PERCENT", "70")),
    orphanAutoRecovery: config.get<string>("STATE_ENABLE_ORPHAN_AUTO_RECOVERY", "true") !== "false",
    forceReleaseEnabled: config.get<string>("STATE_ENABLE_FORCE_RELEASE", "true") !== "false",
    mockMode: config.get<string>("STATE_MOCK_MODE", "true") !== "false",
  };
}
