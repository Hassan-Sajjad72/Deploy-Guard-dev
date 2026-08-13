import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  abandonedReconciliationEvidenceFingerprint,
  assertV1ReconciliationCoordinatorClaim,
} from "../src/orchestration-contracts/worker-runtime/v1-side-effect-reconciliation-coordinator.pure";

const valid = {
  sideEffectId: randomUUID(),
  workerId: "session6.8-coordinator",
  leaseTtlMs: 2_000,
  inspectionTimeoutMs: 1_000,
};
assert.deepEqual(assertV1ReconciliationCoordinatorClaim(valid), valid);
assert.throws(
  () => assertV1ReconciliationCoordinatorClaim({
    ...valid,
    leaseTtlMs: 1_100,
  }),
  /RECONCILIATION_COORDINATOR_CONTRACT_INVALID/,
);
assert.throws(
  () => assertV1ReconciliationCoordinatorClaim({
    ...valid,
    workerId: "unsafe worker",
  }),
  /RECONCILIATION_COORDINATOR_CONTRACT_INVALID/,
);
const abandoned = {
  sideEffectId: valid.sideEffectId,
  reconciliationId: randomUUID(),
  requestFingerprint: "a".repeat(64),
  leaseId: randomUUID(),
  fencingToken: "3",
};
assert.equal(
  abandonedReconciliationEvidenceFingerprint(abandoned),
  abandonedReconciliationEvidenceFingerprint(abandoned),
);
assert.match(
  abandonedReconciliationEvidenceFingerprint(abandoned),
  /^[0-9a-f]{64}$/,
);

const root = join(__dirname, "..");
const coordinator = readFileSync(
  join(
    root,
    "src/orchestration-contracts/worker-runtime/"
      + "inactive-v1-side-effect-reconciliation-coordinator.service.ts",
  ),
  "utf8",
);
const reconciliation = readFileSync(
  join(
    root,
    "src/orchestration-contracts/worker-runtime/"
      + "inactive-v1-side-effect-reconciliation.service.ts",
  ),
  "utf8",
);
const migration = readFileSync(
  join(
    root,
    "src/migrations/"
      + "1760000041000-CreateSideEffectReconciliationLeases.ts",
  ),
  "utf8",
);
assert.match(
  coordinator,
  /MAX\(fencing_token\), 0\)::bigint \+ 1 AS token/,
);
assert.match(
  coordinator,
  /lease\.status IN \('acquired','heartbeat_active'\)/,
);
assert.match(
  coordinator,
  /RECONCILIATION_PREVIOUS_INSPECTION_ABANDONED/,
);
assert.match(
  coordinator,
  /effect\.status !== "started"/,
);
assert.match(
  coordinator,
  /effect\.status !== "uncertain"/,
);
assert.doesNotMatch(coordinator, /\.perform\(/);
assert.doesNotMatch(
  coordinator,
  /@aws-sdk|terraform|docker|child_process|execFile|spawn\(/i,
);
assert.doesNotMatch(
  coordinator,
  /OnModuleInit|OnApplicationBootstrap|@Controller|setInterval/,
);
assert.match(
  reconciliation,
  /FROM deployment_side_effect_reconciliation_leases lease/,
);
assert.doesNotMatch(
  reconciliation,
  /FROM project_operation_leases lease/,
);
assert.match(
  migration,
  /UQ_side_effect_reconciliation_lease_active/,
);
assert.match(migration, /legacy_backfill/);
assert.match(
  migration,
  /Refusing to remove active reconciliation coordinator history/,
);
assert.doesNotMatch(
  migration,
  /INSERT INTO deployment_side_effect_reconciliations/,
);

console.log(
  "Inactive v1 side-effect reconciliation coordinator verification passed",
);
