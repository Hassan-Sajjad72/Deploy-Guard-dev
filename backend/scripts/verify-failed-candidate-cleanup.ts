import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DeploymentGenerationService } from "../src/projects/deployment-generation.service";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { DeploymentGenerationStatus, ProjectDeploymentGeneration } from "../src/projects/project-deployment-generation.entity";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { githubActionsFailureMessage } from "../src/projects/pipeline/github-actions-stage-presentation";

const projectId = "620f00cc-89e8-4376-83e3-42e3a19a602e";
const generationId = "8ad6089e-ed5c-4385-bbcd-9cb731048213";
const operationId = "79beef72-c8a8-4441-baf0-faac1ffd9e5f";
const stateKey = `projects/${projectId}/dev/${generationId}/terraform.tfstate`;

function generationFixture(status = DeploymentGenerationStatus.DEPLOYING) {
  return {
    id: generationId,
    projectId,
    environmentName: "dev",
    ordinal: 2,
    candidateListenerPriority: 21002,
    status,
    terraformStateKey: stateKey,
    resourceManifest: {
      ecsServiceArn: "arn:aws:ecs:us-east-1:123456789012:service/shared/failed-candidate",
      targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/failed/0123456789abcdef",
      candidateListenerRuleArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:listener-rule/app/shared/id/listener/rule",
      securityGroupIds: ["sg-0123456789abcdef0"],
    },
    cleanupMetadata: {},
    createdByOperationId: operationId,
    retiredByOperationId: null,
    activatedAt: null,
    retiredAt: null,
    failedAt: null,
    cleanedAt: null,
    metadata: { activeOperationId: operationId },
  } as unknown as ProjectDeploymentGeneration;
}

async function lifecycleChecks() {
  let generation = generationFixture();
  const saved: ProjectDeploymentGeneration[] = [];
  const repository: any = {
    findOne: async () => generation,
    save: async (value: ProjectDeploymentGeneration) => {
      generation = value;
      saved.push(value);
      return value;
    },
  };
  const routes: any = { findOne: async () => null, save: async (value: unknown) => value };
  const service: any = Object.create(DeploymentGenerationService.prototype);
  service.generations = repository;
  service.routes = routes;

  await service.markFailed(generationId, operationId, "candidate health failed", undefined, { cleanupRequired: true });
  assert.equal(generation.status, DeploymentGenerationStatus.FAILED, "deployment lifecycle evidence remains FAILED");
  assert.equal(generation.cleanupMetadata.cleanupKind, "failed_candidate");
  assert.equal(generation.cleanupMetadata.cleanupStatus, "pending");
  const target = await service.cleanupTarget(generationId);
  assert.equal(target.terraformStateKey, stateKey, "cleanup uses the exact generation state key");
  assert.deepEqual(Object.keys(target.resources).sort(), ["candidateListenerRuleArn", "ecsServiceArn", "securityGroupIds", "targetGroupArn"]);

  await service.markCleanupPending(generationId, { cleanupOperationId: "11111111-1111-4111-8111-111111111111", error: "injected cleanup failure" });
  assert.equal(generation.status, DeploymentGenerationStatus.FAILED, "cleanup failure cannot resurrect or replace FAILED lifecycle state");
  assert.equal(generation.cleanupMetadata.cleanupStatus, "pending");
  await service.markCleaned(generationId, { cleanupOperationId: "22222222-2222-4222-8222-222222222222" });
  assert.equal(generation.status, DeploymentGenerationStatus.FAILED, "successful cleanup preserves failed deployment history");
  assert.equal(generation.cleanupMetadata.cleanupStatus, "cleaned");
  assert.deepEqual(generation.resourceManifest, {});
  await assert.rejects(
    service.requireRetryableGeneration(generationId, projectId, "dev"),
    /being cleaned/,
    "deployment Retry cannot race or reactivate a failed generation whose cleanup has started",
  );
  assert.ok(saved.length >= 3);
}

