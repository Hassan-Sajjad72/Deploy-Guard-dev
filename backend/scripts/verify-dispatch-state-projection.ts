import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";
import { PipelineRunStatus, ProjectPipelineRun } from "../src/projects/project-pipeline-run.entity";
import { ProjectDeploymentGeneration } from "../src/projects/project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "../src/projects/project-environment-route.entity";
import { ProjectStableRelease } from "../src/orchestration/project-stable-release.entity";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { isAiTroubleshootingEligible } from "../src/ai-troubleshooting/ai-troubleshooting.service";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
import { githubActionsFailureLifecyclePhase, githubActionsWorkflowStepPresentation } from "../src/projects/pipeline/github-actions-stage-presentation";
import { DEPLOYGUARD_FAILURE_ARTIFACT_ENTRY, DEPLOYGUARD_RESULT_ARTIFACT_ENTRY, exactZipEntry, GithubActionsService } from "../src/projects/pipeline/github-actions.service";
import { WorkflowAwsCapabilityError } from "../src/projects/github-actions-aws-capability.service";
import { verifyEffectiveWorkflowCapabilities } from "../src/projects/github-actions-aws-capability.service";
import { capabilitiesFor, RAILPACK_RUNTIME_PROVIDER_API_REQUIREMENTS, WORKFLOW_AWS_CAPABILITIES, WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION, workflowCapabilityPolicy } from "../src/projects/github-actions-aws-capability-contract";
import { PINNED_AWS_PROVIDER_VERSION, PINNED_PROVIDER_INDIRECT_API_EXPECTATIONS } from "./pinned-aws-provider-5.100.0-expectations";
import { servicesBase64 } from "../src/projects/railpack-workflow-contract";
import { ProjectServiceRuntimeConfigRevision } from "../src/projects/project-service-runtime-config-revision.entity";
import { ProjectGenerationServiceRevision } from "../src/projects/project-generation-service-revision.entity";
import { Project } from "../src/projects/project.entity";
import { CONTROL_PLANE_VERSION_MISMATCH, ControlPlaneCompatibilityError } from "../src/projects/github-app.service";
import { terminalStructuredFailureMarker } from "../src/projects/failure-ownership";
import { QueryFailedError } from "typeorm";
import { ProjectDeployableService } from "../src/projects/project-deployable-service.entity";
import { ProjectEnvironmentVariable } from "../src/projects/project-environment-variable.entity";
import { ProjectDatabaseTier } from "../src/projects/project-database-tier.entity";
import { ProjectConfigurationSnapshot } from "../src/projects/project-configuration-snapshot.entity";

const user = { id: 7 } as any;
const project = {
  id: "11111111-1111-4111-8111-111111111111", ownerUserId: 7,
  repositoryUrl: "https://github.com/example/application.git", repositoryFullName: "example/application",
  targetBranch: "main", githubInstallationId: "42", environmentName: "dev",
  applicationEntryPointServiceId: "77777777-7777-4777-8777-777777777777",
};

function storedZipEntry(name: string, value: string) {
  const filename = Buffer.from(name);
  const data = Buffer.from(value);
  const local = Buffer.alloc(30 + filename.length + data.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
  filename.copy(local, 30); data.copy(local, 30 + filename.length);
  const central = Buffer.alloc(46 + filename.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28);
  filename.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, eocd]);
}

