import { ConfigService } from "@nestjs/config";

export type SecurityPolicyConfig = {
  scanEnabled: boolean;
  gateMode: "enforce" | "bypass";
  blockCritical: boolean;
  blockHigh: boolean;
  blockBaseImageCritical: boolean;
  requireFixAvailableToBlock: boolean;
  mediumThresholdForApproval: number;
  lowBlocking: boolean;
  allowManualOverrideForHighCritical: boolean;
  allowManualApprovalForMedium: boolean;
};

function bool(value: string | undefined, defaultValue: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }

  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return defaultValue;
}

export function getSecurityPolicyConfig(config: ConfigService): SecurityPolicyConfig {
  const configuredGateMode = config.get<string>("SECURITY_GATE_MODE", "enforce").trim().toLowerCase();
  const bypassEnabled = bool(config.get<string>("SECURITY_BYPASS_ENABLED"), false);
  return {
    scanEnabled: bool(
      config.get<string>(
        "TRIVY_SCAN_ENABLED",
        config.get<string>("TRIVY_ENABLED", "true")
      ),
      true
    ),
    gateMode: configuredGateMode === "bypass" || bypassEnabled ? "bypass" : "enforce",
    blockCritical: bool(config.get<string>("SECURITY_BLOCK_CRITICAL"), true),
    blockHigh: bool(config.get<string>("SECURITY_BLOCK_HIGH"), false),
    blockBaseImageCritical: bool(
      config.get<string>("SECURITY_BLOCK_BASE_IMAGE_CRITICAL"),
      false
    ),
    requireFixAvailableToBlock: bool(
      config.get<string>("SECURITY_REQUIRE_FIX_AVAILABLE_TO_BLOCK"),
      true
    ),
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
      false
    ),
  };
}
