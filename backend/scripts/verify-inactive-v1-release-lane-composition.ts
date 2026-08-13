import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { ConfigService } from "@nestjs/config";
import {
  InactiveV1ReleaseLaneCompositionService,
  V1ReleaseLaneFixtureAdapterFactory,
} from "../src/orchestration-contracts/release-lane/inactive-v1-release-lane-composition";

const projectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";

const dataSource = {
  query: async () => {
    throw new Error("TEST_MUST_NOT_QUERY_POSTGRES");
  },
  transaction: async () => {
    throw new Error("TEST_MUST_NOT_OPEN_TRANSACTION");
  },
} as any;
const planner = {
  plan: async () => {
    throw new Error("TEST_MUST_NOT_PLAN");
  },
} as any;
const outboxDispatcher = {
  dispatchOne: async () => {
    throw new Error("TEST_MUST_NOT_PUBLISH");
  },
} as any;

function config(values: Record<string, unknown>) {
  return new ConfigService(values);
}

function service(
  values: Record<string, unknown>,
  factory?: V1ReleaseLaneFixtureAdapterFactory,
) {
  return new InactiveV1ReleaseLaneCompositionService(
    config(values),
    dataSource,
    planner,
    outboxDispatcher,
    factory,
  );
}

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    TWO_LANE_RELEASE_COMPOSITION_ENABLED: "true",
    TWO_LANE_RELEASE_COMPOSITION_MODE: "fixture",
    TWO_LANE_RELEASE_WORKER_ID: "fixture-release-worker",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST:
      `${secondProjectId},${projectId},${projectId}`,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST:
      "staging,production,production",
    ...overrides,
  };
}

function fixtureFactory(counters: {
  factories: number;
  mutations: number;
  reads: number;
  verifications: number;
}): V1ReleaseLaneFixtureAdapterFactory {
  return (gate) => {
    counters.factories += 1;
    assert.equal(gate.workerId, "fixture-release-worker");
    assert.deepEqual(
      gate.projectAllowlist,
      [projectId, secondProjectId],
    );
    assert.deepEqual(
      gate.environmentAllowlist,
      ["production", "staging"],
    );
    return {
      policy: "deployguard.release-lane/fixture-adapters-v1",
      mutationClient: {
        policy: "deployguard.ecs-release-mutation/client-v1",
        async registerTaskDefinitionRevision() {
          counters.mutations += 1;
          throw new Error("TEST_MUST_NOT_MUTATE_ECS");
        },
        async updateExistingService() {
          counters.mutations += 1;
          throw new Error("TEST_MUST_NOT_MUTATE_ECS");
        },
      },
      rolloutVerifier: {
        policy: "deployguard.ecs-rollout-health/disabled-read-only-v1",
        async verify() {
          counters.verifications += 1;
          throw new Error("TEST_MUST_NOT_READ_ECS");
        },
      },
      readOnlyEvidenceClient: {
        policy:
          "deployguard.ecs-release-reconciliation/fixture-read-only-v1",
        async findTaskDefinitionEvidence() {
          counters.reads += 1;
          throw new Error("TEST_MUST_NOT_READ_ECS");
        },
        async findServiceUpdateEvidence() {
          counters.reads += 1;
          throw new Error("TEST_MUST_NOT_READ_ECS");
        },
      },
    };
  };
}

function assertDisabled(instance: InactiveV1ReleaseLaneCompositionService) {
  assert.deepEqual(instance.getStatus(), {
    state: "disabled",
    mode: null,
    safeCode: "RELEASE_LANE_DISABLED",
    workerConfigured: false,
    projectAllowlistCount: 0,
    environmentAllowlistCount: 0,
    consumerStarted: false,
  });
  assert.equal(instance.getInactiveComposition(), null);
}