async function verifyReleaseArtifactEvidenceReconciliation() {
  const serviceId = "77777777-7777-4777-8777-777777777777";
  const contract = (operationId: string, sourceSha: string, action: "deploy" | "rollback" = "deploy", immutableImage?: string) => servicesBase64({ schemaVersion: 3, projectId: project.id, environmentName: "dev", operationId, sourceSha, services: [{ serviceId, runtimeConfigRevisionId: "77777777-7777-4777-8777-777777777777", serviceName: "Web", serviceDirectory: ".", servicePort: 8080, buildEnvironment: {}, buildSecretReferences: {}, environment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: {}, databaseAttached: false, managedDatabase: { engine: null, aliases: [] }, ...(action === "rollback" && immutableImage ? { rollbackImage: immutableImage } : {}) }] });
  const imageUri = "123456789012.dkr.ecr.us-east-1.amazonaws.com/repo";
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const image = `${imageUri}@${imageDigest}`;
  const runtimeConfigRevisionId = serviceId;
  const runtime = { name: "Web", image, runtime_config_revision_id: runtimeConfigRevisionId, service_port: 8080, ecs_service_arn: "arn:aws:ecs:us-east-1:123456789012:service/dg/dg", ecs_service_name: "dg", task_definition_arn: "arn:aws:ecs:us-east-1:123456789012:task-definition/dg:1", alb_arn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/dg/a", alb_name: "dg", alb_target_group_arn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/dg/a", alb_target_group_name: "dg", public_url: "http://example.test", cloudwatch_log_group_name: `/deployguard/${project.id}/services/${serviceId}`, application_container_name: "application", transport_probe_container_name: "deployguard-transport-probe", transport_probe_port: 65535, platform_health_check_path: "/_deployguard/transport-ready" };
  const valid = { contractVersion: "deployguard.release-result/v5", action: "deploy", sourceSha: "c".repeat(40), operationId: "66666666-6666-4666-8666-666666666666", services: [{ serviceId, runtimeConfigRevisionId, serviceName: "Web", serviceDirectory: ".", servicePort: 8080, imageUri, imageDigest, image }], terraform: { aws_region: "us-east-1", ecs_cluster_arn: "arn:aws:ecs:us-east-1:123456789012:cluster/dg", ecs_cluster_name: "dg", services: { [serviceId]: runtime }, database: null }, awsRuntimeVerification: { contractVersion: "deployguard.aws-runtime-verification/v1", verified: true, verifiedAt: "2026-09-01T00:00:00Z", databaseVerified: false, services: [{ serviceId, verified: true, image, ecsServiceArn: runtime.ecs_service_arn, taskDefinitionArn: runtime.task_definition_arn, runningTaskArns: ["arn:aws:ecs:us-east-1:123456789012:task/dg/1"], ecsTasksRunning: 1, runtimePort: 8080, readinessMode: "platform_transport", transportProbePort: runtime.transport_probe_port, platformHealthCheckPath: runtime.platform_health_check_path, targetGroupArn: runtime.alb_target_group_arn, targetHealth: ["healthy"], environment: { PORT: "8080", HOST: "0.0.0.0" }, secretValueFrom: {}, managedDatabase: { attached: false, attachedServiceId: null, engine: null, aliases: [], credentialsSecretArn: null, secretVersionId: null }, publicUrl: runtime.public_url, publicEndpointVerified: true, taskDefinition: true, secretsInjection: true, vpcConnectivity: true, publicReachability: true, checkedAt: "2026-09-01T00:00:00Z" }] } };
  assert.equal(DEPLOYGUARD_RESULT_ARTIFACT_ENTRY, "deployguard-result.json");
  const archive = storedZipEntry("deployguard-result.json", JSON.stringify(valid));
  assert.equal(exactZipEntry(archive, DEPLOYGUARD_RESULT_ARTIFACT_ENTRY), JSON.stringify(valid));
  const originalFetch = globalThis.fetch;
  let artifactListRead = false;
  globalThis.fetch = (async () => {
    if (!artifactListRead) {
      artifactListRead = true;
      return new Response(JSON.stringify({ artifacts: [{ id: 1, name: `deployguard-result-${valid.operationId}`, expired: false }] }), { status: 200 });
    }
    return new Response(archive, { status: 200, headers: { "content-length": String(archive.length) } });
  }) as typeof fetch;
  try {
    const actionService = Object.create(GithubActionsService.prototype) as GithubActionsService;
    assert.equal(await actionService.getResultArtifact(project.repositoryFullName, "456", valid.operationId, "ignored"), JSON.stringify(valid));
  } finally {
    globalThis.fetch = originalFetch;
  }
  const saved: any[] = [];
  const generations: any[] = [];
  const routes: any[] = [];
  const releases: any[] = [];
  const generationRevisions: any[] = [];
  const runtimeConfig = { id: runtimeConfigRevisionId, projectId: project.id, serviceId, createdByOperationId: valid.operationId, isRollbackSafe: true, sealedAt: null, databaseConfiguration: { attached: false }, nonSecretEnvironment: { PORT: "8080", HOST: "0.0.0.0" }, platformValues: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: {} };
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.sanitizer = new LogSanitizerService();
  service.projects = { findOne: async () => project }; service.users = { findOne: async () => user };
  service.githubApp = { tokenForRepository: async () => ({ token: "ignored" }) };
  service.runs = { save: async (row: any) => { saved.push(structuredClone(row)); return row; } };
  const operation: any = { id: valid.operationId, projectId: project.id, triggeredByUserId: user.id, githubWorkflowRunId: "456", status: PipelineRunStatus.RUNNING, currentStage: "release_evidence_pending", commitSha: valid.sourceSha, metadata: { deploymentAction: "deploy", immutableDispatchInputs: { services_base64: contract(valid.operationId, valid.sourceSha) } } };
  const generationRepository = {
    findOne: async ({ where }: any) => generations.find((generation) => generation.id === where.id) || null,
    createQueryBuilder: () => ({ select: () => ({ where: () => ({ andWhere: () => ({ getRawOne: async () => ({ maximum: "0" }) }) }) }) }),
    create: (row: any) => row,
    find: async () => generations.filter((generation) => generation.status === "live"),
    save: async (row: any) => { const index = generations.findIndex((generation) => generation.id === row.id); if (index >= 0) generations[index] = structuredClone(row); else generations.push(structuredClone(row)); return row; },
  };
  const routeRepository = {
    findOne: async () => routes[0] || null,
    find: async () => routes,
    create: (row: any) => row,
    save: async (row: any) => { routes[0] = structuredClone(row); return row; },
  };
  const releaseRepository = {
    findOne: async ({ where }: any) => releases.find((release) => Object.entries(where).every(([key, value]) => release[key] === value)) || null,
    find: async ({ where }: any) => releases.filter((release) => Object.entries(where).every(([key, value]) => release[key] === value)),
    create: (row: any) => ({ id: `${row.deployedByPipelineRunId}-release`, ...row }),
    save: async (row: any) => { const index = releases.findIndex((release) => release.id === row.id); if (index >= 0) releases[index] = structuredClone(row); else releases.push(structuredClone(row)); return row; },
  };
  let transactionOperation = operation;
  const operationRepository = {
    findOne: async () => transactionOperation,
    save: async (row: any) => { saved.push(structuredClone(row)); return row; },
  };
  const runtimeConfigRepository = { find: async () => [runtimeConfig], save: async (row: any) => Object.assign(runtimeConfig, row) };
  const generationRevisionRepository = {
    find: async ({ where }: any) => generationRevisions.filter((revision) => revision.generationId === where.generationId),
    create: (row: any) => ({ id: `${row.generationId}-${row.serviceId}`, ...row }),
    save: async (rows: any[]) => { generationRevisions.push(...rows.map((row) => structuredClone(row))); return rows; },
  };
  const manager: any = {
    query: async () => undefined,
    getRepository: (entity: unknown) => entity === ProjectPipelineRun ? operationRepository
      : entity === ProjectDeploymentGeneration ? generationRepository
        : entity === ProjectEnvironmentRoute ? routeRepository
          : entity === ProjectStableRelease ? releaseRepository
            : entity === ProjectServiceRuntimeConfigRevision ? runtimeConfigRepository
              : entity === ProjectGenerationServiceRevision ? generationRevisionRepository
                : entity === Project ? { findOne: async () => ({ ...project, applicationEntryPointServiceId: serviceId }) }
            : null,
  };
  service.dataSource = { transaction: async (callback: any) => callback(manager) };
  const terminalStages = [
    { key: "materialize_release_runtime", label: "Deploy Runtime and Verify Application", status: "passed", startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:04:00.000Z", jobUrl: "https://github.example/job/1", failureReason: null },
    { key: "publish_verified_release_result", label: "Finalize Release", status: "passed", startedAt: "2026-09-01T00:04:00.000Z", completedAt: "2026-09-01T00:05:00.000Z", jobUrl: "https://github.example/job/1", failureReason: null },
  ];
  service.actions = { getWorkflowRun: async () => ({ status: "completed", conclusion: "success", updated_at: "2026-09-01T00:05:00.000Z" }), getWorkflowStages: async () => terminalStages, getResultArtifact: async () => JSON.stringify(valid) };
  await service.reconcile(operation);
  assert.equal(saved.at(-1).status, PipelineRunStatus.COMPLETED);
  assert.equal(operation.generationId, operation.id, "the immutable operation establishes the authoritative runtime generation");
  assert.equal(generations[0]?.status, "live");
  assert.equal(routes[0]?.liveGenerationId, operation.id);
  assert.equal(releases[0]?.metadata?.deployedUrl, runtime.public_url);
  assert.equal(generations[0]?.resourceManifest?.services?.find((item: any) => item.serviceId === serviceId)?.cloudWatchLogGroupName, runtime.cloudwatch_log_group_name);
  assert.equal(generations[0]?.resourceManifest?.services?.find((item: any) => item.serviceId === serviceId)?.applicationContainerName, "application");
  assert.equal(operation.metadata.releaseEvidenceVerified, true);
  assert.deepEqual(operation.metadata.workflowStages.map((stage: any) => stage.status), ["passed", "passed"], "terminal success refreshes actual GitHub stage metadata before finalization");
  assert.equal(operation.metadata.workflowStages[1].completedAt, "2026-09-01T00:05:00.000Z");
  assert.equal(operation.metadata.workflowStages.some((stage: any) => ["running", "pending"].includes(stage.status)), false);
  const redeployEvidence = structuredClone(valid);
  redeployEvidence.operationId = "88888888-8888-4888-8888-888888888888";
  redeployEvidence.sourceSha = "e".repeat(40);
  redeployEvidence.services[0].imageDigest = `sha256:${"b".repeat(64)}`;
  redeployEvidence.services[0].image = `${imageUri}@${redeployEvidence.services[0].imageDigest}`;
  redeployEvidence.terraform.services[serviceId].image = redeployEvidence.services[0].image;
  redeployEvidence.terraform.services[serviceId].task_definition_arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/dg:2";
  redeployEvidence.awsRuntimeVerification.services[0].image = redeployEvidence.services[0].image;
  redeployEvidence.awsRuntimeVerification.services[0].taskDefinitionArn = redeployEvidence.terraform.services[serviceId].task_definition_arn;
  const redeploy: any = { ...operation, id: redeployEvidence.operationId, generationId: null, status: PipelineRunStatus.RUNNING, currentStage: "release_evidence_pending", commitSha: redeployEvidence.sourceSha, metadata: { deploymentAction: "deploy", immutableDispatchInputs: { services_base64: contract(redeployEvidence.operationId, redeployEvidence.sourceSha) } } };
  transactionOperation = redeploy;
  runtimeConfig.createdByOperationId = redeploy.id;
  service.actions.getResultArtifact = async () => JSON.stringify(redeployEvidence);
  await service.reconcile(redeploy);
  assert.equal(redeploy.status, PipelineRunStatus.COMPLETED, "a later verified release must finalize against the same project-scoped Terraform state");
  assert.equal(redeploy.currentStage, "release_complete");
  assert.equal(generations.length, 2);
  assert.equal(generations.find((generation) => generation.id === operation.id)?.status, "retired");
  assert.equal(generations.find((generation) => generation.id === redeploy.id)?.status, "live");
  assert.equal(routes[0]?.liveGenerationId, redeploy.id);
  assert.equal(releases.find((release) => release.deployedByPipelineRunId === operation.id)?.status, "rollback_target");
  assert.equal(releases.find((release) => release.deployedByPipelineRunId === redeploy.id)?.status, "stable");
  const rollbackEvidence = structuredClone(valid);
  rollbackEvidence.action = "rollback";
  rollbackEvidence.operationId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  rollbackEvidence.terraform.services[serviceId].task_definition_arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/dg:3";
  rollbackEvidence.awsRuntimeVerification.services[0].taskDefinitionArn = rollbackEvidence.terraform.services[serviceId].task_definition_arn;
  const rollback: any = { ...operation, id: rollbackEvidence.operationId, generationId: null, status: PipelineRunStatus.RUNNING, currentStage: "release_evidence_pending", metadata: { deploymentAction: "rollback", immutableDispatchInputs: { services_base64: contract(rollbackEvidence.operationId, rollbackEvidence.sourceSha, "rollback", rollbackEvidence.services[0].image) } } };
  transactionOperation = rollback;
  service.actions.getResultArtifact = async () => JSON.stringify(rollbackEvidence);
  await service.reconcile(rollback);
  assert.equal(rollback.status, PipelineRunStatus.COMPLETED);
  assert.equal(routes[0]?.liveGenerationId, rollback.id, "rollback finalization creates and promotes a new operation generation");
  assert.equal(releases.find((release) => release.deployedByPipelineRunId === redeploy.id)?.status, "rollback_target", "the previously LIVE redeploy becomes the immediate rollback target");
  assert.equal(releases.find((release) => release.deployedByPipelineRunId === operation.id)?.status, "superseded", "older rollback history is not an ambiguous UI target");
  transactionOperation = operation;
  for (const [key, value] of [["operationId", "wrong"], ["sourceSha", "d".repeat(40)], ["action", "rollback"]] as const) {
    const invalid = { ...valid, [key]: value };
    service.actions.getResultArtifact = async () => JSON.stringify(invalid);
    await assert.rejects(() => service.releaseEvidence(project.repositoryFullName, operation, "ignored"));
  }

  const pendingOperation = { ...operation, status: PipelineRunStatus.RUNNING, currentStage: "release_evidence_pending", metadata: { deploymentAction: "deploy" } };
  service.actions.getResultArtifact = async () => null;
  await service.reconcile(pendingOperation);
  assert.equal(saved.at(-1).status, PipelineRunStatus.RUNNING, "missing evidence must not complete a successful workflow");
  assert.equal(saved.at(-1).currentStage, "release_evidence_pending");
  pendingOperation.metadata.releaseEvidencePendingSince = new Date(Date.now() - 3 * 60_000).toISOString();
  await service.reconcile(pendingOperation);
  await service.reconcile(pendingOperation);
  assert.equal(pendingOperation.status, PipelineRunStatus.FAILED, "bounded missing terminal evidence cannot remain Running forever");
  assert.equal(pendingOperation.metadata.failureCategory, "release_contract_incompatible");
  const transientEvidence: any = { ...operation, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: PipelineRunStatus.RUNNING, currentStage: "release_evidence_pending", metadata: { deploymentAction: "deploy" } };
  service.actions.getResultArtifact = async () => { throw new Error("artifact API temporarily unavailable"); };
  await service.reconcile(transientEvidence);
  assert.equal(transientEvidence.status, PipelineRunStatus.RUNNING, "transient artifact API failures remain retryable polling failures");
  service.actions.getResultArtifact = async () => "not-json";
  await assert.rejects(() => service.releaseEvidence(project.repositoryFullName, operation, "ignored"));
}

async function verifyTerminalFinalizationFailureIsRetryable() {
  const validEvidence = {
    releaseArtifact: { operationId: "99999999-9999-4999-8999-999999999999" },
    imageUri: "123.dkr.ecr.us-east-1.amazonaws.com/repo",
    imageDigest: `sha256:${"f".repeat(64)}`,
    albUrl: "http://example.test",
    taskDefinitionArn: "arn:aws:ecs:us-east-1:123:task-definition/dg:3",
    ecsServiceArn: "arn:aws:ecs:us-east-1:123:service/dg/dg",
  };
  const operation: any = {
    id: validEvidence.releaseArtifact.operationId,
    projectId: project.id,
    triggeredByUserId: user.id,
    githubWorkflowRunId: "789",
    status: PipelineRunStatus.RUNNING,
    currentStage: "release_evidence_pending",
    commitSha: "a".repeat(40),
    metadata: { executionEngine: "railpack", deploymentAction: "deploy" },
  };
  const saved: any[] = [];
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.projects = { findOne: async () => project };
  service.users = { findOne: async () => user };
  service.githubApp = { tokenForRepository: async () => ({ token: "ignored" }) };
  service.runs = { save: async (row: any) => { saved.push(structuredClone(row)); return row; } };
  service.sanitizer = new LogSanitizerService();
  service.actions = {
    getWorkflowRun: async () => ({ status: "completed", conclusion: "success" }),
    getResultArtifact: async () => "unused",
  };
  service.releaseEvidence = async () => validEvidence;
  service.finalizeVerifiedRelease = async () => { throw new Error("token=top-secret-password"); };
  await service.reconcile(operation);
  assert.equal(operation.status, PipelineRunStatus.FAILED, "a terminal successful workflow must not remain active when control-plane finalization fails");
  assert.equal(operation.currentStage, "release_finalization");
  assert.equal(operation.metadata.failureSource, "deployguard_reconciliation");
  assert.equal(operation.metadata.failureCategory, "release_finalization");
  assert.equal(operation.metadata.releaseEvidenceValidated, true);
  assert.equal(operation.errorMessage, "DeployGuard could not finalize the verified release.");
  assert.match(operation.metadata.safeLog, /token=\[REDACTED\]/i, "persisted reconciliation evidence must be sanitized");
  assert.equal(saved.at(-1).status, PipelineRunStatus.FAILED);

  const transient: any = { ...operation, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: PipelineRunStatus.RUNNING, currentStage: "github_actions", metadata: { executionEngine: "railpack", deploymentAction: "deploy" } };
  service.actions.getWorkflowRun = async () => { throw new Error("network unavailable"); };
  await service.reconcile(transient);
  assert.equal(transient.status, PipelineRunStatus.RUNNING, "transient GitHub polling failures remain active for later reconciliation");

  const recovery = Object.create(RailpackDeploymentService.prototype) as any;
  recovery.project = async () => project;
  recovery.runs = { findOne: async () => operation };
  recovery.validatedReleaseEvidence = () => validEvidence;
  let dispatchCalls = 0;
  let localFinalizationCalls = 0;
  recovery.dispatch = async () => { dispatchCalls += 1; return { deployment: { state: "accepted" } }; };
  recovery.finalizeVerifiedRelease = async (_project: any, candidate: any, evidence: any) => {
    localFinalizationCalls += 1;
    assert.equal(candidate, operation);
    assert.equal(evidence, validEvidence);
    candidate.status = PipelineRunStatus.COMPLETED;
    candidate.failureCode = null;
  };
  const recovered = await recovery.retry(user, project.id);
  assert.equal(recovered.deployment.state, "no_op");
  assert.equal(localFinalizationCalls, 1, "retry revalidates evidence and invokes only the local release-finalization transaction");
  assert.equal(dispatchCalls, 0, "release-finalization recovery must perform zero GitHub/AWS deployment dispatches");
  assert.equal(operation.status, PipelineRunStatus.COMPLETED);
}

async function verifyPreDispatchFailure() {
  const saved: any[] = [];
  const snapshots: any[] = [];
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.projects = { findOne: async () => project };
  service.managedDatabaseReconciliation = { reconcile: async () => ({ state: "HEALTHY", deploymentAllowed: true, resetAllowed: false, recoveryAvailable: false, title: "healthy", message: "healthy", tierUpdatedAt: null, identity: { environment: "dev", activeGenerationId: null }, evidence: { managed: false, persistenceEnabled: false, expectedStorageIdentity: false, bindingStatus: null, bindingFileSystemId: null, bindingAccessPointId: null, currentFileSystem: null, accessPoint: null, passwordSecretPresent: false, urlSecretPresent: false, terraformDatabaseAddresses: [], usableRecoveryPointArn: null } }) };
  const runRepository = {
    findOne: async () => null,
    count: async () => 0,
    create: (row: any) => row,
    save: async (row: any) => { saved.push(structuredClone(row)); return row; },
  };
  service.runs = runRepository;
  service.config = { get: (key: string, fallback = "") => key === "DEPLOYGUARD_REUSABLE_WORKFLOW" ? "Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@0123456789abcdef0123456789abcdef01234567" : fallback };
  const serviceRow = { id: project.applicationEntryPointServiceId, projectId: project.id, name: "Web", serviceDirectory: ".", servicePort: 8080, position: 0 };
  const snapshotRepository = { create: (row: any) => row, save: async (row: any) => { const savedSnapshot = { ...row, id: "88888888-8888-4888-8888-888888888888" }; snapshots.push(structuredClone(savedSnapshot)); return savedSnapshot; } };
  const manager = {
    query: async (sql: string) => { assert.match(sql, /pg_advisory_xact_lock/, "admission must acquire the database-backed project configuration lock"); },
    getRepository: (entity: unknown) => entity === Project ? { findOne: async () => ({ ...project }) }
      : entity === ProjectPipelineRun ? runRepository
        : entity === ProjectDeployableService ? { find: async () => [serviceRow] }
          : entity === ProjectEnvironmentVariable ? { createQueryBuilder: () => ({ addSelect() { return this; }, where() { return this; }, getMany: async () => [] }) }
            : entity === ProjectDatabaseTier ? { findOne: async () => null }
              : entity === ProjectConfigurationSnapshot ? snapshotRepository
                : entity === ProjectEnvironmentRoute ? { findOne: async () => null }
                  : null,
  };
  service.dataSource = { transaction: async (callback: any) => callback(manager) };
  service.crypto = { decrypt: (value: string) => value, encrypt: (_value: string) => "encrypted-fixture" };
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
  assert.equal(snapshots.length, 1, "the queued operation is bound to one persisted admitted configuration snapshot");
  assert.equal(snapshots[0].pipelineRunId, failed.id);
  assert.equal(failed.configurationSnapshotId, snapshots[0].id);
  assert.equal(isAiTroubleshootingEligible(failed), true, "sanitized dispatch failure must be troubleshooting eligible");
  return failed;
}

async function verifyAtomicAdmissionAndImmutableConfiguration() {
  const operations: any[] = [];
  const snapshots: any[] = [];
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.managedDatabaseReconciliation = { reconcile: async () => ({ state: "HEALTHY", deploymentAllowed: true, resetAllowed: false, recoveryAvailable: false, title: "healthy", message: "healthy", tierUpdatedAt: null, identity: { environment: "dev", activeGenerationId: null }, evidence: { managed: true, persistenceEnabled: true, expectedStorageIdentity: false, bindingStatus: "pending", bindingFileSystemId: null, bindingAccessPointId: null, currentFileSystem: null, accessPoint: null, passwordSecretPresent: false, urlSecretPresent: false, terraformDatabaseAddresses: [], usableRecoveryPointArn: null } }) };
  const serviceRow: any = { id: project.applicationEntryPointServiceId, projectId: project.id, name: "Web", serviceDirectory: "apps/a", servicePort: 3000, position: 0 };
  const variableRows: any[] = [
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", serviceId: serviceRow.id, key: "MODE", value: "encrypted-mode-a", isSecret: false, scope: "runtime", isActive: true },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", serviceId: serviceRow.id, key: "TOKEN", value: "encrypted-secret-a", isSecret: true, scope: "runtime", isActive: true },
  ];
  let managedTier: any = { provider: "managed", engine: "postgres", attachedServiceId: serviceRow.id, persistenceEnabled: true, backupEnabled: false, databaseName: "app_fixture", databaseUser: "dg_fixture" };
  const runRepository = {
    findOne: async () => operations.find((item) => [PipelineRunStatus.QUEUED, PipelineRunStatus.RUNNING].includes(item.status)) || null,
    count: async () => operations.length,
    create: (row: any) => row,
    save: async (row: any) => {
      const index = operations.findIndex((item) => item.id === row.id);
      if (index < 0) operations.push(row); else operations[index] = row;
      return row;
    },
  };
  let lockTail = Promise.resolve();
  service.dataSource = {
    transaction: async (callback: any) => {
      let release = () => undefined;
      let acquired = false;
      const manager = {
        query: async (sql: string) => {
          assert.match(sql, /pg_advisory_xact_lock/);
          const previous = lockTail;
          lockTail = new Promise<void>((resolve) => { release = resolve; });
          await previous;
          acquired = true;
        },
        getRepository: (entity: unknown) => entity === Project ? { findOne: async () => ({ ...project }) }
          : entity === ProjectPipelineRun ? runRepository
            : entity === ProjectDeployableService ? { find: async () => [{ ...serviceRow }], save: async (row: any) => row }
              : entity === ProjectEnvironmentVariable ? { createQueryBuilder: () => ({ addSelect() { return this; }, where() { return this; }, getMany: async () => variableRows.map((row) => ({ ...row })) }) }
                : entity === ProjectDatabaseTier ? { findOne: async () => managedTier ? { ...managedTier } : null }
                  : entity === ProjectConfigurationSnapshot ? { create: (row: any) => row, findOne: async () => snapshots[0] || null, save: async (row: any) => { const value = { ...row, id: row.id || "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }; if (!row.id) snapshots.push(value); else snapshots[0] = value; return value; } }
                    : entity === ProjectEnvironmentRoute ? { findOne: async () => null }
                      : null,
      };
      try { return await callback(manager); }
      finally { if (acquired) release(); }
    },
  };
  service.projects = { findOne: async () => ({ ...project }) };
  service.runs = runRepository;
  service.crypto = {
    decrypt: (value: string) => value === "encrypted-mode-a" ? "mode-a" : value === "encrypted-secret-a" ? "secret-a" : value,
    encrypt: (_value: string) => "encrypted-snapshot-payload",
  };
  service.config = { get: (key: string, fallback = "") => ({
    DEPLOYGUARD_REUSABLE_WORKFLOW: "Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@0123456789abcdef0123456789abcdef01234567",
    DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN: "arn:aws:iam::123456789012:role/deployguard",
    DEPLOYGUARD_VPC_ID: "vpc-fixture",
    DEPLOYGUARD_PUBLIC_SUBNET_IDS: "subnet-a,subnet-b",
    DEPLOYGUARD_TERRAFORM_STATE_BUCKET: "deployguard-fixture",
    AWS_REGION: "us-east-1",
  } as Record<string, string>)[key] || fallback };
  let releaseFirstCredential = () => undefined;
  const credentialGate = new Promise<void>((resolve) => { releaseFirstCredential = resolve; });
  let credentialStarted = () => undefined;
  const credentialStartedGate = new Promise<void>((resolve) => { credentialStarted = resolve; });
  let credentialCalls = 0;
  service.githubApp = {
    tokenForRepository: async () => {
      credentialCalls += 1;
      serviceRow.serviceDirectory = "apps/b";
      serviceRow.servicePort = 9000;
      variableRows[0].value = "encrypted-mode-b";
      variableRows[1].value = "encrypted-secret-b";
      managedTier = null;
      credentialStarted();
      await credentialGate;
      return { token: "fixture-token" };
    },
    ensureWorkflow: async () => ({ registrationBranch: "main" }),
    oidcTrustSubject: async () => "repo:fixture",
  };
  let validatedServices: any[] = [];
  service.source = {
    resolveSourceSha: async () => "a".repeat(40),
    resolveBuildTargetsAtExactSha: async (input: any) => { validatedServices = input.services; return { ports: input.services.map((item: any) => ({ serviceId: item.serviceId, servicePort: 3000, evidence: { priority: 2, source: "fixture" } })), targets: input.services.map((item: any) => ({ serviceId: item.serviceId, target: { resolverVersion: "deployguard.build-target/v1", sourceSha: "a".repeat(40), serviceDirectory: item.serviceDirectory, workspaceRoot: ".", buildRoot: item.serviceDirectory, installRoot: item.serviceDirectory, packageIdentity: "fixture", dependencyPaths: [], strategy: "isolated", status: "resolved", evidence: {}, override: null, fingerprint: "a".repeat(64) } })) }; },
    resolveRequirementsAtExactSha: async () => ({ status: "READY", fingerprint: "b".repeat(64), requirements: [], unresolvedRequired: [], prohibitedOverrides: [], duplicateConflicts: [], validationBlockers: [] }),
  };
  service.buildTargetRevisions = { create: (row: any) => row, save: async (row: any) => ({ ...row, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }) };
  service.oidcTrust = { ensureRepositoryAuthorized: async () => undefined };
  const materializedSecrets: any[] = [];
  service.runtimeSecrets = { materialize: async (input: any) => {
    materializedSecrets.push(input);
    const versionToken = "f".repeat(64);
    return { versionToken, secretNames: ["TOKEN"], valueFromByName: { TOKEN: `arn:aws:secretsmanager:us-east-1:123456789012:secret:fixture:TOKEN::${versionToken}` } };
  } };
  service.runtimeConfigRevisions = { create: (row: any) => row, save: async (row: any) => ({ ...row, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }) };
  service.awsCapabilities = { ensure: async () => undefined };
  let dispatchCalls = 0;
  let dispatchedInputs: any = null;
  service.actions = { triggerWorkflow: async (input: any) => { dispatchCalls += 1; dispatchedInputs = input.inputs; return { receipt: { workflowRunId: "123", workflowRunUrl: "https://example.test/run/123" } }; } };

  const first = service.deploy(user, project.id);
  await credentialStartedGate;
  const second = await service.deploy(user, project.id);
  assert.equal(second.deployment.state, "no_op", "the losing concurrent caller returns the canonical already-progressing result");
  releaseFirstCredential();
  const accepted = await first;
  assert.equal(accepted.deployment.state, "accepted");
  assert.equal(operations.length, 1, "concurrent lifecycle requests persist exactly one authoritative operation");
  assert.equal(dispatchCalls, 1, "the losing caller never reaches workflow dispatch");
  assert.equal(credentialCalls, 1, "the losing caller never crosses the first external boundary");
  assert.deepEqual(validatedServices, [{ serviceId: serviceRow.id, serviceDirectory: "apps/a", buildTargetOverride: undefined }], "build-target resolution consumes the admitted service snapshot");
  const runtime = JSON.parse(Buffer.from(dispatchedInputs.services_base64, "base64").toString("utf8"));
  assert.equal(runtime.services[0].serviceDirectory, "apps/a");
  assert.equal(runtime.services[0].servicePort, 3000);
  assert.equal(runtime.services[0].buildTarget.buildRoot, "apps/a");
  assert.equal(runtime.services[0].environment.MODE, "mode-a");
  assert.equal(runtime.services[0].databaseAttached, true);
  assert.deepEqual(materializedSecrets[0].secretValues, { TOKEN: "secret-a" }, "secret materialization consumes the admitted encrypted snapshot value in memory");
  assert.equal(snapshots.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshots[0].sanitizedManifest), /secret-a/, "sanitized snapshot metadata contains no plaintext secret value");
  assert.equal(snapshots[0].encryptedSecretPayload, "encrypted-snapshot-payload");

  const migration = readFileSync(join(__dirname, "../src/migrations/1787356821000-EnforceSingleActiveRailpackOperation.ts"), "utf8");
  assert.match(migration, /CREATE UNIQUE INDEX "UQ_project_active_railpack_operation"/);
  assert.match(migration, /"status" IN \('queued', 'running'\)/);
  assert.match(migration, /"metadata"->>'executionEngine' = 'railpack'/);
}

async function verifyActiveOperationUniquenessConflictReturnsCanonicalNoOp() {
  const canonical = { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", projectId: project.id, status: PipelineRunStatus.QUEUED };
  const driverError = Object.assign(new Error("duplicate key"), { code: "23505", constraint: "UQ_project_active_railpack_operation" });
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.dataSource = { transaction: async () => { throw new QueryFailedError("INSERT", [], driverError); } };
  service.runs = { findOne: async () => canonical };
  const result = await service.admitLifecycleOperation(user, project, "deploy", null, null);
  assert.equal(result.active, canonical, "a database uniqueness loser resolves to the canonical active operation instead of a generic failure");
}

function verifyCapabilityFailureIsBoundedAndPreDispatch() {
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  const failure = service.dispatchFailure(new WorkflowAwsCapabilityError([
    "ecs:CreateCluster", "elasticloadbalancing:CreateLoadBalancer", "iam:AttachRolePolicy",
  ], "fixture"), "aws_capability_verification");
  assert.equal(failure.stage, "aws_capability_verification");
  assert.equal(failure.evidence.classification, "platform_configuration");
  assert.deepEqual(failure.evidence.missingCapabilities, ["ecs:CreateCluster", "elasticloadbalancing:CreateLoadBalancer", "iam:AttachRolePolicy"]);
  assert.doesNotMatch(failure.message, /fixture/, "internal IAM simulator text must not become high-level operation evidence");
  const compatibility = service.dispatchFailure(new ControlPlaneCompatibilityError("producer mismatch"), "caller_reconciliation");
  assert.equal(compatibility.stage, "control_plane_compatibility");
  assert.equal(compatibility.evidence.code, CONTROL_PLANE_VERSION_MISMATCH);
  assert.match(compatibility.message, /DG_FAILURE code=DG_CONTROL_PLANE_VERSION_MISMATCH/);
}

async function verifyPerActionCapabilitySimulation() {
  const scope: any = { accountId: "000000000000", region: "us-east-1", projectId: project.id, environmentName: "dev", generationId: "22222222-2222-4222-8222-222222222222", terraformStateBucket: "deployguard-state", vpcId: "vpc-00000000000000000", managedDatabaseEnabled: false };
  const state = WORKFLOW_AWS_CAPABILITIES.find((capability) => capability.id === "terraform-state")!;
  const role = WORKFLOW_AWS_CAPABILITIES.find((capability) => capability.id === "execution-role")!;
  const calls: any[] = [];
  const allowed = { send: async (command: any) => { const input = command.input; calls.push(input); return { EvaluationResults: input.ActionNames.map((action: string) => ({ EvalActionName: action, EvalDecision: "allowed" })) }; } };
  assert.deepEqual(await verifyEffectiveWorkflowCapabilities(allowed, "arn:aws:iam::000000000000:role/deployguard", scope, "deploy", [state]), []);
  const listBucket = calls.find((call) => call.ActionNames.includes("s3:ListBucket"));
  const objectAccess = calls.find((call) => call.ActionNames.includes("s3:GetObject"));
  assert.deepEqual(listBucket.ResourceArns, ["arn:aws:s3:::deployguard-state"]);
  assert.deepEqual(objectAccess.ResourceArns, [`arn:aws:s3:::deployguard-state/projects/${project.id}/runtime/terraform.tfstate`]);
  calls.length = 0;
  await verifyEffectiveWorkflowCapabilities(allowed, "arn:aws:iam::000000000000:role/deployguard", scope, "deploy", [role]);
  assert.ok(calls.every((call) => call.ResourceArns.every((resource: string) => resource.includes(":role/dg-") || resource === "*")), "IAM simulation must not pass the managed policy ARN as a resource");
  const missing = { send: async (command: any) => ({ EvaluationResults: command.input.ActionNames.map((action: string) => ({ EvalActionName: action, EvalDecision: action === "s3:PutObject" ? "implicitDeny" : "allowed" })) }) };
  assert.deepEqual(await verifyEffectiveWorkflowCapabilities(missing, "arn:aws:iam::000000000000:role/deployguard", scope, "deploy", [state]), ["s3:PutObject"]);
  const policy: any = workflowCapabilityPolicy(scope);
  const attach = policy.Statement.find((statement: any) => statement.Action.includes("iam:AttachRolePolicy"));
  assert.deepEqual(attach.Resource, ["arn:aws:iam::000000000000:role/dg-*"]);
  assert.equal(attach.Condition.StringEquals["iam:PolicyARN"], "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy");
}

async function verifyProviderContractAndConditionalDatabaseScope() {
  const scope: any = { accountId: "000000000000", region: "us-east-1", projectId: project.id, environmentName: "dev", generationId: "22222222-2222-4222-8222-222222222222", terraformStateBucket: "deployguard-state", vpcId: "vpc-00000000000000000" };
  const allActions = new Set(WORKFLOW_AWS_CAPABILITIES.flatMap((capability) => capability.actions));
  for (const [resource, actions] of Object.entries(RAILPACK_RUNTIME_PROVIDER_API_REQUIREMENTS)) {
    for (const action of actions) assert.ok(allActions.has(action), `provider action ${action} for ${resource} is absent from the canonical contract`);
  }
  const normal = capabilitiesFor("deploy", { ...scope, managedDatabaseEnabled: false });
  assert.ok(!normal.some((capability) => capability.id === "database-efs" || capability.id === "database-secrets"));
  assert.ok(!normal.flatMap((capability) => capability.actions).some((action) => action.startsWith("elasticfilesystem:") || action.startsWith("route53:") || action === "ec2:DescribeRegions" || action === "secretsmanager:GetResourcePolicy"));
  const database = capabilitiesFor("deploy", { ...scope, managedDatabaseEnabled: true });
  assert.ok(database.some((capability) => capability.id === "database-efs"));
  assert.ok(database.some((capability) => capability.id === "database-secrets"));
  const databaseActions = new Set(database.flatMap((capability) => capability.actions));
  const privateDnsActions = ["route53:CreateHostedZone", "route53:GetHostedZone", "route53:ListHostedZonesByName", "route53:DeleteHostedZone", "ec2:DescribeRegions"];
  for (const action of ["elasticfilesystem:DescribeLifecycleConfiguration", "secretsmanager:GetResourcePolicy", "secretsmanager:ListSecretVersionIds", ...privateDnsActions]) assert.ok(databaseActions.has(action), `managed database capability missing: ${action}`);
  assert.equal(WORKFLOW_AWS_CAPABILITY_CONTRACT_VERSION, "deployguard.railpack-runtime-aws/v8");
  const applicationSecrets = normal.find((capability) => capability.id === "application-secrets");
  assert.ok(applicationSecrets, "application ENV secrets require an explicit pre-dispatch capability");
  assert.ok(applicationSecrets.actions.includes("secretsmanager:GetSecretValue"), "build-scope secrets require immutable-version reads");
  const databasePolicy: any = workflowCapabilityPolicy({ ...scope, managedDatabaseEnabled: true });
  const globalRoute53 = databasePolicy.Statement.find((statement: any) => statement.Action.includes("route53:CreateHostedZone"));
  const hostedZoneRoute53 = databasePolicy.Statement.find((statement: any) => statement.Action.includes("route53:GetHostedZone"));
  assert.deepEqual(globalRoute53.Resource, ["*"], "Route 53 create/list use the required global IAM scope");
  assert.deepEqual(hostedZoneRoute53.Resource, ["arn:aws:route53:::hostedzone/*"], "Route 53 hosted-zone read/delete remain resource-scoped");
  const allowed = { send: async (command: any) => ({ EvaluationResults: command.input.ActionNames.map((action: string) => ({ EvalActionName: action, EvalDecision: "allowed" })) }) };
  assert.deepEqual(await verifyEffectiveWorkflowCapabilities(allowed, "arn:aws:iam::000000000000:role/deployguard", { ...scope, managedDatabaseEnabled: true }, "deploy", database), [], "the complete managed-database capability set must pass admission");
  for (const action of privateDnsActions) {
    const denied = { send: async (command: any) => ({ EvaluationResults: command.input.ActionNames.map((candidate: string) => ({ EvalActionName: candidate, EvalDecision: candidate === action ? "implicitDeny" : "allowed" })) }) };
    assert.deepEqual(
      await verifyEffectiveWorkflowCapabilities(denied, "arn:aws:iam::000000000000:role/deployguard", { ...scope, managedDatabaseEnabled: true }, "deploy", database),
      [action],
      `${action} denial must fail managed-database admission before workflow dispatch`,
    );
  }
  for (const lifecycle of ["deploy", "rollback", "destroy"] as const) {
    const actions = new Set(capabilitiesFor(lifecycle, { ...scope, managedDatabaseEnabled: true }).flatMap((capability) => capability.actions));
    for (const action of privateDnsActions) assert.ok(actions.has(action), `${lifecycle} must admit the complete private-DNS lifecycle: ${action}`);
  }
  assert.equal(PINNED_AWS_PROVIDER_VERSION, "5.100.0");
  const root = join(__dirname, "..", "..");
  const terraform = readFileSync(join(root, "infrastructure", "railpack-runtime", "main.tf"), "utf8");
  const manifestActions = new Set(Object.values(RAILPACK_RUNTIME_PROVIDER_API_REQUIREMENTS).flat());
  for (const expected of PINNED_PROVIDER_INDIRECT_API_EXPECTATIONS) {
    assert.match(terraform, new RegExp(`resource\\s+"${expected.terraformResource}"`), `provider expectation targets a current Terraform resource: ${expected.terraformResource}`);
    assert.ok(manifestActions.has(expected.action), `independent provider expectation missing from manifest: ${expected.action} (${expected.providerFunction})`);
    assert.ok(allActions.has(expected.action), `independent provider expectation missing from capability contract: ${expected.action} (${expected.providerFunction})`);
  }
  assert.ok(capabilitiesFor("destroy", { ...scope, managedDatabaseEnabled: false }).flatMap((capability) => capability.actions).includes("ec2:DescribeNetworkInterfaces"));
  const destroyCapabilities = capabilitiesFor("destroy", { ...scope, managedDatabaseEnabled: false });
  const destroyActions = destroyCapabilities.flatMap((capability) => capability.actions);
  assert.ok(destroyActions.includes("iam:ListInstanceProfilesForRole"), "Terraform Destroy must preflight the provider's IAM role-deletion helper call");
  assert.ok(destroyActions.includes("ecr:DeleteRepository"), "Destroy must preflight immutable ECR repository deletion before dispatch");
  const denyInstanceProfiles = { send: async (command: any) => ({ EvaluationResults: command.input.ActionNames.map((action: string) => ({ EvalActionName: action, EvalDecision: action === "iam:ListInstanceProfilesForRole" ? "implicitDeny" : "allowed" })) }) };
  assert.deepEqual(await verifyEffectiveWorkflowCapabilities(denyInstanceProfiles, "arn:aws:iam::000000000000:role/deployguard", scope, "destroy", destroyCapabilities), ["iam:ListInstanceProfilesForRole"], "missing IAM role-delete helper permission fails before Terraform Destroy");
  const denyEcrDelete = { send: async (command: any) => ({ EvaluationResults: command.input.ActionNames.map((action: string) => ({ EvalActionName: action, EvalDecision: action === "ecr:DeleteRepository" ? "implicitDeny" : "allowed" })) }) };
  assert.deepEqual(await verifyEffectiveWorkflowCapabilities(denyEcrDelete, "arn:aws:iam::000000000000:role/deployguard", scope, "destroy", destroyCapabilities), ["ecr:DeleteRepository"], "missing immutable ECR cleanup permission fails before Destroy dispatch");
  assert.ok(!capabilitiesFor("deploy", { ...scope, managedDatabaseEnabled: false }).flatMap((capability) => capability.actions).includes("ec2:DescribeNetworkInterfaces"));
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
  service.releaseRepository = { findOne: async () => null };
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
  assert.equal(state.latestAttempt.failureOwner, failed.failureOwner || null, "current-state projects only the persisted pipeline-run failure owner");
  assert.equal(state.developerState, "failed_application");
  if (realGithubRun) {
    assert.equal(state.progress.phase, "build", "Railpack build failure must not project as runtime deployment");
    assert.deepEqual(state.latestAttempt.workflowStages?.map((stage) => [stage.key, stage.status]), [
      ["checkout_exact_application_source", "passed"],
      ["install_pinned_railpack", "passed"],
      ["build_immutable_railpack_images", "failed"],
      ["publish_immutable_images_to_ecr", "skipped"],
      ["install_terraform", "skipped"],
    ]);
  } else {
    assert.match(state.developerMessage, /could not start/i);
    assert.doesNotMatch(state.developerMessage, /GitHub Actions failed/i);
  }
}

async function verifyVerifiedReleaseProjectsLive() {
  const completedAt = new Date("2026-08-29T12:00:00.000Z");
  const generationId = "88888888-8888-4888-8888-888888888888";
  const stableUrl = "http://verified.example.test";
  const latest: any = {
    id: generationId, projectId: project.id, generationId, status: PipelineRunStatus.COMPLETED,
    currentStage: "release_complete", githubWorkflowRunId: "456", commitSha: "c".repeat(40),
    createdAt: completedAt, startedAt: completedAt, completedAt, updatedAt: completedAt, failedAt: null,
    metadata: { executionEngine: "railpack", deploymentAction: "deploy", attempt: 1, deployedUrl: stableUrl, releaseEvidenceVerified: true },
  };
  const stableRelease: any = {
    id: "99999999-9999-4999-8999-999999999999", generationId, deployedByPipelineRunId: latest.id,
    deployedAt: completedAt, metadata: { deployedUrl: stableUrl, releaseEvidenceVerified: true },
  };
  const base: any = {
    repository: project.repositoryFullName, branch: project.targetBranch, commit: null, latestAttempt: null,
    stableRelease: null, stableUrl: null, estimatedCost: null, missingConfiguration: [], advisories: [], applicationError: null,
    canRetry: false, stateAuthority: null,
    developerState: "ready", developerAction: "deploy", developerMessage: "ready", progress: { percentage: 0, phase: null, label: "Ready" },
  };
  const projectState = async (candidate: any, release: any) => {
    const builder: any = {
      stable: false,
      where() { return this; },
      andWhere(value: string) { if (value.includes("run.id =")) this.stable = true; return this; },
      orderBy() { return this; },
      clone() { return this; },
      getOne: async () => candidate,
    };
    const service = Object.create(ProjectCurrentStateService.prototype) as any;
    service.runRepository = { createQueryBuilder: () => builder };
    service.releaseRepository = { findOne: async () => null };
    return service.withGithubActionsState(project.id, "dev", base, release ? generationId : null, release);
  };
  const live = await projectState(latest, stableRelease);
  assert.equal(live.developerState, "live");
  assert.equal(live.latestAttempt.generationId, generationId);
  assert.equal(live.stableRelease.generationId, generationId);
  assert.equal(live.stableUrl, stableUrl);

  const invalid = await projectState({ ...latest, metadata: { ...latest.metadata, releaseEvidenceVerified: false } }, stableRelease);
  assert.equal(invalid.developerState, "platform_attention", "a completed operation without validated release evidence must not become LIVE");
  const healthFailed = await projectState({ ...latest, status: PipelineRunStatus.FAILED, currentStage: "release_failed", metadata: { ...latest.metadata, failedStage: "release_failed" } }, null);
  assert.equal(healthFailed.developerState, "failed_application", "failed verification without a stable release must not become LIVE");
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
      { name: "Post Checkout", status: "completed", conclusion: "success" },
      { name: "Checkout exact application source", status: "completed", conclusion: "success" },
      { name: "Install pinned Railpack", status: "completed", conclusion: "success" },
      { name: "Build immutable Railpack images", status: "completed", conclusion: "failure" },
      { name: "Publish immutable images to ECR", status: "completed", conclusion: "skipped" },
      { name: "Install Terraform", status: "completed", conclusion: "skipped" },
    ],
  }] });
  githubActions.getJobLog = async () => "Railpack 0.38.0\nERRO BUILDKIT_HOST environment variable is not set.\ntoken=ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  githubActions.getArtifactEntry = async () => null;
  const githubEvidence = await githubActions.getTerminalFailureEvidence("example/application", "123", "22222222-2222-4222-8222-222222222222", "ignored");
  assert.ok(githubEvidence);
  assert.equal(githubEvidence.failedStage, "build_immutable_railpack_images");
  assert.deepEqual(githubEvidence.workflowStages.map((stage: any) => [stage.key, stage.status]), [
    ["checkout_exact_application_source", "passed"],
    ["install_pinned_railpack", "passed"],
    ["build_immutable_railpack_images", "failed"],
    ["publish_immutable_images_to_ecr", "skipped"],
    ["install_terraform", "skipped"],
  ]);
  service.actions = { getTerminalFailureEvidence: async () => githubEvidence };
  service.sanitizer = new LogSanitizerService();
  const evidence = await service.terminalFailureEvidence("example/application", "123", "22222222-2222-4222-8222-222222222222", "ignored", "deploy");
  assert.equal(evidence.failedStage, "build_immutable_railpack_images");
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
  assert.equal(persisted.metadata.failedStage, "build_immutable_railpack_images");
  assert.match(persisted.metadata.safeLog, /BUILDKIT_HOST environment variable is not set/);
  assert.doesNotMatch(persisted.metadata.safeLog, /ghp_/);
  assert.equal(isAiTroubleshootingEligible(persisted), true, "terminal GitHub failure with sanitized evidence must be eligible");
  return failedRun;
}

