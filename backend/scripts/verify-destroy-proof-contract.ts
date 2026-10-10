import "reflect-metadata";
import { strict as assert } from "node:assert";
import { AwsOwnershipJournal, AWS_RESOURCE_OWNERSHIP_SOURCE, assertAwsOwnershipJournal, assertDestroyOwnership, DestroyOwnershipIncompleteError, freezeDestroyOwnership, OwnedAwsResource, ownershipSha256 } from "../src/projects/aws-resource-ownership";
import { assertCanonicalDestroyCoverage } from "../src/projects/aws-resource-ownership-coverage";
import { runtimeSecretOwnershipRecord } from "../src/projects/runtime-secret-ownership";
import { githubActionsDestroyEvidenceFromValue, githubActionsDestroyEvidenceMatchesOperation } from "../src/projects/github-actions-destroy-evidence";
import { ProjectDeletionService } from "../src/projects/project-deletion.service";
import { ProjectDeploymentGeneration } from "../src/projects/project-deployment-generation.entity";
import { ProjectGenerationServiceRevision } from "../src/projects/project-generation-service-revision.entity";
import { ProjectServiceRuntimeConfigRevision } from "../src/projects/project-service-runtime-config-revision.entity";
import { ProjectPipelineEvent } from "../src/projects/project-pipeline-event.entity";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { Project } from "../src/projects/project.entity";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { servicesBase64 } from "../src/projects/railpack-workflow-contract";
import { destroyProofFixture } from "./fixtures/destroy-proof";

const projectId = "10000000-0000-4000-8000-000000000001";
const operationId = "20000000-0000-4000-8000-000000000002";
const generations = ["30000000-0000-4000-8000-000000000003"];
const failedOperationId = "40000000-0000-4000-8000-000000000004";
const proof = destroyProofFixture(projectId, operationId, generations);
const project: any = { id: projectId, ownerUserId: 7, repositoryFullName: "fixture/repository", environmentName: "dev" };
const runtime = () => ({ schemaVersion: 3 as const, projectId, operationId, sourceSha: "a".repeat(40), environmentName: "dev", projectDeletion: { generationIds: generations, ownership: structuredClone(proof.ownership) },
  services: [{ serviceId: "50000000-0000-4000-8000-000000000005", serviceName: "Web", serviceDirectory: ".", servicePort: 8080, runtimeConfigRevisionId: "60000000-0000-4000-8000-000000000006",
    buildEnvironment: {}, buildSecretReferences: {}, environment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: {}, databaseAttached: false, managedDatabase: { engine: null, aliases: [] } }] });
const operation = (): any => ({ id: operationId, projectId, generationId: generations[0], commitSha: "a".repeat(40), startedAt: new Date(Date.parse(proof.evidence.verifiedAt) - 1000), status: PipelineRunStatus.COMPLETED, currentStage: "project_delete_cleanup",
  metadata: { executionEngine: "railpack", deploymentAction: "destroy", destroyEvidenceValidated: true, immutableDispatchInputs: { ...proof.inputs, services_base64: servicesBase64(runtime()) }, destroyVerification: structuredClone(proof.evidence) } });