void (() => {
  const disabledCounter = {
    factories: 0,
    mutations: 0,
    reads: 0,
    verifications: 0,
  };
  const disabledFactory = fixtureFactory(disabledCounter);
  for (const value of [undefined, "false", "TRUE", "yes", true, 1]) {
    const values = value === undefined
      ? {}
      : { TWO_LANE_RELEASE_COMPOSITION_ENABLED: value };
    assertDisabled(service(values, disabledFactory));
  }
  assert.deepEqual(disabledCounter, {
    factories: 0,
    mutations: 0,
    reads: 0,
    verifications: 0,
  });

  for (const overrides of [
    { TWO_LANE_RELEASE_COMPOSITION_MODE: undefined },
    { TWO_LANE_RELEASE_COMPOSITION_MODE: "production" },
    { TWO_LANE_RELEASE_WORKER_ID: "" },
    { TWO_LANE_RELEASE_WORKER_ID: "bad worker" },
    { TWO_LANE_RELEASE_PROJECT_ALLOWLIST: "" },
    { TWO_LANE_RELEASE_PROJECT_ALLOWLIST: "not-a-uuid" },
    { TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "" },
    { TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "Production" },
  ]) {
    const blockedCounter = {
      factories: 0,
      mutations: 0,
      reads: 0,
      verifications: 0,
    };
    const blocked = service(
      enabledConfig(overrides),
      fixtureFactory(blockedCounter),
    );
    assert.equal(blocked.getStatus().state, "blocked");
    assert.equal(
      blocked.getStatus().safeCode,
      "RELEASE_LANE_CONFIGURATION_INVALID",
    );
    assert.equal(blocked.getInactiveComposition(), null);
    assert.equal(blockedCounter.factories, 0);
  }

  const unavailable = service(enabledConfig());
  assert.equal(unavailable.getStatus().state, "blocked");
  assert.equal(
    unavailable.getStatus().safeCode,
    "RELEASE_LANE_FIXTURE_ADAPTERS_UNAVAILABLE",
  );
  assert.equal(unavailable.getInactiveComposition(), null);

  const rawFactoryError =
    "aws_secret_access_key=must-never-escape";
  const failed = service(enabledConfig(), () => {
    throw new Error(rawFactoryError);
  });
  assert.equal(failed.getStatus().state, "blocked");
  assert.equal(
    JSON.stringify(failed.getStatus()).includes(rawFactoryError),
    false,
  );

  const invalidAdapters = service(enabledConfig(), () => ({
    policy: "wrong",
  } as any));
  assert.equal(invalidAdapters.getStatus().state, "blocked");
  assert.equal(invalidAdapters.getInactiveComposition(), null);

  const readyCounter = {
    factories: 0,
    mutations: 0,
    reads: 0,
    verifications: 0,
  };
  const ready = service(
    enabledConfig(),
    fixtureFactory(readyCounter),
  );
  assert.deepEqual(ready.getStatus(), {
    state: "ready",
    mode: "fixture",
    safeCode: "RELEASE_LANE_COMPOSITION_READY",
    workerConfigured: true,
    projectAllowlistCount: 2,
    environmentAllowlistCount: 2,
    consumerStarted: false,
  });
  const composition = ready.getInactiveComposition();
  assert.ok(composition);
  assert.equal(
    composition.policy,
    "deployguard.release-lane/inactive-composition-v1",
  );
  assert.equal(composition.planner, planner);
  assert.equal(composition.outboxDispatcher, outboxDispatcher);
  assert.equal(composition.consumer.isStarted(), false);
  assert.equal(composition.handler.messageType, "intent.release.execute");
  assert.equal(
    composition.handler.releasePolicy,
    "deployguard.release-handler/inactive-ecs-release-v1",
  );
  assert.equal(
    composition.handlerRegistry.get("intent.release.execute"),
    composition.handler,
  );
  assert.equal(composition.handlerRegistry.size, 4);
  for (const messageType of [
    "intent.infrastructure.plan",
    "intent.infrastructure.apply",
    "intent.deletion.execute",
  ] as const) {
    assert.equal(
      "releasePolicy" in composition.handlerRegistry.get(messageType)!,
      false,
    );
  }
  assert.equal(composition.allows(projectId, "production"), true);
  assert.equal(composition.allows(projectId, "development"), false);
  assert.equal(
    composition.allows(
      "33333333-3333-4333-8333-333333333333",
      "production",
    ),
    false,
  );
  assert.deepEqual(readyCounter, {
    factories: 1,
    mutations: 0,
    reads: 0,
    verifications: 0,
  });

  const sourcePath =
    "src/orchestration-contracts/release-lane/"
    + "inactive-v1-release-lane-composition.ts";
  const source = readFileSync(sourcePath, "utf8");
  for (const forbidden of [
    "Terraform",
    "terraform",
    "InfrastructureService",
    "intent.infrastructure.plan",
    "intent.infrastructure.apply",
    "intent.deletion.execute",
    "ECSClient",
    "new Worker(",
    ".start(",
    ".dispatchOne(",
    ".dispatchBatch(",
    ".publish(",
    ".plan(",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `forbidden composition dependency: ${forbidden}`,
    );
  }
  const moduleSource = readFileSync(
    "src/orchestration-contracts/orchestration-contracts.module.ts",
    "utf8",
  );
  // DI registration is intentional. Activation would require a lifecycle hook
  // or an explicit start call, neither of which belongs in the module.
  assert.equal(moduleSource.includes("onModuleInit"), false);
  assert.equal(moduleSource.includes("new Worker("), false);
  assert.equal(moduleSource.includes(".start("), false);
  const appSource = readFileSync("src/app.module.ts", "utf8");
  assert.equal(
    appSource.includes("InactiveV1ReleaseLaneCompositionService"),
    false,
  );
  console.log(
    "Inactive v1 release-lane composition verification passed",
  );
})();
