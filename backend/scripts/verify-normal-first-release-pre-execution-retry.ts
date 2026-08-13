import { strict as assert } from "node:assert";
import { canonicalSha256 } from "../src/orchestration-contracts/contracts/canonical-json";
import { isFirstReleasePreExecutionRetryEligible } from
  "../src/orchestration-contracts/release-lane/normal-first-release-pre-execution-retry";

const projectId = "7ff60e82-e166-4d3b-9ea7-78203370e59f";
const intentId = "11111111-1111-4111-8111-111111111111";
const manifestId = "22222222-2222-4222-8222-222222222222";
const releaseDraft = {
  commitSha: "039c34770852fb07cef7f9f0f8534c5de408b207",
  deploymentContractHash: "a".repeat(64),
};
const fixture = {
  intent: {
    id: intentId, projectId, environmentName: "dev", kind: "deploy",
    classification: "infrastructure_change", status: "failed",
    failureCode: "REMOTE_CANARY_PLAN_NOT_ALLOWED",
    infrastructureManifestId: manifestId, releaseManifestId: null,
  },
  manifest: {
    id: manifestId, projectId, environmentName: "dev", revision: "1",
    status: "failed", failureCode: "REMOTE_CANARY_PLAN_NOT_ALLOWED",
    planArtifactReference: null, planArtifactSha256: null,
    planInputFingerprint: null, stateVersionId: null,
    terraformOutputs: null, terraformOutputsHash: null, resourceCount: null,
    plannedAt: null, applyStartedAt: null, appliedAt: null,
  },
  draft: {
    intentId, projectId, environmentName: "dev", infrastructureManifestId: manifestId,
    infrastructureRevision: "1", releaseDraft, draftHash: canonicalSha256(releaseDraft),
  },
  outbox: {
    intentId, eventType: "intent.infrastructure.plan", status: "published",
    attemptCount: 1, publishedAt: new Date(), publishedJobId: "job",
    claimedBy: null, claimExpiresAt: null,
  },
  sideEffects: [{
    intentId, projectId, environmentName: "dev",
    effectType: "infrastructure_terraform_plan", status: "failed",
    failureCode: "REMOTE_CANARY_PLAN_NOT_ALLOWED", reconciliationRequired: false,
    safeResultCode: null, resultFingerprint: null, externalReferenceHash: null,
  }],
} as any;

assert.equal(isFirstReleasePreExecutionRetryEligible(fixture), true);
for (const changed of [
  { intent: { ...fixture.intent, failureCode: "TERRAFORM_PLAN_FAILED" } },
  { manifest: { ...fixture.manifest, planInputFingerprint: "b".repeat(64) } },
  { outbox: { ...fixture.outbox, status: "pending", publishedAt: null, publishedJobId: null } },
  { sideEffects: [{ ...fixture.sideEffects[0], reconciliationRequired: true }] },
]) {
  assert.equal(isFirstReleasePreExecutionRetryEligible({ ...fixture, ...changed }), false);
}

console.log("First-release pre-execution retry eligibility verification passed.");
