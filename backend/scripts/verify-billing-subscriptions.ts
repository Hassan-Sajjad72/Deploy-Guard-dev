import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { getBillingConfig } from "../src/billing/billing.config";
import { BILLING_PLAN_ORDER, PLAN_ENTITLEMENTS } from "../src/billing/billing-plan";
import { EntitlementService } from "../src/billing/entitlement.service";
import { FreeTrialRuntimeEnforcerService } from "../src/projects/free-trial-runtime-enforcer.service";
import { BillingService } from "../src/billing/billing.service";
import { UserRole } from "../src/users/user.entity";

assert.deepEqual(BILLING_PLAN_ORDER, ["free", "pro", "pro_plus"]);
assert.deepEqual(Object.fromEntries(BILLING_PLAN_ORDER.map((plan) => [plan, [PLAN_ENTITLEMENTS[plan].priceUsdMonthly, PLAN_ENTITLEMENTS[plan].currentProjects, PLAN_ENTITLEMENTS[plan].liveProjects]])), { free: [0, 10, 1], pro: [399, 20, 5], pro_plus: [799, 30, 10] });
assert.equal(PLAN_ENTITLEMENTS.free.freeTrialHours, 48);
assert.deepEqual(getBillingConfig(new ConfigService({})), { enabled: false, mode: "mock", testPlan: null, testMode: false });
assert.deepEqual(getBillingConfig(new ConfigService({ BILLING_ENABLED: "true", BILLING_MODE: "mock", BILLING_TEST_PLAN: "PRO_PLUS" })), { enabled: true, mode: "mock", testPlan: "pro_plus", testMode: true });
assert.throws(() => getBillingConfig(new ConfigService({ BILLING_ENABLED: "yes" })), /true or false/);
assert.throws(() => getBillingConfig(new ConfigService({ BILLING_TEST_PLAN: "ENTERPRISE" })), /FREE, PRO, or PRO_PLUS/);
assert.throws(() => getBillingConfig(new ConfigService({ NODE_ENV: "production", BILLING_TEST_PLAN: "PRO" })), /local\/FYP/);

