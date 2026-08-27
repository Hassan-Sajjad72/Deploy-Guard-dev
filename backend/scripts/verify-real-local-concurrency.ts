import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { Queue, QueueEvents, Worker } from "bullmq";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";
import { resolveBackendEnvFile } from "../src/config/backend-env-file";

loadEnv({ path: resolveBackendEnvFile() });

const postgres = () => new Client({
  host: process.env.DATABASE_HOST || process.env.DB_HOST || "localhost",
  port: Number(process.env.DATABASE_PORT || process.env.DB_PORT || "5433"),
  user: process.env.DATABASE_USERNAME || process.env.DB_USERNAME || "mini_paas_user",
  password: process.env.DATABASE_PASSWORD || process.env.DB_PASSWORD || "mini_paas_password",
  database: process.env.DATABASE_NAME || process.env.DB_NAME || "mini_paas",
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined,
});

const redis = {
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  maxRetriesPerRequest: null,
};

async function verifyPostgres() {
  const first = postgres();
  const second = postgres();
  await Promise.all([first.connect(), second.connect()]);
  try {
    const lockKey = `deployguard:local-proof:${process.pid}:${Date.now()}`;
    await first.query("BEGIN");
    await first.query("SELECT pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    await second.query("BEGIN");
    const blocked = await second.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
      [lockKey],
    );
    assert.equal(blocked.rows[0].acquired, false, "second connection must not acquire the held configuration/apply lock");
    await first.query("ROLLBACK");
    const acquired = await second.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired",
      [lockKey],
    );
    assert.equal(acquired.rows[0].acquired, true, "lock must become available after rollback");
    await second.query("ROLLBACK");

    await first.query("CREATE TEMP TABLE deployguard_rollback_proof (value text) ON COMMIT PRESERVE ROWS");
    await first.query("BEGIN");
    await first.query("INSERT INTO deployguard_rollback_proof(value) VALUES ('must_rollback')");
    await first.query("ROLLBACK");
    const rolledBack = await first.query<{ count: string }>("SELECT count(*)::text AS count FROM deployguard_rollback_proof");
    assert.equal(rolledBack.rows[0].count, "0", "transaction rollback must remove the uncommitted apply-claim evidence");
  } finally {
    await Promise.allSettled([first.end(), second.end()]);
  }
}

async function verifyRedis() {
  const name = `deployguard-local-proof-${process.pid}-${Date.now()}`;
  const queue = new Queue(name, { connection: redis });
  const events = new QueueEvents(name, { connection: redis });
  await events.waitUntilReady();
  let executorCalls = 0;
  let worker = new Worker(
    name,
    async () => {
      executorCalls += 1;
      return "completed";
    },
    { connection: redis, concurrency: 1 },
  );
  try {
    const first = await queue.add("apply", { runId: "run-local" }, { jobId: "exact-approved-plan" });
    const duplicate = await queue.add("apply", { runId: "run-local" }, { jobId: "exact-approved-plan" });
    assert.equal(first.id, duplicate.id, "BullMQ duplicate delivery must reuse the idempotency key");
    await first.waitUntilFinished(events, 10_000);
    assert.equal(executorCalls, 1);

    await worker.close();
    const restartJob = await queue.add("readiness", { runId: "run-local" }, { jobId: "restart-readiness" });
    worker = new Worker(
      name,
      async () => {
        executorCalls += 1;
        return "recovered";
      },
      { connection: redis, concurrency: 1 },
    );
    await restartJob.waitUntilFinished(events, 10_000);
    assert.equal(executorCalls, 2, "a queued readiness job must continue after a worker restart");
  } finally {
    await worker.close().catch(() => undefined);
    await events.close().catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close().catch(() => undefined);
  }
}

async function main() {
  await verifyPostgres();
  await verifyRedis();
  console.log("Real local PostgreSQL/Redis concurrency verification passed.");
  console.log("POSTGRES=two_connection_advisory_lock,transaction_rollback");
  console.log("REDIS=bullmq_duplicate_idempotency,worker_restart_delivery");
  console.log(`ENV_FILE=${resolve(resolveBackendEnvFile())}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
