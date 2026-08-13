import { strict as assert } from "node:assert";
import { GithubActionsCostEvidenceService } from "../src/projects/github-actions-cost-evidence.service";
import { CostEstimateStatus } from "../src/finops/project-cost-estimate.entity";

const estimates: any[] = [];
const artifactRequests: Array<{ runId: string; name: string }> = [];
const repository = {
  findOne: async () => null,
  create: (value: any) => ({ ...value }),
  save: async (value: any) => {
    const index = estimates.findIndex((item) => item === value || item.pipelineRunId === value.pipelineRunId);
    if (index >= 0) estimates[index] = value; else estimates.push(value);
    return value;
  },
};
const actions = {
  getArtifactEntry: async (_repo: string, runId: string, _operation: string, _token: string, name: string) => {
    artifactRequests.push({ runId, name });
    if (name === "terraform/deployguard-cost-plan.json") return '{"projects":[{"breakdown":{"resources":[{"name":"aws_ecs_service.app","resourceType":"aws_ecs_service","monthlyCost":"7.25"}]}}]}';
    if (name === "project-terraform/deployguard-project-cost-plan.json") return '{"projects":[{"breakdown":{"resources":[{"name":"aws_efs_file_system.database","resourceType":"aws_efs_file_system","monthlyCost":"2.50"}]}}]}';
    return null;
  },
};
const infracost = {
  runInfracostBreakdown: async (plan: string) => plan,
  parseInfracostResponse: (value: string) => JSON.parse(value),
  normalizeCostBreakdown: (value: any) => value.projects.flatMap((project: any) => project.breakdown.resources).map((resource: any) => ({
    resourceType: resource.resourceType,
    resourceName: resource.name,
    serviceName: resource.resourceType,
    monthlyCost: Number(resource.monthlyCost),
    metadata: { source: "infracost" },
  })),
};
const config = { get: (key: string, fallback?: string) => key === "INFRACOST_API_KEY" ? "configured" : fallback };
const service = new GithubActionsCostEvidenceService(repository as never, actions as never, infracost as never, config as never);

async function run() {
  const operation = {
    id: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    generationId: "33333333-3333-4333-8333-333333333333",
    githubWorkflowRunId: "promotion-run",
    triggeredByUserId: 7,
    metadata: { deploymentAction: "deploy", candidateWorkflowRunId: "candidate-run", terraformPlanSummary: { create: 2 } },
  };
  const result = await service.capture(operation as never, "owner/repository", "token", "dev");
  assert.equal(result?.status, CostEstimateStatus.NO_APPROVAL_REQUIRED);
  assert.equal(result?.totalMonthlyCost, 9.75);
  assert.deepEqual(result?.metadata?.terraformScopes, ["generation", "project"]);
  assert.deepEqual(((result?.normalizedBreakdown as { resources: any[] })?.resources || []).map((item) => item.metadata.terraformScope), ["generation", "project"]);
  assert.equal(result?.generationId, operation.generationId);
  assert.equal(result?.pipelineRunId, operation.id);
  assert.equal(result?.metadata?.candidateWorkflowRunId, "candidate-run");
  assert.deepEqual(artifactRequests, [
    { runId: "candidate-run", name: "terraform/deployguard-cost-plan.json" },
    { runId: "candidate-run", name: "project-terraform/deployguard-project-cost-plan.json" },
  ]);
  console.log("GitHub Actions Infracost evidence checks passed: exact operation/generation plans are aggregated and persisted.");
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
