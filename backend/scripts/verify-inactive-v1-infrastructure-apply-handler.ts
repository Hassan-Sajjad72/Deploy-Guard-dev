import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { InactiveV1InfrastructureApplyHandler } from "../src/orchestration-contracts/worker-runtime/inactive-v1-infrastructure-apply.handler";

const projectId = randomUUID(); const intentId = randomUUID(); const manifestId = randomUUID(); const planHash = "a".repeat(64);
let calls = 0; let applyState: "applied" | "failed" = "applied";
const handler = new InactiveV1InfrastructureApplyHandler({ query: async () => [{ planHash }] } as any, {
  applyFromFencedInvocation: async () => {
    calls += 1;
    return {
      state: applyState,
      safeCodes: applyState === "failed" ? ["INFRASTRUCTURE_APPLY_PREFLIGHT_FAILED"] : [],
      manifestId,
      revision: "1",
      resourceCount: applyState === "applied" ? 1 : null,
      stateStatus: applyState === "applied" ? "active" : "absent",
      lockStatus: applyState === "applied" ? "released" : "unverified",
      ownershipStatus: applyState === "applied" ? "released" : "unverified",
    };
  },
} as any);
const envelope: any = { identity: { intentId, infrastructureManifestId: manifestId }, idempotency: { payloadSha256: "b".repeat(64) } };
const context: any = {
  intent: { id: intentId, projectId, environmentName: "dev", classification: "infrastructure_change", status: "running", infrastructureManifestId: manifestId, canonicalIdempotencyKey: "c".repeat(64) },
  releaseManifest: null, route: { queueName: "deployguard-infrastructure-v1", lane: "infrastructure", operation: "apply" }, logicalJobId: "job", envelope,
  sideEffects: {
    execute: async (request: any) => {
      const outcome = await request.perform({});
      return outcome.outcome === "failed"
        ? { disposition: "failed", effect: { status: "failed", failureCode: outcome.safeFailureCode } }
        : { disposition: "executed", effect: { status: outcome.outcome === "succeeded" ? "succeeded" : "uncertain", failureCode: outcome.safeFailureCode } };
    },
  },
};
void (async () => {
  assert.deepEqual(await handler.invoke(context), { outcome: "success" }); assert.equal(calls, 1);
  assert.deepEqual(await handler.invoke({ ...context, route: { ...context.route, operation: "plan" } }), { outcome: "terminal_failure", safeFailureCode: "INFRASTRUCTURE_APPLY_CONTEXT_INVALID" });
  assert.equal(calls, 1);
  applyState = "failed";
  assert.deepEqual(await handler.invoke(context), { outcome: "terminal_failure", safeFailureCode: "INFRASTRUCTURE_APPLY_PREFLIGHT_FAILED" });
  assert.equal(calls, 2);
  process.stdout.write("Inactive v1 infrastructure apply handler verification passed\n");
})().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