async function terminalTriggerCheck() {
  const service: any = Object.create(GithubActionsDeploymentService.prototype);
  const scheduled: string[] = [];
  const failedCalls: unknown[][] = [];
  service.sanitizer = { sanitize: (value: string) => value };
  service.runs = { save: async (value: unknown) => value };
  service.deploymentGenerations = {
    markFailed: async (...args: unknown[]) => { failedCalls.push(args); },
  };
  service.scheduleFailedCandidateCleanup = async (_project: unknown, operation: { id: string }) => { scheduled.push(operation.id); };
  service.logger = { warn: () => undefined };
  const operation: any = {
    id: operationId,
    projectId,
    generationId,
    status: PipelineRunStatus.RUNNING,
    metadata: { executionEngine: "github_actions", deploymentAction: "deploy", workflowPhase: "candidate" },
  };
  const project: any = { id: projectId };
  const saved = await service.failCandidateOperation(operation, { jobs: [] }, "candidate failed", undefined, { project, token: "redacted" });
  assert.equal(saved.status, PipelineRunStatus.FAILED);
  assert.equal(saved.metadata.promotionState, "candidate_failed_before_cutover");
  assert.equal((failedCalls[0]?.[4] as { cleanupRequired: boolean }).cleanupRequired, true);
  assert.deepEqual(scheduled, [operationId], "terminal pre-promotion failure schedules exact-generation cleanup once");

  const buildFailure: any = {
    id: "33333333-3333-4333-8333-333333333333",
    projectId,
    generationId,
    status: PipelineRunStatus.RUNNING,
    metadata: { executionEngine: "github_actions", deploymentAction: "deploy", workflowPhase: "candidate" },
  };
  const buildFailed = await service.failCandidateOperation(buildFailure, {
    jobs: [{ conclusion: "failure", steps: [{ conclusion: "failure", name: "Build and push immutable image" }] }],
  }, "apk failed");
  assert.equal(buildFailed.currentStage, "build_and_push_immutable_image");
  assert.equal(buildFailed.errorMessage, "GitHub Actions failed during Building and publishing container image.", "a build failure must not be presented as provisioning or health failure");
}

function staticBoundaryChecks() {
  const root = resolve(__dirname, "../..");
  const deployment = readFileSync(resolve(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
  const workflow = readFileSync(resolve(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
  assert.match(deployment, /cleanupReason: "failed_candidate"/);
  assert.match(deployment, /internalMaintenance: true/);
  assert.match(deployment, /COALESCE\(run\.metadata ->> 'internalMaintenance', 'false'\) != 'true'/,
    "cleanup debt is outside the developer-operation lane, so a fresh deploy is not blocked");
  assert.match(workflow, /terraform -chdir=\.deployguard\/retired-terraform plan -destroy/);
  assert.match(workflow, /key=\$RETIRED_STATE_KEY/);
  const cleanupStep = workflow.match(/- name: Clean exact generation independently[\s\S]*?- name: Verify exact project deletion/)?.[0] || "";
  assert.doesNotMatch(cleanupStep, /projectPersistence\.stateKey|managedDatabase|aws efs delete|aws secretsmanager delete/,
    "generation cleanup cannot address project database, EFS, secrets, or project Terraform state");
}

function historicalPresentationCheck() {
  assert.equal(
    githubActionsFailureMessage("Candidate provisioning or health verification failed.", "build_and_push_immutable_image", "deploy"),
    "GitHub Actions failed during Building and publishing container image.",
    "existing rows with the legacy generic message project their authoritative build stage",
  );
}

async function main() {
  await lifecycleChecks();
  await terminalTriggerCheck();
  historicalPresentationCheck();
  staticBoundaryChecks();
  console.log("Failed-candidate cleanup checks passed: exact-state cleanup, persistence isolation, idempotent debt, preserved FAILED evidence, and non-blocking fresh Deploy.");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
