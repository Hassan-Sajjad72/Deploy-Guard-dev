import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InactiveLegacyShadowInsertionAdapter } from "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter";
import { InactiveReleaseLaneShadowObserverService } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service";
import { ReleaseLaneShadowObservationInput } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.types";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const settle = () => new Promise<void>((resolvePromise) => setImmediate(resolvePromise));

async function main() {
  const observations: ReleaseLaneShadowObservationInput[] = [];
  const adapter = new InactiveLegacyShadowInsertionAdapter({
    observe: async (input: ReleaseLaneShadowObservationInput) => { observations.push(input); return { enabled: false }; },
  } as never);
  adapter.observeWorkerTerminalCompleted({ projectId, pipelineRunId: runId, bullmqJobId: "job-1" });
  adapter.observeWorkerTerminalCompleted({ projectId, pipelineRunId: runId, bullmqJobId: "job-1" });
  adapter.observeWorkerTerminalFailed({ projectId, pipelineRunId: runId, bullmqJobId: "job-2" });
  adapter.observeWorkerTerminalFailed({ projectId, pipelineRunId: runId, bullmqJobId: "job-2" });
  await settle();
  assert.deepEqual(observations.map((input) => [input.proposedLane, input.environmentName, input.operationClass, input.insertionSource, input.logicalOperationIdentity]), [
    ["legacy", "dev", "legacy_worker_terminal_success", "pipeline_worker.completed_persisted", `worker-terminal:${runId}:job-1:completed`],
    ["legacy", "dev", "legacy_worker_terminal_success", "pipeline_worker.completed_persisted", `worker-terminal:${runId}:job-1:completed`],
    ["legacy", "dev", "legacy_worker_terminal_failure", "pipeline_worker.failed_persisted", `worker-terminal:${runId}:job-2:failed`],
    ["legacy", "dev", "legacy_worker_terminal_failure", "pipeline_worker.failed_persisted", `worker-terminal:${runId}:job-2:failed`],
  ]);
  assert.equal(observations.every((input) => !/payload|repository|credential|cloud|error|runtime/i.test(JSON.stringify(input))), true);

  new InactiveLegacyShadowInsertionAdapter({ observe: () => { throw new Error("observer failure"); } } as never)
    .observeWorkerTerminalCompleted({ projectId, pipelineRunId: runId, bullmqJobId: "observer-failure" });
  new InactiveLegacyShadowInsertionAdapter({ observe: () => new Promise(() => undefined) } as never)
    .observeWorkerTerminalFailed({ projectId, pipelineRunId: runId, bullmqJobId: "observer-timeout" });
  await settle();

  const previousShadow = process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  let transactions = 0;
  const disabled = new InactiveLegacyShadowInsertionAdapter(new InactiveReleaseLaneShadowObserverService({
    transaction: () => { transactions += 1; throw new Error("must not read database"); },
  } as never));
  disabled.observeWorkerTerminalCompleted({ projectId, pipelineRunId: runId, bullmqJobId: "disabled" });
  await settle();
  assert.equal(transactions, 0, "disabled shadow mode must not access the database");
  if (previousShadow === undefined) delete process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE;
  else process.env.TWO_LANE_OWNERSHIP_SHADOW_MODE = previousShadow;

  const worker = readFileSync(resolve(__dirname, "../src/projects/pipeline/pipeline-worker.service.ts"), "utf8");
  const finality = readFileSync(resolve(__dirname, "../src/projects/pipeline/pipeline-job-finality.service.ts"), "utf8");
  const adapterSource = readFileSync(resolve(__dirname, "../src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts"), "utf8");
  assert.match(worker, /await this\.jobFinality\.recordCompleted\(/);
  assert.match(worker, /await this\.jobFinality\.recordFailedAfterRetriesExhausted\(/);
  assert.equal(worker.includes("observeWorkerTerminalCompleted"), false, "worker cannot observe before finality commits");
  assert.match(finality, /const result = await this\.record\(input, "completed"\)/);
  assert.match(finality, /this\.observeTerminalFinality\(result\)/);
  assert.equal(finality.indexOf("this.observeTerminalFinality(result)") > finality.indexOf("const result = await this.record(input, \"completed\")"), true);
  assert.equal(/InactiveReleaseLaneOwnershipService|InactiveReleaseLaneCorrelationService|\.acquire\(|\.renew\(|\.release\(/.test(adapterSource), false);
  console.log("Inactive legacy worker terminal shadow fixture verification passed");
}
void main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });
