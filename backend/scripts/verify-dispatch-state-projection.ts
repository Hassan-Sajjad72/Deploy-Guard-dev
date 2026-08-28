import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { isAiTroubleshootingEligible } from "../src/ai-troubleshooting/ai-troubleshooting.service";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
import { githubActionsFailureLifecyclePhase } from "../src/projects/pipeline/github-actions-stage-presentation";
import { GithubActionsService } from "../src/projects/pipeline/github-actions.service";

const user = { id: 7 } as any;
const project = {
  id: "11111111-1111-4111-8111-111111111111", ownerUserId: 7,
  repositoryUrl: "https://github.com/example/application.git", repositoryFullName: "example/application",
  targetBranch: "main", githubInstallationId: "42", environmentName: "dev",
};

async function verifyPreDispatchFailure() {
  const saved: any[] = [];
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.projects = { findOne: async () => project };
  service.runs = {
    findOne: async () => null,
    count: async () => 0,
    create: (row: any) => row,
    save: async (row: any) => { saved.push(structuredClone(row)); return row; },
  };
  service.config = { get: (key: string, fallback = "") => key === "DEPLOYGUARD_REUSABLE_WORKFLOW" ? "Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@0123456789abcdef0123456789abcdef01234567" : fallback };
  service.githubApp = {
    tokenForRepository: async () => {
      assert.equal(saved[0]?.status, PipelineRunStatus.QUEUED, "attempt must exist before GitHub authentication");
      assert.equal(saved[0]?.metadata?.executionEngine, "railpack");
      throw new Error("caller reconciliation permission was denied");
    },
  };
  const result = await service.deploy(user, project.id);
  assert.equal(result.deployment.state, "dispatch_failed");
  const failed = saved.at(-1);
  assert.equal(failed.status, PipelineRunStatus.FAILED);
  assert.equal(failed.githubWorkflowStatus, "not_dispatched");
  assert.equal(failed.githubWorkflowRunId, undefined);
  assert.equal(failed.metadata.dispatchState, "failed");
  assert.equal(failed.metadata.failureSource, "deployguard_dispatch");
  assert.equal(typeof failed.metadata.safeLog, "string");
  assert.equal(isAiTroubleshootingEligible(failed), true, "sanitized dispatch failure must be troubleshooting eligible");
  return failed;
}

async function verifyCurrentStateProjection(failed: any, realGithubRun = false) {
  const queries: string[] = [];
  const builder: any = {
    where(value: string) { queries.push(value); return this; },
    andWhere(value: string) { queries.push(value); return this; },
    orderBy() { return this; }, clone() { return this; },
    getOne: async () => failed,
  };
  const service = Object.create(ProjectCurrentStateService.prototype) as any;
  service.runRepository = { createQueryBuilder: () => builder };
  const base = {
    repository: project.repositoryFullName, branch: project.targetBranch, commit: null, latestAttempt: null,
    stableRelease: null, stableUrl: null, estimatedCost: null, missingConfiguration: [], advisories: [], applicationError: null,
    canRetry: false, stateAuthority: null,
    developerState: "ready", developerAction: "deploy", developerMessage: "ready", progress: { percentage: 0, phase: null, label: "Ready" },
  };
  const state = await service.withGithubActionsState(project.id, "dev", base, null);
  assert.ok(queries.some((query) => query.includes("'railpack'")), "current state must select Railpack operations");
  assert.equal(state.latestAttempt.operationId, failed.id);
  assert.equal(state.latestAttempt.workflowRunId, realGithubRun ? "123" : null);
  assert.equal(state.developerState, "failed_application");
  if (realGithubRun) {
    assert.equal(state.progress.phase, "build", "Railpack build failure must not project as runtime deployment");
    assert.deepEqual(state.latestAttempt.workflowStages?.map((stage) => [stage.key, stage.status]), [
      ["checkout_exact_application_source", "passed"],
      ["install_pinned_railpack", "passed"],
      ["build_and_push_immutable_railpack_image", "failed"],
      ["publish_immutable_image_to_ecr", "skipped"],
      ["install_terraform", "skipped"],
    ]);
  } else {
    assert.match(state.developerMessage, /could not start/i);
    assert.doesNotMatch(state.developerMessage, /GitHub Actions failed/i);
  }
}

