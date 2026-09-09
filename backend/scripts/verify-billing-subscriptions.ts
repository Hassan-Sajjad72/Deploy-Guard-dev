import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { getBillingConfig } from "../src/billing/billing.config";
import { BILLING_PLAN_ORDER, PLAN_ENTITLEMENTS } from "../src/billing/billing-plan";
import { BillingSubscription } from "../src/billing/billing-subscription.entity";
import { EntitlementService } from "../src/billing/entitlement.service";
import { ProjectEnvironmentRoute } from "../src/projects/project-environment-route.entity";

assert.deepEqual(BILLING_PLAN_ORDER, ["free", "pro", "pro_plus"]);
assert.deepEqual(Object.fromEntries(BILLING_PLAN_ORDER.map((plan) => [plan, [PLAN_ENTITLEMENTS[plan].priceUsdMonthly, PLAN_ENTITLEMENTS[plan].currentProjects, PLAN_ENTITLEMENTS[plan].liveProjects]])), { free: [0, 10, 1], pro: [399, 20, 5], pro_plus: [799, 30, 10] });
assert.deepEqual(getBillingConfig(new ConfigService({})), { enabled: false, enforce: false, provider: "stripe", mode: "test", testMode: true });
assert.deepEqual(getBillingConfig(new ConfigService({ BILLING_ENABLED: "true", BILLING_ENFORCE: "false", BILLING_PROVIDER: "stripe", BILLING_MODE: "test" })), { enabled: true, enforce: false, provider: "stripe", mode: "test", testMode: true });
assert.equal(getBillingConfig(new ConfigService({ BILLING_ENABLED: "true", BILLING_ENFORCE: "true" })).enforce, true);
assert.throws(() => getBillingConfig(new ConfigService({ BILLING_ENFORCE: "yes" })), /true or false/);
assert.throws(() => getBillingConfig(new ConfigService({ BILLING_MODE: "live" })), /test/);
assert.throws(() => getBillingConfig(new ConfigService({ BILLING_PROVIDER: "unsupported" })), /stripe/);

async function main() {
const subscription: any = { id: "subscription", userId: 7, plan: "free", status: "active", provider: "none", mode: "not_configured", trialStartedAt: null, trialEndsAt: null, trialProjectId: null };
let saves = 0;
const subscriptions: any = { findOne: async () => subscription, create: (value: any) => value, save: async (value: any) => { saves += 1; Object.assign(subscription, value); return value; } };
const routeQuery: any = { where() { return this; }, andWhere() { return this; }, getExists: async () => false };
const manager: any = { query: async () => undefined, getRepository: (entity: any) => entity === BillingSubscription ? subscriptions : entity === ProjectEnvironmentRoute ? { createQueryBuilder: () => routeQuery } : {} };
let counts = { totalProjects: 2, currentProjects: 2, activeProjects: 2, liveProjects: 2, activeRuns: 0 };
const activatedAt = new Date("2026-09-08T12:00:00.000Z");
const usage: any = { counts: async () => counts, earliestLiveProject: async () => ({ projectId: "10000000-0000-4000-8000-000000000001", activatedAt }) };
const dataSource: any = { manager, transaction: async (callback: any) => callback(manager), getRepository: (entity: any) => manager.getRepository(entity) };

const observe = new EntitlementService(dataSource, usage, new ConfigService({ BILLING_ENABLED: "true", BILLING_ENFORCE: "false" }));
const observedUsage = await observe.projectUsage(7);
assert.deepEqual(observedUsage.overLimit, { currentProjects: false, liveProjects: true });
assert.equal(observedUsage.enforcement.enabled, false);
assert.equal((await observe.assertCanDeployProject(7, "20000000-0000-4000-8000-000000000001") as any).allowed, true, "observation mode must not block an over-limit deployment");
counts = { ...counts, currentProjects: 10 };
assert.equal((await observe.assertCanCreateProject(7) as any).allowed, true, "observation mode must not block the total-project limit");
await observe.reconcileFreeTrial(7);
assert.equal(subscription.trialStartedAt.toISOString(), activatedAt.toISOString());
assert.equal(subscription.trialEndsAt.toISOString(), "2026-09-10T12:00:00.000Z");
assert.equal(subscription.trialProjectId, "10000000-0000-4000-8000-000000000001");
assert.notEqual(subscription.mode, "mock", "a real LIVE deployment must not create mock-payment state");
await observe.reconcileFreeTrial(7);
assert.equal(saves, 1, "existing LIVE state starts exactly one persisted trial");

subscription.trialStartedAt = null; subscription.trialEndsAt = null; subscription.trialProjectId = null; saves = 0;
await observe.recordSuccessfulLiveDeployment(7, "30000000-0000-4000-8000-000000000001", activatedAt, manager);
await observe.recordSuccessfulLiveDeployment(7, "30000000-0000-4000-8000-000000000001", new Date(activatedAt.getTime() + 60_000), manager);
assert.equal(subscription.trialStartedAt.toISOString(), activatedAt.toISOString());
assert.equal(subscription.trialEndsAt.toISOString(), "2026-09-10T12:00:00.000Z");
assert.equal(saves, 1, "the first successful LIVE deployment starts exactly one persisted trial");

subscription.trialEndsAt = new Date("2020-01-01T00:00:00.000Z");
const enforce = new EntitlementService(dataSource, usage, new ConfigService({ BILLING_ENABLED: "true", BILLING_ENFORCE: "true" }));
await assert.rejects(enforce.assertCanCreateProject(7), (error: any) => error.response?.code === "DG_CURRENT_PROJECT_QUOTA_REACHED");
await assert.rejects(enforce.assertCanDeployProject(7, "20000000-0000-4000-8000-000000000001"), (error: any) => error.response?.code === "DG_FREE_TRIAL_EXPIRED");
subscription.trialEndsAt = new Date("2099-01-01T00:00:00.000Z");
await assert.rejects(enforce.assertCanDeployProject(7, "20000000-0000-4000-8000-000000000001"), (error: any) => error.response?.code === "DG_LIVE_PROJECT_QUOTA_REACHED");
const disabled = new EntitlementService(dataSource, usage, new ConfigService({ BILLING_ENABLED: "false", BILLING_ENFORCE: "true" }));
assert.equal((await disabled.assertCanDeployProject(7, "20000000-0000-4000-8000-000000000001") as any).allowed, true);
assert.equal((await disabled.assertCanCreateProject(7) as any).allowed, true);

for (const [plan, limits] of [["pro", [20, 5]], ["pro_plus", [30, 10]]] as const) {
  subscription.plan = plan; counts = { ...counts, currentProjects: limits[0] - 1, liveProjects: limits[1] - 1 };
  const result = await enforce.projectUsage(7); assert.equal(result.currentProjectLimit, limits[0]); assert.equal(result.liveProjectLimit, limits[1]);
}
console.log("Billing subscription verification passed: plans, independent enforcement, OVER_LIMIT observation, authoritative LIVE reconciliation, and one persisted 48-hour Free trial.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
