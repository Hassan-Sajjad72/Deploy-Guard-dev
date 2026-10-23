import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const currentState = readFileSync(join(root, "src/projects/current-state/project-current-state.service.ts"), "utf8");
const controller = readFileSync(join(root, "src/projects/projects.controller.ts"), "utf8");
const status = readFileSync(join(root, "src/orchestration-contracts/release-lane/normal-release-lane-status.service.ts"), "utf8");

assert.match(currentState, /NormalReleaseLaneStatusService/);
assert.match(currentState, /normalReleaseLaneStatus\.get\(user, project\.id\)/);
assert.match(currentState, /\n\s+releaseLane,\n/);
assert.match(controller, /@Get\(":projectId\/release-lane\/status"\)/);
assert.match(controller, /normalReleaseLaneStatus\.get\(req\.user!, projectId\)/);
assert.doesNotMatch(status, /\.save\(|\.update\(|\.insert\(|\.delete\(|DurableOutboxDispatcherService|InactiveV1BullMqConsumerService|PipelineService|TerraformRunnerService|ECSClient/);

console.log("Normal release-lane current-state projection verification passed");