async function verifyTerminalGithubFailure() {
  const saved: any[] = [];
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.projects = { findOne: async () => project };
  service.users = { findOne: async () => user };
  service.githubApp = { tokenForRepository: async () => ({ token: "ignored" }) };
  service.runs = { save: async (row: any) => { saved.push(structuredClone(row)); return row; } };
  const githubActions = Object.create(GithubActionsService.prototype) as any;
  githubActions.getWorkflowJobs = async () => ({ jobs: [{
    id: 45, name: "deploy", status: "completed", conclusion: "failure", html_url: "https://github.example/actions/runs/123",
    steps: [
      { name: "Checkout exact application source", status: "completed", conclusion: "success" },
      { name: "Install pinned Railpack", status: "completed", conclusion: "success" },
      { name: "Build and push immutable Railpack image", status: "completed", conclusion: "failure" },
      { name: "Publish immutable image to ECR", status: "completed", conclusion: "skipped" },
      { name: "Install Terraform", status: "completed", conclusion: "skipped" },
    ],
  }] });
  githubActions.getJobLog = async () => "Railpack 0.38.0\nERRO BUILDKIT_HOST environment variable is not set.\ntoken=ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const githubEvidence = await githubActions.getTerminalFailureEvidence("example/application", "123", "ignored");
  assert.ok(githubEvidence);
  assert.equal(githubEvidence.failedStage, "build_and_push_immutable_railpack_image");
  assert.deepEqual(githubEvidence.workflowStages.map((stage: any) => [stage.key, stage.status]), [
    ["checkout_exact_application_source", "passed"],
    ["install_pinned_railpack", "passed"],
    ["build_and_push_immutable_railpack_image", "failed"],
    ["publish_immutable_image_to_ecr", "skipped"],
    ["install_terraform", "skipped"],
  ]);
  service.actions = { getTerminalFailureEvidence: async () => githubEvidence };
  service.sanitizer = new LogSanitizerService();
  const evidence = await service.terminalFailureEvidence("example/application", "123", "ignored");
  assert.equal(evidence.failedStage, "build_and_push_immutable_railpack_image");
  assert.match(evidence.safeLog, /BUILDKIT_HOST environment variable is not set/);
  assert.doesNotMatch(evidence.safeLog, /ghp_/);
  const failedRun = {
    id: "22222222-2222-4222-8222-222222222222", projectId: project.id, githubWorkflowRunId: "123",
    status: PipelineRunStatus.RUNNING, currentStage: evidence.failedStage, commitSha: "a".repeat(40),
    metadata: { executionEngine: "railpack", deploymentAction: "deploy", safeLog: evidence.safeLog, failedStage: evidence.failedStage, workflowStages: evidence.workflowStages, workflowConclusion: "failure" },
    errorMessage: evidence.safeLog, updatedAt: new Date(), failedAt: new Date(), completedAt: new Date(), createdAt: new Date(), generationId: null,
  };
  assert.equal(githubActionsFailureLifecyclePhase(failedRun.currentStage), "build");
  service.actions.getWorkflowRun = async () => ({ status: "completed", conclusion: "failure" });
  await service.reconcile(failedRun);
  const persisted = saved.at(-1);
  assert.equal(persisted.status, PipelineRunStatus.FAILED);
  assert.equal(persisted.metadata.workflowConclusion, "failure");
  assert.equal(persisted.metadata.failedStage, "build_and_push_immutable_railpack_image");
  assert.match(persisted.metadata.safeLog, /BUILDKIT_HOST environment variable is not set/);
  assert.doesNotMatch(persisted.metadata.safeLog, /ghp_/);
  assert.equal(isAiTroubleshootingEligible(persisted), true, "terminal GitHub failure with sanitized evidence must be eligible");
  return failedRun;
}

void (async () => {
  const failed = await verifyPreDispatchFailure();
  await verifyCurrentStateProjection(failed);
  const terminalFailure = await verifyTerminalGithubFailure();
  await verifyCurrentStateProjection(terminalFailure, true);
  const root = join(__dirname, "..", "..");
  const phases = readFileSync(join(root, "frontend", "src", "utils", "developerDeploymentPresentation.js"), "utf8");
  const routes = readFileSync(join(root, "frontend", "src", "routes", "AppRoutes.jsx"), "utf8");
  const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
  assert.doesNotMatch(phases, /key: "analyze"/);
  assert.match(phases, /Source \/ Dispatch/);
  assert.match(routes, /ProjectInfrastructure/);
  assert.match(workflow, /tmpdir="\$\(mktemp -d\)"/);
  assert.match(workflow, /test ! -f \/tmp\/railpack/);
  assert.doesNotMatch(workflow, /-o \/tmp\/railpack\.tgz/);
  assert.match(workflow, /name: Build immutable Railpack image[\s\S]*?if: success\(\) && inputs\.deployment_action == 'deploy'/);
  assert.match(workflow, /name: Publish immutable image to ECR[\s\S]*?steps\.build\.outputs\.image != ''/);
  assert.match(workflow, /name: Install Terraform[\s\S]*?steps\.image\.outputs\.image != ''/);
  assert.match(workflow, /name: Materialize release runtime[\s\S]*?steps\.image\.outputs\.image != ''/);
  assert.match(workflow, /name: Publish verified release result[\s\S]*?if: success\(\) && hashFiles/);
  assert.match(workflow, /BUILDKIT_HOST="docker-container:\/\/\$\{BUILDKIT_CONTAINER\}" railpack build --name/);
  assert.match(workflow, /docker exec "\$BUILDKIT_CONTAINER" buildctl debug workers/);
  assert.match(workflow, /name: Clean up Railpack BuildKit daemon[\s\S]*?if: always\(\)/);
  console.log("DISPATCH_STATE_PROJECTION=PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
