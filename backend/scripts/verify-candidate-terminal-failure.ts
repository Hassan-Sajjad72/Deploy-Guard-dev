import "reflect-metadata";
import { strict as assert } from "node:assert";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";

const project: any = {
  id: "9ffe6827-f55a-4469-ac80-64530f8cea2e",
  repositoryUrl: "https://github.com/owner/application.git",
  repositoryFullName: "owner/application",
  targetBranch: "main",
};

async function terminalFailure(requestedMode: "DEPLOY" | "RESET_FRESH" | "RETRY", retryOfOperationId?: string) {
  const service: any = Object.create(GithubActionsDeploymentService.prototype);
  const bound: Array<[string, string]> = [];
  const failed: Array<[string, string]> = [];
  service.nextAttempt = async () => 7;
  service.deploymentGenerations = {
    bindCreatingOperation: async (generationId: string, operationId: string) => { bound.push([generationId, operationId]); },
    markFailed: async (generationId: string, operationId: string) => { failed.push([generationId, operationId]); },
  };
  let persisted: any = null;
  const repository: any = {
    manager: {},
    create: (value: any) => value,
    save: async (value: any) => { persisted = value; return value; },
    createQueryBuilder: () => ({
      where() { return this; },
      andWhere() { return this; },
      orderBy() { return this; },
      getOne: async () => null,
    }),
  };
  const generationId = "404cd3c1-a7dd-4b26-85e9-f531b3cb7ef1";
  await service.failCandidateBeforeDispatch({ id: 7 }, project, repository, generationId, new Error("injected admission failure"), {
    requestedMode,
    ...(retryOfOperationId ? {
      retryOfOperationId,
      source: { id: retryOfOperationId, commitSha: "a".repeat(40), repositoryUrl: project.repositoryUrl, repositoryFullName: project.repositoryFullName, targetBranch: project.targetBranch },
    } : {}),
  });
  assert.equal(persisted.status, PipelineRunStatus.FAILED);
  assert.equal(persisted.currentStage, "candidate_preparation");
  assert.equal(persisted.metadata.deploymentMode, requestedMode);
  assert.equal(persisted.metadata.retryOfOperationId || null, retryOfOperationId || null);
  assert.deepEqual(bound, [[generationId, persisted.id]], "the exact persisted operation becomes generation authority before terminal transition");
  assert.deepEqual(failed, [[generationId, persisted.id]], "the exact persisted operation marks the candidate FAILED and clears its route identity");
}

async function main() {
  await terminalFailure("DEPLOY");
  await terminalFailure("RESET_FRESH");
  await terminalFailure("RETRY", "19686aa8-d31e-4d27-8ab5-429274ebfcbd");
  console.log("Candidate terminal-failure checks passed: Deploy, Reset-Fresh and Retry persist a failed operation and terminally release the exact candidate generation.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
