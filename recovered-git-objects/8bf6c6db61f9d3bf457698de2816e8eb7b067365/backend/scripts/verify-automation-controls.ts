import { strict as assert } from "node:assert";
import { GoneException } from "@nestjs/common";
import { InfrastructureController } from "../src/infrastructure/infrastructure.controller";
import { OrchestrationController } from "../src/orchestration/orchestration.controller";
import { ProjectsController } from "../src/projects/projects.controller";

const projectId = "11111111-1111-4111-8111-111111111111";
const runId = "22222222-2222-4222-8222-222222222222";
const user = { id: 1, role: "developer" };
const request = { user };

let forbiddenDependencyCalls = 0;
const forbiddenDependency = new Proxy({}, {
  get() {
    forbiddenDependencyCalls += 1;
    throw new Error("A retired endpoint reached an execution dependency.");
  },
});

const projects = Object.create(ProjectsController.prototype) as ProjectsController & Record<string, unknown>;
(projects as any).pipelineService = forbiddenDependency;
(projects as any).normalDeploymentCommand = forbiddenDependency;
const infrastructure = Object.create(InfrastructureController.prototype) as InfrastructureController & Record<string, unknown>;
(infrastructure as any).infrastructureService = forbiddenDependency;
const orchestration = Object.create(OrchestrationController.prototype) as OrchestrationController & Record<string, unknown>;
(orchestration as any).orchestrationService = forbiddenDependency;

async function expectRetired(work: () => Promise<unknown>) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof GoneException);
    assert.equal(error.getStatus(), 410);
    const response = error.getResponse() as { code?: string };
    assert.equal(response.code, "LEGACY_DEPLOYMENT_EXECUTION_RETIRED");
    return true;
  });
}

async function main() {
  await expectRetired(() => projects.startAutomation(request as never, projectId));
  await expectRetired(() => projects.startPipelineRun(request as never, projectId, {}));
  await expectRetired(() => projects.cancelPipelineRun(request as never, projectId, runId));
  await expectRetired(() => projects.retryPipelineRun(request as never, projectId, runId));
  await expectRetired(() => projects.approveTerraformApply(request as never, projectId, runId));
  await expectRetired(() => projects.executeRecoveryResume(request as never, projectId, {}));
  await expectRetired(() => infrastructure.deploy(request as never, projectId));
  await expectRetired(() => infrastructure.plan(request as never, projectId));
  await expectRetired(() => infrastructure.apply(request as never, projectId));
  await expectRetired(() => orchestration.deploy(request as never, projectId));

  assert.equal(forbiddenDependencyCalls, 0, "retired routes must not create runs or publish queue work");
  console.log("Legacy deployment retirement guards passed without execution or queue publication.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
