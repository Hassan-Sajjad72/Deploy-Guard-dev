import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InactiveLegacyShadowInsertionAdapter } from "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter";
import { InactiveReleaseLaneShadowObserverService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service";
import { ReleaseLaneShadowObservationInput } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.types";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { PipelineService } from "../src/projects/pipeline/pipeline.service";

const projectId = "11111111-1111-4111-8111-111111111111";
const user = { id: 7 };
const settle = () => new Promise<void>((done) => setImmediate(done));

type HarnessOptions = {
  status: PipelineRunStatus;
  observer?: { observe(input: ReleaseLaneShadowObservationInput): Promise<unknown> | unknown };
  shadow?: InactiveLegacyShadowInsertionAdapter;
};

function harness(options: HarnessOptions) {
  const observations: ReleaseLaneShadowObservationInput[] = [];
  const removed: string[] = [];
  const run = {
    id: "22222222-2222-4222-8222-222222222222", projectId, status: options.status,
    currentStage: "queued", metadata: { safe: true }, createdAt: new Date(), updatedAt: new Date(),
  } as Record<string, unknown>;
  const shadow = options.shadow ?? new InactiveLegacyShadowInsertionAdapter((options.observer ?? {
    observe: async (input: ReleaseLaneShadowObservationInput) => { observations.push(input); },
  }) as never);
  const service = new PipelineService(
    {
      findOne: async () => run,
      save: async (value: unknown) => value,
    } as never,
    { create: (value: unknown) => value, save: async () => undefined } as never,
    {} as never,
    {} as never,
    {
      getJobs: async () => [{ data: { pipelineRunId: run.id }, remove: async () => removed.push(String(run.id)) }],
    } as never,
    { getProjectEntityForManage: async () => ({ id: projectId }) } as never,
    { record: async () => undefined } as never,
    { sanitize: (value: unknown) => String(value || ""), sanitizeMetadata: (value: Record<string, unknown>) => value } as never,
    { recordUserAction: async () => undefined } as never,
    {} as never,
    {} as never,
    shadow,
  );
  return { service, run, observations, removed };
}

async function main() {
  for (const status of [
    PipelineRunStatus.QUEUED,
    PipelineRunStatus.WAITING_FOR_COST_APPROVAL,
    PipelineRunStatus.APPLY_DISABLED,
    PipelineRunStatus.RUNNING,
  ]) {
    const current = harness({ status });
    const response = await current.service.cancelRun(user as never, projectId, String(current.run.id));
    await settle();
    assert.equal(response.status, PipelineRunStatus.CANCELLED);
    assert.deepEqual(current.observations.map((input) => [input.proposedLane, input.environmentName, input.operationClass, input.insertionSource, input.logicalOperationIdentity]), [
      ["legacy", "dev", "legacy_cancel", "pipeline_service.cancel_persisted", `cancel:${current.run.id}:cancelled`],
    ]);
    assert.equal(current.removed.length, 1, "shadow observation must not change queued-job removal");
  }

  const terminal = harness({ status: PipelineRunStatus.FAILED });
  await assert.rejects(() => terminal.service.cancelRun(user as never, projectId, String(terminal.run.id)), /cannot be cancelled/);
  await settle();
  assert.equal(terminal.observations.length, 0, "terminal rejection must not observe");

  const observerFailure = harness({ status: PipelineRunStatus.QUEUED, observer: { observe: () => { throw new Error("observer failure"); } } });
  await observerFailure.service.cancelRun(user as never, projectId, String(observerFailure.run.id));
  assert.equal(observerFailure.removed.length, 1);
  const observerTimeout = harness({ status: PipelineRunStatus.QUEUED, observer: { observe: () => new Promise(() => undefined) } });
  await observerTimeout.service.cancelRun(user as never, projectId, String(observerTimeout.run.id));
  assert.equal(observerTimeout.removed.length, 1);

  const previousMode = process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  let transactionCalls = 0;
  const disabledShadow = new InactiveLegacyShadowInsertionAdapter(new InactiveReleaseLaneShadowObserverService({
    transaction: () => { transactionCalls += 1; throw new Error("database must not be read"); },
  } as never));
  const disabled = harness({ status: PipelineRunStatus.QUEUED, shadow: disabledShadow });
  await disabled.service.cancelRun(user as never, projectId, String(disabled.run.id));
  await settle();
  assert.equal(transactionCalls, 0);
  if (previousMode === undefined) delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  else process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE = previousMode;

  const replayed: ReleaseLaneShadowObservationInput[] = [];
  const adapter = new InactiveLegacyShadowInsertionAdapter({ observe: async (input: ReleaseLaneShadowObservationInput) => { replayed.push(input); } } as never);
  adapter.observeCancellationPersisted({ projectId, pipelineRunId: "same-run" });
  adapter.observeCancellationPersisted({ projectId, pipelineRunId: "same-run" });
  await settle();
  assert.equal(replayed[0].logicalOperationIdentity, "cancel:same-run:cancelled");
  assert.equal(replayed[0].logicalOperationIdentity, replayed[1].logicalOperationIdentity);

  const pipelineSource = readFileSync(resolve(__dirname, "../src/projects/pipeline/pipeline.service.ts"), "utf8");
  const adapterSource = readFileSync(resolve(__dirname, "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts"), "utf8");
  const workerSource = readFileSync(resolve(__dirname, "../src/projects/pipeline/pipeline-worker.service.ts"), "utf8");
  const savedRunIndex = pipelineSource.indexOf("const savedRun = await this.runRepository.save(run)");
  const cancellationObservationIndex = pipelineSource.indexOf("observeCancellationPersisted", savedRunIndex);
  assert.equal(cancellationObservationIndex > savedRunIndex, true);
  assert.equal(cancellationObservationIndex < pipelineSource.indexOf("await this.eventRepository.save", savedRunIndex), true);
  assert.equal(/InactiveReleaseLaneOwnershipService|InactiveReleaseLaneCorrelationService|\.acquire\(|\.renew\(|\.release\(/.test(adapterSource), false);
  assert.equal(workerSource.includes("observeCancellationPersisted"), false);
  console.log("Inactive legacy cancellation shadow insertion verification passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
