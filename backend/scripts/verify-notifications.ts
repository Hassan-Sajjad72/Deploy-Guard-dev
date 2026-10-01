import { strict as assert } from "node:assert";
import { NotificationDispatcherService } from "../src/notifications/notification-dispatcher.service";
import { NotificationsService } from "../src/notifications/notifications.service";
import { SnsNotificationAdapter } from "../src/notifications/sns-notification.adapter";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { UserRole } from "../src/users/user.entity";
const service = Object.create(NotificationDispatcherService.prototype) as NotificationDispatcherService;
assert.deepEqual(service.classify("docker_build", "failed"), { type: "deployment_failed", kind: "critical" });
assert.deepEqual(service.classify("dockerfile_security_check_failed", "failed"), { type: "security_policy_block", kind: "critical" });
assert.deepEqual(service.classify("stable_release", "completed"), { type: "deployment_succeeded", kind: "success" });
assert.deepEqual(service.classify("infrastructure_destroy", "failed"), { type: "destroy_failed", kind: "critical" });
assert.deepEqual(service.classify("rollback", "started"), { type: "rollback_started", kind: "stage" });
assert.deepEqual(service.classify("redeploy_completed", "completed"), { type: "redeployment_succeeded", kind: "success" });
assert.deepEqual(service.classify("deploy_started", "started"), { type: "deployment_started", kind: "stage" });
assert.deepEqual(service.classify("runtime_unhealthy", "failed"), { type: "runtime_unhealthy", kind: "critical" });
assert.deepEqual(service.classify("cost_threshold_exceeded", "warning"), { type: "cost_threshold_exceeded", kind: "critical" });

function verifyProviderGate() {
  const config = { get: (key: string, fallback?: string) => ({ SNS_TOPIC_ARN: "arn:configured-but-disabled", SNS_REGION: "us-east-1" }[key] ?? fallback) } as never;
  const adapter = new SnsNotificationAdapter(config);
  assert.deepEqual(adapter.status(), { enabled: false, configured: false, mode: "disabled", region: "us-east-1" });
}

function verifyIncompleteProviderIsUnavailable() {
  const adapter = new SnsNotificationAdapter({ get: (key: string, fallback?: string) => key === "NOTIFICATION_DELIVERY_ENABLED" ? "true" : key === "AWS_REGION" ? "us-east-1" : fallback } as never);
  assert.deepEqual(adapter.status(), { enabled: true, configured: false, mode: "unavailable", region: "us-east-1" });
}

async function verifyDisabledProviderEndpointsDoNotThrow() {
  const user: any = { id: 7, role: UserRole.DEVELOPER };
  const project: any = { id: "project-disabled", ownerUserId: user.id, name: "Disabled provider" };
  let subscription: any = null;
  const preferences: any[] = [];
  const subscriptionRepo: any = {
    findOne: async () => subscription,
    create: (value: Record<string, unknown>) => ({ id: "subscription-1", createdAt: new Date(), updatedAt: new Date(), ...value }),
    save: async (value: any) => { subscription = value; return value; },
  };
  const service = new NotificationsService(
    { findOne: async () => project } as never,
    { save: async (value: any) => { preferences.push(value); return value; } } as never,
    subscriptionRepo,
    { find: async () => [], findOne: async () => null } as never,
    {
      getOrCreatePreference: async () => ({ id: "preference-1", enabled: false }),
      dispatch: async () => ({ id: "delivery-1", status: "skipped_unconfigured" }),
    } as never,
    new SnsNotificationAdapter({ get: (_key: string, fallback?: string) => fallback } as never),
    { record: async () => undefined } as never,
    { sanitize: (value: unknown) => String(value) } as never,
  );
  const created = await service.subscribe(user, project.id, "owner@example.com");
  assert.equal(created.status, "not_configured", "disabled SNS subscribe returns an honest state instead of throwing");
  const resent = await service.resendConfirmation(user, project.id);
  assert.equal(resent?.status, "not_configured", "disabled SNS resend returns an honest state instead of throwing");
  assert.deepEqual(await service.unsubscribe(user, project.id), { status: "unsubscribed" });
  assert.equal((await service.test(user, project.id))?.status, "skipped_unconfigured", "disabled SNS test delivery is skipped, not an HTTP 500");
  assert.ok(preferences.length >= 2, "preference changes remain persisted while the provider is disabled");
}