async function verifyStructuredRuntimeFailureSurvivesTerminalReconciliation() {
  const serviceId = "77777777-7777-4777-8777-777777777777";
  for (const action of ["deploy", "rollback", "destroy"] as const) {
    const saved: any[] = [];
    const terminalStages = [
      { key: "materialize_release_runtime", label: "Deploy Runtime and Verify Application", status: "failed", startedAt: "2026-09-01T00:00:00.000Z", completedAt: "2026-09-01T00:03:00.000Z", jobUrl: null, failureReason: "GitHub Actions step failed: Materialize release runtime" },
      { key: "publish_verified_release_result", label: "Finalize Release", status: "skipped", startedAt: null, completedAt: null, jobUrl: null, failureReason: null },
    ];
    const service = Object.create(RailpackDeploymentService.prototype) as any;
    service.projects = { findOne: async () => project };
    service.users = { findOne: async () => user };
    service.githubApp = { tokenForRepository: async () => ({ token: "ignored" }) };
    service.runs = { save: async (row: any) => { saved.push(structuredClone(row)); return row; } };
    service.sanitizer = new LogSanitizerService();
    service.actions = {
      getWorkflowRun: async () => ({ status: "completed", conclusion: "failure", updated_at: "2026-09-01T00:03:00.000Z" }),
      getWorkflowStages: async () => terminalStages,
      getTerminalFailureEvidence: async () => ({
        failedStage: "materialize_release_runtime",
        rawEvidence: `DG_ECS_DIAGNOSTICS {"diagnosticCode":"ECS_STABILITY_FAILED"}\nDG_FAILURE serviceId=${serviceId} code=DG_ECS_STABILITY_FAILED stage=ecs_stability`,
        workflowStages: terminalStages,
      }),
    };
    const operation: any = { id: "55555555-5555-4555-8555-555555555555", projectId: project.id, triggeredByUserId: user.id, githubWorkflowRunId: "123", status: PipelineRunStatus.RUNNING, currentStage: "materialize_release_runtime", commitSha: "a".repeat(40), metadata: { executionEngine: "railpack", deploymentAction: action } };
    await service.reconcile(operation);
    const persisted = saved.at(-1);
    assert.equal(persisted.status, PipelineRunStatus.FAILED);
    assert.equal(persisted.currentStage, "ecs_stability", `${action} preserves the emitted runtime stage instead of the wrapper GitHub step`);
    assert.equal(persisted.metadata.failedStage, "ecs_stability");
    assert.equal(persisted.failureCode, "DG_ECS_STABILITY_FAILED");
    assert.equal(persisted.failureServiceId, serviceId);
    assert.equal(persisted.metadata.workflowStages.some((stage: any) => stage.status === "running"), false, `${action} terminal failure leaves no falsely running stage`);
  }
}

