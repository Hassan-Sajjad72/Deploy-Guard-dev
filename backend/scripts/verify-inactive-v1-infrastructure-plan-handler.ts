import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { InactiveV1InfrastructurePlanHandler } from "../src/orchestration-contracts/worker-runtime/inactive-v1-infrastructure-plan.handler";
import { workerEnvelopeJobId } from "../src/orchestration-contracts/contracts/worker-envelope.validator";

const projectId = randomUUID();
const intentId = randomUUID();
const manifestId = randomUUID();
const draftId = randomUUID();
const outboxId = randomUUID();
const planHash = "a".repeat(64);
const planInput = "b".repeat(64);
const canonicalKey = "c".repeat(64);
const payloadSha = "d".repeat(64);
const draft = { schemaVersion: 1, source: { commitSha: "e".repeat(40) } };
const envelope: any = {
  schemaVersion: 1,
  protocol: { name: "deployguard.worker", version: 1, messageType: "intent.infrastructure.plan" },
  producer: { service: "test", producedAt: new Date().toISOString() },
  routing: { lane: "infrastructure", operation: "plan", queue: "deployguard-infrastructure-v1" },
  identity: { projectId, environmentName: "dev", intentId, infrastructureManifestId: manifestId, releaseManifestId: null, pipelineRunId: null, destroyOperationId: null },
  idempotency: { canonicalKey, payloadSha256: payloadSha },
};
const planReference = { phase: "planned", artifactSha256: planHash, inputFingerprint: planInput, workspaceRef: "workspace", stateKey: "state", planSummary: { create: 1 } };
const evidence = { draftId, draftHash: canonicalSha256(draft), releaseDraft: draft, planOutboxId: outboxId, planArtifactSha256: planHash, planInputFingerprint: planInput, planReference };

let plannerCalls = 0;
const handler = new InactiveV1InfrastructurePlanHandler(
  { query: async () => [evidence] } as any,
  { plan: async () => { plannerCalls += 1; return { state: "planned" }; } } as any,
);
const sideEffects: any = {
  execute: async (request: any) => {
    const outcome = await request.perform({});
    assert.equal(outcome.outcome, "succeeded");
    return { disposition: "executed", effect: { status: "succeeded" } };
  },
  finalizationStatus: () => ({ allowed: true, safeFailureCode: null }),
};
const context: any = {
  leaseId: randomUUID(), workerId: "infra-test-worker", fencingToken: "1", logicalJobId: workerEnvelopeJobId(envelope),
  lease: {}, intent: { id: intentId, projectId, environmentName: "dev", classification: "infrastructure_change", status: "running", canonicalIdempotencyKey: canonicalKey, infrastructureManifestId: manifestId, releaseManifestId: null, pipelineRunId: null, destroyOperationId: null },
  infrastructureManifest: { id: manifestId, status: "desired" }, releaseManifest: null,
  route: { messageType: "intent.infrastructure.plan", queueName: "deployguard-infrastructure-v1", lane: "infrastructure", operation: "plan" },
  envelope, execution: { signal: new AbortController().signal, isLeaseTrusted: () => true }, sideEffects,
};

async function main() {
  const outcome = await handler.invoke(context);
  assert.deepEqual(outcome, { outcome: "plan_completed", initialReleaseDraftId: draftId, planOutboxId: outboxId, planArtifactSha256: planHash, planInputFingerprint: planInput });
  assert.equal(plannerCalls, 1);
  const invalid = await handler.invoke({ ...context, route: { ...context.route, operation: "apply" } });
  assert.deepEqual(invalid, { outcome: "terminal_failure", safeFailureCode: "INFRASTRUCTURE_PLAN_CONTEXT_INVALID" });
  assert.equal(plannerCalls, 1);
  process.stdout.write("Inactive v1 infrastructure plan handler verification passed\n");
}
main().catch((error) => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