async function verifyUnconfirmedIsNotSent() {
  let providerCalls = 0;
  const deliveryRepo = {
    findOne: async () => null,
    create: (value: Record<string, unknown>) => ({ id: "delivery-1", publishedAt: null, attempts: 0, ...value }),
    save: async (value: Record<string, unknown>) => value,
  };
  const dispatcher = new NotificationDispatcherService(
    { findOne: async () => ({ id: "project-1", ownerUserId: 7, name: "Project" }) } as never,
    { findOne: async () => ({ enabled: true, criticalEnabled: true, successEnabled: true, stageUpdatesEnabled: true }) } as never,
    { findOne: async () => null } as never,
    deliveryRepo as never,
    { status: () => ({ configured: true }), send: async () => { providerCalls += 1; return { status: "published" }; } } as never,
    { sanitize: (value: unknown) => String(value) } as never,
    { record: async () => undefined } as never
  );
  const delivery = await dispatcher.dispatch({ projectId: "project-1", pipelineRunId: "run-1", stage: "docker_build", status: "failed", message: "Build failed" });
  assert.equal(delivery?.status, "skipped_unconfirmed");
  assert.equal(delivery?.publishedAt, null);
  assert.equal(providerCalls, 0);
}

async function verifyRetryAndDeduplication() {
  let providerCalls = 0;
  let entitlementCalls = 0;
  const stored = new Map<string, Record<string, unknown>>();
  const deliveryRepo = {
    findOne: async ({ where }: { where: { deduplicationKey: string } }) => stored.get(where.deduplicationKey) || null,
    create: (value: Record<string, unknown>) => ({ id: "delivery-retry", publishedAt: null, attempts: 0, ...value }),
    save: async (value: Record<string, unknown>) => { stored.set(String(value.deduplicationKey), value); return value; },
  };
  const dispatcher = new NotificationDispatcherService(
    { findOne: async () => ({ id: "project-1", ownerUserId: 7, name: "Project" }) } as never,
    { findOne: async () => ({ enabled: true, criticalEnabled: true, successEnabled: true, stageUpdatesEnabled: true }) } as never,
    { findOne: async () => ({ status: "confirmed" }) } as never,
    deliveryRepo as never,
    { status: () => ({ configured: true }), send: async () => { providerCalls += 1; if (providerCalls < 3) throw new Error("provider detail must not persist"); return { status: "published", messageId: "provider-message" }; } } as never,
    { sanitize: (value: unknown) => String(value).replace(/provider detail/g, "[REDACTED]") } as never,
    { record: async () => undefined } as never
  );
  const input = { projectId: "project-1", pipelineRunId: "run-1", eventId: "event-1", stage: "docker_build", status: "failed", message: "Build failed" };
  const first = await dispatcher.dispatch(input);
  const duplicate = await dispatcher.dispatch(input);
  assert.equal(first?.status, "published");
  assert.ok(first?.publishedAt instanceof Date, "the persisted provider-acceptance timestamp is recorded without claiming inbox delivery");
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
    { status: () => ({ configured: true }), send: async () => { providerCalls += 1; return { status: "published" }; } } as never,
    { sanitize: (value: unknown) => String(value) } as never,
    { record: async () => undefined } as never
  );
  const result = await dispatcher.dispatch({ projectId: "project-1", pipelineRunId: "run-1", eventId: "event-1", stage: "docker_build", status: "failed", message: "Build failed" });
  assert.equal(result?.id, winner.id);
  assert.equal(providerCalls, 0);
}

async function verifyPendingConfirmationCanBecomeConfirmed() {
  const adapter = new SnsNotificationAdapter({ get: (key: string, fallback?: string) => key === "NOTIFICATION_DELIVERY_ENABLED" ? "true" : key === "AWS_REGION" ? "us-east-1" : ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].includes(key) ? "configured-for-test" : fallback } as never);
  (adapter as any).client = () => ({ send: async (command: any) => command.constructor.name === "ListSubscriptionsByTopicCommand"
    ? { Subscriptions: [{ Protocol: "email", Endpoint: "owner@example.com", SubscriptionArn: "arn:aws:sns:us-east-1:123:topic:confirmed" }] }
    : { Attributes: { FilterPolicy: JSON.stringify({ deployguardUserId: ["7"], deployguardProjectId: ["project-1"] }) } } });
  const current = await adapter.findSubscription("owner@example.com", 7, "project-1", "arn:aws:sns:us-east-1:123:topic", "PendingConfirmation");
  assert.equal(current?.status, "confirmed", "status refresh must discover the real ARN after the email confirmation link is accepted");
}

