import "reflect-metadata";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { BillingAccount } from "../src/billing/billing-account.entity";
import { BillingCheckoutSession } from "../src/billing/billing-checkout-session.entity";
import { BillingInvoice } from "../src/billing/billing-invoice.entity";
import { BillingService } from "../src/billing/billing.service";
import { BillingSubscription } from "../src/billing/billing-subscription.entity";
import { BillingUsageCounter } from "../src/billing/billing-usage-counter.entity";
import { BillingUsageEvent } from "../src/billing/billing-usage-event.entity";
import { BillingWebhookEvent } from "../src/billing/billing-webhook-event.entity";
import { EntitlementService } from "../src/billing/entitlement.service";
import { NotificationDelivery } from "../src/notifications/notification-delivery.entity";
import { NotificationDispatcherService } from "../src/notifications/notification-dispatcher.service";
import { NotificationPreference } from "../src/notifications/notification-preference.entity";
import { NotificationSubscription } from "../src/notifications/notification-subscription.entity";

const database = process.env.DATABASE_NAME || process.env.DB_NAME || "";
if (!/^dg_billing_notifications_[a-z0-9_]+$/.test(database)) {
  throw new Error("BILLING_NOTIFICATION_FIXTURE_DATABASE_REQUIRED");
}

const dataSource = new DataSource({
  type: "postgres",
  host: process.env.DATABASE_HOST || "localhost",
  port: Number(process.env.DATABASE_PORT || "5433"),
  username: process.env.DATABASE_USERNAME || "mini_paas_user",
  password: process.env.DATABASE_PASSWORD || "mini_paas_password",
  database,
  synchronize: false,
  entities: [
    BillingAccount,
    BillingSubscription,
    BillingUsageCounter,
    BillingUsageEvent,
    BillingCheckoutSession,
    BillingInvoice,
    BillingWebhookEvent,
    NotificationPreference,
    NotificationSubscription,
    NotificationDelivery,
  ],
});

function stripeSubscriptionEvent(id: string, created: number, status: "active" | "canceled") {
  return {
    id,
    type: "customer.subscription.updated",
    created,
    livemode: false,
    data: {
      object: {
        id: "sub_fixture",
        customer: "cus_fixture",
        status,
        cancel_at_period_end: false,
        items: { data: [{ current_period_start: created, current_period_end: created + 3600 }] },
      },
    },
  };
}

