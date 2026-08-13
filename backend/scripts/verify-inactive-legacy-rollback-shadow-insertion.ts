import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InactiveLegacyShadowInsertionAdapter } from "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter";
import { InactiveReleaseLaneShadowObserverService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service";
import { ReleaseLaneShadowObservationInput } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.types";
import { RollbackService } from "../src/orchestration/rollback.service";

const projectId = "11111111-1111-4111-8111-111111111111";
const pipelineRunId = "22222222-2222-4222-8222-222222222222";
const settle = () => new Promise<void>((done) => setImmediate(done));

type HarnessOptions = {
  ecsError?: Error;
  recordSaveError?: Error;
  observer?: { observe(input: ReleaseLaneShadowObservationInput): Promise<unknown> | unknown };
  shadow?: InactiveLegacyShadowInsertionAdapter;
};

function harness(options: HarnessOptions = {}) {
  const observations: ReleaseLaneShadowObservationInput[] = [];
  const savedRecords: Array<Record<string, unknown>> = [];
  let recordNumber = 0;
  let ecsUpdates = 0;
  const deployment = {
    id: "33333333-3333-4333-8333-333333333333", projectId, pipelineRunId,
    commitSha: "candidate", taskDefinitionArn: "candidate-task", ecsServiceArn: "service",
    metadata: {}, stable: false,
  } as Record<string, unknown>;
  const target = {
    id: "44444444-4444-4444-8444-444444444444", projectId, commitSha: "stable",
    shortCommitSha: "stable", imageUri: "registry@sha256:abc", taskDefinitionArn: "stable-task",
  } as Record<string, unknown>;
  const shadow = options.shadow ?? new InactiveLegacyShadowInsertionAdapter((options.observer ?? {
    observe: async (input: ReleaseLaneShadowObservationInput) => { observations.push(input); },
  }) as never);
  const rollbackRepository = {
    create: (value: Record<string, unknown>) => value,
    save: async (value: Record<string, unknown>) => {
      if (options.recordSaveError && recordNumber === 0) throw options.recordSaveError;
      if (!value.id) value.id = `55555555-5555-4555-8555-${String(++recordNumber).padStart(12, "0")}`;
      savedRecords.push(value);
      return value;
    },
  };
  const service = new RollbackService(
    { findOne: async () => deployment, save: async (value: unknown) => value } as never,
    { findOne: async () => target, update: async () => undefined, save: async (value: unknown) => value } as never,
    rollbackRepository as never,
    { create: (value: unknown) => value, save: async () => undefined } as never,
    {
      updateServiceToTaskDefinition: async () => {
        ecsUpdates += 1;
        if (options.ecsError) throw options.ecsError;
      },
      waitForServiceStability: async () => ({ stable: true }),
    } as never,
    { waitForHealthyTargets: async () => ({ healthy: true }) } as never,
    { record: async () => undefined } as never,
    shadow,
  );
  return { service, observations, savedRecords, getEcsUpdates: () => ecsUpdates };
}

function compact(inputs: ReleaseLaneShadowObservationInput[]) {
  return inputs.map((input) => [input.proposedLane, input.environmentName, input.operationClass, input.insertionSource, input.logicalOperationIdentity]);
}

async function main() {
  const manual = harness();
  await manual.service.rollbackToPreviousStable(projectId, null);
  await settle();
  assert.deepEqual(compact(manual.observations), [
    ["legacy", "dev", "legacy_rollback", "rollback_service.record_created", "rollback-request:55555555-5555-4555-8555-000000000001"],
    ["legacy", "dev", "legacy_rollback", "rollback_service.before_ecs_update", "rollback-mutation:55555555-5555-4555-8555-000000000001"],
    ["legacy", "dev", "legacy_rollback", "rollback_service.terminal_succeeded", "rollback-terminal:55555555-5555-4555-8555-000000000001:succeeded"],
  ]);
  assert.equal(manual.getEcsUpdates(), 1);

  const automatic = harness();
  await automatic.service.rollbackToPreviousStable(projectId, pipelineRunId);
  await settle();
  assert.equal(automatic.observations.length, 3);
  assert.equal(automatic.observations.every((entry) => entry.operationClass === "legacy_rollback" && entry.projectId === projectId && entry.environmentName === "dev"), true);
  assert.equal(automatic.observations.some((entry) => entry.logicalOperationIdentity.includes(pipelineRunId)), false);

  const failedEcs = new Error("ecs failure");
  const failure = harness({ ecsError: failedEcs });
  await assert.rejects(() => failure.service.rollbackToPreviousStable(projectId, pipelineRunId), (error) => error === failedEcs);
  await settle();
  assert.deepEqual(failure.observations.map((entry) => entry.insertionSource), [
    "rollback_service.record_created", "rollback_service.before_ecs_update", "rollback_service.terminal_failed",
  ]);
  assert.equal(failure.savedRecords.at(-1)?.status, "failed");

  const recordFailure = new Error("record persistence failed");
  const beforeRecord = harness({ recordSaveError: recordFailure });
  await assert.rejects(() => beforeRecord.service.rollbackToPreviousStable(projectId), (error) => error === recordFailure);
  await settle();
  assert.equal(beforeRecord.observations.length, 0);
  assert.equal(beforeRecord.getEcsUpdates(), 0);

  const observerFailure = harness({ observer: { observe: () => { throw new Error("observer unavailable"); } } });
  await observerFailure.service.rollbackToPreviousStable(projectId);
  assert.equal(observerFailure.getEcsUpdates(), 1);
  const observerTimeout = harness({ observer: { observe: () => new Promise(() => undefined) } });
  await observerTimeout.service.rollbackToPreviousStable(projectId);
  assert.equal(observerTimeout.getEcsUpdates(), 1);

  const priorMode = process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  let transactionCalls = 0;
  const disabledShadow = new InactiveLegacyShadowInsertionAdapter(new InactiveReleaseLaneShadowObserverService({
    transaction: () => { transactionCalls += 1; throw new Error("database must not be read"); },
  } as never));
  const disabled = harness({ shadow: disabledShadow });
  await disabled.service.rollbackToPreviousStable(projectId);
  await settle();
  assert.equal(transactionCalls, 0);
  if (priorMode === undefined) delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  else process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE = priorMode;

  const adapter = new InactiveLegacyShadowInsertionAdapter({
    observe: async (input: ReleaseLaneShadowObservationInput) => { manual.observations.push(input); },
  } as never);
  adapter.observeRollbackRecordCreated({ projectId, rollbackRecordId: "same-record" });
  adapter.observeRollbackRecordCreated({ projectId, rollbackRecordId: "same-record" });
  await settle();
  assert.equal(manual.observations.at(-1)?.logicalOperationIdentity, "rollback-request:same-record");

  const rollbackSource = readFileSync(resolve(__dirname, "../src/orchestration/rollback.service.ts"), "utf8");
  const adapterSource = readFileSync(resolve(__dirname, "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts"), "utf8");
  const orchestrationSource = readFileSync(resolve(__dirname, "../src/orchestration/orchestration.service.ts"), "utf8");
  const workerSource = readFileSync(resolve(__dirname, "../src/projects/pipeline/pipeline-worker.service.ts"), "utf8");
  assert.equal(rollbackSource.indexOf("observeRollbackRecordCreated") > rollbackSource.indexOf("const record = await this.rollbackRepository.save"), true);
  assert.equal(rollbackSource.indexOf("observeRollbackBeforeEcsUpdate") < rollbackSource.indexOf("await this.ecsService.updateServiceToTaskDefinition"), true);
  assert.equal(rollbackSource.indexOf("observeRollbackSucceeded") > rollbackSource.indexOf("await this.releaseRepository.save(target)"), true);
  assert.equal(rollbackSource.indexOf("observeRollbackFailed") > rollbackSource.indexOf("await this.rollbackRepository.save(record)"), true);
  assert.equal(/InactiveReleaseLaneOwnershipService|InactiveReleaseLaneCorrelationService|\.acquire\(|\.renew\(|\.release\(/.test(adapterSource), false);
  assert.equal(orchestrationSource.includes("observeRollback"), false);
  assert.equal(workerSource.includes("observeRollback"), false);
  console.log("Inactive legacy rollback shadow insertion verification passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
