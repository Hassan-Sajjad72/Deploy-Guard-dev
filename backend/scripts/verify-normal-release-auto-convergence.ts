import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import {
  NormalReleaseLaneAutoConvergenceScheduler,
} from "../src/orchestration-contracts/worker-runtime/normal-release-lane-auto-convergence.scheduler";

const projectId = "846665b9-ce31-405d-a131-b84457d80932";
const intentId = "11111111-1111-4111-8111-111111111111";

function config(overrides: Record<string, unknown> = {}) {
  return new ConfigService({
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED: "true",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_INTERVAL_MS: "1000",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ATTEMPTS: "2",
    TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_MAX_ELAPSED_MS: "60000",
    ...overrides,
  });
}

async function waitFor(condition: () => boolean, label: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function fixture(result: { state: "blocked" | "resumed" | "exhausted"; code: string }) {
  let candidates = 0;
  let reconciliations = 0;
  const convergence = {
    async findAutomaticCandidate() {
      candidates += 1;
      return candidates === 1 ? intentId : null;
    },
    async reconcileExact(
      observedProjectId: string,
      observedIntentId: string,
      bounds: { maxAttempts: number; maxElapsedMs: number },
    ) {
      reconciliations += 1;
      assert.equal(observedProjectId, projectId);
      assert.equal(observedIntentId, intentId);
      assert.deepEqual(bounds, { maxAttempts: 2, maxElapsedMs: 60_000 });
      return { state: result.state, safeCodes: [result.code] as [string] };
    },
  };
  return {
    scheduler: new NormalReleaseLaneAutoConvergenceScheduler(
      config(),
      convergence as never,
    ),
    candidates: () => candidates,
    reconciliations: () => reconciliations,
  };
}

async function run() {
  const disabledQueries = { value: 0 };
  const disabled = new NormalReleaseLaneAutoConvergenceScheduler(
    config({ TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED: "false" }),
    {
      async findAutomaticCandidate() {
        disabledQueries.value += 1;
        return intentId;
      },
    } as never,
  );
  assert.equal(disabled.start(projectId).state, "disabled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(disabledQueries.value, 0);
  await disabled.stop();

  const resumed = fixture({
    state: "resumed",
    code: "NORMAL_RELEASE_CONVERGENCE_RESUMED",
  });
  resumed.scheduler.start(projectId);
  resumed.scheduler.start(projectId);
  await waitFor(() => resumed.reconciliations() === 1, "one exact retry");
  assert.equal(resumed.scheduler.getStatus().state, "idle");
  assert.equal(resumed.candidates(), 1);
  await resumed.scheduler.stop();
  assert.equal(resumed.scheduler.getStatus().state, "stopped");

  const pending = fixture({
    state: "blocked",
    code: "NORMAL_RELEASE_CONVERGENCE_NOT_PROVEN",
  });
  pending.scheduler.start(projectId);
  await waitFor(() => pending.reconciliations() === 1, "read-only pending outcome");
  assert.equal(pending.scheduler.getStatus().state, "reconciling");
  await pending.scheduler.stop();

  const exhausted = fixture({
    state: "exhausted",
    code: "NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED",
  });
  exhausted.scheduler.start(projectId);
  await waitFor(() => exhausted.reconciliations() === 1, "bounded terminal outcome");
  assert.equal(exhausted.scheduler.getStatus().state, "terminal");
  await new Promise((resolve) => setTimeout(resolve, 1_050));
  assert.equal(exhausted.reconciliations(), 1);
  await exhausted.scheduler.stop();

  process.stdout.write("Normal release auto-convergence scheduler verification passed\n");
}

run().catch((error) => {
  process.stderr.write(
    `Normal release auto-convergence scheduler verification failed: ${
      error instanceof Error ? error.message : "unknown"
    }\n`,
  );
  process.exitCode = 1;
});
