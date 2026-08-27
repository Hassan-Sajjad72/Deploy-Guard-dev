import { strict as assert } from "node:assert";
import { Queue, Worker } from "bullmq";

const suffix = `${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
const queueName = `session8_13_finality_${suffix}`;
const connection = { host: process.env.REDIS_HOST || "127.0.0.1", port: Number(process.env.REDIS_PORT || "6379") };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const queue = new Queue(queueName, { connection });
  const failures: Array<{ id: string; state: string; attemptsMade: number; attempts: number }> = [];
  const calls = new Map<string, number>();
  const worker = new Worker(queueName, async (job) => {
    const count = (calls.get(job.name) || 0) + 1;
    calls.set(job.name, count);
    if (job.name === "retry-then-success" && count === 1) throw new Error("fixture");
    if (job.name === "retry-exhausted") throw new Error("fixture");
    return "ok";
  }, { connection, concurrency: 1 });
  worker.on("failed", async (job) => {
    if (!job) return;
    failures.push({ id: String(job.id), state: await job.getState(), attemptsMade: job.attemptsMade, attempts: Number(job.opts.attempts || 1) });
  });
  try {
    const success = await queue.add("one-attempt-success", {}, { attempts: 1 });
    const retrySuccess = await queue.add("retry-then-success", {}, { attempts: 2, backoff: { type: "fixed", delay: 25 } });
    const exhausted = await queue.add("retry-exhausted", {}, { attempts: 2, backoff: { type: "fixed", delay: 25 } });
    for (let i = 0; i < 160; i += 1) {
      const [a, b, c] = await Promise.all([success.getState(), retrySuccess.getState(), exhausted.getState()]);
      if (a === "completed" && b === "completed" && c === "failed" && failures.length >= 3) break;
      await wait(25);
    }
    assert.equal(await success.getState(), "completed");
    assert.equal(await retrySuccess.getState(), "completed");
    assert.equal(await exhausted.getState(), "failed");
    const retryFailure = failures.find((row) => row.id === String(retrySuccess.id));
    assert.deepEqual(retryFailure && [retryFailure.state, retryFailure.attemptsMade, retryFailure.attempts], ["delayed", 1, 2]);
    const exhaustedFailures = failures.filter((row) => row.id === String(exhausted.id));
    assert.deepEqual(exhaustedFailures.map((row) => [row.state, row.attemptsMade, row.attempts]), [["delayed", 1, 2], ["failed", 2, 2]]);
    console.log("BullMQ 5.79.2 retry/finality semantics verification passed");
  } finally {
    await worker.close();
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
  }
}
void main().catch((error) => { console.error(error instanceof Error ? error.stack || error.message : String(error)); process.exitCode = 1; });