async function main() {
  await dataSource.initialize();
  const runToken = randomUUID();
  const customerId = `cus_${runToken}`;
  const subscriptionId = `sub_${runToken}`;
  const concurrentEventId = `evt_concurrent_${runToken}`;
  const olderEventId = `evt_older_${runToken}`;
  const accountRepo = dataSource.getRepository(BillingAccount);
  const subscriptionRepo = dataSource.getRepository(BillingSubscription);
  const webhookRepo = dataSource.getRepository(BillingWebhookEvent);
  const deliveries = dataSource.getRepository(NotificationDelivery);
  const preferences = dataSource.getRepository(NotificationPreference);
  const subscriptions = dataSource.getRepository(NotificationSubscription);

  const [user] = await dataSource.query(
    `INSERT INTO users (github_id, name, email, role)
     VALUES ($1, $2, $3, 'developer') RETURNING id, email`,
    [`fixture-${Date.now()}`, "Billing fixture", "fixture@example.invalid"]
  ) as Array<{ id: number; email: string }>;
  const project = { id: randomUUID(), ownerUserId: user.id, name: "Notification fixture" };
  await dataSource.query(
    `INSERT INTO projects (id, owner_user_id, name, description, repository_url, repository_provider,
      repository_full_name, target_branch, environment_name, deployment_overrides, status, visibility)
     VALUES ($1, $2, $3, $4, $5, 'github', $6, 'main', 'dev', '{}'::jsonb, 'created', 'private')`,
    [project.id, user.id, project.name, "Disposable provider-boundary verification", "https://example.invalid/disposable.git", "fixture/disposable"]
  );
  await accountRepo.save(accountRepo.create({ userId: user.id, providerCustomerId: customerId, provider: "stripe", mode: "live" }));
  await subscriptionRepo.save(subscriptionRepo.create({ userId: user.id, plan: "free", status: "active", provider: "none", mode: "not_configured" }));

  let currentEvent = stripeSubscriptionEvent(concurrentEventId, 200, "active");
  currentEvent.data.object.customer = customerId;
  currentEvent.data.object.id = subscriptionId;
  const billing = new BillingService(
    accountRepo,
    subscriptionRepo,
    dataSource.getRepository(BillingCheckoutSession),
    dataSource.getRepository(BillingInvoice),
    webhookRepo,
    dataSource,
    { verifyWebhook: () => currentEvent } as never,
    {} as never,
    {} as never,
    { record: async () => undefined } as never,
    { dispatchAccount: async () => undefined } as never
  );
  const concurrent = await Promise.all([
    billing.handleStripeWebhook(Buffer.from("{}"), "fixture"),
    billing.handleStripeWebhook(Buffer.from("{}"), "fixture"),
  ]);
  assert.equal(concurrent.filter((item) => item.duplicate).length, 1);
  assert.equal(await webhookRepo.count({ where: { providerEventId: concurrentEventId } }), 1);
  assert.equal((await webhookRepo.findOneByOrFail({ providerEventId: concurrentEventId })).status, "processed");

  currentEvent = stripeSubscriptionEvent(olderEventId, 100, "canceled");
  currentEvent.data.object.customer = customerId;
  currentEvent.data.object.id = subscriptionId;
  await billing.handleStripeWebhook(Buffer.from("{}"), "fixture");
  const durableSubscription = await subscriptionRepo.findOneByOrFail({ userId: user.id });
  assert.equal(durableSubscription.status, "active");
  assert.equal(durableSubscription.providerEventCreatedAt?.toISOString(), new Date(200_000).toISOString());

  await preferences.save(preferences.create({ userId: user.id, projectId: project.id, criticalEnabled: true, successEnabled: true, stageUpdatesEnabled: true }));
  await subscriptions.save(subscriptions.create({ userId: user.id, projectId: project.id, destination: user.email, status: "confirmed", protocol: "email", confirmedAt: new Date() }));
  let providerCalls = 0;
  let entitlementCalls = 0;
  const dispatcher = new NotificationDispatcherService(
    { findOne: async ({ where }: { where: { id: string } }) => where.id === project.id ? project : null } as never,
    preferences,
    subscriptions,
    deliveries,
    {
      status: () => ({ enabled: true, configured: true, mode: "live" }),
      send: async () => {
        providerCalls += 1;
        if (providerCalls < 3) throw new Error("fixture provider failure with secret=never-persist");
        return { status: "sent", messageId: "fixture-provider-message" };
      },
    } as never,
    { sanitize: (value: unknown) => String(value).replace(/secret=[^ ]+/g, "secret=[REDACTED]") } as never,
    { record: async () => undefined } as never
  );
  const notification = { projectId: project.id, pipelineRunId: null, eventId: "fixture-event", stage: "deployment", status: "failed", message: "Sanitized fixture failure" };
  await Promise.all([dispatcher.dispatch(notification), dispatcher.dispatch(notification)]);
  const persistedDeliveries = await deliveries.find({ where: { projectId: project.id } });
  assert.equal(persistedDeliveries.length, 1);
  assert.equal(persistedDeliveries[0].status, "sent");
  assert.equal(persistedDeliveries[0].attempts, 3);
  assert.equal(persistedDeliveries[0].lastError, null);
  assert.equal(providerCalls, 3);
  assert.equal(entitlementCalls, 0);

  durableSubscription.plan = "free";
  durableSubscription.provider = "none";
  durableSubscription.mode = "not_configured";
  durableSubscription.status = "active";
  await subscriptionRepo.save(durableSubscription);
  const projectUsage = { counts: async () => ({ activeProjects: 0, activeRuns: 0 }) };
  const entitlements = new EntitlementService(dataSource, projectUsage as never);
  const usageKey = `fixture-usage-${randomUUID()}`;
  const usage = await Promise.all([
    entitlements.consume(user.id, "terraform_export", usageKey, 1, { projectId: project.id, unsafe: "excluded" }),
    entitlements.consume(user.id, "terraform_export", usageKey, 1, { projectId: project.id, unsafe: "excluded" }),
  ]);
  assert.equal(usage.filter((item) => item.consumed).length, 1);
  assert.equal(await dataSource.getRepository(BillingUsageEvent).count({ where: { idempotencyKey: usageKey } }), 1);
  const usageEvent = await dataSource.getRepository(BillingUsageEvent).findOneByOrFail({ idempotencyKey: usageKey });
  assert.deepEqual(usageEvent.metadata, { projectId: project.id });
  await assert.rejects(
    () => entitlements.consume(user.id, "terraform_export", `fixture-over-limit-${randomUUID()}`, 1),
    /limit reached/
  );

  console.log(JSON.stringify({
    database,
    webhook: { eventId: "sanitized", rows: 2, concurrentDuplicate: true, outOfOrderIgnored: true },
    notification: { deliveryId: "sanitized", rows: 1, providerCalls, attempts: persistedDeliveries[0].attempts, status: persistedDeliveries[0].status },
    entitlement: { events: 1, idempotent: true, limitEnforced: true, unsafeMetadataExcluded: true },
    externalProviders: "not_invoked",
  }));
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { if (dataSource.isInitialized) await dataSource.destroy(); });
