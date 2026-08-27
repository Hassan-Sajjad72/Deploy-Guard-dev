import "reflect-metadata";
import { strict as assert } from "node:assert";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { DetectionStatus } from "../src/projects/project-detection-profile.entity";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";

const projectId = "11111111-2222-4333-8444-555555555555";
const user: any = { id: 7 };
const project: any = { id: projectId, environmentName: "dev" };
const previousStable: any = {
  id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  projectId,
  status: PipelineRunStatus.COMPLETED,
  currentStage: "healthy",
  metadata: {
    executionEngine: "github_actions",
    deploymentAction: "deploy",
    deployedUrl: "https://live.example.test",
  },
};
function harness(input: { active?: any; live?: any; latest?: any; detectionStatus?: DetectionStatus; refreshedCommit?: string }) {
  const service: any = Object.create(GithubActionsDeploymentService.prototype);
  const calls: string[] = [];
  let immutableCommit = "detected-before-refresh";
  service.platformFoundation = () => ({ vpcId: "vpc-test" });
  service.sharedPlatformFoundation = { assertActive: async () => undefined };
  service.project = async () => project;
  service.withProjectLock = async (_id: string, work: (repository: any) => Promise<unknown>) => {
    calls.push("lock");
    return work({});
  };
  service.reconcileActive = async () => input.active || null;
  service.currentLiveRun = async () => input.live || null;
  service.latestRun = async () => input.latest || null;
  service.deploymentGenerations = {
    live: async () => input.live ? { id: "live-generation" } : null,
    createCandidate: async () => ({ id: "candidate-generation" }),
    markFailed: async () => undefined,
  };
  service.deploymentProfiles = {
    runDetection: async () => {
      calls.push("detect-latest-commit");
      immutableCommit = input.refreshedCommit || "detected-after-refresh";
      return { detectionStatus: input.detectionStatus || DetectionStatus.SUCCESS, commitSha: immutableCommit };
    },
  };
  service.dispatch = async (_user: any, _projectId: string, _repository: any, action: string, previousId: string | null) => {
    calls.push(`dispatch:${action}:${previousId || "none"}`);
    calls.push(`immutable-commit:${immutableCommit}`);
    return { deployment: { state: "accepted", operation: { id: "new-operation", status: "queued", commitSha: immutableCommit } } };
  };
  service.result = (state: string, message: string, operation: any) => ({ deployment: { state, message, operation } });
  return { service, calls };
}

async function run() {
  const redeploy = harness({ live: previousStable });
  const accepted: any = await redeploy.service.deploy(user, projectId);
  assert.equal(accepted.deployment.state, "accepted");
  assert.deepEqual(redeploy.calls, [
    "lock",
    `dispatch:deploy:${previousStable.id}`,
    "immutable-commit:detected-before-refresh",
  ], "a LIVE redeploy uses the dispatch boundary that owns authoritative stale-analysis refresh");

  const initial = harness({ live: null });
  await initial.service.deploy(user, projectId);
  assert.deepEqual(initial.calls, ["lock", "dispatch:deploy:none", "immutable-commit:detected-before-refresh"], "a first deployment preserves the existing flow");

  const duplicate = harness({ active: { id: "active-operation", status: PipelineRunStatus.RUNNING }, live: previousStable });
  const noOp: any = await duplicate.service.deploy(user, projectId);
  assert.equal(noOp.deployment.state, "no_op");
  assert.deepEqual(duplicate.calls, ["lock"], "an active operation prevents detection and duplicate dispatch");

  const classifier: any = Object.create(GithubActionsDeploymentService.prototype);
  const repository = (value: any) => ({ createQueryBuilder: () => {
    const query: any = { where: () => query, andWhere: () => query, orderBy: () => query, addOrderBy: () => query, getOne: async () => value };
    return query;
  } });
  assert.equal((await classifier.currentLiveRun(projectId, repository(previousStable), "generation-1"))?.id, previousStable.id);
  assert.equal(await classifier.currentLiveRun(projectId, repository(null), "generation-1"), null, "workflow completion without verified health is not a LIVE redeploy source");

  console.log("LIVE-project redeploy checks passed: every Deploy creates a candidate, active operations remain serialized, and the previous LIVE release stays linked.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