async function verifyPersistedRuntimeFailureArtifactIsConsumed() {
  const operationId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const serviceId = "77777777-7777-4777-8777-777777777777";
  const marker = `DG_FAILURE serviceId=${serviceId} code=DG_ECS_STABILITY_FAILED stage=ecs_stability`;
  const actions = Object.create(GithubActionsService.prototype) as any;
  actions.getWorkflowJobs = async () => ({ jobs: [{ id: 91, name: "deploy", status: "completed", conclusion: "failure", steps: [{ name: "Materialize release runtime", status: "completed", conclusion: "failure" }] }] });
  actions.getWorkflowStages = async () => [{ key: "materialize_release_runtime", label: "Deploy Runtime and Verify Application", status: "failed", startedAt: null, completedAt: null, jobUrl: null, failureReason: "GitHub Actions step failed: Materialize release runtime" }];
  actions.getJobLog = async () => "The verifier returned exit code 1.";
  actions.getArtifactEntry = async (_repository: string, _runId: string, candidateOperationId: string, _token: string, entry: string) => {
    assert.equal(candidateOperationId, operationId);
    assert.equal(entry, DEPLOYGUARD_FAILURE_ARTIFACT_ENTRY);
    return JSON.stringify({ contractVersion: "deployguard.release-failure/v1", action: "deploy", sourceSha: "a".repeat(40), operationId, failedStage: "aws_runtime_verification", awsRuntimeVerification: { contractVersion: "deployguard.aws-runtime-verification/v1", verified: false, services: [{ serviceId, verified: false, failureCode: "DG_ECS_STABILITY_FAILED", stage: "ecs_stability", failureMarker: marker, diagnostics: { taskEvents: ["service deployment failed"], targetHealth: [{ targetId: "10.0.0.5", state: "unhealthy" }] } }] } });
  };
  const evidence = await actions.getTerminalFailureEvidence("example/application", "123", operationId, "ignored", "deploy");
  assert.ok(evidence);
  assert.match(evidence.rawEvidence, /Persisted terminal verification evidence/);
  assert.match(evidence.rawEvidence, new RegExp(marker));
  assert.match(evidence.rawEvidence, /targetHealth/);
  const parsed = terminalStructuredFailureMarker(evidence.rawEvidence);
  assert.equal(parsed.code, "DG_ECS_STABILITY_FAILED");
  assert.equal(parsed.serviceId, serviceId);
  assert.equal(parsed.stage, "ecs_stability", "backend terminal reconciliation consumes the exact persisted verifier failure marker");
}

