import { strict as assert } from "node:assert";
import { NotificationDispatcherService } from "../src/notifications/notification-dispatcher.service";
const service = Object.create(NotificationDispatcherService.prototype) as NotificationDispatcherService;
assert.deepEqual(service.classify("docker_build", "failed"), { type: "deployment_failed", kind: "critical" });
assert.deepEqual(service.classify("security_gate", "blocked"), { type: "security_policy_block", kind: "critical" });
assert.deepEqual(service.classify("dockerfile_security_check_failed", "failed"), { type: "security_policy_block", kind: "critical" });
assert.deepEqual(service.classify("stable_release", "completed"), { type: "deployment_succeeded", kind: "success" });
assert.deepEqual(service.classify("infrastructure_destroy", "failed"), { type: "destroy_failed", kind: "critical" });
assert.deepEqual(service.classify("rollback", "started"), { type: "rollback_started", kind: "stage" });

async function verifyUnconfirmedIsNotSent() {
  let providerCalls = 0;
  const deliveryRepo = {
    findOne: async () => null,
    create: (value: Record<string, unknown>) => ({ id: "delivery-1", sentAt: null, attempts: 0, ...value }),
    save: async (value: Record<string, unknown>) => value,
  };
  const dispatcher = new NotificationDispatcherService(
    { findOne: async () => ({ id: "project-1", ownerUserId: 7, name: "Project" }) } as never,
    { findOne: async () => ({ criticalEnabled: true, successEnabled: true, stageUpdatesEnabled: true }) } as never,
    { findOne: async () => null } as never,
    deliveryRepo as never,
    { status: () => ({ configured: true }), send: async () => { providerCalls += 1; return { status: "sent" }; } } as never,
    { planForUser: async () => "pro", consume: async () => undefined } as never,
    { sanitize: (value: unknown) => String(value) } as never,
    { record: async () => undefined } as never
  );
  const delivery = await dispatcher.dispatch({ projectId: "project-1", pipelineRunId: "run-1", stage: "docker_build", status: "failed", message: "Build failed" });
  assert.equal(delivery?.status, "skipped_unconfirmed");
  assert.equal(delivery?.sentAt, null);
  assert.equal(providerCalls, 0);
}

verifyUnconfirmedIsNotSent()
  .then(() => console.log("Notification mapping and unconfirmed-delivery honesty passed"))
  .catch((error) => { console.error(error); process.exitCode = 1; });
