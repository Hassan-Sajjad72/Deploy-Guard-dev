import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { NormalReleaseLaneExecutionService } from "../src/orchestration-contracts/release-lane/normal-release-lane-execution.service";

const projectId = "11111111-1111-4111-8111-111111111111";
const intentId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const infrastructureId = "44444444-4444-4444-8444-444444444444";
const outboxId = "55555555-5555-4555-8555-555555555555";
const user: any = { id: 7, role: "developer" };

const intent = {
  id: intentId,
  projectId,
  environmentName: "dev",
  classification: "release_only",
  status: "planned",
  releaseManifestId: releaseId,
  infrastructureManifestId: infrastructureId,
};
const release = {
  id: releaseId,
  projectId,
  environmentName: "dev",
  status: "desired",
  createdByIntentId: intentId,
  infrastructureManifestId: infrastructureId,
};
const outbox = {
  id: outboxId,
  intentId,
  status: "pending",
  attemptCount: 0,
  publishedAt: null,
  publishedJobId: null,
  claimedBy: null,
  claimExpiresAt: null,
};

function build(values: Record<string, unknown>, result: any = { status: "published" }, firstRelease = false) {
  const calls: any[] = [];
  const service = new NormalReleaseLaneExecutionService(
    new ConfigService(values),
    { dispatchExact: async (target: any) => { calls.push(target); return result; } } as any,
    { findOne: async () => ({ id: projectId, ownerUserId: user.id, environmentName: "dev" }) } as any,
    { find: async () => [intent] } as any,
    { findOne: async () => firstRelease
      ? { ...release, parentManifestId: null, previousStableManifestId: null }
      : release } as any,
    { findOne: async () => ({ id: infrastructureId, projectId, environmentName: "dev", status: "applied" }) } as any,
    { find: async () => [outbox] } as any,
  );
  return { service, calls };
}

void (async () => {
  const values = {
    TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED: "true",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
  };
  const disabled = build({ ...values, TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED: "false" });
  assert.deepEqual(await disabled.service.dispatch(user, projectId), {
    state: "disabled",
    safeCodes: ["NORMAL_RELEASE_LANE_EXECUTION_DISABLED"],
    fallbackToLegacy: false,
  });
  assert.equal(disabled.calls.length, 0);

  const ready = build(values);
  assert.deepEqual(await ready.service.dispatch(user, projectId), {
    state: "dispatched",
    safeCodes: ["RELEASE_LANE_OUTBOX_DISPATCHED"],
    fallbackToLegacy: false,
  });
  assert.deepEqual(ready.calls, [{ outboxId, intentId, projectId, environmentName: "dev" }]);

  const firstDisabled = build(values, { status: "published" }, true);
  assert.deepEqual(await firstDisabled.service.dispatch(user, projectId), {
    state: "blocked",
    safeCodes: ["NORMAL_MANAGED_FIRST_RELEASE_EXECUTION_DISABLED"],
    fallbackToLegacy: false,
  });
  assert.equal(firstDisabled.calls.length, 0);
  const firstEnabled = build({
    ...values,
    TWO_LANE_NORMAL_MANAGED_FIRST_RELEASE_EXECUTION_ENABLED: "true",
  }, { status: "published" }, true);
  assert.equal((await firstEnabled.service.dispatch(user, projectId)).state, "dispatched");
  assert.equal(firstEnabled.calls.length, 1);

  const blockedWorker = build(values, { status: "blocked", reason: "WORKER_PROTOCOL_UNAVAILABLE" });
  assert.deepEqual(await blockedWorker.service.dispatch(user, projectId), {
    state: "blocked",
    safeCodes: ["WORKER_PROTOCOL_UNAVAILABLE"],
    fallbackToLegacy: false,
  });

  const terminal = new NormalReleaseLaneExecutionService(
    new ConfigService(values),
    { dispatchExact: async () => { throw new Error("must not dispatch terminal outbox"); } } as any,
    { findOne: async () => ({ id: projectId, ownerUserId: user.id, environmentName: "dev" }) } as any,
    { find: async () => [intent] } as any,
    { findOne: async () => release } as any,
    { findOne: async () => ({ id: infrastructureId }) } as any,
    { find: async () => [{ ...outbox, status: "dead_letter" }] } as any,
  );
  assert.deepEqual(await terminal.dispatch(user, projectId), {
    state: "blocked",
    safeCodes: ["NORMAL_RELEASE_LANE_OUTBOX_NOT_DISPATCHABLE"],
    fallbackToLegacy: false,
  });

  const source = readFileSync(join(__dirname, "../src/orchestration-contracts/release-lane/normal-release-lane-execution.service.ts"), "utf8");
  const controller = readFileSync(join(__dirname, "../src/projects/projects.controller.ts"), "utf8");
  const appModule = readFileSync(join(__dirname, "../src/app.module.ts"), "utf8");
  assert.match(controller, /@Post\(":projectId\/release-lane\/dispatch"\)/);
  assert.match(controller, /normalReleaseLaneExecution\.dispatch/);
  assert.match(appModule, /api\/projects\/:projectId\/release-lane\/dispatch/);
  assert.match(source, /dispatcher\.dispatchExact/);
  assert.doesNotMatch(source, /OneShotRunner|InactiveV1BullMqConsumerService|PipelineService|TerraformRunnerService|ECSClient|Docker/);
  console.log("Normal release-lane execution bridge verification passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