async function verifyActiveGithubStagesPersistWithoutPipeline() {
  const saved: any[] = [];
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.projects = { findOne: async () => project };
  service.users = { findOne: async () => user };
  service.githubApp = { tokenForRepository: async () => ({ token: "ignored" }) };
  service.runs = { save: async (row: any) => { saved.push(structuredClone(row)); return row; } };
  service.actions = {
    getWorkflowRun: async () => ({ status: "in_progress", conclusion: null }),
    getWorkflowStages: async () => [
      { key: "checkout", label: "Checkout", status: "passed", startedAt: "2026-08-29T10:00:00.000Z", completedAt: "2026-08-29T10:00:03.000Z", jobUrl: null, failureReason: null },
      { key: "aws_oidc", label: "AWS OIDC", status: "passed", startedAt: "2026-08-29T10:00:03.000Z", completedAt: "2026-08-29T10:00:06.000Z", jobUrl: null, failureReason: null },
      { key: "build_immutable_railpack_images", label: "Building Railpack images", status: "running", startedAt: "2026-08-29T10:00:06.000Z", completedAt: null, jobUrl: null, failureReason: null },
      { key: "materialize_release_runtime", label: "Materializing runtime", status: "pending", startedAt: null, completedAt: null, jobUrl: null, failureReason: null },
    ],
  };
  const operation: any = { id: "55555555-5555-4555-8555-555555555555", projectId: project.id, triggeredByUserId: user.id, githubWorkflowRunId: "123", status: PipelineRunStatus.RUNNING, currentStage: "github_actions", metadata: { executionEngine: "railpack" } };
  await service.reconcile(operation);
  assert.equal(saved.at(-1).currentStage, "build_immutable_railpack_images");
  assert.deepEqual(saved.at(-1).metadata.workflowStages.map((stage: any) => stage.status), ["passed", "passed", "running", "pending"]);
  service.actions.getWorkflowStages = async () => [];
  await service.reconcile(operation);
  assert.equal(saved.at(-1).metadata.workflowStages.length, 4, "a transient empty jobs response must retain prior stage evidence");
}

