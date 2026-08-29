import "reflect-metadata";
import { strict as assert } from "node:assert";
import { validate } from "class-validator";
import { ForbiddenException } from "@nestjs/common";
import { DESTROY_CONFIRMATION_PHRASE } from "../src/projects/destroy-confirmation";
import { DestroyGithubActionsDto } from "../src/projects/dto/destroy-github-actions.dto";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";

const projectId = "122a34a1-5d28-4f39-bb51-28379671fdb4";
const user: any = { id: 7 };
const project: any = { id: projectId, name: "smart-retail-pro" };

async function verifyApiBoundary() {
  const valid = Object.assign(new DestroyGithubActionsDto(), { confirmationPhrase: DESTROY_CONFIRMATION_PHRASE });
  assert.equal((await validate(valid)).length, 0, "DESTROY is the valid API confirmation phrase");

  const invalid = Object.assign(new DestroyGithubActionsDto(), { confirmationPhrase: project.name });
  assert.ok((await validate(invalid)).length > 0, "a project name is not a valid API confirmation phrase");
}

async function verifyDispatchContract() {
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.project = async () => project;
  let dispatched: any[] | null = null;
  service.dispatch = async (...args: any[]) => {
    dispatched = args;
    return { deployment: { state: "accepted", operation: { id: "operation-1" } } };
  };

  const accepted = await service.destroy(user, projectId, DESTROY_CONFIRMATION_PHRASE);
  assert.equal(accepted.deployment.state, "accepted");
  assert.ok(dispatched, "DESTROY reaches the destroy dispatch path");
  assert.deepEqual(dispatched?.slice(0, 3), [user, projectId, "destroy"]);

  dispatched = null;
  await assert.rejects(
    () => service.destroy(user, projectId, "DELETE"),
    (error: unknown) => error instanceof ForbiddenException && error.message === `Type ${DESTROY_CONFIRMATION_PHRASE} to confirm destroy.`,
    "an incorrect phrase is rejected before dispatch",
  );
  assert.equal(dispatched, null, "a rejected confirmation never reaches destroy dispatch");
}

void (async () => {
  await verifyApiBoundary();
  await verifyDispatchContract();
  console.log("DESTROY_CONFIRMATION_CONTRACT=PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