async function verifySubscribeDoesNotAssumeEmailConfirmation() {
  const adapter = new SnsNotificationAdapter({ get: (key: string, fallback?: string) => key === "NOTIFICATION_DELIVERY_ENABLED" ? "true" : key === "AWS_REGION" ? "us-east-1" : ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].includes(key) ? "configured-for-test" : fallback } as never);
  (adapter as any).client = () => ({ send: async (command: any) => command.constructor.name === "CreateTopicCommand"
    ? { TopicArn: "arn:aws:sns:us-east-1:123:deployguard-project-1-notifications" }
    : { SubscriptionArn: "arn:aws:sns:us-east-1:123:deployguard-project-1-notifications:subscription-1" } });
  const created = await adapter.subscribe("owner@example.com", 7, "project-1");
  assert.equal(created.status, "pending_confirmation", "an ARN returned by Subscribe is not evidence that the email recipient confirmed it");
}

async function verifyProviderPendingOverridesStaleConfirmedArn() {
  const adapter = new SnsNotificationAdapter({ get: (key: string, fallback?: string) => key === "NOTIFICATION_DELIVERY_ENABLED" ? "true" : key === "AWS_REGION" ? "us-east-1" : ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].includes(key) ? "configured-for-test" : fallback } as never);
  (adapter as any).client = () => ({ send: async () => ({ Subscriptions: [{ Protocol: "email", Endpoint: "owner@example.com", SubscriptionArn: "PendingConfirmation" }] }) });
  const current = await adapter.findSubscription("owner@example.com", 7, "project-1", "arn:aws:sns:us-east-1:123:topic", "arn:aws:sns:us-east-1:123:topic:premature-arn");
  assert.equal(current?.status, "pending_confirmation", "AWS pending state must downgrade a prematurely confirmed local subscription");
}

async function verifySettingsReconcilePrematureConfirmation() {
  const user: any = { id: 7, role: UserRole.DEVELOPER };
  const subscription: any = { id: "subscription-1", userId: user.id, projectId: "project-1", destination: "owner@example.com", status: "confirmed", providerSubscriptionArn: "arn:premature", providerTopicArn: "arn:topic", confirmedAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
  const service = new NotificationsService(
    { findOne: async () => ({ id: "project-1", ownerUserId: user.id }) } as never,
    {} as never,
    { findOne: async () => subscription, save: async (value: any) => value } as never,
    { find: async () => [] } as never,
    { getOrCreatePreference: async () => ({ enabled: true }) } as never,
    { status: () => ({ configured: true }), findSubscription: async () => ({ status: "pending_confirmation", subscriptionArn: "arn:premature", topicArn: "arn:topic" }) } as never,
    {} as never,
    {} as never,
  );
  const settings = await service.settings(user, "project-1");
  assert.equal(settings.configurationStatus, "pending_confirmation", "settings must reconcile a premature local confirmation against current SNS state");
  assert.equal(subscription.confirmedAt, null, "pending provider state removes the misleading local confirmation timestamp");
}

async function verifySettingsClearMissingProviderSubscription() {
  const user: any = { id: 7, role: UserRole.DEVELOPER };
  const subscription: any = { id: "subscription-1", userId: user.id, projectId: "project-1", destination: "owner@example.com", status: "confirmed", providerSubscriptionArn: "arn:stale", providerTopicArn: "arn:topic", confirmedAt: new Date(), createdAt: new Date(), updatedAt: new Date() };
  const service = new NotificationsService(
    { findOne: async () => ({ id: "project-1", ownerUserId: user.id }) } as never,
    {} as never,
    { findOne: async () => subscription, save: async (value: any) => value } as never,
    { find: async () => [] } as never,
    { getOrCreatePreference: async () => ({ enabled: true }) } as never,
    { status: () => ({ configured: true }), findSubscription: async () => null } as never,
    {} as never,
    {} as never,
  );
  const settings = await service.settings(user, "project-1");
  assert.equal(settings.configurationStatus, "not_configured", "a locally confirmed subscription missing from SNS cannot remain confirmed");
  assert.equal(subscription.providerSubscriptionArn, null);
  assert.equal(subscription.confirmedAt, null);
}

async function verifyPublishMeansProviderAcceptance() {
  const adapter = new SnsNotificationAdapter({ get: (key: string, fallback?: string) => key === "NOTIFICATION_DELIVERY_ENABLED" ? "true" : key === "AWS_REGION" ? "us-east-1" : ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].includes(key) ? "configured-for-test" : fallback } as never);
  (adapter as any).client = () => ({ send: async (command: any) => command.constructor.name === "CreateTopicCommand"
    ? { TopicArn: "arn:aws:sns:us-east-1:123:deployguard-project-1-notifications" }
    : { MessageId: "provider-message" } });
  assert.deepEqual(
    await adapter.send(7, "project-1", "Lifecycle update", "Deployment completed"),
    { status: "published", messageId: "provider-message" },
    "SNS Publish acknowledgement must be represented as provider acceptance, not email delivery",
  );
}

