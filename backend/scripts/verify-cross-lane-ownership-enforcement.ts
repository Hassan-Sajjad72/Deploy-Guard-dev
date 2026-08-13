import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CrossLaneOwnershipEnforcementError,
  CrossLaneOwnershipEnforcementService,
} from "../src/orchestration-contracts/release-lane/cross-lane-ownership-enforcement.service";

class ConfigFixture {
  constructor(private readonly enabled: unknown) {}
  get(key: string) {
    return key === "TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED"
      ? this.enabled
      : undefined;
  }
}

async function main() {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const ownership = {
    acquire: async (input: Record<string, unknown>) => {
      calls.push({ method: "acquire", input });
      return {
        disposition: "acquired",
        ownership: {
          projectId: input.projectId,
          environmentName: input.environmentName,
          ownerLane: input.lane,
          leaseId: input.leaseId,
          fencingToken: "7",
          status: "acquired",
          acquiredAt: new Date(),
          heartbeatAt: new Date(),
          expiresAt: new Date(Date.now() + 60_000),
          releasedAt: null,
        },
      };
    },
    renew: async (input: Record<string, unknown>) => {
      calls.push({ method: "renew", input });
      return { disposition: "already_owned", ownership: {} };
    },
    release: async (input: Record<string, unknown>) => {
      calls.push({ method: "release", input });
      return { disposition: "already_owned", ownership: {} };
    },
  };
  const correlation = {
    linkV1IntentOwnership: async (input: Record<string, unknown>) => {
      calls.push({ method: "linkV1IntentOwnership", input });
      return { disposition: "linked" };
    },
    attachClaimedV1OperationLease: async (input: Record<string, unknown>) => {
      calls.push({ method: "attachClaimedV1OperationLease", input });
      return { disposition: "linked" };
    },
  };
  const projectId = "11111111-1111-4111-8111-111111111111";
  const intentId = "22222222-2222-4222-8222-222222222222";
  const disabled = new CrossLaneOwnershipEnforcementService(
    new ConfigFixture(false) as never,
    ownership as never,
    correlation as never,
  );
  assert.deepEqual(await disabled.acquireLegacy({
    projectId,
    operationId: intentId,
    actorId: "user:1",
    operationClass: "legacy_full_deployment_run",
  }), { enabled: false });
  assert.equal(calls.length, 0, "disabled mode must not touch ownership");

  for (const malformed of [undefined, true, "TRUE", "1", "yes"]) {
    assert.equal(new CrossLaneOwnershipEnforcementService(
      new ConfigFixture(malformed) as never,
      ownership as never,
      correlation as never,
    ).isEnabled(), false);
  }

  const enabled = new CrossLaneOwnershipEnforcementService(
    new ConfigFixture("true") as never,
    ownership as never,
    correlation as never,
  );
  const first = await enabled.acquireV1({
    projectId,
    environmentName: "dev",
    intentId,
    actorId: "worker:v1",
    requestFingerprint: "a".repeat(64),
  });
  const replay = await enabled.acquireV1({
    projectId,
    environmentName: "dev",
    intentId,
    actorId: "worker:v1",
    requestFingerprint: "a".repeat(64),
  });
  assert.equal(first.enabled, true);
  assert.equal(replay.enabled, true);
  if (!first.enabled || !replay.enabled) throw new Error("Expected claims");
  assert.equal(
    first.fence.ownershipLeaseId,
    replay.fence.ownershipLeaseId,
    "logical replay must use one deterministic cross-lane lease identity",
  );
  const operationLeaseId = "33333333-3333-4333-8333-333333333333";
  assert.notEqual(first.fence.ownershipLeaseId, operationLeaseId);
  await enabled.attachV1OperationLease(first, {
    intentId,
    operationLeaseId,
    operationWorkerId: "worker:v1",
    operationFencingToken: "11",
  });
  await assert.rejects(
    () => enabled.attachV1OperationLease(first, {
      intentId,
      operationLeaseId: first.fence.ownershipLeaseId,
      operationWorkerId: "worker:v1",
      operationFencingToken: "11",
    }),
    (error: unknown) =>
      error instanceof CrossLaneOwnershipEnforcementError
      && error.code === "CROSS_LANE_CORRELATION_FAILED",
  );
  assert.equal(await enabled.renew(first), true);
  assert.equal(await enabled.release(first), true);

  const recoveryCalls: string[] = [];
  const failingCorrelation = new CrossLaneOwnershipEnforcementService(
    new ConfigFixture("true") as never,
    {
      ...ownership,
      release: async () => {
        recoveryCalls.push("release");
        return { disposition: "already_owned", ownership: {} };
      },
    } as never,
    {
      ...correlation,
      linkV1IntentOwnership: async () => ({
        disposition: "correlation_conflict",
      }),
    } as never,
  );
  await assert.rejects(
    () => failingCorrelation.acquireV1({
      projectId,
      environmentName: "dev",
      intentId: "44444444-4444-4444-8444-444444444444",
      actorId: "worker:v1",
      requestFingerprint: "b".repeat(64),
    }),
    /CROSS_LANE_CORRELATION_FAILED/,
  );
  assert.deepEqual(
    recoveryCalls,
    ["release"],
    "correlation failure must release the newly acquired owner",
  );

  const serviceSource = readFileSync(resolve(
    __dirname,
    "../src/orchestration-contracts/release-lane/cross-lane-ownership-enforcement.service.ts",
  ), "utf8");
  const consumerSource = readFileSync(resolve(
    __dirname,
    "../src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service.ts",
  ), "utf8");
  const invocationSource = readFileSync(resolve(
    __dirname,
    "../src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service.ts",
  ), "utf8");
  assert.doesNotMatch(
    serviceSource,
    /from\s+["']bullmq["']|from\s+["']@aws-sdk|require\(\s*["']bullmq["']\s*\)|\b(?:new\s+)?(?:Queue|Worker|ECSClient)\s*[<(]|\.(?:add|addBulk|run|start)\s*\(/,
  );
  assert.match(consumerSource, /acquireCrossLane[\s\S]+this\.invocation\.invoke/);
  assert.match(invocationSource, /attachV1OperationLease[\s\S]+loadContext/);
  assert.match(consumerSource, /envelope\.routing\.lane === "deletion"/);
  assert.doesNotMatch(serviceSource, /operationLeaseId:\s*claim\.fence\.ownershipLeaseId/);

  console.log("Default-off cross-lane ownership enforcement fixture verification passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
