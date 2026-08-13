import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { workerEnvelopePayloadForHash } from "../src/orchestration-contracts/contracts/worker-envelope.validator";
import { NormalFirstReleaseInfrastructurePlanExecutionService } from "../src/orchestration-contracts/release-lane/normal-first-release-infrastructure-plan-execution.service";
import {
  isNormalFirstReleasePlanOperation,
  normalFirstReleasePlanOperationWhere,
} from "../src/orchestration-contracts/release-lane/normal-first-release-plan-operation";

const projectId = "11111111-1111-4111-8111-111111111111";
const intentId = "22222222-2222-4222-8222-222222222222";
const manifestId = "33333333-3333-4333-8333-333333333333";
const outboxId = "44444444-4444-4444-8444-444444444444";
const user: any = { id: 7, role: "developer" };
const canonicalKey = "a".repeat(64);
const releaseDraft = { schemaVersion: 1, commitSha: "b".repeat(40) };
const envelope: any = {
  protocol: { name: "deployguard.worker", schemaVersion: 1, messageType: "intent.infrastructure.plan", minimumWorkerProtocol: 1, maximumWorkerProtocol: 1 },
  producer: { service: "deployguard-api", serviceVersion: "test", gitSha: "test", producedAt: new Date().toISOString() },
  identity: { intentId, projectId, environmentName: "dev", pipelineRunId: null, destroyOperationId: null, infrastructureManifestId: manifestId, releaseManifestId: null },
  routing: { lane: "infrastructure", operation: "plan", queue: "deployguard-infrastructure-v1" },
  idempotency: { canonicalKey, payloadSha256: "0".repeat(64), attempt: 1, replayOfJobId: null },
  execution: { mode: "full", resumeFromStage: null, reusableCheckpointIds: [], invalidatedCheckpointIds: [], reasonCodes: ["FIRST_RELEASE"], fencingTokenRequired: true },
  trace: { correlationId: intentId, causationId: null, actorUserId: 7 },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
envelope.idempotency.payloadSha256 = canonicalSha256(workerEnvelopePayloadForHash(envelope));
const parent: any = { id: intentId, projectId, environmentName: "dev", kind: "retry", classification: "infrastructure_change", status: "planned", releaseManifestId: null, infrastructureManifestId: manifestId, canonicalIdempotencyKey: canonicalKey };
const manifest: any = { id: manifestId, projectId, environmentName: "dev", status: "desired", revision: "1", appliedAt: null };
const draft: any = { id: randomUUID(), intentId, projectId, environmentName: "dev", infrastructureManifestId: manifestId, infrastructureRevision: "1", draftHash: canonicalSha256(releaseDraft), releaseDraft };
const outbox: any = { id: outboxId, intentId, eventType: "intent.infrastructure.plan", workerEnvelope: envelope, payloadSha256: envelope.idempotency.payloadSha256, status: "pending", attemptCount: 0, claimedBy: null, claimExpiresAt: null, publishedAt: null, publishedJobId: null };

function build(values: Record<string, unknown>, result: any = { status: "published" }, candidate: any = parent) {
  const calls: any[] = [];
  const service = new NormalFirstReleaseInfrastructurePlanExecutionService(
    new ConfigService(values),
    { dispatchExact: async (target: any) => { calls.push(target); return result; } } as any,
    { findOneBy: async () => ({ id: projectId, ownerUserId: user.id, environmentName: "dev" }) } as any,
    { find: async () => candidate ? [candidate] : [] } as any,
    { findOneBy: async () => manifest } as any,
    { find: async () => [draft] } as any,
    { find: async () => [outbox] } as any,
  );
  return { service, calls };
}

void (async () => {
  assert.equal(isNormalFirstReleasePlanOperation(parent), true);
  assert.equal(isNormalFirstReleasePlanOperation({ ...parent, kind: "apply" }), false);
  const canonicalWhere = normalFirstReleasePlanOperationWhere(projectId) as any;
  assert.deepEqual(canonicalWhere.kind.value, ["deploy", "retry"]);
  assert.deepEqual(canonicalWhere.status.value, ["planned", "enqueued", "running"]);
  const values = {
    TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED: "true",
    TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_EXECUTION_ENABLED: "true",
    TWO_LANE_RELEASE_PROJECT_ALLOWLIST: projectId,
    TWO_LANE_RELEASE_ENVIRONMENT_ALLOWLIST: "dev",
  };
  const disabled = build({ ...values, TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_EXECUTION_ENABLED: "false" });
  assert.deepEqual(await disabled.service.dispatch(user, projectId), {
    state: "disabled", safeCodes: ["NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_EXECUTION_DISABLED"], fallbackToLegacy: false,
  });
  assert.equal(disabled.calls.length, 0);
  const ready = build(values);
  assert.deepEqual(await ready.service.dispatch(user, projectId), {
    state: "dispatched", safeCodes: ["FIRST_RELEASE_INFRASTRUCTURE_PLAN_OUTBOX_DISPATCHED"], fallbackToLegacy: false,
  });
  assert.deepEqual(ready.calls, [{ outboxId, intentId, projectId, environmentName: "dev" }]);
  const duplicate = build(values, { status: "blocked", reason: "OUTBOX_ALREADY_CLAIMED" });
  assert.deepEqual(await duplicate.service.dispatch(user, projectId), {
    state: "blocked", safeCodes: ["OUTBOX_ALREADY_CLAIMED"], fallbackToLegacy: false,
  });
  const malformed = build(values, { status: "published" }, { ...parent, releaseManifestId: randomUUID() });
  assert.deepEqual(await malformed.service.dispatch(user, projectId), {
    state: "blocked", safeCodes: ["NORMAL_FIRST_RELEASE_INFRASTRUCTURE_PLAN_EVIDENCE_MALFORMED"], fallbackToLegacy: false,
  });
  const source = readFileSync(join(__dirname, "../src/orchestration-contracts/release-lane/normal-first-release-infrastructure-plan-execution.service.ts"), "utf8");
  const controller = readFileSync(join(__dirname, "../src/projects/projects.controller.ts"), "utf8");
  const app = readFileSync(join(__dirname, "../src/app.module.ts"), "utf8");
  assert.match(source, /dispatcher\.dispatchExact/);
  assert.doesNotMatch(source, /OneShotRunner|InactiveV1BullMqConsumerService|TerraformRunnerService|ECSClient|Docker/);
  assert.match(controller, /release-lane\/infrastructure-plan\/dispatch/);
  assert.match(app, /release-lane\/infrastructure-plan\/dispatch/);
  console.log("Normal first-release infrastructure plan dispatch verification passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
