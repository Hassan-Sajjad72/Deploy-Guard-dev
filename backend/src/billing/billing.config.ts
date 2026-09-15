import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
export type BillingConfig = {
  enabled: boolean;
  enforce: boolean;
  provider: "stripe";
  mode: "test";
  testMode: true;
};

function strictBoolean(value: string | undefined, key: string, fallback: boolean) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new BadRequestException(`${key} must be true or false.`);
}

export function getBillingConfig(config: ConfigService): BillingConfig {
  const enabled = strictBoolean(config.get<string>("BILLING_ENABLED"), "BILLING_ENABLED", false);
  const enforce = strictBoolean(config.get<string>("BILLING_ENFORCE"), "BILLING_ENFORCE", false);
  const provider = String(config.get<string>("BILLING_PROVIDER", "stripe")).trim().toLowerCase();
  const mode = String(config.get<string>("BILLING_MODE", "test")).trim().toLowerCase();
  if (provider !== "stripe") throw new BadRequestException("BILLING_PROVIDER must be stripe.");
  if (mode !== "test") throw new BadRequestException("BILLING_MODE must be test; Stripe live payments are not supported.");
  return { enabled, enforce: enabled && enforce, provider: "stripe", mode: "test", testMode: true };
}
