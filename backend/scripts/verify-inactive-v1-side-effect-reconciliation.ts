import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalizeV1SideEffectReconciliationIdentity,
  safeInconclusiveReconciliationEvidence,
  validateV1ReadOnlySideEffectEvidence,
  v1SideEffectReconciliationRequestFingerprint,
} from "../src/orchestration-contracts/worker-runtime/v1-side-effect-reconciliation.pure";

const hash = (character: string) => character.repeat(64);
const identity = {
  sideEffectId: randomUUID(),
  intentId: randomUUID(),
  projectId: randomUUID(),
  environmentName: "production",
  operationId: randomUUID(),
  idempotencyKey: hash("a"),
  adapterId: "fixture.read-only",
  inspectionFingerprint: hash("b"),
  effectRequestFingerprint: hash("c"),
  leaseId: randomUUID(),
  workerId: "session6.7-worker",
  fencingToken: "9",
};

assert.deepEqual(
  canonicalizeV1SideEffectReconciliationIdentity(identity),
  identity,
);
const fingerprint = v1SideEffectReconciliationRequestFingerprint(identity);
assert.match(fingerprint, /^[0-9a-f]{64}$/);
assert.equal(
  v1SideEffectReconciliationRequestFingerprint({
    ...identity,
    leaseId: randomUUID(),
    workerId: "session6.7-replacement",
    fencingToken: "10",
  }),
  fingerprint,
  "ownership replacement must not change logical reconciliation identity",
);
assert.throws(
  () => canonicalizeV1SideEffectReconciliationIdentity({
    ...identity,
    fencingToken: "0",
  }),
  /SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID/,
);

const succeeded = validateV1ReadOnlySideEffectEvidence({
  classification: "succeeded",
  safeEvidenceCode: "TARGET_EFFECT_CONFIRMED",
  evidenceFingerprint: hash("d"),
  resultFingerprint: hash("e"),
  externalReferenceHash: hash("f"),
});
assert.equal(succeeded.classification, "succeeded");
assert.equal(
  validateV1ReadOnlySideEffectEvidence({
    classification: "failed",
    safeFailureCode: "TARGET_EFFECT_REJECTED",
    evidenceFingerprint: hash("1"),
  }).classification,
  "failed",
);
assert.equal(
  validateV1ReadOnlySideEffectEvidence({
    classification: "pending",
    safeEvidenceCode: "TARGET_EFFECT_STILL_PENDING",
    evidenceFingerprint: hash("2"),
  }).classification,
  "pending",
);
assert.equal(
  validateV1ReadOnlySideEffectEvidence({
    classification: "manual_review",
    safeFailureCode: "TARGET_EVIDENCE_AMBIGUOUS",
    evidenceFingerprint: hash("3"),
  }).classification,
  "manual_review",
);
assert.throws(
  () => validateV1ReadOnlySideEffectEvidence({
    classification: "succeeded",
    safeEvidenceCode: "TARGET_EFFECT_CONFIRMED",
    evidenceFingerprint: hash("4"),
    resultFingerprint: hash("5"),
    rawSdkResponse: { accessKey: "must-not-be-accepted" },
  }),
  /SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID/,
);
assert.throws(
  () => validateV1ReadOnlySideEffectEvidence({
    classification: "failed",
    safeFailureCode: "unsafe raw error",
    evidenceFingerprint: hash("6"),
  }),
);
assert.equal(
  safeInconclusiveReconciliationEvidence(
    identity.sideEffectId,
    fingerprint,
    "RECONCILIATION_INSPECTION_FAILED",
  ).classification,
  "manual_review",
);
assert.equal(
  safeInconclusiveReconciliationEvidence(
    identity.sideEffectId,
    fingerprint,
    "RECONCILIATION_INSPECTION_TIMED_OUT",
  ).classification,
  "pending",
);

const root = join(__dirname, "..");
const service = readFileSync(
  join(
    root,
    "src/orchestration-contracts/worker-runtime/"
      + "inactive-v1-side-effect-reconciliation.service.ts",
  ),
  "utf8",
);
const types = readFileSync(
  join(
    root,
    "src/orchestration-contracts/worker-runtime/"
      + "v1-side-effect-reconciliation.types.ts",
  ),
  "utf8",
);
const migration = readFileSync(
  join(
    root,
    "src/migrations/"
      + "1760000040000-CreateSideEffectReconciliationJournal.ts",
  ),
  "utf8",
);
assert.match(
  types,
  /deployguard\.side-effect-reconciliation\/read-only-v1/,
);
assert.match(service, /effect\.status !== "started"/);
assert.match(service, /effect\.status !== "uncertain"/);
assert.match(service, /lease\.fencing_token = \$3::bigint/);
assert.match(service, /lease\.expires_at > clock_timestamp\(\)/);
assert.match(service, /effect\.status IN \('started','uncertain'\)/);
assert.doesNotMatch(service, /\.perform\(/);
assert.doesNotMatch(
  service,
  /@aws-sdk|terraform|docker|child_process|execFile|spawn\(/i,
);
assert.doesNotMatch(
  service,
  /OnModuleInit|OnApplicationBootstrap|setInterval/,
);
assert.match(
  migration,
  /CREATE TABLE IF NOT EXISTS "deployment_side_effect_reconciliations"/,
);
assert.match(migration, /UQ_side_effect_reconciliation_idempotency/);
assert.match(
  migration,
  /Refusing to remove side-effect reconciliation evidence/,
);
assert.doesNotMatch(
  migration,
  /INSERT INTO "deployment_side_effect_reconciliations"/,
);

console.log(
  "Inactive v1 side-effect reconciliation contract verification passed",
);