async function verifyLegacyDeliveryHistoryIsPresentedHonestly() {
  const user: any = { id: 7, role: UserRole.DEVELOPER };
  const publishedAt = new Date("2026-09-08T12:00:00.000Z");
  const service = new NotificationsService(
    { findOne: async () => ({ id: "project-1", ownerUserId: user.id }) } as never,
    {} as never,
    { findOne: async () => null } as never,
    { find: async () => [{ id: "delivery-1", eventType: "deployment_succeeded", status: "sent", subject: "DeployGuard", attempts: 1, lastError: null, safeMetadata: {}, createdAt: publishedAt, publishedAt }] } as never,
    { getOrCreatePreference: async () => ({ enabled: true }) } as never,
    { status: () => ({ enabled: false, configured: false, mode: "disabled", region: "us-east-1" }) } as never,
    {} as never,
    {} as never,
  );
  const settings = await service.settings(user, "project-1");
  assert.equal(settings.deliveries[0].status, "published", "legacy sent rows are presented as SNS publication, not inbox delivery");
  assert.equal(settings.deliveries[0].publishedAt, publishedAt);
  assert.equal("sentAt" in settings.deliveries[0], false, "the public delivery history does not expose a misleading sent timestamp");
}

function lifecycleOperation(action: "deploy" | "rollback" | "destroy", status: PipelineRunStatus, releaseStrategy?: "direct_ecs" | "terraform_bootstrap") {
  return {
    id: `run-${action}-${releaseStrategy || "default"}`,
    projectId: "project-1",
    generationId: "generation-1",
    commitSha: "a".repeat(40),
    status,
    currentStage: status === PipelineRunStatus.FAILED ? "release_failed" : "release_complete",
    errorMessage: status === PipelineRunStatus.FAILED ? `${action} failed safely` : null,
    metadata: {
      deploymentAction: action,
      releaseStrategy,
      releaseEvidenceVerified: action !== "destroy" && status === PipelineRunStatus.COMPLETED,
      destroyEvidenceValidated: action === "destroy" && status === PipelineRunStatus.COMPLETED,
      failedStage: status === PipelineRunStatus.FAILED ? "release_failed" : null,
    },
  } as any;
}

async function verifyRailpackLifecycleMappingAndBestEffortBoundary() {
  const observed: Array<{ stage: string; status: string }> = [];
  const lifecycle: any = Object.create(RailpackDeploymentService.prototype);
  lifecycle.notifications = { dispatch: async (input: { stage: string; status: string }) => { observed.push({ stage: input.stage, status: input.status }); } };
  const cases = [
    ["deploy", undefined, "deploy"],
    ["deploy", "direct_ecs", "redeploy"],
    ["rollback", undefined, "rollback"],
    ["destroy", undefined, "destroy"],
  ] as const;
  for (const [action, strategy, expected] of cases) {
    await lifecycle.dispatchLifecycleNotification(lifecycleOperation(action, PipelineRunStatus.COMPLETED, strategy), "completed");
    await lifecycle.dispatchLifecycleNotification(lifecycleOperation(action, PipelineRunStatus.FAILED, strategy), "failed");
    assert.deepEqual(observed.slice(-2), [
      { stage: `${expected}_completed`, status: "completed" },
      { stage: `${expected}_failed`, status: "failed" },
    ], `${expected} emits success and failure through the existing dispatcher`);
  }
  const unverified = lifecycleOperation("deploy", PipelineRunStatus.COMPLETED);
  unverified.metadata.releaseEvidenceVerified = false;
  await lifecycle.dispatchLifecycleNotification(unverified, "completed");
  assert.equal(observed.length, 8, "GitHub success without authoritative release verification cannot emit lifecycle success");

  lifecycle.notifications = { dispatch: async () => { throw new Error("SNS unavailable"); } };
  const completed = lifecycleOperation("rollback", PipelineRunStatus.COMPLETED);
  await lifecycle.dispatchLifecycleNotification(completed, "completed");
  assert.equal(completed.status, PipelineRunStatus.COMPLETED, "notification failure cannot alter the authoritative lifecycle result");
}

