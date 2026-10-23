import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { PlannerClassificationNotAllowedError, PlannerIdempotencyConflictError } from "../src/orchestration-contracts/planner/transactional-deployment-planner.types";
import { NormalReleaseLanePlanningService } from "../src/orchestration-contracts/release-lane/normal-release-lane-planning.service";

const projectId = "11111111-1111-4111-8111-111111111111";
const infrastructureId = "22222222-2222-4222-8222-222222222222";
const stableId = "33333333-3333-4333-8333-333333333333";
const user: any = { id: 7, role: "developer" };
const contract = { projectId, deployable: true, invalidatedAt: null, invalidatedReason: null, commitSha: "a".repeat(40), detectionSourceCommit: "a".repeat(40), contractHash: "b".repeat(64) };
const preflight = { projectId, validationStatus: "passed", inputFingerprint: "b".repeat(64) };
const applied = { id: infrastructureId, projectId, environmentName: "dev", status: "applied" };
const stable = { id: stableId, projectId, environmentName: "dev", status: "stable", infrastructureManifestId: infrastructureId, initialServiceArn: "service", taskDefinitionArn: "task" };

function build(values: Record<string, unknown>, behavior: "prepared" | "conflict" | "classification" = "prepared") {
  let planned = 0;
  const planner = { plan: async (input: any) => {
    planned += 1;
    assert.equal(input.requiredClassification, "release_only");
    assert.equal(input.requestedCommitSha, contract.commitSha);
    assert.equal(input.idempotencyKey, `normal-release-plan:v1:${projectId}:dev:${infrastructureId}:${stableId}:${contract.commitSha}:${contract.contractHash}`);
    if (behavior === "conflict") throw new PlannerIdempotencyConflictError();
    if (behavior === "classification") throw new PlannerClassificationNotAllowedError("infrastructure_change");
    return { replayed: false, intent: { id: "44444444-4444-4444-8444-444444444444", status: "planned", releaseManifestId: "55555555-5555-4555-8555-555555555555" }, decision: { classification: "release_only" } };
  } };
  const service = new NormalReleaseLanePlanningService(
    new ConfigService(values),
    planner as any,
    { findOne: async () => ({ id: projectId, ownerUserId: user.id, environmentName: "dev" }) } as any,
    { findOne: async () => contract } as any,
    { findOne: async () => preflight } as any,
    { findOne: async () => applied } as any,
    { findOne: async () => stable } as any,
  );
  return { service, planned: () => planned };
}

void (async () => {
  const disabled = build({});
  assert.deepEqual(await disabled.service.prepare(user, projectId), {
    state: "disabled", safeCodes: ["NORMAL_RELEASE_LANE_PLANNING_DISABLED"], fallbackToLegacy: true,
  });
  assert.equal(disabled.planned(), 0);

  const values = {
    TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED: "true",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
  };
  const ready = build(values);
  const prepared = await ready.service.prepare(user, projectId);
  assert.equal(prepared.state, "prepared");
  assert.equal(prepared.fallbackToLegacy, false);
  assert.equal(ready.planned(), 1);

  const changedCommit = {
    ...contract,
    commitSha: "c".repeat(40),
    detectionSourceCommit: "c".repeat(40),
  };
  const changedCommitPlanner: any[] = [];
  const changedCommitService = new NormalReleaseLanePlanningService(
    new ConfigService(values),
    { plan: async (input: any) => {
      changedCommitPlanner.push(input);
      return { replayed: false, intent: { id: "44444444-4444-4444-8444-444444444444", status: "planned", releaseManifestId: "55555555-5555-4555-8555-555555555555" }, decision: { classification: "release_only" } };
    } } as any,
    { findOne: async () => ({ id: projectId, ownerUserId: user.id, environmentName: "dev" }) } as any,
    { findOne: async () => changedCommit } as any,
    { findOne: async () => preflight } as any,
    { findOne: async () => applied } as any,
    { findOne: async () => stable } as any,
  );
  await changedCommitService.prepare(user, projectId);
  assert.notEqual(changedCommitPlanner[0].idempotencyKey, `normal-release-plan:v1:${projectId}:dev:${infrastructureId}:${stableId}:${contract.commitSha}:${contract.contractHash}`);
  assert.match(changedCommitPlanner[0].idempotencyKey, new RegExp(`:${changedCommit.commitSha}:${changedCommit.contractHash}$`));

  const conflict = build(values, "conflict");
  assert.deepEqual(await conflict.service.prepare(user, projectId), {
    state: "blocked", safeCodes: ["NORMAL_RELEASE_LANE_IDEMPOTENCY_CONFLICT"], fallbackToLegacy: false,
  });
  const classification = build(values, "classification");
  assert.deepEqual(await classification.service.prepare(user, projectId), {
    state: "blocked", safeCodes: ["NORMAL_RELEASE_LANE_NOT_RELEASE_ONLY"], fallbackToLegacy: true,
  });

  const wrongScope = build({ ...values, TWO_LANE_RELEASE_PROJECT_ALLOWLIST: "99999999-9999-4999-8999-999999999999" });
  assert.deepEqual(await wrongScope.service.prepare(user, projectId), {
    state: "blocked", safeCodes: ["NORMAL_RELEASE_LANE_CONFIGURATION_INVALID"], fallbackToLegacy: true,
  });
  assert.equal(wrongScope.planned(), 0);
  const controller = readFileSync(join(__dirname, "../src/projects/projects.controller.ts"), "utf8");
  const source = readFileSync(join(__dirname, "../src/orchestration-contracts/release-lane/normal-release-lane-planning.service.ts"), "utf8");
  assert.match(controller, /@Post\(":projectId\/release-lane\/prepare"\)/);
  assert.match(controller, /normalReleaseLanePlanning\.prepare/);
  assert.doesNotMatch(source, /DurableOutboxDispatcherService|InactiveV1BullMqConsumerService|PipelineService|TerraformRunnerService/);
  console.log("Normal release-lane planning verification passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