async function verifyTerminalStageMetadataConvergenceAndBackfill() {
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.config = { get: () => 0 };
  let reads = 0;
  service.actions = { getWorkflowStages: async () => {
    reads += 1;
    return reads < 3
      ? [{ key: "materialize_release_runtime", label: "Deploy Runtime and Verify Application", status: "running", startedAt: "2026-09-01T00:00:00Z", completedAt: null }]
      : [{ key: "materialize_release_runtime", label: "Deploy Runtime and Verify Application", status: "passed", startedAt: "2026-09-01T00:00:00Z", completedAt: "2026-09-01T00:04:00Z" }];
  } };
  const settled = await service.terminalWorkflowStages("example/application", "123", "ignored", "deploy", []);
  assert.equal(reads, 3, "terminal jobs metadata is retried within a fixed bound until GitHub exposes a final snapshot");
  assert.equal(settled.unavailable, false);
  assert.deepEqual(settled.stages.map((stage: any) => stage.status), ["passed"]);

  reads = 0;
  service.actions.getWorkflowStages = async () => {
    reads += 1;
    return [
      { key: "materialize_release_runtime", label: "Deploy Runtime and Verify Application", status: "running", startedAt: "2026-09-01T00:00:00Z", completedAt: null },
      { key: "publish_verified_release_result", label: "Finalize Release", status: "pending", startedAt: null, completedAt: null },
    ];
  };
  const unavailable = await service.terminalWorkflowStages("example/application", "123", "ignored", "deploy", []);
  assert.equal(reads, 3);
  assert.equal(unavailable.unavailable, true);
  assert.deepEqual(unavailable.stages.map((stage: any) => stage.status), ["unavailable", "unavailable"], "terminal state never persists visually Running or Pending when GitHub's final jobs snapshot is absent");

  const terminal: any = {
    id: "99999999-9999-4999-8999-999999999999", projectId: project.id, triggeredByUserId: user.id,
    githubWorkflowRunId: "123", status: PipelineRunStatus.FAILED, currentStage: "ecs_stability",
    metadata: { deploymentAction: "deploy", terminalWorkflowStagesUnavailable: true, workflowStages: unavailable.stages },
  };
  service.projects = { findOne: async () => project };
  service.users = { findOne: async () => user };
  service.githubApp = { tokenForRepository: async () => ({ token: "ignored" }) };
  service.runs = { save: async (row: any) => row };
  service.actions.getWorkflowStages = async () => [{ key: "materialize_release_runtime", label: "Deploy Runtime and Verify Application", status: "failed", startedAt: "2026-09-01T00:00:00Z", completedAt: "2026-09-01T00:04:00Z" }];
  await service.reconcileTerminalWorkflowStages(terminal);
  assert.equal(terminal.status, PipelineRunStatus.FAILED, "read-only stage backfill cannot change the terminal operation outcome");
  assert.equal(terminal.metadata.terminalWorkflowStagesUnavailable, false);
  assert.deepEqual(terminal.metadata.workflowStages.map((stage: any) => stage.status), ["failed"], "a later read-only refresh backfills real final GitHub metadata without fabricating Passed");
}

