export type BillingPlan = "free" | "pro" | "pro_plus";
export type BillingMetric = "ai_analysis" | "ai_followup" | "notification" | "terraform_export";

export type PlanEntitlements = {
  priceUsdMonthly: number;
  currentProjects: number;
  /** Backward-compatible read-model alias for currentProjects. */
  activeProjects: number;
  liveProjects: number;
  freeTrialHours: number | null;
  aiAnalysesPerMonth: number;
  aiFollowupsPerMonth: number;
  notificationsPerMonth: number;
  terraformExportsPerMonth: number;
  notificationStageUpdates: boolean;
};

export const PLAN_ENTITLEMENTS: Record<BillingPlan, PlanEntitlements> = {
  free: {
    priceUsdMonthly: 0, currentProjects: 10, activeProjects: 10, liveProjects: 1, freeTrialHours: 48,
    aiAnalysesPerMonth: 5,
    aiFollowupsPerMonth: 10,
    notificationsPerMonth: 25,
    terraformExportsPerMonth: 1,
    notificationStageUpdates: false,
  },
  pro: {
    priceUsdMonthly: 399, currentProjects: 20, activeProjects: 20, liveProjects: 5, freeTrialHours: null,
    aiAnalysesPerMonth: 200,
    aiFollowupsPerMonth: 500,
    notificationsPerMonth: 5000,
    terraformExportsPerMonth: 100,
    notificationStageUpdates: true,
  },
  pro_plus: {
    priceUsdMonthly: 799, currentProjects: 30, activeProjects: 30, liveProjects: 10, freeTrialHours: null,
    // Unrelated metered features retain the existing Pro behavior.
    aiAnalysesPerMonth: 200, aiFollowupsPerMonth: 500, notificationsPerMonth: 5000,
    terraformExportsPerMonth: 100, notificationStageUpdates: true,
  },
};

export const MINIMUM_LIVE_PROJECT_COST_USD = 55;
export const BILLING_PLAN_ORDER: BillingPlan[] = ["free", "pro", "pro_plus"];
export const publicBillingPlan = (plan: BillingPlan) => plan.toUpperCase();

export const METRIC_LIMIT_KEY: Record<BillingMetric, keyof PlanEntitlements> = {
  ai_analysis: "aiAnalysesPerMonth",
  ai_followup: "aiFollowupsPerMonth",
  notification: "notificationsPerMonth",
  terraform_export: "terraformExportsPerMonth",
};