async function verifyRailpackLifecyclePreferencesAndDeduplication() {
  async function scenario(options: { enabled: boolean; stageUpdatesEnabled: boolean; confirmed: boolean }) {
    let providerCalls = 0;
    const stored = new Map<string, Record<string, any>>();
    const dispatcher = new NotificationDispatcherService(
      { findOne: async () => ({ id: "project-1", ownerUserId: 7, name: "Project" }) } as never,
      { findOne: async () => ({ enabled: options.enabled, criticalEnabled: true, successEnabled: true, stageUpdatesEnabled: options.stageUpdatesEnabled }) } as never,
      { findOne: async () => options.confirmed ? ({ status: "confirmed" }) : null } as never,
      {
        findOne: async ({ where }: { where: { deduplicationKey: string } }) => stored.get(where.deduplicationKey) || null,
        create: (value: Record<string, unknown>) => ({ id: `delivery-${stored.size + 1}`, publishedAt: null, attempts: 0, ...value }),
        save: async (value: Record<string, any>) => { stored.set(String(value.deduplicationKey), value); return value; },
      } as never,
      { status: () => ({ configured: true }), send: async () => { providerCalls += 1; return { status: "published", messageId: `message-${providerCalls}` }; } } as never,
      { sanitize: (value: unknown) => String(value) } as never,
      { record: async () => undefined } as never,
    );
    const lifecycle: any = Object.create(RailpackDeploymentService.prototype);
    lifecycle.notifications = dispatcher;
    return { lifecycle, calls: () => providerCalls };
  }

  const enabled = await scenario({ enabled: true, stageUpdatesEnabled: true, confirmed: true });
  const completed = lifecycleOperation("deploy", PipelineRunStatus.COMPLETED);
  await enabled.lifecycle.dispatchLifecycleNotification(completed, "completed");
  await enabled.lifecycle.dispatchLifecycleNotification(completed, "completed");
  assert.equal(enabled.calls(), 1, "repeated reconciliation is deduplicated by the existing delivery key");
  await enabled.lifecycle.dispatchLifecycleNotification(lifecycleOperation("deploy", PipelineRunStatus.RUNNING), "started");
  assert.equal(enabled.calls(), 2, "enabled stage updates publish lifecycle start notifications");

  const disabled = await scenario({ enabled: false, stageUpdatesEnabled: true, confirmed: true });
  await disabled.lifecycle.dispatchLifecycleNotification(lifecycleOperation("deploy", PipelineRunStatus.COMPLETED), "completed");
  assert.equal(disabled.calls(), 0, "disabled notifications do not publish");

  const unsubscribed = await scenario({ enabled: true, stageUpdatesEnabled: true, confirmed: false });
  const rollback = lifecycleOperation("rollback", PipelineRunStatus.COMPLETED);
  await unsubscribed.lifecycle.dispatchLifecycleNotification(rollback, "completed");
  assert.equal(unsubscribed.calls(), 0, "unsubscribed notifications do not publish");
  assert.equal(rollback.status, PipelineRunStatus.COMPLETED, "unsubscribed notification handling leaves lifecycle success intact");

  const noStages = await scenario({ enabled: true, stageUpdatesEnabled: false, confirmed: true });
  await noStages.lifecycle.dispatchLifecycleNotification(lifecycleOperation("deploy", PipelineRunStatus.RUNNING), "started");
  assert.equal(noStages.calls(), 0, "start notifications obey stageUpdatesEnabled");
}

verifyProviderGate();
verifyIncompleteProviderIsUnavailable();
Promise.all([verifyDisabledProviderEndpointsDoNotThrow(), verifyUnconfirmedIsNotSent(), verifyRetryAndDeduplication(), verifyConcurrentInsertCollisionFailsClosed(), verifyPendingConfirmationCanBecomeConfirmed(), verifySubscribeDoesNotAssumeEmailConfirmation(), verifyProviderPendingOverridesStaleConfirmedArn(), verifySettingsReconcilePrematureConfirmation(), verifySettingsClearMissingProviderSubscription(), verifyPublishMeansProviderAcceptance(), verifyLegacyDeliveryHistoryIsPresentedHonestly(), verifyRailpackLifecycleMappingAndBestEffortBoundary(), verifyRailpackLifecyclePreferencesAndDeduplication()])
  .then(() => console.log("Notification provider gate, mapping, retry, and deduplication honesty passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
