import { ConfigService } from "@nestjs/config";
import { SubscriptionTier } from "./project-cost-settings.entity";

export type FinopsConfig = {
  mockMode: boolean;
  infracostEnabled: boolean;
  bypassCostGate: boolean;
  enforceTierLimits: boolean;
  currency: string;
  defaultWarningThreshold: number;
  tierLimits: Record<SubscriptionTier, number>;
  terraformWorkdir: string | null;
  enableRealTerraform: boolean;
};

export function getFinopsConfig(config: ConfigService): FinopsConfig {
  const enabled = (key: string, defaultValue: boolean) => {
    const value = config.get<string>(key)?.trim().toLowerCase();
    if (value === "true") return true;
    if (value === "false") return false;
    return defaultValue;
  };
  const infracostEnabled = enabled("INFRACOST_ENABLED", false);
  const costGateMode = config.get<string>("COST_GATE_MODE", "enforce").trim().toLowerCase();
  const mockMode =
    enabled("FINOPS_MOCK_MODE", true) ||
    !infracostEnabled ||
    costGateMode === "bypass";
  return {
    mockMode,
    infracostEnabled,
    bypassCostGate: mockMode || costGateMode === "bypass",
    enforceTierLimits:
      config.get<string>("FINOPS_ENFORCE_TIER_LIMITS", "false") === "true",
    currency: config.get<string>("INFRACOST_CURRENCY", "USD"),
    defaultWarningThreshold: Number(
      config.get<string>("FINOPS_DEFAULT_WARNING_THRESHOLD_USD", "25")
    ),
    tierLimits: {
      [SubscriptionTier.FREE]: Number(config.get<string>("FINOPS_FREE_TIER_LIMIT_USD", "10")),
      [SubscriptionTier.STARTER]: Number(config.get<string>("FINOPS_STARTER_TIER_LIMIT_USD", "50")),
      [SubscriptionTier.PRO]: Number(config.get<string>("FINOPS_PRO_TIER_LIMIT_USD", "200")),
      [SubscriptionTier.ENTERPRISE]: Number(
        config.get<string>("FINOPS_ENTERPRISE_TIER_LIMIT_USD", "999999")
      ),
    },
    terraformWorkdir: config.get<string>("FINOPS_TERRAFORM_WORKDIR") || null,
    enableRealTerraform:
      config.get<string>("FINOPS_ENABLE_REAL_TERRAFORM", "false") === "true",
  };
}
