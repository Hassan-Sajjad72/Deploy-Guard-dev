import { strict as assert } from "node:assert";
import { NotificationDispatcherService } from "../src/notifications/notification-dispatcher.service";
import { SnsNotificationAdapter } from "../src/notifications/sns-notification.adapter";
const service = Object.create(NotificationDispatcherService.prototype) as NotificationDispatcherService;
assert.deepEqual(service.classify("docker_build", "failed"), { type: "deployment_failed", kind: "critical" });
assert.deepEqual(service.classify("dockerfile_security_check_failed", "failed"), { type: "security_policy_block", kind: "critical" });
assert.deepEqual(service.classify("stable_release", "completed"), { type: "deployment_succeeded", kind: "success" });
assert.deepEqual(service.classify("infrastructure_destroy", "failed"), { type: "destroy_failed", kind: "critical" });
assert.deepEqual(service.classify("rollback", "started"), { type: "rollback_started", kind: "stage" });
assert.deepEqual(service.classify("redeploy_completed", "completed"), { type: "redeployment_succeeded", kind: "success" });
assert.deepEqual(service.classify("runtime_unhealthy", "failed"), { type: "runtime_unhealthy", kind: "critical" });
assert.deepEqual(service.classify("cost_threshold_exceeded", "warning"), { type: "cost_threshold_exceeded", kind: "critical" });

function verifyProviderGate() {
  const config = { get: (key: string, fallback?: string) => ({ SNS_TOPIC_ARN: "arn:configured-but-disabled", SNS_REGION: "us-east-1" }[key] ?? fallback) } as never;
  const adapter = new SnsNotificationAdapter(config);
  assert.deepEqual(adapter.status(), { enabled: false, configured: false, mode: "disabled", region: "us-east-1" });
}

async function verifyUnconfirmedIsNotSent() {
  let providerCalls = 0;
  const deliveryRepo = {
    findOne: async () => null,
    create: (value: Record<string, unknown>) => ({ id: "delivery-1", sentAt: null, attempts: 0, ...value }),
    save: async (value: Record<string, unknown>) => value,
  };
  const dispatcher = new NotificationDispatcherService(
    { findOne: async () => ({ id: "project-1", ownerUserId: 7, name: "Project" }) } as never,
    { findOne: async () => ({ enabled: true, criticalEnabled: true, successEnabled: true, stageUpdatesEnabled: true }) } as never,
    { findOne: async () => null } as never,
    deliveryRepo as never,
    { status: () => ({ configured: true }), send: async () => { providerCalls += 1; return { status: "sent" }; } } as never,
    { sanitize: (value: unknown) => String(value) } as never,
    { record: async () => undefined } as never
  );
  const delivery = await dispatcher.dispatch({ projectId: "project-1", pipelineRunId: "run-1", stage: "docker_build", status: "failed", message: "Build failed" });
  assert.equal(delivery?.status, "skipped_unconfirmed");
  assert.equal(delivery?.sentAt, null);
  assert.equal(providerCalls, 0);
}

async function verifyRetryAndDeduplication() {
  let providerCalls = 0;
  let entitlementCalls = 0;
  const stored = new Map<string, Record<string, unknown>>();
  const deliveryRepo = {
    findOne: async ({ where }: { where: { deduplicationKey: string } }) => stored.get(where.deduplicationKey) || null,
    create: (value: Record<string, unknown>) => ({ id: "delivery-retry", sentAt: null, attempts: 0, ...value }),
    save: async (value: Record<string, unknown>) => { stored.set(String(value.deduplicationKey), value); return value; },
  };
  const dispatcher = new NotificationDispatcherService(
    { findOne: async () => ({ id: "project-1", ownerUserId: 7, name: "Project" }) } as never,
    { findOne: async () => ({ enabled: true, criticalEnabled: true, successEnabled: true, stageUpdatesEnabled: true }) } as never,
    { findOne: async () => ({ status: "confirmed" }) } as never,
    deliveryRepo as never,
    { status: () => ({ configured: true }), send: async () => { providerCalls += 1; if (providerCalls < 3) throw new Error("provider detail must not persist"); return { status: "sent", messageId: "provider-message" }; } } as never,
    { sanitize: (value: unknown) => String(value).replace(/provider detail/g, "[REDACTED]") } as never,
    { record: async () => undefined } as never
  );
  const input = { projectId: "project-1", pipelineRunId: "run-1", eventId: "event-1", stage: "docker_build", status: "failed", message: "Build failed" };
  const first = await dispatcher.dispatch(input);
  const duplicate = await dispatcher.dispatch(input);
  assert.equal(first?.status, "sent");
  assert.equal(first?.attempts, 3);
  assert.equal(first?.lastError, null);
  assert.equal(duplicate?.id, first?.id);
  assert.equal(providerCalls, 3);
  assert.equal(entitlementCalls, 0);
  assert.equal(stored.size, 1);
}

async function verifyConcurrentInsertCollisionFailsClosed() {
  let lookups = 0;
  let providerCalls = 0;
  const winner = { id: "delivery-winner", deduplicationKey: "project-1:run-1:event-1:deployment_failed", status: "pending" };
  const deliveryRepo = {
    findOne: async () => (++lookups === 1 ? null : winner),
    create: (value: Record<string, unknown>) => value,
    save: async () => { throw Object.assign(new Error("duplicate"), { code: "23505" }); },
  };
  const dispatcher = new NotificationDispatcherService(
    { findOne: async () => ({ id: "project-1", ownerUserId: 7, name: "Project" }) } as never,
    { findOne: async () => ({ enabled: true, criticalEnabled: true, successEnabled: true, stageUpdatesEnabled: true }) } as never,
    { findOne: async () => ({ status: "confirmed" }) } as never,
    deliveryRepo as never,
    { status: () => ({ configured: true }), send: async () => { providerCalls += 1; return { status: "sent" }; } } as never,
    { sanitize: (value: unknown) => String(value) } as never,
    { record: async () => undefined } as never
  );
  const result = await dispatcher.dispatch({ projectId: "project-1", pipelineRunId: "run-1", eventId: "event-1", stage: "docker_build", status: "failed", message: "Build failed" });
  assert.equal(result?.id, winner.id);
  assert.equal(providerCalls, 0);
}

async function verifyPendingConfirmationCanBecomeConfirmed() {
  const adapter = new SnsNotificationAdapter({ get: (key: string, fallback?: string) => key === "NOTIFICATION_DELIVERY_ENABLED" ? "true" : key === "AWS_REGION" ? "us-east-1" : fallback } as never);
  (adapter as any).client = () => ({ send: async (command: any) => command.constructor.name === "ListSubscriptionsByTopicCommand"
    ? { Subscriptions: [{ Protocol: "email", Endpoint: "owner@example.com", SubscriptionArn: "arn:aws:sns:us-east-1:123:topic:confirmed" }] }
    : { Attributes: { FilterPolicy: JSON.stringify({ deployguardUserId: ["7"], deployguardProjectId: ["project-1"] }) } } });
  const current = await adapter.findSubscription("owner@example.com", 7, "project-1", "arn:aws:sns:us-east-1:123:topic", "PendingConfirmation");
  assert.equal(current?.status, "confirmed", "status refresh must discover the real ARN after the email confirmation link is accepted");
}

verifyProviderGate();
Promise.all([verifyUnconfirmedIsNotSent(), verifyRetryAndDeduplication(), verifyConcurrentInsertCollisionFailsClosed(), verifyPendingConfirmationCanBecomeConfirmed()])
  .then(() => console.log("Notification provider gate, mapping, retry, and deduplication honesty passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
