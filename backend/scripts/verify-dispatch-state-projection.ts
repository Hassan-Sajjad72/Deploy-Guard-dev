import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { isAiTroubleshootingEligible } from "../src/ai-troubleshooting/ai-troubleshooting.service";

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

async function verifyCurrentStateProjection(failed: any) {
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
  assert.equal(state.latestAttempt.workflowRunId, null);
  assert.equal(state.developerState, "failed_application");
  assert.match(state.developerMessage, /could not start/i);
  assert.doesNotMatch(state.developerMessage, /GitHub Actions failed/i);
}

void (async () => {
  const failed = await verifyPreDispatchFailure();
  await verifyCurrentStateProjection(failed);
  const root = join(__dirname, "..", "..");
  const phases = readFileSync(join(root, "frontend", "src", "utils", "developerDeploymentPresentation.js"), "utf8");
  const routes = readFileSync(join(root, "frontend", "src", "routes", "AppRoutes.jsx"), "utf8");
  assert.doesNotMatch(phases, /key: "analyze"/);
  assert.match(phases, /Source \/ Dispatch/);
  assert.match(routes, /ProjectInfrastructure/);
  console.log("DISPATCH_STATE_PROJECTION=PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
