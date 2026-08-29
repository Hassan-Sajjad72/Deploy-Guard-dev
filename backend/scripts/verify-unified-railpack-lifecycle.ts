import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProjectStableRelease, StableReleaseStatus } from "../src/orchestration/project-stable-release.entity";
import { LiveRuntimeIdentityRecoveryService } from "../src/projects/current-state/live-runtime-identity-recovery.service";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "../src/projects/project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "../src/projects/project-environment-route.entity";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { ProjectsController } from "../src/projects/projects.controller";
import { UserRole } from "../src/users/user.entity";

const projectId = "122a34a1-5d28-4f39-bb51-28379671fdb4";
const operationA = "f07a2838-82fc-4590-9be5-465f38aa5be4";
const operationB = "7fcf0947-d66e-4d79-9cfc-9879d0022548";
const sourceA = "610aba282a1b0000000000000000000000000000";
const digestA = `sha256:${"a".repeat(64)}`;
const imageUri = `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-${projectId}`;

function releaseA(): any {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    projectId,
    environmentName: "dev",
    generationId: operationA,
    deployedByPipelineRunId: operationA,
    status: StableReleaseStatus.ROLLBACK_TARGET,
    commitSha: sourceA,
    shortCommitSha: sourceA.slice(0, 12),
    imageUri,
    taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/dg:1",
    ecsServiceArn: "arn:aws:ecs:us-east-1:123456789012:service/dg-cluster/dg-service",
    appPort: 8080,
    healthCheckPath: "/",
    deployedAt: new Date("2026-08-29T08:00:00.000Z"),
    metadata: { imageDigest: digestA, releaseEvidenceVerified: true, deployedUrl: "http://dg.example.test" },
  };
}

async function verifyRollbackAuthority() {
  const target = releaseA();
  const project: any = { id: projectId, environmentName: "dev" };
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.project = async () => project;
  service.releases = { findOne: async ({ where }: any) => where.status === StableReleaseStatus.ROLLBACK_TARGET ? target : null };
  const candidates = await service.rollbackCandidates({ id: 1 }, projectId);
  assert.equal(candidates.candidates.length, 1);
  assert.deepEqual(Object.keys(candidates.candidates[0]).sort(), ["appPort", "commitSha", "deployedAt", "generationId", "healthCheckPath", "imageDigest", "imageUri", "releaseId", "releaseRevision", "targetOperationId"].sort());
  assert.equal(candidates.candidates[0].targetOperationId, operationA);
  assert.equal(candidates.candidates[0].commitSha, sourceA);
  assert.equal(candidates.candidates[0].imageUri, imageUri);
  assert.equal(candidates.candidates[0].imageDigest, digestA);
  let dispatchArgs: any[] = [];
  service.dispatch = async (...args: any[]) => { dispatchArgs = args; return { deployment: { state: "accepted" } }; };
  await service.rollback({ id: 1 }, projectId, operationA);
  assert.equal(dispatchArgs[2], "rollback");
  assert.equal(dispatchArgs[3].immutableImage, `${imageUri}@${digestA}`);
  assert.equal(dispatchArgs[3].sourceSha, sourceA);

  const failed: any = { projectId, metadata: { deploymentAction: "rollback", rollbackTarget: dispatchArgs[3] } };
  service.runs = { findOne: async () => failed };
  dispatchArgs = [];
  await service.retry({ id: 1 }, projectId);
  assert.deepEqual(dispatchArgs[3], failed.metadata.rollbackTarget, "failed rollback retry must preserve the exact immutable target");
  assert.equal(dispatchArgs[4], undefined === failed.id ? null : failed.id);

  service.releases.findOne = async () => ({ ...target, imageUri: "docker.io/example/app" });
  await assert.rejects(() => service.rollbackCandidates({ id: 1 }, projectId), /immutable ECR release evidence/);

  const completedAt = new Date("2026-08-29T09:00:00.000Z");
  const currentOperation: any = { id: operationB, projectId, generationId: operationB, status: PipelineRunStatus.COMPLETED, currentStage: "release_complete", githubWorkflowRunId: "123", commitSha: "0fd1d77c357ce2ef7e49bf584fac60500c340532", createdAt: completedAt, startedAt: completedAt, completedAt, updatedAt: completedAt, failedAt: null, metadata: { executionEngine: "railpack", deploymentAction: "deploy", releaseEvidenceVerified: true } };
  const currentRelease: any = { ...target, id: "current-release", generationId: operationB, deployedByPipelineRunId: operationB, status: StableReleaseStatus.STABLE, deployedAt: completedAt, metadata: { ...target.metadata, deployedUrl: "http://dg.example.test" } };
  const builder: any = { where() { return this; }, andWhere() { return this; }, orderBy() { return this; }, clone() { return this; }, getOne: async () => currentOperation };
  const currentState = Object.create(ProjectCurrentStateService.prototype) as any;
  currentState.runRepository = { createQueryBuilder: () => builder };
  currentState.releaseRepository = { findOne: async () => target };
  const base: any = { repository: "owner/repo", branch: "main", commit: null, latestAttempt: null, stableRelease: null, stableUrl: null, estimatedCost: null, missingConfiguration: [], advisories: [], applicationError: null, canRetry: false, stateAuthority: null, developerState: "ready", developerAction: "deploy", developerMessage: "ready", progress: { percentage: 0, phase: null, label: "Ready" } };
  const withTarget = await currentState.withGithubActionsState(projectId, "dev", base, operationB, currentRelease);
  assert.equal(withTarget.stableRelease.rollbackAvailable, true, "rollback availability comes from canonical rollback-target existence");
  currentState.releaseRepository.findOne = async () => null;
  const initialDeploy = await currentState.withGithubActionsState(projectId, "dev", base, operationB, currentRelease);
  assert.equal(initialDeploy.stableRelease.rollbackAvailable, false, "an initial deploy with no previous release cannot roll back");
}

