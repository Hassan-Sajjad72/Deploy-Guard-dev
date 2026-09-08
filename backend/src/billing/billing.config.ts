import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { BillingPlan } from "./billing-plan";

const PLAN: Record<string, BillingPlan> = { FREE: "free", PRO: "pro", PRO_PLUS: "pro_plus" };
export type BillingConfig = { enabled: boolean; mode: "mock"; testPlan: BillingPlan | null; testMode: boolean };

function strictBoolean(value: string | undefined, key: string, fallback: boolean) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new BadRequestException(`${key} must be true or false.`);
}

export function getBillingConfig(config: ConfigService): BillingConfig {
  const enabled = strictBoolean(config.get<string>("BILLING_ENABLED"), "BILLING_ENABLED", false);
  const mode = String(config.get<string>("BILLING_MODE", "mock")).trim().toLowerCase();
  if (mode !== "mock") throw new BadRequestException("BILLING_MODE must be mock.");
  const rawTestPlan = String(config.get<string>("BILLING_TEST_PLAN", "")).trim().toUpperCase();
  if (rawTestPlan && !PLAN[rawTestPlan]) throw new BadRequestException("BILLING_TEST_PLAN must be FREE, PRO, or PRO_PLUS.");
  const production = String(config.get<string>("NODE_ENV", "development")).toLowerCase() === "production";
  if (production && rawTestPlan) throw new BadRequestException("BILLING_TEST_PLAN is restricted to local/FYP testing.");
  return { enabled, mode: "mock", testPlan: rawTestPlan ? PLAN[rawTestPlan] : null, testMode: Boolean(rawTestPlan) };
}
