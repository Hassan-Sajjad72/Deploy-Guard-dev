import { ConfigService } from "@nestjs/config";
import { envBoolean } from "../config/env-parsing";

export type StateManagementConfig = {
  bucket: string;
  prefix: string;
  region: string;
  useLockfile: boolean;
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
    bucket:
      config.get<string>("TERRAFORM_STATE_BUCKET", "").trim() ||
      config.get<string>("DEPLOYGUARD_TF_STATE_BUCKET", "").trim(),
    prefix:
      config.get<string>("TERRAFORM_STATE_PREFIX", "").trim() ||
      config.get<string>("DEPLOYGUARD_TF_STATE_PREFIX", "").trim() ||
      "projects",
    region:
      config.get<string>("TERRAFORM_STATE_REGION", "").trim() ||
      config.get<string>("AWS_REGION", "").trim(),
    useLockfile: envBoolean(config, "TERRAFORM_STATE_USE_LOCKFILE", true),
    heartbeatIntervalSeconds: Number(config.get<string>("STATE_LOCK_HEARTBEAT_INTERVAL_SECONDS", "30")),
    staleAfterSeconds: Number(config.get<string>("STATE_LOCK_STALE_AFTER_SECONDS", "300")),
    monitorIntervalSeconds: Number(config.get<string>("STATE_LOCK_MONITOR_INTERVAL_SECONDS", "60")),
    resourceDropWarningPercent: Number(config.get<string>("STATE_RESOURCE_DROP_WARNING_PERCENT", "70")),
    orphanAutoRecovery: envBoolean(config, "STATE_ENABLE_ORPHAN_AUTO_RECOVERY", true),
    forceReleaseEnabled: envBoolean(config, "STATE_ENABLE_FORCE_RELEASE", true),
    mockMode: envBoolean(config, "STATE_MOCK_MODE", false),
  };
}