async function verifyHistoricalIdentityRecovery() {
  const generation: any = {
    id: operationB, projectId, environmentName: "dev", status: DeploymentGenerationStatus.LIVE,
    resourceManifest: { ecsServiceArn: "arn:aws:ecs:us-east-1:123456789012:service/dg-cluster/dg-service", taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/dg:2", publicUrl: "http://dg.example.test", imageUri, imageDigest: digestA, terraformStateKey: `projects/${projectId}/dev/runtime/terraform.tfstate` },
  };
  const release: any = {
    ...releaseA(), id: "66666666-7777-4888-8999-000000000000", generationId: operationB, deployedByPipelineRunId: operationB,
    status: StableReleaseStatus.STABLE, taskDefinitionArn: generation.resourceManifest.taskDefinitionArn,
    metadata: { imageDigest: digestA, releaseEvidenceVerified: true, deployedUrl: "http://dg.example.test", runtimeIdentity: generation.resourceManifest },
  };
  const route: any = { id: "77777777-8888-4999-8aaa-bbbbbbbbbbbb", projectId, environmentName: "dev", liveGenerationId: operationB, metadata: {} };
  const generationRepository: any = { findOne: async () => generation, save: async (value: any) => Object.assign(generation, value) };
  const releaseRepository: any = { findOne: async () => release, save: async (value: any) => Object.assign(release, value) };
  const routeRepository: any = { findOne: async () => route, save: async (value: any) => Object.assign(route, value) };
  let persisted = 0;
  const dataSource: any = { transaction: async (work: any) => work({
    query: async () => undefined,
    getRepository: (entity: unknown) => entity === ProjectDeploymentGeneration ? { ...generationRepository, save: async (value: any) => { persisted += 1; return generationRepository.save(value); } }
      : entity === ProjectStableRelease ? { ...releaseRepository, save: async (value: any) => { persisted += 1; return releaseRepository.save(value); } }
        : { ...routeRepository, save: async (value: any) => { persisted += 1; return routeRepository.save(value); } },
  }) };
  const recovery: any = new LiveRuntimeIdentityRecoveryService(generationRepository, releaseRepository, routeRepository, dataSource);
  let awsReads = 0;
  recovery.ecs = () => ({ send: async (command: any) => {
    awsReads += 1;
    if (command.constructor.name === "DescribeServicesCommand") return { services: [{ serviceArn: release.ecsServiceArn, serviceName: "dg-service", clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/dg-cluster", status: "ACTIVE", taskDefinition: release.taskDefinitionArn, loadBalancers: [{ containerName: "application", targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/dg/abc" }], tags: [{ key: "ManagedBy", value: "DeployGuard" }, { key: "DeployGuardProjectId", value: projectId }, { key: "DeployGuardOperationId", value: operationB }] }] };
    return { taskDefinition: { containerDefinitions: [{ name: "application", image: `${imageUri}@${digestA}`, logConfiguration: { options: { "awslogs-group": `/deployguard/${projectId}/application`, "awslogs-stream-prefix": "application" } } }] }, tags: [{ key: "ManagedBy", value: "DeployGuard" }, { key: "DeployGuardProjectId", value: projectId }, { key: "DeployGuardOperationId", value: operationB }] };
  } });
  recovery.elb = () => ({ send: async (command: any) => {
    awsReads += 1;
    if (command.constructor.name === "DescribeTargetGroupsCommand") return { TargetGroups: [{ TargetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/dg/abc", TargetGroupName: "dg", LoadBalancerArns: ["arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/dg/def"] }] };
    if (command.constructor.name === "DescribeTagsCommand") return { TagDescriptions: [{ Tags: [{ Key: "ManagedBy", Value: "DeployGuard" }, { Key: "DeployGuardProjectId", Value: projectId }, { Key: "DeployGuardOperationId", Value: operationB }] }] };
    return { LoadBalancers: [{ LoadBalancerArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/dg/def", LoadBalancerName: "dg", DNSName: "dg.example.test" }] };
  } });
  const identity = await recovery.recover({ id: projectId, environmentName: "dev" });
  assert.equal(identity.ecsClusterName, "dg-cluster");
  assert.equal(identity.targetGroupName, "dg");
  assert.equal(identity.cloudWatchLogGroupName, `/deployguard/${projectId}/application`);
  assert.equal(identity.applicationContainerName, "application");
  assert.equal(persisted, 3, "recovered safe identity is persisted to generation, stable release, and route");
  const readsAfterRecovery = awsReads;
  await recovery.recover({ id: projectId, environmentName: "dev" });
  assert.equal(awsReads, readsAfterRecovery, "complete recovered identity is idempotent and avoids repeated AWS reconstruction");
}

async function verifyDeveloperInfrastructureContract() {
  const controller: any = Object.create(ProjectsController.prototype);
  const expected = { stateAuthority: { state: "LIVE" }, infrastructureEvidence: { runtimeIdentity: { imageUri } } };
  controller.projectCurrentStateService = { getDetailedCurrentState: async (actor: any) => {
    assert.equal(actor.role, UserRole.DEVELOPER);
    return expected;
  } };
  assert.equal(await controller.getDetailedCurrentState({ user: { id: 7, role: UserRole.DEVELOPER } }, projectId), expected);
  controller.projectCurrentStateService.getDetailedCurrentState = async () => { throw new Error("Project not found"); };
  await assert.rejects(() => controller.getDetailedCurrentState({ user: { id: 8, role: UserRole.DEVELOPER } }, projectId), /Project not found/);
}

function verifyWorkflowAndUiContract() {
  const root = join(__dirname, "..", "..");
  const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
  const frontend = readFileSync(join(root, "frontend", "src", "components", "projects", "ProjectOverviewLifecycle.jsx"), "utf8");
  const controller = readFileSync(join(root, "backend", "src", "projects", "projects.controller.ts"), "utf8");
  assert.match(frontend, /target\.targetOperationId/);
  assert.match(workflow, /Checkout exact application source[\s\S]*?if: inputs\.deployment_action == 'deploy'/);
  assert.match(workflow, /Build immutable Railpack image[\s\S]*?inputs\.deployment_action == 'deploy'/);
  assert.match(workflow, /Publish immutable image to ECR[\s\S]*?inputs\.deployment_action == 'deploy'/);
  assert.match(workflow, /Select immutable rollback image[\s\S]*?inputs\.deployment_action == 'rollback'/);
  assert.match(workflow, /ROLLBACK_IMAGE_DIGEST[\s\S]*?@sha256:\[0-9a-f\]\{64\}/);
  assert.match(workflow, /terraform -chdir=\.deployguard\/terraform apply/);
  assert.match(workflow, /aws ecs wait services-stable/);
  assert.match(workflow, /curl --fail/);
  assert.match(workflow, /Publish verified release result/);
  const detailsRoute = /@Get\(":projectId\/current-state\/details"\)([\s\S]*?)async getDetailedCurrentState/.exec(controller)?.[1] || "";
  assert.doesNotMatch(detailsRoute, /UserRole\.ADMIN/, "normal Infrastructure details must not require ADMIN");
}

void (async () => {
  await verifyRollbackAuthority();
  await verifyHistoricalIdentityRecovery();
  await verifyDeveloperInfrastructureContract();
  verifyWorkflowAndUiContract();
  console.log("UNIFIED_RAILPACK_LIFECYCLE=PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
