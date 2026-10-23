import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import {
  NormalV1ReleaseConsumerRuntimeService,
} from "../src/orchestration-contracts/worker-runtime/normal-v1-release-consumer-runtime.service";

const projectId = "846665b9-ce31-405d-a131-b84457d80932";

function configuration(overrides: Record<string, unknown> = {}) {
  return {
    TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
    TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED: "true",
    OUTBOX_BULLMQ_PREFIX: "normal-v1-lifecycle-test",
    ...overrides,
  };
}

function fixture(values: Record<string, unknown>) {
  let starts = 0;
  let stops = 0;
  let startInput: Record<string, unknown> | null = null;
  let operationalState:
    "stopped" | "idle" | "processing" | "terminal" = "stopped";
  const consumer = {
    async start(input: Record<string, unknown>) {
      starts += 1;
      startInput = input;
      operationalState = "idle";
      return {
        workerId: "normal-v1:test",
        queueNames: ["deployguard-release-v1"],
        isActive: () => operationalState !== "stopped",
        lastFailureCode: () => null,
        stop: async () => {
          stops += 1;
          operationalState = "stopped";
        },
      };
    },
    getOperationalStatus() {
      return {
        state: operationalState,
        ready: operationalState !== "stopped",
        activeMessageType:
          operationalState === "processing"
            ? "intent.release.execute"
            : null,
        lastOutcome:
          operationalState === "terminal"
            ? {
              state: "terminal",
              safeCode: "CONSUMER_JOB_COMPLETED",
              observedAt: new Date(0).toISOString(),
            }
            : null,
      };
    },
  };
  const composition = {
    configuration: {
      workerId: "normal-v1:test",
      projectAllowlist: [projectId],
      environmentAllowlist: ["dev"],
    },
    laterReleaseImageClient: {},
    consumer,
  };
  const service = new NormalV1ReleaseConsumerRuntimeService(
    new ConfigService(values),
    {
      getStatus: () => ({
        state: "ready",
        mode: "production_canary",
      }),
      getInactiveComposition: () => composition,
    } as never,
    {
      start: () => ({ state: "disabled", safeCode: "NORMAL_RELEASE_AUTO_CONVERGENCE_DISABLED" }),
      stop: async () => ({ state: "stopped", safeCode: "NORMAL_RELEASE_AUTO_CONVERGENCE_STOPPED" }),
      getStatus: () => ({ state: "stopped", safeCode: "NORMAL_RELEASE_AUTO_CONVERGENCE_STOPPED" }),
    } as never,
  );
  return {
    service,
    consumer,
    starts: () => starts,
    stops: () => stops,
    input: () => startInput,
  };
}

async function run() {
  const disabled = fixture(configuration({
    TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED: "false",
  }));
  assert.equal((await disabled.service.start()).state, "disabled");
  assert.equal(disabled.starts(), 0);

  const malformed = fixture(configuration({
    TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED: "TRUE",
  }));
  assert.equal((await malformed.service.start()).state, "blocked");
  assert.equal(malformed.starts(), 0);

  const broad = fixture(configuration());
  const broadComposition = (broad as any).service["compositionService"]
    .getInactiveComposition();
  (broad as any).service["compositionService"].getInactiveComposition =
    () => ({
      ...broadComposition,
      configuration: {
        workerId: "normal-v1:test",
        projectAllowlist: [
          projectId,
          "11111111-1111-4111-8111-111111111111",
        ],
        environmentAllowlist: ["dev"],
      },
    });
  assert.equal((await broad.service.start()).state, "blocked");
  assert.equal(broad.starts(), 0);

  const enabled = fixture(configuration());
  const started = await enabled.service.start();
  assert.equal(started.state, "idle");
  assert.equal(started.ready, true);
  assert.equal(enabled.starts(), 1);
  assert.deepEqual((enabled.input() as any).scope, {
    projectIds: [projectId],
    environmentNames: ["dev"],
  });
  assert.equal((enabled.input() as any).concurrency, 1);
  assert.deepEqual(
    (enabled.input() as any).capability.supportedMessageTypes,
    ["intent.release.execute"],
  );
  const stopped = await enabled.service.stop();
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.ready, false);
  assert.equal(enabled.stops(), 1);

  const root = join(__dirname, "..");
  const processSource = readFileSync(
    join(root, "src/normal-v1-release-consumer.worker.ts"),
    "utf8",
  );
  const moduleSource = readFileSync(
    join(root, "src/normal-v1-release-consumer.module.ts"),
    "utf8",
  );
  const supervisorSource = readFileSync(
    join(
      root,
      "src/orchestration-contracts/worker-runtime/normal-v1-release-consumer-process.ts",
    ),
    "utf8",
  );
  assert.match(supervisorSource, /SIGTERM/);
  assert.match(supervisorSource, /SIGINT/);
  assert.match(supervisorSource, /await input\.runtime\.stop\(\)/);
  assert.match(supervisorSource, /await input\.close\(\)/);
  assert.doesNotMatch(processSource, /AppModule/);
  assert.doesNotMatch(processSource, /dispatchExact|\.dispatch\(/);
  assert.doesNotMatch(moduleSource, /ProjectsModule|InfrastructureModule/);

  process.stdout.write(
    "Normal v1 release consumer lifecycle verification passed.\n",
  );
}

run().catch((error) => {
  process.stderr.write(
    `Normal v1 release consumer lifecycle verification failed: ${
      error instanceof Error ? error.message : "unknown"
    }\n`,
  );
  process.exitCode = 1;
});