async function verifyCurrentStateReconcilesWithoutPipeline() {
  const startedAt = new Date("2026-08-29T10:00:00.000Z");
  const failedAt = new Date("2026-08-29T10:02:00.000Z");
  const operation: any = {
    id: "33333333-3333-4333-8333-333333333333", projectId: project.id, status: PipelineRunStatus.RUNNING,
    githubWorkflowRunId: "33215481954", commitSha: "b".repeat(40), generationId: null, createdAt: startedAt, startedAt,
    updatedAt: startedAt, completedAt: null, failedAt: null,
    metadata: { executionEngine: "railpack", deploymentAction: "deploy", attempt: 4 },
  };
  let reconciliationCalls = 0;
  const service = Object.create(ProjectCurrentStateService.prototype) as any;
  service.projectsService = { getProjectEntityForView: async () => ({ ...project, environment: "dev" }) };
  service.deploymentReconciliation = {
    reconcileActive: async (actor: any, projectId: string) => {
      assert.equal(actor, user);
      assert.equal(projectId, project.id);
      reconciliationCalls += 1;
      operation.status = PipelineRunStatus.FAILED;
      operation.currentStage = "build_immutable_railpack_images";
      operation.failedAt = failedAt;
      operation.completedAt = failedAt;
      operation.updatedAt = failedAt;
      operation.errorMessage = "ERRO BUILDKIT_HOST environment variable is not set.";
      operation.metadata = {
        ...operation.metadata,
        failedStage: operation.currentStage,
        safeLog: operation.errorMessage,
        workflowStages: [
          { key: "checkout_exact_application_source", status: "passed" },
          { key: "build_immutable_railpack_images", status: "failed" },
          { key: "publish_immutable_images_to_ecr", status: "skipped" },
        ],
      };
    },
  };
  service.dataSource = { getRepository: () => ({ findOne: async () => null }) };
  service.releaseRepository = { findOne: async () => null };
  service.estimateRepository = { findOne: async () => null };
  service.generationRepository = { find: async () => [] };
  service.githubActionsReadinessState = () => ({
    repository: project.repositoryFullName, branch: project.targetBranch, commit: null, latestAttempt: null,
    stableRelease: null, stableUrl: null, estimatedCost: null, missingConfiguration: [], advisories: [], applicationError: null,
    canRetry: false, stateAuthority: null, developerState: "ready", developerAction: "deploy", developerMessage: "ready", progress: { percentage: 0, phase: null, label: "Ready" },
  });
  service.withGithubActionsState = async () => {
    assert.equal(operation.status, PipelineRunStatus.FAILED, "Overview current-state refresh must reconcile terminal GitHub failure before projection");
    return {
      developerState: "failed_application", developerAction: "deploy_again", developerMessage: operation.errorMessage,
      progress: { percentage: 40, phase: "build", label: "Build Application failed" }, repository: project.repositoryFullName, branch: project.targetBranch,
      latestAttempt: {
        operationId: operation.id, workflowRunId: operation.githubWorkflowRunId, operationType: "deploy", status: "failed_application", outcome: "blocked", attempt: "4",
        generationId: null, releaseRevision: null, commit: operation.commitSha, message: operation.errorMessage,
        occurredAt: failedAt.toISOString(), startedAt: startedAt.toISOString(), completedAt: failedAt.toISOString(),
        workflowStages: operation.metadata.workflowStages,
      }, stableRelease: null, stableUrl: null, estimatedCost: null, missingConfiguration: [], advisories: [], applicationError: null, canRetry: true, stateAuthority: null,
    };
  };
  service.withStateAuthority = (_projectId: string, _environment: string, state: any) => state;
  const overviewState = await service.getCurrentState(user, project.id);
  assert.equal(reconciliationCalls, 1, "Overview current-state reads reconcile active GitHub operations without opening Pipeline");
  assert.equal(overviewState.developerState, "failed_application");
  assert.equal(overviewState.latestAttempt.operationId, operation.id);
  assert.equal(overviewState.latestAttempt.workflowRunId, operation.githubWorkflowRunId);
  assert.equal(overviewState.latestAttempt.generationId, null);
  assert.equal(overviewState.latestAttempt.startedAt, startedAt.toISOString());
  assert.equal(overviewState.latestAttempt.completedAt, failedAt.toISOString());
  assert.deepEqual(overviewState.latestAttempt.workflowStages, operation.metadata.workflowStages);
}

