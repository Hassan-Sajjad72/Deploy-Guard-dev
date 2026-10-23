import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { NormalReleaseLaneStatusService } from "../src/orchestration-contracts/release-lane/normal-release-lane-status.service";

const projectId = "11111111-1111-4111-8111-111111111111";
const intentId = "22222222-2222-4222-8222-222222222222";
const infrastructureId = "33333333-3333-4333-8333-333333333333";
const releaseId = "44444444-4444-4444-8444-444444444444";
const user: any = { id: 7, role: "developer" };

function service(status = "planned", options: { enabled?: boolean; malformed?: boolean; missing?: boolean } = {}) {
  let reads = 0;
  const enqueued = ["enqueued", "running", "completed", "failed", "cancelled"].includes(status);
  const started = ["running", "completed", "failed", "cancelled"].includes(status);
  const terminal = ["completed", "failed", "cancelled", "rejected"].includes(status);
  const intent = options.missing ? null : {
    id: intentId, projectId, environmentName: "dev", classification: "release_only", status,
    releaseManifestId: releaseId, infrastructureManifestId: infrastructureId,
    receivedAt: new Date("2026-07-27T00:00:00.000Z"),
    plannedAt: new Date("2026-07-27T00:01:00.000Z"),
    enqueuedAt: enqueued ? new Date("2026-07-27T00:02:00.000Z") : null,
    startedAt: started ? new Date("2026-07-27T00:03:00.000Z") : null,
    completedAt: terminal ? new Date("2026-07-27T00:04:00.000Z") : null,
    updatedAt: new Date("2026-07-27T00:04:00.000Z"),
  };
  const instance = new NormalReleaseLaneStatusService(
    new ConfigService({
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: options.enabled === false ? "false" : "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    }),
    { findOne: async () => { reads += 1; return { id: projectId, ownerUserId: user.id, environmentName: "dev", visibility: "private" }; } } as any,
    { findOne: async () => { reads += 1; return intent; } } as any,
    { findOne: async () => { reads += 1; return options.malformed ? null : { id: releaseId, projectId, environmentName: "dev", revision: "3", infrastructureManifestId: infrastructureId, commitSha: "1234567890abcdef1234567890abcdef12345678", updatedAt: new Date("2026-07-27T00:01:00.000Z") }; } } as any,
    { findOne: async () => { reads += 1; return options.malformed ? null : { id: infrastructureId, projectId, environmentName: "dev", revision: "4", status: "applied" }; } } as any,
    { findOne: async () => { reads += 1; return status === "planned" ? { status: "pending", createdAt: new Date("2026-07-27T00:01:00.000Z"), updatedAt: new Date("2026-07-27T00:02:00.000Z") } : null; } } as any,
  );
  return { instance, reads: () => reads };
}

void (async () => {
  const disabled = service("planned", { enabled: false });
  assert.deepEqual(await disabled.instance.get(user, projectId), { state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_DISABLED"] });
  assert.equal(disabled.reads(), 1);

  const outOfScope = new NormalReleaseLaneStatusService(
    new ConfigService({
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: "99999999-9999-4999-8999-999999999999",
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    }),
    { findOne: async () => ({ id: projectId, ownerUserId: user.id, environmentName: "dev", visibility: "private" }) } as any,
    {} as any, {} as any, {} as any, {} as any,
  );
  assert.deepEqual(await outOfScope.get(user, projectId), { state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_STATUS_DISABLED"] });

  const prepared = service();
  const result = await prepared.instance.get(user, projectId);
  assert.equal(result.state, "prepared");
  assert.equal(result.intent?.outboxStatus, "pending");
  assert.equal(result.intent?.safeId, intentId.slice(0, 8));
  assert.equal(result.intent?.releaseManifestRevision, "3");
  assert.equal(result.intent?.appliedInfrastructureRevision, "4");
  assert.equal(result.intent?.sourceCommitShortSha, "1234567890ab");
  assert.equal(result.intent?.lifecycleCode, "RELEASE_LANE_INTENT_PREPARED");
  assert.equal(result.intent?.lastMeaningfulAt, "2026-07-27T00:04:00.000Z");
  assert.deepEqual(result.intent?.events, [{ kind: "prepared", code: "RELEASE_LANE_INTENT_PREPARED", occurredAt: "2026-07-27T00:01:00.000Z" }]);

  assert.equal((await service("cancelled").instance.get(user, projectId)).state, "cancelled");
  const completed = await service("completed").instance.get(user, projectId);
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.intent?.events.map((event) => event.kind), ["prepared", "queued", "running", "completed"]);
  assert.equal(completed.intent?.events.length <= 4, true);
  const completedEvents = (completed as any).intent.events;
  assert.deepEqual(completedEvents.map((event: any) => event.occurredAt), completedEvents.map((event: any) => event.occurredAt).sort());
  assert.equal((await service("planned", { malformed: true }).instance.get(user, projectId)).state, "blocked");
  const blocked = await service("failed").instance.get(user, projectId);
  assert.equal(blocked.state, "blocked");
  assert.equal((blocked as any).intent.events.at(-1).kind, "blocked");
  assert.equal((blocked as any).intent.events.at(-1).code, "NORMAL_RELEASE_LANE_STATUS_BLOCKED");
  assert.equal((await service("planned", { missing: true }).instance.get(user, projectId)).state, "missing");

  const forbidden = new NormalReleaseLaneStatusService(
    new ConfigService({
      TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
      TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
      TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    }),
    { findOne: async () => ({ id: projectId, ownerUserId: 99, environmentName: "dev", visibility: "private" }) } as any,
    {} as any, {} as any, {} as any, {} as any,
  );
  await assert.rejects(() => forbidden.get(user, projectId), /Insufficient permissions/);

  const source = readFileSync(join(__dirname, "../src/orchestration-contracts/release-lane/normal-release-lane-status.service.ts"), "utf8");
  assert.doesNotMatch(source, /DurableOutboxDispatcherService|InactiveV1BullMqConsumerService|PipelineService|TerraformRunnerService|ECSClient/);
  assert.doesNotMatch(source, /\bid:\s*intent\.id/);
  assert.match(source, /RELEASE_LANE_EVENT_LIMIT = 4/);
  assert.match(source, /events\(intent, outbox, state\.value, state\.safeCode\)/);
  assert.doesNotMatch(source, /events\([\s\S]*release\?\.createdAt/);
  assert.doesNotMatch(source, /ProjectOperationLease|SideEffectJournal|fencing/i);
  console.log("Normal release-lane status verification passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
