import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigService } from "@nestjs/config";
import {
  InactiveV1ReleaseLaneCompositionService,
  V1ReleaseLaneProductionCanaryAdapterFactory,
} from "../src/orchestration-contracts/release-lane/inactive-v1-release-lane-composition";
import { ProductionV1ReleaseCanaryAdapterFactory } from "../src/orchestration-contracts/release-lane/production-v1-release-canary-adapter.factory";
import { ProductionV1ReleaseCanaryPreflightService } from "../src/orchestration-contracts/release-lane/production-v1-release-canary-preflight.service";

const projectId = "92000000-0000-4000-8000-000000000001";
const noDatabase = {
  getRepository() {
    throw new Error("TEST_MUST_NOT_QUERY_DATABASE");
  },
  query() {
    throw new Error("TEST_MUST_NOT_QUERY_DATABASE");
  },
} as any;
const planner = { plan: async () => { throw new Error("TEST_MUST_NOT_PLAN"); } } as any;
const dispatcher = { dispatchOne: async () => { throw new Error("TEST_MUST_NOT_PUBLISH"); } } as any;

function values(overrides: Record<string, unknown> = {}) {
  return {
    AWS_REGION: "us-east-1",
    TWO_LANE_RELEASE_COMPOSITION_ENABLED: "true",
    TWO_LANE_RELEASE_COMPOSITION_MODE: "production_canary",
    TWO_LANE_RELEASE_WORKER_ID: "canary-read-only-worker",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED: "true",
    TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST: "dev",
    TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED: "true",
    TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED: "true",
    TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_MODE: "read_only",
    ...overrides,
  };
}

function composition(input: Record<string, unknown>) {
  const config = new ConfigService(input);
  const production = new ProductionV1ReleaseCanaryAdapterFactory(config, noDatabase);
  return new InactiveV1ReleaseLaneCompositionService(
    config,
    noDatabase,
    planner,
    dispatcher,
    undefined,
    production.create.bind(production) as V1ReleaseLaneProductionCanaryAdapterFactory,
  );
}

void (async () => {
  const ready = composition(values());
  assert.equal(ready.getStatus().state, "ready");
  assert.equal(ready.getStatus().mode, "production_canary");
  assert.equal(ready.getInactiveComposition()?.consumer.isStarted(), false);
  assert.ok(ready.getInactiveComposition()?.handler);
  assert.ok(ready.getInactiveComposition()?.mutation);
  assert.ok(ready.getInactiveComposition()?.outcomes);
  assert.equal(ready.getInactiveComposition()?.firstReleaseBootstrap, null);

  const firstReleaseReady = composition(values({
    TWO_LANE_FIRST_RELEASE_BOOTSTRAP_ENABLED: "true",
  }));
  const firstRelease = firstReleaseReady.getInactiveComposition();
  assert.ok(firstRelease?.firstReleaseBootstrap);
  await assert.rejects(
    () => firstRelease!.runFirstReleaseBootstrap({
      identity: {
        projectId: "93000000-0000-4000-8000-000000000001",
        environmentName: "dev", infrastructureManifestId: projectId,
        infrastructureRevision: "1", intentId: projectId,
        idempotencyKey: "a".repeat(64), buildPushOperationId: projectId,
        registerTaskDefinitionOperationId: projectId,
        createServiceOperationId: projectId,
      },
    } as any),
    /FIRST_RELEASE_BOOTSTRAP_NOT_ALLOWED/,
  );

  for (const override of [
    { TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED: "false" },
    { TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED: "TRUE" },
    { TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_MODE: "mutating" },
    { TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "production" },
    { TWO_LANE_RELEASE_PROJECT_ALLOWLIST: `${projectId},93000000-0000-4000-8000-000000000001` },
    { TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST: "93000000-0000-4000-8000-000000000001" },
  ]) {
    const blocked = composition(values(override));
    assert.equal(blocked.getStatus().state, "blocked");
    assert.equal(blocked.getInactiveComposition(), null);
  }

  const disabledConfig = new ConfigService({});
  const disabledComposition = new InactiveV1ReleaseLaneCompositionService(
    disabledConfig, noDatabase, planner, dispatcher,
  );
  const disabledPreflight = new ProductionV1ReleaseCanaryPreflightService(
    disabledConfig,
    noDatabase,
    disabledComposition,
  );
  assert.deepEqual(await disabledPreflight.run(), {
    state: "disabled",
    safeCodes: ["CANARY_DISABLED"],
    accountVerified: false,
    regionVerified: false,
    ecrRepositoryVerified: false,
    ecsFoundationVerified: false,
    loadBalancerVerified: false,
    identityTagsVerified: false,
    futureMutationPermissionsVerified: false,
  });

  const source = readFileSync(resolve(__dirname,
    "../src/orchestration-contracts/release-lane/production-v1-release-canary-preflight.service.ts",
  ), "utf8");
  for (const forbidden of ["RegisterTaskDefinitionCommand", "UpdateServiceCommand", "CreateServiceCommand", "DeleteServiceCommand", "terraform"]) {
    assert.equal(source.includes(forbidden), false, `preflight contains ${forbidden}`);
  }
  console.log("Operational production canary preflight verification passed.");
})().catch((error) => {
  console.error(error instanceof Error ? error.message : "verification failed");
  process.exitCode = 1;
});
