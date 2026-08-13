import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PipelineJobFinalityService } from "../src/projects/pipeline/pipeline-job-finality.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";

function harness(options: { enabled?: boolean; runStatus?: PipelineRunStatus; eventStatus?: string; existingDecision?: string; transactionError?: boolean } = {}) {
  const rows: Record<string, unknown>[] = [];
  let transactions = 0;
  const finalities = {
    findOne: async () => options.existingDecision ? { decision: options.existingDecision } : rows[0] || null,
    create: (value: Record<string, unknown>) => value,
    insert: async (value: Record<string, unknown>) => { rows.push(value); },
  };
  const manager = {
    getRepository: (entity: { name: string }) => {
      if (entity.name === "ProjectPipelineJobFinality") return finalities;
      if (entity.name === "ProjectPipelineRun") return { findOne: async () => ({ id: runId, projectId, status: options.runStatus || PipelineRunStatus.COMPLETED, completedAt: new Date(1), failedAt: new Date(1) }) };
      return { findOne: async () => options.eventStatus === null ? null : ({ id: "event", status: options.eventStatus || "success", occurredAt: new Date(2) }) };
    },
  };
  const dataSource = {
    transaction: async (_level: unknown, callback: (manager: unknown) => Promise<unknown>) => {
      transactions += 1;
      if (options.transactionError) throw new Error("unavailable");
      return callback(manager);
    },
  };
  const service = new PipelineJobFinalityService(
    dataSource as never,
    { get: () => options.enabled ? "true" : undefined } as never,
    finalities as never,
  );
  return { service, rows, transactions: () => transactions };
}

async function main() {
  const disabled = harness();
  assert.deepEqual(await disabled.service.recordCompleted({ pipelineRunId: runId, bullmqJobId: "123" }), { enabled: false });
  assert.equal(disabled.transactions(), 0, "disabled mode must not access persistence");

  const completed = harness({ enabled: true });
  assert.equal((await completed.service.recordCompleted({ pipelineRunId: runId, bullmqJobId: "123" }) as any).disposition, "recorded");
  assert.equal(completed.rows.length, 1);
  assert.deepEqual(Object.keys(completed.rows[0]).sort(), ["bullmqJobId", "decision", "evidenceHash", "pipelineRunId", "projectId"].sort());
  assert.equal(JSON.stringify(completed.rows[0]).includes("payload"), false);

  const replay = harness({ enabled: true, existingDecision: "completed" });
  assert.equal((await replay.service.recordCompleted({ pipelineRunId: runId, bullmqJobId: "123" }) as any).disposition, "already_recorded");
  const conflict = harness({ enabled: true, existingDecision: "failed_after_retries_exhausted" });
  await assert.rejects(() => conflict.service.recordCompleted({ pipelineRunId: runId, bullmqJobId: "123" }), /finality_conflict/);

  const retrying = harness({ enabled: true, runStatus: PipelineRunStatus.FAILED, eventStatus: "failed" });
  assert.equal((await retrying.service.recordFailedAfterRetriesExhausted({ pipelineRunId: runId, bullmqJobId: "retry-1", queueState: "failed", attemptsMade: 1, configuredAttempts: 2 }) as any).disposition, "not_eligible");
  assert.equal(retrying.transactions(), 0, "a remaining retry must not query or write evidence");
  assert.equal((await retrying.service.recordFailedAfterRetriesExhausted({ pipelineRunId: runId, bullmqJobId: "retry-1", queueState: "failed", attemptsMade: 2, configuredAttempts: 2 }) as any).disposition, "recorded");

  const cancelled = harness({ enabled: true, runStatus: PipelineRunStatus.CANCELLED });
  assert.equal((await cancelled.service.recordCompleted({ pipelineRunId: runId, bullmqJobId: "cancelled-1" }) as any).disposition, "not_eligible");
  const safe = harness({ enabled: true, transactionError: true });
  await safe.service.recordCompletedSafely({ pipelineRunId: runId, bullmqJobId: "safe-1" });

  const worker = readFileSync(resolve(__dirname, "../src/projects/pipeline/pipeline-worker.service.ts"), "utf8");
  const service = readFileSync(resolve(__dirname, "../src/projects/pipeline/pipeline-job-finality.service.ts"), "utf8");
  assert.match(worker, /worker\.on\("completed"/);
  assert.match(worker, /worker\.on\("failed"/);
  assert.match(worker, /await job\.getState\(\)/);
  assert.match(service, /LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED/);
  assert.match(service, /private observeTerminalFinality/);
  assert.equal(service.indexOf("this.observeTerminalFinality(result)") > service.indexOf("const result = await this.record(input, \"completed\")"), true);
  console.log("Pipeline job finality evidence fixture verification passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
