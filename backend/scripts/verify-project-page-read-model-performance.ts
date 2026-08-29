import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";

const projectId = "11111111-1111-4111-8111-111111111111";
const generationId = "22222222-2222-4222-8222-222222222222";
const user = { id: 7 } as any;

async function currentStateUsesOnlyItsPersistedProjection() {
  let awsEvidenceCalls = 0;
  const service = Object.create(ProjectCurrentStateService.prototype) as any;
  service.projectsService = {
    getProjectEntityForView: async () => ({ id: projectId, environment: "development" }),
  };
  service.profileRepository = { findOne: async () => null };
  service.preflightRepository = { findOne: async () => null };
  service.dataSource = { getRepository: () => ({ findOne: async () => ({ liveGenerationId: generationId, candidateGenerationId: null }) }) };
  service.releaseRepository = { findOne: async () => null };
  service.estimateRepository = { findOne: async () => null };
  service.generationRepository = { find: async () => [] };
  service.githubActionsReadinessState = () => ({ stableRelease: { generationId }, stableUrl: "https://app.example.test" });
  service.withGithubActionsState = async (_projectId: string, _environment: string, projected: unknown) => projected;
  service.withStateAuthority = (_projectId: string, _environment: string, projected: unknown) => projected;
  service.liveAwsEvidence = async () => { awsEvidenceCalls += 1; return null; };

  await service.getCurrentState(user, projectId);
  assert.equal(awsEvidenceCalls, 0, "ordinary current-state reads must not wait for AWS SDK inspection");

  let detailedOptions: unknown;
  service.getCurrentState = async (_user: unknown, _id: string, options: unknown) => {
    detailedOptions = options;
    return { developerState: "live" };
  };
  service.contractRepository = { findOne: async () => null };
  await service.getDetailedCurrentState(user, projectId);
  assert.deepEqual(detailedOptions, { refreshCloudState: true }, "only the detailed inspection endpoint may opt into AWS enrichment");
}

async function historyUsesOnlyPersistedOperations() {
  let reconcileCalls = 0;
  let githubTokenCalls = 0;
  let workflowStageCalls = 0;
  const operation = {
    id: "33333333-3333-4333-8333-333333333333",
    projectId,
    status: "queued",
    githubWorkflowRunId: "123456789",
    metadata: { executionEngine: "github_actions", workflowStages: [{ key: "build", status: "passed" }] },
  };
  const query = {
    where() { return this; },
    andWhere() { return this; },
    orderBy() { return this; },
    getMany: async () => [operation],
  };
  const service = Object.create(GithubActionsDeploymentService.prototype) as any;
  service.runs = { createQueryBuilder: () => query };
  service.project = async () => ({ id: projectId, repositoryFullName: "owner/repository", githubInstallationId: "installation" });
  service.reconcile = async () => { reconcileCalls += 1; };
  service.githubApp = { tokenForRepository: async () => { githubTokenCalls += 1; return { token: "never-used" }; } };
  service.workflowStages = async () => { workflowStageCalls += 1; return []; };
  service.response = (run: typeof operation) => ({ id: run.id, status: run.status });

  const result = await service.history(user, projectId);
  assert.deepEqual(result.operations, [{ id: operation.id, status: "queued", workflowStages: [{ key: "build", status: "passed" }] }]);
  assert.equal(reconcileCalls, 0, "history reads must not synchronously reconcile GitHub Actions");
  assert.equal(githubTokenCalls, 0, "history reads must not mint a GitHub token");
  assert.equal(workflowStageCalls, 0, "history reads must not fetch GitHub job details");
  const source = readFileSync(join(__dirname, "../src/projects/github-actions-deployment.service.ts"), "utf8");
  assert.match(source, /setInterval\(\(\) => void this\.reconcileActiveOperations\(\), intervalMs\)/, "GitHub status reconciliation must remain scheduled in the background");
  const troubleshooting = readFileSync(join(__dirname, "../src/ai-troubleshooting/ai-troubleshooting.service.ts"), "utf8");
  const listMethod = troubleshooting.match(/async list\([\s\S]*?\n  async get\(/)?.[0] || "";
  assert.match(listMethod, /provider: this\.provider\.status\(\)/, "Pipeline recovery reads must not probe the AI provider");
  assert.doesNotMatch(listMethod, /provider\.availability\(\)/, "Pipeline recovery reads must stay local");
}

async function main() {
  await currentStateUsesOnlyItsPersistedProjection();
  await historyUsesOnlyPersistedOperations();
  console.log("Project Overview/Pipeline read-model performance regression checks passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
