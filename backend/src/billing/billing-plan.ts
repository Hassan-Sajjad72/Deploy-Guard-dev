export type BillingPlan = "free" | "pro";
export type BillingMetric = "ai_analysis" | "ai_followup" | "notification" | "terraform_export";

export type PlanEntitlements = {
  activeProjects: number;
  aiAnalysesPerMonth: number;
  aiFollowupsPerMonth: number;
  notificationsPerMonth: number;
  terraformExportsPerMonth: number;
  notificationStageUpdates: boolean;
};

export const PLAN_ENTITLEMENTS: Record<BillingPlan, PlanEntitlements> = {
  free: {
    activeProjects: 3,
    aiAnalysesPerMonth: 5,
    aiFollowupsPerMonth: 10,
    notificationsPerMonth: 25,
    terraformExportsPerMonth: 1,
    notificationStageUpdates: false,
  },
  pro: {
    activeProjects: 50,
    aiAnalysesPerMonth: 200,
    aiFollowupsPerMonth: 500,
    notificationsPerMonth: 5000,
    terraformExportsPerMonth: 100,
    notificationStageUpdates: true,
  },
};

export const METRIC_LIMIT_KEY: Record<BillingMetric, keyof PlanEntitlements> = {
  ai_analysis: "aiAnalysesPerMonth",
  ai_followup: "aiFollowupsPerMonth",
  notification: "notificationsPerMonth",
  terraform_export: "terraformExportsPerMonth",
};
