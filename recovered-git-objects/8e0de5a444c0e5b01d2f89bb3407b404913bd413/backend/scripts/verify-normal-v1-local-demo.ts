import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const supervisor = readFileSync(
  resolve(__dirname, "normal-v1-local-demo.ts"),
  "utf8",
);
const fixture = readFileSync(
  resolve(__dirname, "verify-normal-v1-local-fixture-worker-postgres-redis.ts"),
  "utf8",
);
const rootPackage = readFileSync(resolve(root, "package.json"), "utf8");

assert.match(rootPackage, /"demo:normal-v1-local"/);
assert.doesNotMatch(rootPackage, /worker:normal-v1-deletion/);
assert.match(supervisor, /NORMAL_V1_LOCAL_DEMO_PRODUCTION_FORBIDDEN/);
assert.match(supervisor, /NORMAL_V1_LOCAL_DEMO_ALREADY_RUNNING/);
assert.match(supervisor, /dependencies = \["postgres", "redis"\]/);
assert.match(supervisor, /NORMAL_V1_LOCAL_DEMO_HOLD/);
assert.match(supervisor, /process\.kill\(current\.pid!, "SIGTERM"\)/);
assert.match(supervisor, /defaultsRestoredOff: true/);
assert.match(supervisor, /operationSignals/);
assert.doesNotMatch(supervisor, /terraform|ecr|ecs|aws/i);

assert.match(fixture, /TWO_LANE_RELEASE_COMPOSITION_MODE: "fixture"/);
assert.match(fixture, /TWO_LANE_LATER_RELEASE_LIVE_CLIENT_ENABLED: "false"/);
assert.match(fixture, /TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED: "false"/);
assert.match(fixture, /TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED: "false"/);
assert.match(fixture, /cloudExecution: "not_reachable"/);
assert.match(fixture, /service=healthy; phases=5\/5; effects=3\/3; events=5; logs=3/);
assert.match(fixture, /state: "stopped"/);
assert.match(fixture, /cleanupComplete: true/);
assert.doesNotMatch(
  fixture,
  /deployguard-deletion-v1|intent\.deletion\.execute/,
);

process.stdout.write("Normal-v1 local demo lifecycle contract verification passed.\n");
