import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { ProjectExtinctionIncompleteError, ProjectExtinctionService } from "../src/projects/project-extinction.service";

const projectId = "11111111-2222-4333-8444-555555555555";
const generationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const operationId = "99999999-8888-4777-8666-555555555555";
const project: any = {
  id: projectId, ownerUserId: 7, repositoryFullName: "owner/repository",
  targetBranch: "main", githubInstallationId: 42,
};
const verifiedDestroy: any = {
  id: operationId, projectId, generationId, status: PipelineRunStatus.COMPLETED,
  metadata: {
    deploymentAction: "destroy",
    destroyVerification: {
      status: "verified_destroyed", deploymentOperationId: operationId,
      projectOwnedAwsResourcesAbsent: true, allProjectTerraformArtifactsAbsent: true,
    },
  },
};

function harness(options: { sharedCaller?: boolean; failGithubRun?: boolean } = {}) {
  const calls: string[] = [];
  const service: any = Object.create(ProjectExtinctionService.prototype);
  service.projects = { count: async () => options.sharedCaller ? 1 : 0, exist: async () => false };
  service.generations = { find: async () => [{ id: generationId }] };
  service.runs = { find: async () => [{ id: operationId, githubWorkflowRunId: "123456" }, { id: "other-operation", githubWorkflowRunId: "123457" }] };
  service.subscriptions = { find: async () => [{ providerSubscriptionArn: "subscription", providerTopicArn: "topic" }] };
  service.sns = { extinguishProject: async (id: string) => calls.push(`sns:${id}`) };
  service.actions = { deleteWorkflowRun: async (_repo: string, runId: string) => {
    calls.push(`run:${runId}`);
    if (options.failGithubRun) throw new Error("GitHub run remains");
  } };
  service.githubApp = { removeManagedWorkflow: async () => calls.push("caller") };
  service.databaseOwnedRowIdentities = async () => ["related-row-id"];
  service.purgeQueueTraces = async (identities: string[]) => calls.push(`queues:${identities.includes("related-row-id")}`);
  service.dataSource = { transaction: async (work: (manager: any) => Promise<unknown>) => {
    calls.push("db-transaction");
    const manager: any = {
      getRepository(entity: any) {
        if (entity.name === "ProjectPipelineRun") return { findOne: async () => verifiedDestroy };
        return { findOne: async () => project, delete: async () => ({ affected: 1 }) };
      },
      query: async (sql: string) => sql.includes("information_schema.columns") ? [] : [],
    };
    return work(manager);
  } };
  return { service, calls };
}

async function run() {
  const incomplete = harness();
  await assert.rejects(
    incomplete.service.extinguish(project, { ...verifiedDestroy, metadata: { deploymentAction: "destroy", destroyVerification: { status: "verified_destroyed", deploymentOperationId: operationId } } }, "token"),
    (error: unknown) => error instanceof ProjectExtinctionIncompleteError && error.message.startsWith("DESTROY_INCOMPLETE:"),
  );
  assert.deepEqual(incomplete.calls, [], "no provider or database cleanup starts without project-wide absence evidence");

  const failure = harness({ failGithubRun: true });
  await assert.rejects(failure.service.extinguish(project, verifiedDestroy, "token"), /DESTROY_INCOMPLETE: GitHub run remains/);
  assert.equal(failure.calls.includes("db-transaction"), false, "database history remains retryable until external cleanup succeeds");

  const success = harness();
  const result = await success.service.extinguish(project, verifiedDestroy, "token");
  assert.deepEqual(result, { projectId, generationIds: [generationId], status: "extinct" });
  assert.deepEqual(success.calls, [`sns:${projectId}`, "run:123456", "run:123457", "caller", "queues:true", "db-transaction"]);

  const shared = harness({ sharedCaller: true });
  await shared.service.extinguish(project, verifiedDestroy, "token");
  assert.equal(shared.calls.includes("caller"), false, "a generic caller still used by another project is not deleted");

  const root = resolve(__dirname, "../..");
  const migration = readFileSync(resolve(root, "backend/src/migrations/1760000068000-ProjectExtinctionCascade.ts"), "utf8");
  const workflow = readFileSync(resolve(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
  const deployment = readFileSync(resolve(root, "backend/src/projects/github-actions-deployment.service.ts"), "utf8");
  const extinction = readFileSync(resolve(root, "backend/src/projects/project-extinction.service.ts"), "utf8");
  assert.match(migration, /ON DELETE CASCADE NOT VALID/);
  assert.match(migration, /column_name = 'project_id'/);
  assert.match(migration, /column_name = 'generation_id'/);
  assert.match(workflow, /purge_tagged_project_resources/);
  assert.match(workflow, /purge_project_state_versions/);
  assert.match(workflow, /projectOwnedAwsResourcesAbsent:true/);
  assert.match(workflow, /allProjectTerraformArtifactsAbsent:true/);
  assert.match(deployment, /currentStage = "project_extinction"/);
  assert.match(deployment, /errorMessage = "DESTROY_INCOMPLETE"/);
  assert.match(extinction, /json_agg\(source\.column_name ORDER BY source\.ordinal_position\) AS columns/, "text-column discovery uses a driver-stable JSON array");
  console.log("Project extinction checks passed: fail-closed external cleanup, project-wide evidence, transactional erasure, shared-caller isolation, and retryable failure semantics.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
