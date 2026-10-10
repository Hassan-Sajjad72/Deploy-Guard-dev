import "reflect-metadata";
import { strict as assert } from "node:assert";
import { githubActionsDestroyEvidenceFromValue } from "../src/projects/github-actions-destroy-evidence";
import { ProjectDeletionIncompleteError, ProjectDeletionService } from "../src/projects/project-deletion.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { servicesBase64 } from "../src/projects/railpack-workflow-contract";

const projectId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000002";
const generationIds = ["30000000-0000-4000-8000-000000000003", "40000000-0000-4000-8000-000000000004"];
const foreignGeneration = "50000000-0000-4000-8000-000000000005";
const project: any = { id: projectId, environmentName: "dev", ownerUserId: 7, repositoryFullName: "fixture/repository" };
const encoded = servicesBase64({
  schemaVersion: 3, projectId, operationId, sourceSha: "a".repeat(40), environmentName: "dev", projectDeletion: { generationIds },
  services: [{ serviceId: "60000000-0000-4000-8000-000000000006", serviceName: "Web", serviceDirectory: ".", servicePort: 8080,
    runtimeConfigRevisionId: "70000000-0000-4000-8000-000000000007", buildEnvironment: {}, buildSecretReferences: {},
    environment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: {}, databaseAttached: false, managedDatabase: { engine: null, aliases: [] },
    rollbackImage: `123456789012.dkr.ecr.us-east-1.amazonaws.com/fixture@sha256:${"b".repeat(64)}` }],
});
const evidence = () => ({ contractVersion: "deployguard.destroy-result/v2", deploymentOperationId: operationId, projectId, environmentName: "dev", generationIds: [...generationIds],
  status: "project_delete_ready", generationResourcesRemoved: true, projectResourcesRemoved: true, terraformStateArtifactsRemoved: true, sharedPlatformUntouched: true, verifiedAt: new Date().toISOString() });
const operation = () => ({ id: operationId, projectId, generationId: generationIds[0], commitSha: "a".repeat(40), status: PipelineRunStatus.COMPLETED, currentStage: "project_delete_cleanup",
  metadata: { deploymentAction: "destroy", destroyEvidenceValidated: true, immutableDispatchInputs: { services_base64: encoded }, destroyVerification: evidence() } });

async function verify() {
  assert.equal(githubActionsDestroyEvidenceFromValue({ ...evidence(), generationIds: [...generationIds, 7] }), null,
    "non-string generation identities cannot be silently discarded from deletion claims");
  for (const invalid of [null, [], { ...evidence(), environmentName: "Prod" }, { ...evidence(), generationIds: [generationIds[0], generationIds[0]] }]) {
    assert.equal(githubActionsDestroyEvidenceFromValue(invalid), null);
  }
  const lifecycle: any = Object.create(RailpackDeploymentService.prototype);
  let saves = 0;
  let cleanups = 0;
  lifecycle.runs = { save: async (row: unknown) => { saves++; return row; } };
  lifecycle.notifications = { dispatch: async () => undefined };
  lifecycle.projectDeletion = { finalize: async () => { cleanups++; } };
  for (const ids of [[generationIds[0]], [generationIds[0], foreignGeneration], [...generationIds, foreignGeneration]]) {
    const candidate = operation();
    const invalid = { ...evidence(), generationIds: ids };
    await assert.rejects(() => lifecycle.finalizeVerifiedDestroy(project, candidate, { destroyVerification: invalid }, "success"),
      /scope|generation/, "including LIVE is insufficient: deletion must cover exactly the frozen complete generation set");
    candidate.metadata.destroyVerification = invalid;
    assert.equal(lifecycle.verifiedDestroyEvidence(candidate, project), null, "cleanup-only retry must revalidate the same exact scope");
  }
  assert.equal(saves, 0);
  assert.equal(cleanups, 0, "narrowed/widened deletion evidence cannot reach control-plane cleanup");
  const candidate = operation();
  await lifecycle.finalizeVerifiedDestroy(project, candidate, { destroyVerification: { ...evidence(), generationIds: [...generationIds].reverse() } }, "success");
  assert.equal(cleanups, 1, "order-independent complete scope remains supported");

  const deletion: any = Object.create(ProjectDeletionService.prototype);
  deletion.assertReady(project, operation());
  for (const metadata of [
    { ...operation().metadata, immutableDispatchInputs: {} },
    { ...operation().metadata, destroyVerification: { ...evidence(), generationIds: [generationIds[0]] } },
    { ...operation().metadata, destroyEvidenceValidated: false },
  ]) assert.throws(() => deletion.assertReady(project, { ...operation(), metadata }), ProjectDeletionIncompleteError);

  let deletes = 0;
  let persisted = operation();
  deletion.subscriptions = { find: async () => [] };
  deletion.projects = { count: async () => 1 };
  deletion.sns = { deleteProjectResources: async () => undefined };
  deletion.githubApp = { removeManagedWorkflow: async () => { throw new Error("shared caller must be preserved"); } };
  deletion.dataSource = { transaction: async (callback: (manager: unknown) => Promise<unknown>) => callback({
    query: async () => undefined,
    getRepository: () => ({ findOne: async (options: any) => {
      assert.deepEqual(options.lock, { mode: "pessimistic_write" }, "persisted eligibility must remain locked until deletion commits");
      return persisted;
    }, delete: async () => { deletes++; return { affected: 1 }; } }),
  }) };
  persisted = { ...operation(), status: PipelineRunStatus.RUNNING };
  await assert.rejects(() => deletion.finalize(project, operation()), ProjectDeletionIncompleteError,
    "the operation must still be eligible inside the deletion transaction");
  assert.equal(deletes, 0, "a revoked/stale operation cannot erase project authority");
  persisted = operation();
  assert.deepEqual(await deletion.finalize(project, operation()), { projectId, status: "deleted" });
  assert.equal(deletes, 1);
  console.log("DESTROY_SCOPE_INTEGRITY=PASS EXACT_FROZEN_GENERATIONS=1 MALFORMED_IDENTITIES_REJECTED=1 RETRY_REVALIDATED=1 TRANSACTION_REVALIDATED=1 AWS_EXECUTION=NONE ABSENCE_PROOF=NOT_CERTIFIED");
}
void verify().catch((error) => { console.error(error); process.exitCode = 1; });
