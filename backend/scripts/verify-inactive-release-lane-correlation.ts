import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ReleaseLaneCorrelationError,
} from "../src/orchestration-contracts/release-lane/inactive-release-lane-correlation.types";
import { normalizeReleaseLaneEnvironment } from "../src/orchestration-contracts/release-lane/inactive-release-lane-ownership.pure";

assert.equal(normalizeReleaseLaneEnvironment(" Production "), "production");
assert.throws(
  () => normalizeReleaseLaneEnvironment("production/other"),
  (error: unknown) => error instanceof ReleaseLaneCorrelationError || (error as Error).message === "OWNERSHIP_INPUT_INVALID",
);

const source = readFileSync(resolve(__dirname,
  "../src/orchestration-contracts/release-lane/inactive-release-lane-correlation.service.ts"), "utf8");
const migration = readFileSync(resolve(__dirname,
  "../src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation.ts"), "utf8");

for (const method of [
  "linkLegacyRun", "linkLegacyRollback", "linkV1IntentOwnership",
  "attachClaimedV1OperationLease", "validateBothIndependentFences",
]) assert.match(source, new RegExp(`async ${method}`));
assert.match(source, /operation_lease_id IS NULL/);
assert.match(source, /deployment_intent_id = \$8/);
assert.match(source, /status IN \('released','expired'\)/);
assert.match(source, /pg_advisory_xact_lock/);
assert.equal(/\.acquire\(/.test(source), false, "correlation adapter must not acquire ownership");
assert.equal(/queue\.add|BullMQ|terraform|ECS|aws-sdk/i.test(source), false);
assert.match(migration, /ADD COLUMN IF NOT EXISTS "deployment_intent_id" uuid/);
assert.match(migration, /ADD COLUMN IF NOT EXISTS "cross_lane_ownership_id" uuid/);
assert.match(migration, /Refusing to roll back release-lane correlation while correlation history exists/);
console.log("Inactive release-lane correlation static verification passed");
