import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { InactiveV1ExecutionLeaseHeartbeatService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-execution-lease-heartbeat.service";
import { canonicalExecutionLeaseHeartbeatInterval } from "../src/orchestration-contracts/worker-runtime/v1-execution-lease-heartbeat.pure";
import { InactiveV1PreExecutionOwnershipService } from "../src/orchestration-contracts/worker-runtime/inactive-v1-pre-execution-ownership.service";

const fence = {
  leaseId: "11111111-1111-4111-8111-111111111111",
  workerId: "session6.5-worker",
  fencingToken: "7",
  leaseTtlMs: 1_000,
  intervalMs: 100,
};

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForAbort(signal: AbortSignal) {
  if (signal.aborted) return;
  await Promise.race([
    new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    }),
    wait(2_000).then(() => {
      throw new Error("Timed out waiting for heartbeat abort.");
    }),
  ]);
}

function heartbeatWith(
  renew: (...args: never[]) => Promise<unknown>,
) {
  const ownership = { renew } as unknown as
    InactiveV1PreExecutionOwnershipService;
  return new InactiveV1ExecutionLeaseHeartbeatService(ownership);
}

async function run() {
  assert.equal(canonicalExecutionLeaseHeartbeatInterval(60_000), 20_000);
  assert.equal(canonicalExecutionLeaseHeartbeatInterval(1_000), 333);
  assert.equal(
    canonicalExecutionLeaseHeartbeatInterval(1_000, 100),
    100,
  );
  for (const invalid of [99, 500, 1_000]) {
    assert.throws(
      () => canonicalExecutionLeaseHeartbeatInterval(1_000, invalid),
      /heartbeat interval is invalid/,
    );
  }

  let renewals = 0;
  let concurrent = 0;
  let maximumConcurrent = 0;
  const serialized = heartbeatWith(async () => {
    renewals += 1;
    concurrent += 1;
    maximumConcurrent = Math.max(maximumConcurrent, concurrent);
    await wait(140);
    concurrent -= 1;
    return {};
  }).start(fence);
  await wait(520);
  assert.equal(serialized.isTrusted(), true);
  assert.ok(renewals >= 2);
  assert.equal(maximumConcurrent, 1);
  assert.equal(await serialized.stop(), "stopped");
  const renewalsAfterStop = renewals;
  await wait(180);
  assert.equal(renewals, renewalsAfterStop);

  const ownershipLost = heartbeatWith(async () => null).start(fence);
  await waitForAbort(ownershipLost.signal);
  assert.equal(ownershipLost.isTrusted(), false);
  assert.equal(ownershipLost.disposition(), "ownership_lost");
  assert.equal(
    ownershipLost.lastFailureCode(),
    "EXECUTION_OWNERSHIP_LOST",
  );
  assert.equal(await ownershipLost.stop(), "ownership_lost");

  const rawFailure = "postgres://user:password@private-host/raw";
  const failed = heartbeatWith(async () => {
    throw new Error(rawFailure);
  }).start(fence);
  await waitForAbort(failed.signal);
  assert.equal(failed.disposition(), "heartbeat_failed");
  assert.equal(failed.lastFailureCode(), "EXECUTION_HEARTBEAT_FAILED");
  assert.equal(JSON.stringify({
    disposition: failed.disposition(),
    failureCode: failed.lastFailureCode(),
  }).includes(rawFailure), false);
  assert.equal(await failed.stop(), "heartbeat_failed");

  const cancellation = new AbortController();
  const cancelled = heartbeatWith(async () => ({})).start({
    ...fence,
    abortSignal: cancellation.signal,
  });
  cancellation.abort();
  assert.equal(cancelled.signal.aborted, true);
  assert.equal(cancelled.isTrusted(), false);
  assert.equal(cancelled.disposition(), "cancelled");
  assert.equal(cancelled.lastFailureCode(), "EXECUTION_CANCELLED");
  assert.equal(await cancelled.stop(), "cancelled");

  const root = join(__dirname, "..");
  const invocationSource = readFileSync(
    join(
      root,
      "src/orchestration-contracts/worker-runtime/"
        + "inactive-v1-fenced-invocation.service.ts",
    ),
    "utf8",
  );
  const consumerSource = readFileSync(
    join(
      root,
      "src/orchestration-contracts/worker-runtime/"
        + "inactive-v1-bullmq-consumer.service.ts",
    ),
    "utf8",
  );
  const heartbeatSource = readFileSync(
    join(
      root,
      "src/orchestration-contracts/worker-runtime/"
        + "inactive-v1-execution-lease-heartbeat.service.ts",
    ),
    "utf8",
  );
  assert.match(
    invocationSource,
    /this\.leaseHeartbeat\.start\(\{[\s\S]*this\.ownership\.complete/,
  );
  assert.match(invocationSource, /execution:[\s\S]*isLeaseTrusted/);
  assert.match(invocationSource, /EXECUTION_HEARTBEAT_FAILED/);
  assert.doesNotMatch(
    heartbeatSource,
    /OnModuleInit|OnApplicationBootstrap|ConfigService|createRedisConnection/,
  );
  assert.doesNotMatch(
    heartbeatSource,
    /Terraform|ECS|AWS|Docker|legacy|child_process/,
  );
  assert.doesNotMatch(
    consumerSource,
    /OnModuleInit|OnApplicationBootstrap/,
  );

  console.log(
    "Inactive v1 execution lease heartbeat verification passed",
  );
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
