import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { InfrastructureController } from "../src/infrastructure/infrastructure.controller";
import { OrchestrationController } from "../src/orchestration/orchestration.controller";
import { ProjectsController } from "../src/projects/projects.controller";

const projects = ProjectsController.prototype as unknown as Record<string, unknown>;
for (const method of ["startAutomation", "startPipelineRun", "cancelPipelineRun", "retryPipelineRun", "approveTerraformApply", "executeRecoveryResume", "prepareReleaseLane", "dispatchReleaseLane", "dispatchFirstReleaseInfrastructurePlan", "dispatchFirstReleaseInfrastructureApply", "approveNormalV1Cost", "getReleaseLaneStatus"]) {
  assert.equal(projects[method], undefined, `legacy ProjectsController method ${method} must be absent`);
}
const infrastructure = InfrastructureController.prototype as unknown as Record<string, unknown>;
for (const method of ["deploy", "plan", "apply"]) assert.equal(infrastructure[method], undefined, `legacy infrastructure method ${method} must be absent`);
const orchestration = OrchestrationController.prototype as unknown as Record<string, unknown>;
for (const method of ["deploy", "rollback", "updateScaling", "spotEvent"]) assert.equal(orchestration[method], undefined, `legacy orchestration mutation ${method} must be absent`);

const compose = readFileSync(resolve(__dirname, "../../docker-compose.yml"), "utf8");
assert.doesNotMatch(compose, /redis|normal-v1|worker/i);
const packageJson = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf8"));
assert.equal(Object.keys(packageJson.scripts).some((name) => /^(worker:|dev:worker$)/.test(name)), false);
console.log("Legacy deployment routes, worker scripts, Redis compose service, and custom mutation endpoints are absent.");