async function verifyConcurrentStateReadsShareReconciliation() {
  let reconciliationCalls = 0;
  const service = Object.create(RailpackDeploymentService.prototype) as any;
  service.reconciliationInFlight = new Map();
  service.projects = { findOne: async () => project };
  service.runs = { find: async () => [{ id: "44444444-4444-4444-8444-444444444444", status: PipelineRunStatus.RUNNING }] };
  service.reconcile = async () => { reconciliationCalls += 1; await Promise.resolve(); };
  await Promise.all([service.reconcileActive(user, project.id), service.reconcileActive(user, project.id)]);
  assert.equal(reconciliationCalls, 1, "concurrent current-state and history reads must share one GitHub reconciliation");
}

void (async () => {
  await verifyAtomicAdmissionAndImmutableConfiguration();
  await verifyActiveOperationUniquenessConflictReturnsCanonicalNoOp();
  const failed = await verifyPreDispatchFailure();
  verifyCapabilityFailureIsBoundedAndPreDispatch();
  await verifyPerActionCapabilitySimulation();
  await verifyReleaseArtifactEvidenceReconciliation();
  await verifyTerminalFinalizationFailureIsRetryable();
  await verifyProviderContractAndConditionalDatabaseScope();
  await verifyCurrentStateProjection(failed);
  await verifyVerifiedReleaseProjectsLive();
  const terminalFailure = await verifyTerminalGithubFailure();
  await verifyStructuredRuntimeFailureSurvivesTerminalReconciliation();
  await verifyPersistedRuntimeFailureArtifactIsConsumed();
  await verifyActiveGithubStagesPersistWithoutPipeline();
  await verifyTerminalStageMetadataConvergenceAndBackfill();
  await verifyCurrentStateProjection(terminalFailure, true);
  await verifyCurrentStateReconcilesWithoutPipeline();
  await verifyConcurrentStateReadsShareReconciliation();
  const root = join(__dirname, "..", "..");
  const phases = readFileSync(join(root, "frontend", "src", "utils", "developerDeploymentPresentation.js"), "utf8");
  const routes = readFileSync(join(root, "frontend", "src", "routes", "AppRoutes.jsx"), "utf8");
  const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
  const overviewPage = readFileSync(join(root, "frontend", "src", "pages", "ProjectDetails.jsx"), "utf8");
  const pipelinePage = readFileSync(join(root, "frontend", "src", "pages", "ProjectPipeline.jsx"), "utf8");
  const infrastructurePage = readFileSync(join(root, "frontend", "src", "pages", "ProjectInfrastructure.jsx"), "utf8");
  const monitoringPage = readFileSync(join(root, "frontend", "src", "pages", "ProjectMetrics.jsx"), "utf8");
  const troubleshootingPage = readFileSync(join(root, "frontend", "src", "pages", "ProjectTroubleshooting.jsx"), "utf8");
  const currentStateService = readFileSync(join(root, "backend", "src", "projects", "current-state", "project-current-state.service.ts"), "utf8");
  const runtimeResolver = readFileSync(join(root, "backend", "src", "observability", "live-runtime-resolver.service.ts"), "utf8");
  const migration = readFileSync(join(root, "backend", "src", "migrations", "1787356812000-DropLegacyGenerationStateKeyIndex.ts"), "utf8");
  assert.doesNotMatch(phases, /key: "analyze"/);
  assert.match(phases, /Prepare Source/);
  assert.match(routes, /ProjectInfrastructure/);
  assert.match(workflow, /tmpdir="\$\(mktemp -d\)"/);
  assert.match(workflow, /trap 'rm -rf "\$tmpdir"' EXIT/);
  assert.doesNotMatch(workflow, /-o \/tmp\/railpack\.tgz/);
  assert.match(workflow, /name: Build immutable Railpack images[\s\S]*?if: success\(\) && inputs\.deployment_action == 'deploy'/);
  assert.match(workflow, /name: Publish immutable images to ECR[\s\S]*?steps\.build\.outputs\.built == 'true'/);
  assert.match(workflow, /name: Install Terraform[\s\S]*?if: success\(\)/);
  assert.match(workflow, /name: Materialize release runtime[\s\S]*?steps\.image\.outputs\.published == 'true'/);
  assert.match(workflow, /name: Publish verified release result[\s\S]*?if: success\(\) && hashFiles/);
  assert.match(workflow, /BUILDKIT_HOST="docker-container:\/\/\$\{BUILDKIT_CONTAINER\}" railpack build "\$\{build_env_args\[@\]\}" --name/);
  assert.match(workflow, /docker exec "\$BUILDKIT_CONTAINER" buildctl debug workers/);
  assert.match(workflow, /name: Clean up Railpack BuildKit daemon[\s\S]*?if: always\(\)/);
  assert.match(overviewPage, /getProjectCurrentState/);
  assert.match(pipelinePage, /getProjectCurrentState/);
  assert.match(infrastructurePage, /Provisioning failed/);
  assert.doesNotMatch(infrastructurePage, /attempt\?\.message/);
  assert.equal(githubActionsWorkflowStepPresentation("Post Checkout"), null);
  assert.equal(githubActionsWorkflowStepPresentation("Materialize release runtime")?.key, "materialize_release_runtime");
  assert.equal(githubActionsFailureLifecyclePhase("Materialize release runtime"), "deploy");
  assert.equal(githubActionsFailureLifecyclePhase("release_evidence_validation"), "finalize", "terminal artifact rejection must not project as runtime deployment failure");
  const lifecycle = Object.create(ProjectCurrentStateService.prototype) as any;
  assert.equal(lifecycle.githubLifecyclePhase("materialize_release_runtime", { deploymentAction: "deploy", workflowStages: [{ key: "publish_immutable_images_to_ecr", status: "passed" }] }), "deploy");
  assert.equal(lifecycle.githubLifecyclePhase("publish_immutable_images_to_ecr", { deploymentAction: "deploy", workflowStages: [{ key: "build_immutable_railpack_images", status: "passed" }] }), "build");
  assert.match(infrastructurePage, /getProjectDetailedCurrentState/);
  assert.match(infrastructurePage, /runtimeIdentity\?\.services/, "Infrastructure retains persisted release identity");
  assert.match(infrastructurePage, /evidence\?\.services/, "Infrastructure retains current per-service AWS observations");
  assert.match(infrastructurePage, /terraformStateKey/);
  assert.match(monitoringPage, /temporarily unavailable/i);
  assert.doesNotMatch(currentStateService, /DEPLOYGUARD_SHARED_ECS_CLUSTER_ARN|DEPLOYGUARD_SHARED_ECS_CLUSTER_NAME|DEPLOYGUARD_SHARED_ALB_ARN/);
  assert.doesNotMatch(runtimeResolver, /DEPLOYGUARD_SHARED_ECS_CLUSTER_ARN|DEPLOYGUARD_SHARED_ECS_CLUSTER_NAME|DEPLOYGUARD_SHARED_ALB_ARN|metadata\.targetGroupArn/);
  assert.match(runtimeResolver, /cloudWatchLogGroupName/);
  assert.match(runtimeResolver, /applicationContainerName/);
  assert.match(migration, /uq_project_deployment_generation_state_key/);
  assert.match(troubleshootingPage, /getGithubActionsDeploymentHistory/);
  console.log("DISPATCH_STATE_PROJECTION=PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
