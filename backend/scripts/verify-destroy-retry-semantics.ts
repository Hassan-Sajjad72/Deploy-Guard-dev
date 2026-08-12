import "reflect-metadata";
import { strict as assert } from "node:assert";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { WorkflowAwsCapabilityError } from "../src/projects/github-actions-aws-capability.service";
import {
  GITHUB_ACTIONS_INPUT_NAMES,
  GithubActionsOperationInputs,
  immutableDispatchFingerprint,
} from "../src/projects/github-actions-operation-contract";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";

const projectId = "b713ea5b-589b-4ab4-8175-6af7dc2ed402";
const generationId = "404cd3c1-a7dd-4b26-85e9-f531b3cb7ef1";
const historicalGenerationId = "11111111-2222-4333-8444-555555555555";
const sourceId = "19686aa8-d31e-4d27-8ab5-429274ebfcbd";
const commitSha = "a".repeat(40);
const inputs = Object.fromEntries(GITHUB_ACTIONS_INPUT_NAMES.map((name) => [name, "fixture"])) as GithubActionsOperationInputs;
Object.assign(inputs, {
  deployment_action: "destroy",
  deployment_operation_id: sourceId,
  project_id: projectId,
  repository_full_name: "owner/flask-hello-world",
  repository_branch: "master",
  commit_sha: commitSha,
  environment_references_base64: Buffer.from(JSON.stringify({
    public: ["PUBLIC_SETTING"], secret: ["SECRET_SETTING"], configurationFingerprint: "f".repeat(64),
    extinction: { projectId, knownGenerationIds: [generationId] },
  })).toString("base64"),
});
const source: any = {
  id: sourceId,
  projectId,
  generationId,
  triggeredByUserId: 7,
  detectionProfileId: "profile-id",
  repositoryUrl: "https://github.com/owner/flask-hello-world.git",
  repositoryFullName: inputs.repository_full_name,
  targetBranch: inputs.repository_branch,
  commitSha,
  status: PipelineRunStatus.FAILED,
  currentStage: "remove_immutable_image_repository_after_destroy",
  metadata: {
    executionEngine: "github_actions",
    deploymentAction: "destroy",
    attempt: 4,
    immutableDispatchInputs: inputs,
    immutableDispatchFingerprint: immutableDispatchFingerprint(inputs),
  },
};

async function run() {
  const service: any = Object.create(GithubActionsDeploymentService.prototype);
  service.githubApp = {
    ensureWorkflow: async () => ({ path: ".github/workflows/deployguard.yml" }),
    oidcTrustSubject: async () => "repo:owner/flask-hello-world:*",
    tokenForRepository: async () => ({ token: "test-token" }),
  };
  service.oidcTrust = { ensureRepositoryAuthorized: async () => undefined };
  service.awsCapabilities = { ensure: async () => ({ contractVersion: "deployguard.workflow-aws/v1", fingerprint: "fixture", reconciled: false }) };
  service.nextAttempt = async () => 5;
  service.destroyLifecycles = {
    begin: async () => undefined,
    acquire: async () => ({ id: "destroy-lifecycle", status: "DESTROYING", phase: "AWS_CLEANUP" }),
  };
  let persisted: any = null;
  const repository = {
    manager: {
      query: async () => [],
      getRepository: () => ({ find: async () => [{ id: historicalGenerationId }, { id: generationId }] }),
    },
    create: (value: any) => value,
    save: async (value: any) => { persisted = value; return value; },
  };
  let scheduled: { operation: any; inputs: GithubActionsOperationInputs } | null = null;
  service.schedulePersistedOperation = (operation: any, _token: string, retryInputs: GithubActionsOperationInputs) => {
    scheduled = { operation, inputs: retryInputs };
  };

  const result = await service.redispatch(
    { id: 7 },
    {
      id: projectId,
      repositoryFullName: inputs.repository_full_name,
      targetBranch: inputs.repository_branch,
      githubInstallationId: "installation-id",
    },
    repository,
    source,
    generationId,
  );

  assert.ok(persisted);
  assert.notEqual(persisted.id, sourceId, "Destroy retry creates a new immutable operation ID");
  assert.equal(persisted.generationId, generationId, "Destroy retry stays in the active generation");
  assert.equal(persisted.metadata.deploymentAction, "destroy", "Destroy retry preserves the persisted operation type");
  assert.equal(persisted.metadata.retryOfOperationId, sourceId, "Destroy retry links to the failed Destroy");
  assert.equal(persisted.metadata.attempt, 5);
  assert.equal(persisted.status, PipelineRunStatus.QUEUED);
  assert.equal((scheduled as any)?.operation.id, persisted.id);
  assert.equal((scheduled as any)?.inputs.deployment_action, "destroy", "workflow dispatch remains a Destroy");
  assert.equal((scheduled as any)?.inputs.deployment_operation_id, persisted.id);
  const refreshedReferences = JSON.parse(Buffer.from((scheduled as any).inputs.environment_references_base64, "base64").toString("utf8"));
  assert.deepEqual(refreshedReferences.public, ["PUBLIC_SETTING"]);
  assert.deepEqual(refreshedReferences.secret, ["SECRET_SETTING"]);
  assert.equal(refreshedReferences.extinction.projectId, projectId);
  assert.deepEqual(refreshedReferences.extinction.knownGenerationIds, [historicalGenerationId, generationId]);
  assert.equal(refreshedReferences.extinction.resourceManifest.generationId, generationId);
  assert.equal(source.status, PipelineRunStatus.FAILED, "the source Destroy remains failed");
  assert.equal(result.deployment.operation.deploymentAction, "destroy");
  assert.equal(result.deployment.message, "Destroy retry queued as a new immutable attempt.");

  persisted = null;
  scheduled = null;
  service.awsCapabilities.ensure = async () => { throw new WorkflowAwsCapabilityError(["elasticloadbalancing:DescribeTags"], "fixture capability denial"); };
  await assert.rejects(
    service.redispatch(
      { id: 7 },
      { id: projectId, repositoryFullName: inputs.repository_full_name, targetBranch: inputs.repository_branch, githubInstallationId: "installation-id" },
      repository,
      source,
      generationId,
    ),
    (error: unknown) => error instanceof WorkflowAwsCapabilityError,
  );
  assert.equal(persisted, null, "platform capability failure creates no customer attempt");
  assert.equal(scheduled, null, "platform capability failure dispatches no workflow");
}

run()
  .then(() => console.log("Destroy retry semantics passed: new linked operation, same generation, preserved Destroy action, and no dispatch side effect."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
