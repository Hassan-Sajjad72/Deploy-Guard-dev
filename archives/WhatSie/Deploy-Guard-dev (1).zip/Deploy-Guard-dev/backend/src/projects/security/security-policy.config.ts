import { ConfigService } from "@nestjs/config";

export type SecurityPolicyConfig = {
  blockCritical: boolean;
  blockHigh: boolean;
  mediumThresholdForApproval: number;
  lowBlocking: boolean;
  allowManualOverrideForHighCritical: boolean;
  allowManualApprovalForMedium: boolean;
};

function bool(value: string | undefined, defaultValue: boolean) {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  return value === "true";
}

export function getSecurityPolicyConfig(config: ConfigService): SecurityPolicyConfig {
  return {
    blockCritical: bool(config.get<string>("SECURITY_BLOCK_CRITICAL"), true),
    blockHigh: bool(config.get<string>("SECURITY_BLOCK_HIGH"), true),
    mediumThresholdForApproval: Number(
      config.get<string>("SECURITY_MEDIUM_APPROVAL_THRESHOLD", "5")
    ),
    lowBlocking: bool(config.get<string>("SECURITY_LOW_BLOCKING"), false),
    allowManualOverrideForHighCritical: bool(
      config.get<string>("SECURITY_ALLOW_HIGH_CRITICAL_OVERRIDE"),
      false
    ),
    allowManualApprovalForMedium: bool(
      config.get<string>("SECURITY_ALLOW_MEDIUM_APPROVAL"),
      true
    ),
  };
}
