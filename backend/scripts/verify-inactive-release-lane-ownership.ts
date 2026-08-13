import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertReleaseLaneOwnershipInput,
  normalizeReleaseLaneEnvironment,
} from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.pure";
import { ReleaseLaneOwnershipError } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.types";

const valid = {
  projectId: "11111111-1111-4111-8111-111111111111",
  environmentName: "production",
  lane: "v1",
  leaseId: "22222222-2222-4222-8222-222222222222",
  actorId: "worker:release-1",
  idempotencyKey: "a".repeat(64),
  requestFingerprint: "b".repeat(64),
  leaseTtlMs: 60_000,
};

assert.equal(normalizeReleaseLaneEnvironment(" Production "), "production");
assert.throws(
  () => normalizeReleaseLaneEnvironment("production!"),
  (error: unknown) => error instanceof ReleaseLaneOwnershipError
    && error.code === "OWNERSHIP_INPUT_INVALID",
);
assert.doesNotThrow(() => assertReleaseLaneOwnershipInput(valid));
for (const invalid of [
  { ...valid, lane: "release" },
  { ...valid, leaseId: "not-a-uuid" },
  { ...valid, actorId: "unsafe actor" },
  { ...valid, idempotencyKey: "not-a-hash" },
  { ...valid, requestFingerprint: "B".repeat(64) },
  { ...valid, leaseTtlMs: 1 },
]) {
  assert.throws(() => assertReleaseLaneOwnershipInput(invalid));
}

const source = readFileSync(resolve(
  __dirname,
  "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service.ts",
), "utf8");
assert.match(source, /pg_advisory_xact_lock/);
assert.match(source, /SERIALIZABLE/);
assert.match(source, /project_pipeline_runs/);
assert.match(source, /deployment_intents/);
assert.match(source, /project_operation_leases/);
assert.doesNotMatch(source, /\.add\(|BullMQ|terraform|ECSClient|Docker|aws-sdk/i);

console.log("Inactive legacy/v1 release-lane ownership pure contract verification passed");
