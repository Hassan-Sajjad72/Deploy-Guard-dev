import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isReleaseLaneShadowModeEnabled } from "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service";

assert.equal(isReleaseLaneShadowModeEnabled("true"), true);
for (const value of [undefined, "false", "TRUE", " true", "1", "unknown"]) {
  assert.equal(isReleaseLaneShadowModeEnabled(value), false);
}

const source = readFileSync(resolve(__dirname,
  "../src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service.ts"), "utf8");
const migration = readFileSync(resolve(__dirname,
  "../src/migrations/1760000045000-CreateReleaseLaneShadowObservations.ts"), "utf8");

assert.match(source, /if \(!isReleaseLaneShadowModeEnabled\(\)\) return \{ enabled: false \}/);
assert.match(source, /FOR UPDATE/);
assert.equal(/InactiveReleaseLaneOwnershipService|InactiveReleaseLaneCorrelationService|\.acquire\(|\.renew\(|\.release\(|\.linkLegacy|\.attachClaimed|\.clear/.test(source), false);
assert.equal(/queue\.add|from ["']bullmq|from ["']@aws-sdk|child_process|fetch\(/i.test(source), false);
assert.match(source, /"unsafe_stale"/);
assert.match(source, /"insufficient_evidence"/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS "project_release_lane_shadow_observations"/);
assert.match(migration, /UQ_release_lane_shadow_operation/);
assert.match(migration, /Refusing to roll back release-lane shadow observations while history exists/);
console.log("Inactive release-lane shadow observer static verification passed");