async function run() {
const subscription: any = { plan: "free", status: "active", trialStartedAt: null, trialEndsAt: null, trialProjectId: null };
const subscriptions = { findOne: async () => subscription, create: (value: any) => value, save: async (value: any) => value };
const routeQuery = { where() { return this; }, andWhere() { return this; }, getExists: async () => false };
const manager: any = { query: async () => undefined, getRepository: (entity: any) => entity.name === "BillingSubscription" ? subscriptions : { createQueryBuilder: () => routeQuery } };
const usage: any = { counts: async () => ({ totalProjects: 10, currentProjects: 10, activeProjects: 10, liveProjects: 1, activeRuns: 0 }) };
const service = new EntitlementService({ manager } as any, usage, new ConfigService({ BILLING_ENABLED: "true", BILLING_MODE: "mock" }));
await assert.rejects(service.assertCanCreateProject(1, manager), (error: any) => error.response?.code === "DG_CURRENT_PROJECT_QUOTA_REACHED");
await assert.rejects(service.assertCanDeployProject(1, "10000000-0000-4000-8000-000000000001", manager), (error: any) => error.response?.code === "DG_LIVE_PROJECT_QUOTA_REACHED");
usage.counts = async () => ({ totalProjects: 1, currentProjects: 1, activeProjects: 1, liveProjects: 0, activeRuns: 0 });
const activatedAt = new Date("2026-09-09T00:00:00.000Z");
await service.recordSuccessfulLiveDeployment(1, "10000000-0000-4000-8000-000000000001", activatedAt, manager);
assert.equal(subscription.trialStartedAt.toISOString(), activatedAt.toISOString());
assert.equal(subscription.trialEndsAt.toISOString(), "2026-09-11T00:00:00.000Z");
await assert.rejects(service.assertCanDeployProject(1, "10000000-0000-4000-8000-000000000001", { ...manager, getRepository: (entity: any) => entity.name === "BillingSubscription" ? { ...subscriptions, findOne: async () => ({ ...subscription, trialEndsAt: new Date("2020-01-01") }) } : { createQueryBuilder: () => routeQuery } } as any), (error: any) => error.response?.code === "DG_FREE_TRIAL_EXPIRED");
const disabled = new EntitlementService({ manager } as any, usage, new ConfigService({ BILLING_ENABLED: "false" }));
assert.equal((await disabled.assertCanDeployProject(1, "project", manager)).allowed, true);
let destroyCalls = 0;
const expiredSubscription = { userId: 1, plan: "free", trialEndsAt: new Date("2026-09-08T00:00:00Z"), trialProjectId: "10000000-0000-4000-8000-000000000001" };
const repository = (entity: any) => entity.name === "BillingSubscription"
  ? { createQueryBuilder: () => ({ where() { return this; }, andWhere() { return this; }, getMany: async () => [expiredSubscription] }) }
  : entity.name === "ProjectEnvironmentRoute"
    ? { createQueryBuilder: () => ({ innerJoin() { return this; }, where() { return this; }, getMany: async () => [{ projectId: expiredSubscription.trialProjectId, liveGenerationId: "20000000-0000-4000-8000-000000000001" }] }) }
    : entity.name === "Project" ? { findOne: async () => ({ id: expiredSubscription.trialProjectId, ownerUserId: 1 }) } : { findOne: async () => ({ id: 1 }) };
const enforcer = new FreeTrialRuntimeEnforcerService({ getRepository: repository } as any, new ConfigService({ BILLING_ENABLED: "true" }), { destroy: async () => { destroyCalls += 1; } } as any);
await enforcer.enforce(new Date("2026-09-09T00:00:00Z"));
assert.equal(destroyCalls, 1, "expired Free LIVE runtime must use the existing destroy lifecycle");
const mockSubscription: any = { id: "subscription", userId: 1, plan: "free", status: "active", provider: "none", mode: "not_configured", billingPeriodStart: null, billingPeriodEnd: null, trialStartedAt: null, trialEndsAt: null, trialProjectId: null, cancelAtPeriodEnd: false };
const invoices: any[] = [];
const subscriptionRepo: any = { findOne: async () => mockSubscription, create: (value: any) => ({ ...mockSubscription, ...value }), save: async (value: any) => Object.assign(mockSubscription, value) };
const invoiceRepo: any = { find: async () => invoices, create: (value: any) => ({ id: String(invoices.length + 1), ...value }), save: async (value: any) => { invoices.push(value); return value; } };
const billing = new BillingService(
  { findOne: async () => null } as any, subscriptionRepo, {} as any, invoiceRepo, {} as any,
  { getRepository: () => ({ findOne: async () => ({ id: 1, role: UserRole.DEVELOPER }) }) } as any,
  { status: () => ({ configured: false }) } as any,
  { usage: async () => ({ plan: mockSubscription.plan, entitlements: PLAN_ENTITLEMENTS[mockSubscription.plan as keyof typeof PLAN_ENTITLEMENTS], usage: {}, periodStart: "2026-09-01", periodEnd: "2026-09-30", enforcement: { enabled: true }, billing: { enabled: true, mode: "mock", testMode: false } }), projectUsage: async () => ({ currentProjects: 1, liveProjects: 0, currentProjectLimit: 10, liveProjectLimit: 1 }) } as any,
  { deploymentRunsSince: async () => 0 } as any, { record: async () => undefined } as any,
  new ConfigService({ BILLING_ENABLED: "true", BILLING_MODE: "mock" }), {} as any,
);
const developer: any = { id: 1, role: UserRole.DEVELOPER };
await billing.setDemoPlan(developer, "pro");
assert.equal(mockSubscription.plan, "pro"); assert.equal(invoices.at(-1).amountDue, 39900);
await billing.setDemoPlan(developer, "pro_plus");
assert.equal(mockSubscription.plan, "pro_plus"); assert.equal(invoices.at(-1).amountDue, 79900);
await assert.rejects(billing.setDemoPlan(developer, "free"), /only upgrade/);
console.log("Billing subscription certification passed: centralized plans, disabled bypass, current/LIVE quotas, mock test plan, and 48-hour Free trial.");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
