import { strict as assert } from "node:assert";
import { EntitlementService } from "../src/billing/entitlement.service";
import { METRIC_LIMIT_KEY, PLAN_ENTITLEMENTS } from "../src/billing/billing-plan";
import { getPlanUsageEnforcementConfig } from "../src/billing/plan-usage-enforcement.config";
import { BillingProviderService } from "../src/billing/billing-provider.service";

assert(PLAN_ENTITLEMENTS.free.activeProjects >= 1);
assert(PLAN_ENTITLEMENTS.pro.activeProjects > PLAN_ENTITLEMENTS.free.activeProjects);
assert(PLAN_ENTITLEMENTS.pro.aiAnalysesPerMonth > PLAN_ENTITLEMENTS.free.aiAnalysesPerMonth);
assert.equal(METRIC_LIMIT_KEY.terraform_export, "terraformExportsPerMonth");
assert.equal(PLAN_ENTITLEMENTS.free.notificationStageUpdates, false);
assert.equal(PLAN_ENTITLEMENTS.pro.notificationStageUpdates, true);
assert.equal(getPlanUsageEnforcementConfig({}).enabled, true);
assert.equal(getPlanUsageEnforcementConfig({ PLAN_USAGE_ENFORCEMENT_ENABLED: "false" }).enabled, false);
assert.equal(getPlanUsageEnforcementConfig({ USAGE_LIMITS_ENABLED: "0" }).enabled, false);
assert.equal(getPlanUsageEnforcementConfig({ BILLING_ENFORCEMENT_ENABLED: "true" }).enabled, true);

function config(values: Record<string, string>) {
  return { get: (key: string, fallback?: string) => values[key] ?? fallback } as never;
}

async function verifyProviderGate() {
  const disabled = new BillingProviderService(config({
    STRIPE_SECRET_KEY: "configured-but-disabled",
    STRIPE_PRO_PRICE_ID: "price_configured",
    STRIPE_WEBHOOK_SECRET: "configured",
  }));
  assert.deepEqual(disabled.status(), {
    provider: "none",
    mode: "disabled",
    enabled: false,
    configured: false,
    missingConfiguration: [],
    webhookConfigured: false,
  });
  await assert.rejects(() => disabled.createCheckout({} as never), /BILLING_PROVIDER_DISABLED/);
  assert.throws(() => disabled.verifyWebhook(Buffer.from("{}"), "signature"), /BILLING_PROVIDER_DISABLED/);

  const incomplete = new BillingProviderService(config({ BILLING_PROVIDER_ENABLED: "true" }));
  assert.equal(incomplete.status().mode, "not_configured");
  assert.deepEqual(incomplete.status().missingConfiguration, ["STRIPE_SECRET_KEY", "STRIPE_PRO_PRICE_ID"]);
  await assert.rejects(() => incomplete.createCheckout({} as never), /NOT_CONFIGURED/);
}

async function verifyMeteredBypass() {
  const counter = { quantity: PLAN_ENTITLEMENTS.free.aiAnalysesPerMonth };
  const manager = {
    query: async () => undefined,
    getRepository: (entity: { name: string }) => {
      if (entity.name === "BillingSubscription") return { findOne: async () => null };
      if (entity.name === "BillingUsageEvent") return { findOne: async () => null, create: (value: unknown) => value, save: async (value: unknown) => value };
      return { findOne: async () => counter, create: (value: unknown) => value, save: async (value: unknown) => value };
    },
  };
  const dataSource = { transaction: async (work: (value: typeof manager) => unknown) => work(manager) };
  const entitlements = new EntitlementService(dataSource as never, {} as never);
  const original = process.env.PLAN_USAGE_ENFORCEMENT_ENABLED;
  try {
    process.env.PLAN_USAGE_ENFORCEMENT_ENABLED = "false";
    const result = await entitlements.consume(1, "ai_analysis", "testing-bypass");
    assert.equal(result.enforcement.enabled, false);
    assert.equal(result.quantity, PLAN_ENTITLEMENTS.free.aiAnalysesPerMonth + 1);
  } finally {
    if (original === undefined) delete process.env.PLAN_USAGE_ENFORCEMENT_ENABLED;
    else process.env.PLAN_USAGE_ENFORCEMENT_ENABLED = original;
  }
}

Promise.all([verifyMeteredBypass(), verifyProviderGate()])
  .then(() => console.log("Billing entitlement, explicit provider gate, and enforcement configuration verification passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
