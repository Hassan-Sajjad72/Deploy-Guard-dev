import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const backendPackage = JSON.parse(read("backend/package.json"));
const frontendPackage = JSON.parse(read("frontend/package.json"));

for (const packageJson of [backendPackage, frontendPackage]) {
  const text = JSON.stringify(packageJson);
  assert.doesNotMatch(text, /ioredis|normal-v1|release-lane|outbox|worker-runtime/i);
}
assert.equal(backendPackage.dependencies?.bullmq, "^5.81.3", "BullMQ remains available for the product's configured background queues");

const compose = read("compose.yaml");
assert.match(compose, /^\s*postgres:/m);
assert.doesNotMatch(compose, /redis|bullmq|worker|outbox/i);

const app = read("backend/src/app.module.ts");
const projects = read("backend/src/projects/projects.module.ts");
const infrastructure = read("backend/src/infrastructure/infrastructure.module.ts");
for (const source of [app, projects, infrastructure]) {
  assert.doesNotMatch(source, /OrchestrationContractsModule/);
  assert.doesNotMatch(source, /bullmq|ioredis|release-lane|normal-v1|outbox/i);
}
assert.match(projects, /NotificationsModule/, "canonical operation notifications remain active without reviving the retired worker graph");

for (const entry of [
  "backend/src/pipeline.worker.ts",
  "backend/src/normal-v1-release-consumer.worker.ts",
  "backend/src/normal-v1-infrastructure-plan-consumer.worker.ts",
  "backend/src/normal-v1-infrastructure-apply-consumer.worker.ts",
]) {
  assert.equal(existsSync(resolve(root, entry)), false, `${entry} must be removed`);
}

const auth = read("backend/src/auth/auth.controller.ts");
assert.doesNotMatch(auth, /@Post\("(?:signup|login)"\)/);
const controller = read("backend/src/projects/projects.controller.ts");
assert.doesNotMatch(controller, /deployNormalV1|normal_deployment_requested|release-lane/);
assert.match(controller, /deployGithubActions/);
const frontend = read("frontend/src/components/projects/CanonicalDeploymentView.jsx");
assert.match(frontend, /deployGithubActionsDeployment/);
assert.doesNotMatch(frontend, /executeNormalReleaseAction|normalReleaseAction/);

console.log("GitHub Actions-only product graph and legacy execution retirement verification passed.");
