import "reflect-metadata";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import Stripe = require("stripe");
import { BillingAccount } from "../src/billing/billing-account.entity";
import { BillingCheckoutSession } from "../src/billing/billing-checkout-session.entity";
import { BillingInvoice } from "../src/billing/billing-invoice.entity";
import { BillingPayment } from "../src/billing/billing-payment.entity";
import { BillingProviderService, VerifiedStripeEvent } from "../src/billing/billing-provider.service";
import { BillingService } from "../src/billing/billing.service";
import { BillingSubscription } from "../src/billing/billing-subscription.entity";
import { BillingWebhookEvent } from "../src/billing/billing-webhook-event.entity";
import { EntitlementService } from "../src/billing/entitlement.service";

const baseConfig = {
  BILLING_ENABLED: "true", BILLING_ENFORCE: "false", BILLING_PROVIDER: "stripe", BILLING_MODE: "test",
  STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_PUBLISHABLE_KEY: "pk_test_fixture", STRIPE_WEBHOOK_SECRET: "whsec_fixture",
  STRIPE_PRO_PRICE_ID: "price_ProFixture123", STRIPE_PRO_PLUS_PRICE_ID: "price_PlusFixture123", FRONTEND_URL: "http://localhost:5173",
};

function memoryRepo<T extends { id?: string }>(seed: T[] = []) {
  const rows = seed;
  return {
    rows,
    create: (value: Partial<T>) => ({ id: randomUUID(), createdAt: new Date(), ...value }) as unknown as T,
    save: async (value: T) => { const index = rows.findIndex((row) => row.id === value.id); if (index >= 0) rows[index] = value; else rows.push(value); return value; },
    findOne: async ({ where }: any) => rows.find((row: any) => Object.entries(where).every(([key, value]: [string, any]) => value?._type === "isNull" ? row[key] == null : row[key] === value)) || null,
    find: async ({ where }: any = {}) => rows.filter((row: any) => Object.entries(where || {}).every(([key, value]: [string, any]) => value?._type === "isNull" ? row[key] == null : row[key] === value)),
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_pro", object: "subscription", livemode: false, customer: "cus_7", status: "active",
    items: { data: [{ id: "si_pro", price: { id: "price_ProFixture123" }, current_period_start: 1788912000, current_period_end: 1791590400 }] },
    cancel_at_period_end: false, canceled_at: null, ended_at: null, metadata: { deployguardUserId: "7", deployguardPlan: "pro" },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

function event(eventId: string, eventType: string, object: Stripe.Event.Data.Object, created = 1788912000): VerifiedStripeEvent {
  return { eventId, eventType, object, occurredAt: new Date(created * 1000) };
}

function signedEvent(type: string, object: unknown, livemode = false) {
  return JSON.stringify({ id: "evt_signed", object: "event", api_version: "2026-08-27.basil", created: 1788912000, livemode, pending_webhooks: 1, request: null, type, data: { object } });
}

async function main() {
  const controller = readFileSync(join(__dirname, "../src/billing/billing.controller.ts"), "utf8");
  const frontend = readFileSync(join(__dirname, "../../frontend/src/pages/Billing.jsx"), "utf8");
  assert.match(controller, /@Post\("portal"\)/);
  assert.match(controller, /@Post\("webhook\/stripe"\) webhook/);
  assert.match(frontend, /Manage Billing/);
  assert.match(frontend, /Payment verification pending/);
  assert.doesNotMatch(frontend, /get\("session_id"\)/, "the success redirect session ID must not be used as entitlement authority");

  const provider = new BillingProviderService(new ConfigService(baseConfig));
  assert.equal(provider.status().configured, true);
  assert.equal(provider.planForPrice("price_ProFixture123"), "pro");
  assert.equal(provider.planForPrice("price_PlusFixture123"), "pro_plus");
  assert.equal(provider.planForPrice("price_unknown"), null);
  const liveProvider = new BillingProviderService(new ConfigService({ ...baseConfig, STRIPE_SECRET_KEY: `sk_${"live"}_forbidden`, STRIPE_PUBLISHABLE_KEY: `pk_${"live"}_forbidden` }));
  assert.equal(liveProvider.status().configured, false);

  const customerRequests: any[] = [];
  const checkoutRequests: Array<{ params: Stripe.Checkout.SessionCreateParams; options: Stripe.RequestOptions }> = [];
  const portalRequests: any[] = [];
  const snapshots: Record<string, Stripe.Subscription> = { sub_pro: subscription() };
  (provider as any).stripeClient = {
    customers: {
      search: async () => ({ data: customerRequests.length ? [{ id: "cus_7" }] : [] }),
      create: async (params: any, options: any) => { customerRequests.push({ params, options }); return { id: "cus_7" }; },
    },
    checkout: { sessions: { create: async (params: Stripe.Checkout.SessionCreateParams, options: Stripe.RequestOptions) => {
      checkoutRequests.push({ params, options });
      const suffix = params.line_items?.[0]?.price === "price_PlusFixture123" ? "plus" : `pro_${checkoutRequests.length}`;
      return { id: `cs_${suffix}`, url: `https://checkout.stripe.com/c/pay/cs_${suffix}`, expires_at: 1788915600 };
    } } },
    subscriptions: { retrieve: async (id: string) => snapshots[id] },
    billingPortal: { sessions: { create: async (params: any) => { portalRequests.push(params); return { id: "bps_test", url: "https://billing.stripe.com/p/session/test" }; } } },
    webhooks: new Stripe("sk_test_fixture").webhooks,
  };

  const user = { id: 7, name: "Fixture User", email: "fixture@example.invalid", role: "developer" } as any;
  const directCustomer = await provider.createCustomer(user);
  assert.equal(directCustomer.id, "cus_7");
  assert.equal(customerRequests[0].options.idempotencyKey, "deployguard-customer-7");
  const directPro = await provider.createCheckout("dg-direct-pro", "pro", user, "cus_7");
  const directPlus = await provider.createCheckout("dg-direct-plus", "pro_plus", user, "cus_7");
  assert.match(directPro.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.match(directPlus.url, /^https:\/\/checkout\.stripe\.com\//);
  assert.deepEqual(checkoutRequests.slice(0, 2).map(({ params }) => params.mode), ["subscription", "subscription"]);
  assert.deepEqual(checkoutRequests.slice(0, 2).map(({ params }) => params.line_items?.[0]?.price), ["price_ProFixture123", "price_PlusFixture123"]);
  assert.equal(checkoutRequests[0].params.customer, "cus_7");
  assert.equal(checkoutRequests[0].params.subscription_data?.metadata?.deployguardUserId, "7");
  assert.equal(checkoutRequests[0].params.success_url, "http://localhost:5173/billing?checkout=returned&session_id={CHECKOUT_SESSION_ID}");
  assert.equal(checkoutRequests[0].options.idempotencyKey, "dg-direct-pro");

  const signed = signedEvent("customer.subscription.updated", subscription());
  const signature = new Stripe("sk_test_fixture").webhooks.generateTestHeaderString({ payload: signed, secret: baseConfig.STRIPE_WEBHOOK_SECRET });
  assert.equal(provider.verifyWebhook(Buffer.from(signed), signature).eventType, "customer.subscription.updated");
  assert.throws(() => provider.verifyWebhook(Buffer.from(signed), "invalid"), /Invalid Stripe webhook signature/);
  const live = signedEvent("customer.subscription.updated", subscription(), true);
  const liveSignature = new Stripe("sk_test_fixture").webhooks.generateTestHeaderString({ payload: live, secret: baseConfig.STRIPE_WEBHOOK_SECRET });
  assert.throws(() => provider.verifyWebhook(Buffer.from(live), liveSignature), /live-mode events are not accepted/);

  const accounts = memoryRepo<any>();
  const subscriptions = memoryRepo<any>([{ id: randomUUID(), userId: 7, providerSubscriptionId: null, providerPriceId: null, plan: "free", status: "active", provider: "none", mode: "not_configured", cancelAtPeriodEnd: false, providerEventCreatedAt: null }]);
  const checkouts = memoryRepo<any>();
  const invoices = memoryRepo<any>();
  const payments = memoryRepo<any>();
  const webhooks = memoryRepo<any>();
  const repo = (entity: any) => entity === BillingAccount ? accounts : entity === BillingSubscription ? subscriptions : entity === BillingCheckoutSession ? checkouts : entity === BillingInvoice ? invoices : entity === BillingPayment ? payments : entity === BillingWebhookEvent ? webhooks : memoryRepo<any>();
  const manager: any = { query: async () => undefined, getRepository: repo };
  const source: any = { manager, transaction: async (...args: any[]) => (typeof args[0] === "function" ? args[0] : args[1])(manager), getRepository: repo };
  const entitlementStub: any = {
    planForUser: async (userId: number) => {
      const row = subscriptions.rows.find((item) => item.userId === userId);
      return row && ["active", "trialing", "past_due"].includes(row.status) ? row.plan : "free";
    },
  };
  let currentEvent = event("evt_unused", "customer.created", { id: "cus_unused" } as any);
  (provider as any).verifyWebhook = () => currentEvent;
  const billing = new BillingService(accounts as any, subscriptions as any, checkouts as any, invoices as any, payments as any, webhooks as any, source, provider, entitlementStub, {} as any, { record: async () => undefined } as any, new ConfigService(baseConfig));

  const firstCheckout = await billing.createCheckout(user, "pro");
  assert.equal(accounts.rows.length, 1);
  assert.equal(accounts.rows[0].providerCustomerId, "cus_7");
  assert.equal(await entitlementStub.planForUser(7), "free", "Checkout creation and browser return must not grant paid access");
  await billing.createCheckout(user, "pro_plus");
  assert.equal(accounts.rows.length, 1, "future Checkouts must reuse the persisted Stripe Customer");
  assert.equal(customerRequests.length, 1, "customer search and persisted identity prevent duplicate Stripe Customers");

  currentEvent = event("evt_checkout", "checkout.session.completed", { id: firstCheckout.providerSessionId, object: "checkout.session", customer: "cus_7", subscription: "sub_pro" } as any);
  assert.equal((await billing.handleStripeWebhook(Buffer.from("{}"), "sig")).status, "subscription_verified");
  assert.equal(subscriptions.rows[0].providerSubscriptionId, "sub_pro");
  assert.equal(subscriptions.rows[0].providerPriceId, "price_ProFixture123");
  assert.equal(subscriptions.rows[0].plan, "pro");
  assert.equal(subscriptions.rows[0].billingPeriodEnd.toISOString(), "2026-10-10T00:00:00.000Z");
  assert.equal((await billing.handleStripeWebhook(Buffer.from("{}"), "sig")).duplicate, true, "duplicate event delivery must be idempotent");

  currentEvent = event("evt_created", "customer.subscription.created", subscription(), 1788912100);
  assert.equal((await billing.handleStripeWebhook(Buffer.from("{}"), "sig")).status, "active");
  snapshots.sub_pro = subscription({ status: "past_due" });
  currentEvent = event("evt_updated", "customer.subscription.updated", snapshots.sub_pro, 1788912200);
  await billing.handleStripeWebhook(Buffer.from("{}"), "sig");
  assert.equal(subscriptions.rows[0].status, "past_due");
  assert.equal(await entitlementStub.planForUser(7), "pro", "past_due retains access during Stripe Smart Retries");

  const failedInvoice = { id: "in_failed", object: "invoice", livemode: false, customer: "cus_7", parent: { subscription_details: { subscription: "sub_pro" } }, number: "DG-FAIL", status: "open", amount_due: 39900, amount_paid: 0, currency: "usd", hosted_invoice_url: "https://invoice.stripe.com/i/fail", invoice_pdf: null, created: 1788912300, status_transitions: { paid_at: null } } as any;
  currentEvent = event("evt_invoice_failed", "invoice.payment_failed", failedInvoice, 1788912300);
  assert.equal((await billing.handleStripeWebhook(Buffer.from("{}"), "sig")).status, "payment_failed");
  assert.equal(payments.rows.length, 0);
  assert.equal(invoices.rows[0].status, "payment_failed");

  snapshots.sub_pro = subscription({ status: "active" });
  const paidInvoice = { ...failedInvoice, id: "in_paid", number: "DG-PAID", status: "paid", amount_paid: 39900, status_transitions: { paid_at: 1788912400 } };
  currentEvent = event("evt_invoice_paid", "invoice.paid", paidInvoice, 1788912400);
  await billing.handleStripeWebhook(Buffer.from("{}"), "sig");
  assert.equal(subscriptions.rows[0].status, "active", "later payment recovery restores authoritative active state");
  assert.equal(payments.rows.length, 1);
  assert.equal(invoices.rows.length, 2);
  currentEvent = event("evt_invoice_paid_replay", "invoice.paid", paidInvoice, 1788912401);
  await billing.handleStripeWebhook(Buffer.from("{}"), "sig");
  assert.equal(payments.rows.length, 1, "one verified invoice payment creates exactly one payment");
  assert.equal(invoices.rows.length, 2, "invoice replay updates rather than duplicates the invoice");

  snapshots.sub_pro = subscription({ status: "active", cancel_at_period_end: true, canceled_at: 1788912500 });
  currentEvent = event("evt_cancel_scheduled", "customer.subscription.updated", snapshots.sub_pro, 1788912500);
  await billing.handleStripeWebhook(Buffer.from("{}"), "sig");
  assert.equal(subscriptions.rows[0].cancelAtPeriodEnd, true);
  assert.equal(await entitlementStub.planForUser(7), "pro", "cancel-at-period-end retains access until Stripe ends the subscription");

  currentEvent = event("evt_deleted", "customer.subscription.deleted", subscription({ status: "canceled", canceled_at: 1788912600, ended_at: 1788912600 }), 1788912600);
  await billing.handleStripeWebhook(Buffer.from("{}"), "sig");
  assert.equal(subscriptions.rows[0].status, "canceled");
  assert.equal(await entitlementStub.planForUser(7), "free");

  snapshots.sub_pro = subscription({ status: "active" });
  currentEvent = event("evt_recovered_newer", "customer.subscription.updated", snapshots.sub_pro, 1788912800);
  await billing.handleStripeWebhook(Buffer.from("{}"), "sig");
  currentEvent = event("evt_stale_delete", "customer.subscription.deleted", subscription({ status: "canceled" }), 1788912700);
  assert.equal((await billing.handleStripeWebhook(Buffer.from("{}"), "sig")).status, "stale_ignored");
  assert.equal(subscriptions.rows[0].status, "active", "older deletion delivery must not override newer authoritative state");

  const actualEntitlements = new EntitlementService(source, {} as any, new ConfigService(baseConfig));
  for (const [status, expected] of [["active", "pro"], ["trialing", "pro"], ["past_due", "pro"], ["unpaid", "free"], ["canceled", "free"], ["incomplete", "free"], ["incomplete_expired", "free"], ["paused", "free"]]) {
    subscriptions.rows[0].status = status;
    assert.equal(await actualEntitlements.planForUser(7), expected, `status ${status} entitlement mapping`);
  }
  subscriptions.rows[0].status = "active";

  const portal = await billing.createPortal(user);
  assert.match(portal.portalUrl, /^https:\/\/billing\.stripe\.com\//);
  assert.deepEqual(portalRequests.at(-1), { customer: "cus_7", return_url: "http://localhost:5173/billing" });

  console.log("Stripe recurring billing verification passed: fixed subscription Prices, Customer reuse, signed webhook authority, lifecycle state, out-of-order safety, invoice/payment idempotency, entitlement mapping, and Customer Portal.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