async function verify() {
  const { observeDeletion } = require("../../infrastructure/railpack-runtime/observe-deletion.mjs");
  // Run the real observer with explicitly injected read-only responses, then
  // validate its output through the production backend contract.
  const report = await observeDeletion(proof.ownership.manifest, async (args: string[]) => {
    const body = args[0] === "sts" ? { Account: "123456789012" }
      : args[1] === "describe-clusters" ? { clusters: [], failures: [{ arn: args[3], reason: "MISSING" }] }
        : args[1] === "describe-task-definition" ? { taskDefinition: { taskDefinitionArn: args[3], status: "INACTIVE" } }
          : args[0] === "logs" ? { logGroups: [] } : null;
    const code = { "describe-repositories": "RepositoryNotFoundException", "head-object": "404", "describe-services": "ClusterNotFoundException",
      "describe-load-balancers": "LoadBalancerNotFound", "describe-target-groups": "TargetGroupNotFound" }[args[1]];
    return body ? { status: 0, stdout: JSON.stringify(body), stderr: "" }
      : { status: 1, stdout: "", stderr: `An error occurred (${code}) when calling the Read operation:` };
  }, { attempts: 1, delayMs: 0 });
  assert.equal(report.status, "PASS");
  const evidence: any = { ...proof.evidence, verifiedAt: report.verifiedAt, observation: report };
  const parsed = githubActionsDestroyEvidenceFromValue(evidence);
  assert.ok(parsed && githubActionsDestroyEvidenceMatchesOperation(parsed, operation(), "dev"), "actual injected observer output must match the frozen receipt-bound manifest");
  const legacy: any = { ...proof.evidence, contractVersion: "deployguard.destroy-result/v2" };
  delete legacy.ownershipSha256; delete legacy.observation;
  assert.equal(githubActionsDestroyEvidenceFromValue(legacy), null, "legacy success booleans cannot become deletion authority");
  const mutations: Array<(v: any) => void> = [
    (v) => { v.ownershipSha256 = "f".repeat(64); },
    (v) => { v.observation.manifestSha256 = "f".repeat(64); },
    (v) => { v.observation.scope.accountId = "999999999999"; },
    (v) => { v.observation.scope.operationId = failedOperationId; },
    (v) => { v.observation.observations.pop(); },
    (v) => { v.observation.observations.push(v.observation.observations[0]); },
    (v) => { v.observation.observations[0].id += "-foreign"; },
    (v) => { v.observation.observations[0].status = "UNVERIFIED"; },
    (v) => { v.observation.observations[0].providerCode = "AccessDeniedException"; },
    (v) => { v.observation.observations[0].basis = "running"; },
    (v) => { v.observation.observations[0].attempts = 0; },
    (v) => { v.observation.observations[0].attempts = 11; },
    (v) => { v.observation.observations.find((r: any) => r.type === "s3_state_object").providerCode = null; },
    (v) => { v.observation.observations.find((r: any) => r.type === "aws_ecs_task_definition").basis = "absent"; },
    (v) => { v.observation.code = "DG_DELETION_ACCOUNT_UNVERIFIED"; },
    (v) => { v.observation.verifiedAt = "2020-01-01T00:00:00.000Z"; },
    (v) => { v.verifiedAt = v.observation.verifiedAt = "0"; },
    (v) => { v.verifiedAt = v.observation.verifiedAt = "2020-01-01T00:00:00.000Z"; },
  ];
  const lifecycle: any = Object.create(RailpackDeploymentService.prototype);
  let writes = 0;
  lifecycle.runs = { save: async () => { writes++; } };
  lifecycle.projectDeletion = { finalize: async () => { writes++; } };
  const deletion: any = Object.create(ProjectDeletionService.prototype);
  deletion.subscriptions = { find: async () => { writes++; } };
  const projection: any = Object.create(ProjectCurrentStateService.prototype);
  for (const mutate of mutations) {
    const invalid = structuredClone(evidence); mutate(invalid);
    const candidate = githubActionsDestroyEvidenceFromValue(invalid);
    assert.ok(!candidate || !githubActionsDestroyEvidenceMatchesOperation(candidate, operation(), "dev"));
    const row = operation(); row.metadata.destroyVerification = invalid;
    assert.equal(lifecycle.verifiedDestroyEvidence(row, project), null);
    await assert.rejects(() => lifecycle.finalizeVerifiedDestroy(project, row, { destroyVerification: invalid }, "success"));
    await assert.rejects(() => deletion.finalize(project, row));
    assert.equal(await projection.verifiedDestroyAncestor(row, projectId, "dev"), null);
  }
  const old = operation(); old.metadata.destroyVerification = legacy;
  await assert.rejects(() => deletion.finalize(project, old));
  assert.equal(await projection.verifiedDestroyAncestor(old, projectId, "dev"), null);
  assert.equal(lifecycle.presentOperation(old).destroyVerificationStatus, "pending", "legacy completion must use the existing pending-verification UI contract");
  assert.equal(lifecycle.presentOperation(operation()).destroyVerificationStatus, "verified");
  let notifications = 0;
  lifecycle.notifications = { dispatch: async () => { notifications++; } };
  await lifecycle.dispatchLifecycleNotification(old, "completed", project);
  assert.equal(notifications, 0, "legacy validated markers cannot publish a destroy-success notification");
  assert.equal(writes, 0, "invalid proof must fail before records, notifications, SNS or GitHub cleanup");
  assert.equal((await projection.verifiedDestroyAncestor(operation(), projectId, "dev"))?.id, operationId);
  for (const mutate of [
    (v: any) => { v.metadata.destroyEvidenceValidated = false; },
    (v: any) => { v.currentStage = "release_evidence_validation"; },
    (v: any) => { v.status = PipelineRunStatus.RUNNING; },
    (v: any) => { v.status = PipelineRunStatus.FAILED; v.metadata.failureCategory = "release_contract_incompatible"; },
  ]) {
    const invalid = operation(); mutate(invalid);
    assert.equal(lifecycle.verifiedDestroyEvidence(invalid, project), null, "raw valid proof cannot bypass persisted eligibility or a failed validation");
    await assert.rejects(() => deletion.finalize(project, invalid));
    assert.equal(await projection.verifiedDestroyAncestor(invalid, projectId, "dev"), null);
  }
  const cleanupRetry = operation(); cleanupRetry.status = PipelineRunStatus.FAILED; cleanupRetry.metadata.failureCategory = "project_delete_incomplete";
  assert.ok(lifecycle.verifiedDestroyEvidence(cleanupRetry, project), "validated cleanup failures retain the existing cleanup-only retry path");

  const failed: any = { ...proof.operations[0], id: failedOperationId, metadata: { executionEngine: "railpack", deploymentAction: "deploy" } };
  const all = [...proof.operations, failed];
  assert.throws(() => freezeDestroyOwnership(proof.ownership.manifest.scope, all, proof.events, "m0-disposable-state"), /OWNERSHIP_INCOMPLETE/, "failed attempts cannot be omitted merely because they never became a generation");
  const failedJournal: AwsOwnershipJournal = { ...structuredClone(proof.journals[0]), scope: { ...proof.journals[0].scope, operationId: failedOperationId }, resources: [{ type: "aws_ecr_repository", id: `deployguard-failed-${projectId}` }] };
  const failedEvent = { projectId, pipelineRunId: failedOperationId, source: AWS_RESOURCE_OWNERSHIP_SOURCE, metadata: { evidence: failedJournal, sha256: ownershipSha256(failedJournal) } };
  const union = freezeDestroyOwnership(proof.ownership.manifest.scope, all, [...proof.events, failedEvent], "m0-disposable-state");
  assert.equal(union.receipts.length, 2);
  assert.ok(union.manifest.resources.some((r) => r.id === failedJournal.resources[0].id));
  for (const mutate of [
    (v: any) => { v.unresolvedIntents = ["lost-response"]; }, (v: any) => { v.coverage.pop(); },
    (v: any) => { v.resources[0].id = "arn:aws:ecs:us-east-1:999999999999:cluster/foreign"; },
    (v: any) => { v.scope.environmentName = "Prod"; }, (v: any) => { v.secretValue = "must-not-retain"; },
  ]) { const invalid = structuredClone(proof.journals[0]); mutate(invalid); assert.throws(() => assertAwsOwnershipJournal(invalid)); }
  const noLock = structuredClone(proof.ownership); noLock.manifest.resources = noLock.manifest.resources.filter((r) => !r.id.endsWith(".tflock"));
  assert.throws(() => assertDestroyOwnership(noLock), /OWNERSHIP_INCOMPLETE/);
  assert.throws(() => freezeDestroyOwnership(proof.ownership.manifest.scope, proof.operations, [...proof.events, proof.events[0]], "m0-disposable-state"));
  const corrupt = structuredClone(proof.events); corrupt[0].metadata.sha256 = "f".repeat(64);
  assert.throws(() => freezeDestroyOwnership(proof.ownership.manifest.scope, proof.operations, corrupt, "m0-disposable-state"));
  // Hash stability is checked with a recursive key reversal, not a replacer
  // that accidentally discards nested identifiers.
  const reverse = (v: any): any => Array.isArray(v) ? v.map(reverse) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverse(v[k])])) : v;
  assert.equal(ownershipSha256(reverse(proof.journals[0])), ownershipSha256(proof.journals[0]));
  assert.deepEqual(freezeDestroyOwnership(proof.ownership.manifest.scope, proof.operations, reverse(proof.events), "m0-disposable-state"), proof.ownership,
    "JSONB key order must not change frozen manifest ordering or its bytes");

  const canonicalGenerations = generations.map((id, index) => ({ id, createdByOperationId: proof.operations[index].id }));
  const coverage = (ownership = proof.ownership, revisions: any = proof.revisions, configurations: any = proof.configurations, runtimeEvents: any = []) =>
    assertCanonicalDestroyCoverage(ownership, canonicalGenerations, revisions, configurations, runtimeEvents);
  coverage();
  for (const resource of proof.ownership.manifest.resources.filter((r) => r.type !== "s3_state_object")) {
    const narrowed = structuredClone(proof.ownership); narrowed.manifest.resources = narrowed.manifest.resources.filter((r) => r.type !== resource.type || r.id !== resource.id);
    assert.throws(() => coverage(narrowed), DestroyOwnershipIncompleteError, `canonical ${resource.type} cannot be omitted`);
  }
  const emptyEvents = structuredClone(proof.events);
  emptyEvents.forEach((row) => { row.metadata.evidence.resources = []; row.metadata.sha256 = ownershipSha256(row.metadata.evidence); });
  const stateOnly = freezeDestroyOwnership(proof.ownership.manifest.scope, proof.operations, emptyEvents, "m0-disposable-state");
  assert.throws(() => coverage(stateOnly), DestroyOwnershipIncompleteError, "complete-family flags plus state/lock cannot erase a canonical running generation");
  assert.throws(() => coverage(proof.ownership, []), DestroyOwnershipIncompleteError, "every retained generation needs its canonical members");
  for (const mutate of [
    (r: any) => { r.projectId = failedOperationId; }, (r: any) => { r.runtimeConfigRevisionId = failedOperationId; },
    (r: any) => { r.imageUri = r.imageUri.replace("123456789012", "999999999999"); },
    (r: any) => { r.runtimeIdentity.ecsClusterArn = "arn:aws:ecs:us-east-1:123456789012:cluster/unrelated"; },
  ]) { const invalid = structuredClone(proof.revisions); mutate(invalid[0]); assert.throws(() => coverage(proof.ownership, invalid), DestroyOwnershipIncompleteError); }
  const historical = destroyProofFixture(projectId, operationId, [...generations, "80000000-0000-4000-8000-000000000008"]);
  const historicalGenerations = historical.operations.map((row, index) => ({ id: historical.ownership.manifest.scope.generationIds[index], createdByOperationId: row.id }));
  const noOldTask = structuredClone(historical.ownership);
  noOldTask.manifest.resources = noOldTask.manifest.resources.filter((r) => r.id !== historical.revisions[0].runtimeIdentity.taskDefinitionArn);
  assert.throws(() => assertCanonicalDestroyCoverage(noOldTask, historicalGenerations, historical.revisions as any, historical.configurations as any, []), DestroyOwnershipIncompleteError,
    "the latest revision is not a substitute for complete historical task revisions");

  const secretName = `deployguard/${projectId}/dev/services/${proof.revisions[0].serviceId}/runtime`;
  const secretArn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${secretName}-abcdef`;
  const secretScope = { ...proof.ownership.manifest.scope, operationId: proof.operations[0].id };
  const runtimeEvents = (["intent", "owned"] as const).map((phase) => runtimeSecretOwnershipRecord({ phase, projectId, operationId: secretScope.operationId,
    serviceId: proof.revisions[0].serviceId, environmentName: "dev", secretName, versionToken: "d".repeat(64), ...(phase === "owned" ? { secretArn } : {}) }, secretScope));
  const secretOwnership = structuredClone(proof.ownership); secretOwnership.manifest.resources.push({ type: "aws_secretsmanager_secret", id: secretArn });
  const secretConfigs: any = structuredClone(proof.configurations); secretConfigs[0].secretReferences = { TOKEN: `${secretArn}:TOKEN::${"d".repeat(64)}` };
  coverage(secretOwnership, proof.revisions, secretConfigs, runtimeEvents);
  for (const rows of [[], [runtimeEvents[0]], [runtimeEvents[1]]]) assert.throws(() => coverage(secretOwnership, proof.revisions, secretConfigs, rows), DestroyOwnershipIncompleteError);
  assert.throws(() => coverage(proof.ownership, proof.revisions, secretConfigs, runtimeEvents), DestroyOwnershipIncompleteError, "owned runtime-secret receipts cannot be omitted from the manifest");
  const corruptRuntime = structuredClone(runtimeEvents); corruptRuntime[0].metadata!.sha256 = "f".repeat(64);
  assert.throws(() => coverage(secretOwnership, proof.revisions, secretConfigs, corruptRuntime), DestroyOwnershipIncompleteError);
  const malformedRuntime = structuredClone(runtimeEvents); (malformedRuntime[0].metadata!.evidence as any).versionToken = "not-a-token";
  assert.throws(() => coverage(secretOwnership, proof.revisions, secretConfigs, malformedRuntime), DestroyOwnershipIncompleteError);

  const plannedOnly: any = { ...structuredClone(proof.configurations[0]), id: failedOperationId, serviceId: failedOperationId, sealedAt: null, databaseConfiguration: { attached: true } };
  coverage(proof.ownership, proof.revisions, [...proof.configurations, plannedOnly]);
  const database: any = { attached_service_id: proof.revisions[0].serviceId, ecs_service_arn: `arn:aws:ecs:us-east-1:123456789012:service/deployguard-${projectId}/database`,
    task_definition_arn: `arn:aws:ecs:us-east-1:123456789012:task-definition/deployguard-database:1`, cloudwatch_log_group_name: `/deployguard/${projectId}/database`,
    efs_file_system_id: "fs-1234567890abcdef0", efs_access_point_id: "fsap-1234567890abcdef0", credentials_secret_arn: `arn:aws:secretsmanager:us-east-1:123456789012:secret:deployguard/${projectId}/database-abcdef`,
    security_group_id: "sg-1234567890abcdef0", cloud_map_service_id: "srv-1234567890abcdef", cloud_map_namespace_id: "ns-1234567890abcdef" };
  const databaseResources: OwnedAwsResource[] = [
    { type: "aws_ecs_service", id: database.ecs_service_arn, parent: proof.journals[0].resources[0].id },
    ...([["aws_ecs_task_definition", "task_definition_arn"], ["aws_cloudwatch_log_group", "cloudwatch_log_group_name"], ["aws_efs_file_system", "efs_file_system_id"],
      ["aws_efs_access_point", "efs_access_point_id"], ["aws_secretsmanager_secret", "credentials_secret_arn"], ["aws_security_group", "security_group_id"],
      ["aws_service_discovery_service", "cloud_map_service_id"], ["aws_service_discovery_private_dns_namespace", "cloud_map_namespace_id"]] as const).map(([type, key]) => ({ type, id: database[key] })),
  ];
  const databaseOwnership = structuredClone(proof.ownership); databaseOwnership.manifest.resources.push(...databaseResources);
  const databaseConfigs: any = structuredClone(proof.configurations); databaseConfigs[0].databaseConfiguration = { attached: true, secretArn: database.credentials_secret_arn, runtimeIdentity: database };
  coverage(databaseOwnership, proof.revisions, databaseConfigs);
  for (const resource of databaseResources) {
    const narrowed = structuredClone(databaseOwnership); narrowed.manifest.resources = narrowed.manifest.resources.filter((r) => r.type !== resource.type || r.id !== resource.id);
    assert.throws(() => coverage(narrowed, proof.revisions, databaseConfigs), DestroyOwnershipIncompleteError, `independent database ${resource.type} cannot be omitted`);
  }

  const admission: any = Object.create(RailpackDeploymentService.prototype);
  admission.config = { get: (key: string, fallback?: unknown) => ({ DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN: proof.inputs.aws_role_arn, DEPLOYGUARD_TERRAFORM_STATE_BUCKET: proof.inputs.terraform_state_bucket }[key] || fallback) };
  let retainedEvents = proof.events;
  let retainedHistory: any[] = proof.operations;
  let retainedGenerations = proof.retainedGenerations;
  let configurationReads = 0;
  admission.captureAdmittedConfiguration = async () => { configurationReads++; throw new Error("Unexpected configuration read."); };
  const manager: any = { query: async () => undefined, getRepository: (entity: any) => entity === Project ? { findOne: async () => project }
    : entity === ProjectDeploymentGeneration ? { find: async () => retainedGenerations }
      : entity === ProjectPipelineEvent ? { find: async () => retainedEvents }
      : entity === ProjectGenerationServiceRevision ? { find: async () => proof.revisions }
      : entity === ProjectServiceRuntimeConfigRevision ? { find: async () => proof.configurations }
        : { findOne: async () => null, find: async () => retainedHistory } };
  admission.dataSource = { transaction: async (callback: any) => callback(manager) };
  retainedEvents = [];
  await assert.rejects(() => admission.admitLifecycleOperation({ id: 7 }, project, "destroy", null, null, null), (error: any) => error.getStatus?.() === 409 && /OWNERSHIP_INCOMPLETE/.test(error.message));
  assert.equal(configurationReads, 0, "legacy deletion must be blocked before configuration, GitHub or AWS work");
  retainedEvents = proof.events;
  const admitted = await admission.destroyOwnershipForAdmission(manager, project, "dev", operationId);
  assert.deepEqual(admitted, proof.ownership);
  for (const environment of ["prod", 42, null]) {
    retainedHistory = [...proof.operations, { ...proof.operations[0], id: failedOperationId,
      metadata: { ...proof.operations[0].metadata, immutableDispatchInputs: { environment_name: environment } } }];
    await assert.rejects(() => admission.destroyOwnershipForAdmission(manager, project, "dev", operationId), (error: any) => error.getStatus?.() === 409,
      "a different or malformed historical environment cannot be excluded from whole-project deletion authority");
  }
  retainedHistory = proof.operations;
  retainedGenerations = [{ ...proof.retainedGenerations[0], environmentName: "prod" }];
  await assert.rejects(() => admission.destroyOwnershipForAdmission(manager, project, "dev", operationId), (error: any) => error.getStatus?.() === 409);
  retainedGenerations = proof.retainedGenerations;
  manager.getRepository = () => ({ find: async () => { throw new Error("database failure containing a secret"); } });
  await assert.rejects(() => admission.destroyOwnershipForAdmission(manager, project, "dev", operationId), (error: any) => error.getStatus?.() === 503 && !error.message.includes("secret"));
  console.log("DESTROY_PROOF_CONTRACT=PASS VERSION=3 LEGACY_FAIL_CLOSED=1 FAILED_ATTEMPT_COVERAGE=1 RECEIPT_INTEGRITY=1 EXACT_OBSERVER_BINDING=1 STATE_AND_LOCK=1 ALL_CONSUMERS=1 CANONICAL_RESOURCE_MINIMUM=1 HISTORICAL_TASK_REVISIONS=1 RUNTIME_SECRET_INTENTS=1 INDEPENDENT_DATABASE_COVERAGE=1 AWS_EXECUTION=NONE");
}
void verify().catch((error) => { console.error(error); process.exitCode = 1; });
