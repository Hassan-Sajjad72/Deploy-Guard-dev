import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CostEstimateStatus,
  ProjectCostEstimate,
} from "./project-cost-estimate.entity";
import { SubscriptionTier } from "./project-cost-settings.entity";
import { getFinopsConfig } from "./finops.config";

@Injectable()
export class FinopsPolicyService {
  constructor(private readonly config: ConfigService) {}

  tierLimit(tier: SubscriptionTier | string) {
    const finopsConfig = getFinopsConfig(this.config);
    return finopsConfig.tierLimits[tier as SubscriptionTier] ?? finopsConfig.tierLimits.free;
  }

  evaluate(input: {
    totalMonthlyCost: number;
    warningThresholdMonthlyCost: number;
    subscriptionTier: SubscriptionTier | string;
  }) {
    const tierLimitMonthlyCost = this.tierLimit(input.subscriptionTier);
    const finopsConfig = getFinopsConfig(this.config);
    const overTier = input.totalMonthlyCost > tierLimitMonthlyCost;

    if (finopsConfig.bypassCostGate) {
      return {
        status: CostEstimateStatus.NO_APPROVAL_REQUIRED,
        approvalRequired: false,
        blockedByTierLimit: false,
        tierLimitMonthlyCost,
        upgradePromptMessage: null,
      };
    }

    if (overTier && finopsConfig.enforceTierLimits) {
      return {
        status: CostEstimateStatus.BLOCKED_BY_TIER_LIMIT,
        approvalRequired: false,
        blockedByTierLimit: true,
        tierLimitMonthlyCost,
        upgradePromptMessage: `Estimated monthly cost exceeds the ${input.subscriptionTier} tier limit. Upgrade required before provisioning.`,
      };
    }

    if (input.totalMonthlyCost > input.warningThresholdMonthlyCost) {
      return {
        status: CostEstimateStatus.APPROVAL_REQUIRED,
        approvalRequired: true,
        blockedByTierLimit: false,
        tierLimitMonthlyCost,
        upgradePromptMessage: null,
      };
    }

    if (overTier) {
      return {
        status: CostEstimateStatus.WARNING_OVER_TIER,
        approvalRequired: false,
        blockedByTierLimit: false,
        tierLimitMonthlyCost,
        upgradePromptMessage: "Estimated monthly cost exceeds the configured tier, but tier enforcement is off.",
      };
    }

    return {
      status: CostEstimateStatus.NO_APPROVAL_REQUIRED,
      approvalRequired: false,
      blockedByTierLimit: false,
      tierLimitMonthlyCost,
      upgradePromptMessage: null,
    };
  }

  canApprove(estimate: ProjectCostEstimate) {
    return estimate.status === CostEstimateStatus.APPROVAL_REQUIRED;
  }

  canReject(estimate: ProjectCostEstimate) {
    return estimate.status === CostEstimateStatus.APPROVAL_REQUIRED;
  }
}
