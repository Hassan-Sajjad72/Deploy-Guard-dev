import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { RailpackDeploymentService } from "../src/projects/railpack-deployment.service";

const projectId = "122a34a1-5d28-4f39-bb51-28379671fdb4";
const generationId = "7fcf0947-d66e-4d79-9cfc-9879d0022548";
const operationId = "76bcb093-3928-44ce-a81e-a54caeedba4d";
const project: any = { id: projectId, environmentName: "dev", ownerUserId: 7, repositoryFullName: "owner/repository", targetBranch: "main" };
const observedAt = "2026-08-29T12:00:00.000Z";

function failed(action: "deploy" | "rollback" | "destroy") {
  return {
    developerState: "live", developerAction: "open_application", developerMessage: `The latest ${action} operation failed. The verified stable release remains live.`,
    progress: { percentage: 60, phase: "deploy" as const, label: "Failed" }, repository: "owner/repository", branch: "main", commit: "a".repeat(40),
    latestAttempt: { operationId, generationId, workflowRunId: "33252955775", operationType: action, status: "failed_application", outcome: "blocked" as const, attempt: "2", message: "Terraform failed", releaseRevision: null, commit: "a".repeat(40), occurredAt: observedAt },
    stableRelease: { id: "release", operationId: "previous", revision: "1", generationId, commit: "a".repeat(40), promotedAt: observedAt, rollbackAvailable: true, runtimeIdentity: { region: "us-east-1", ecsClusterArn: "cluster", services: [{ serviceId: "99999999-9999-4999-8999-999999999999", ecsServiceArn: "service", targetGroupArn: "target", cloudWatchLogGroupName: "/deployguard/app", applicationContainerName: "application" }] } },
    stableUrl: "https://application.example.test", estimatedCost: null, missingConfiguration: [], advisories: [], applicationError: null, canRetry: true, stateAuthority: null,
  } as any;
}

function authority(projected: any, runtime: "present" | "absent" | "unknown") {
  const service: any = Object.create(ProjectCurrentStateService.prototype);
  service.config = { get: (_key: string, fallback?: unknown) => fallback };
  const evidence = runtime === "present" ? {
    observedAt,
    ecr: { repository: "deployguard-test", imageTag: null, imageDigest: `sha256:${"a".repeat(64)}` },
    ecs: { cluster: "cluster", service: "service", taskDefinitionRevision: 1, desiredCount: 1, runningCount: 1, pendingCount: 0 },
    alb: { name: "alb", status: "active", targetHealth: ["healthy"], endpoint: "https://application.example.test" },
    services: [],
  } : null;
  return service.withStateAuthority(projectId, "dev", projected, evidence, {
    observedAt,
    runtime,
    resources: { ecs: runtime === "unknown" ? "unknown" : runtime, alb: runtime === "unknown" ? "unknown" : runtime, cloudWatch: runtime === "unknown" ? "unknown" : runtime },
    evidence,
  });
}

function activeDestroy() {
  const projected = failed("destroy");
  projected.developerMessage = "A destroy operation is in progress. The verified stable release remains live.";
  projected.latestAttempt = { ...projected.latestAttempt, status: "destroying", outcome: null, completedAt: null };
  projected.progress = { percentage: 70, phase: "deploy", label: "Destroying application" };
  projected.canRetry = false;
  return projected;
}

function destroyEvidence() {
  return {
    contractVersion: "deployguard.destroy-result/v2", deploymentOperationId: operationId, projectId, environmentName: "dev", generationIds: [generationId],
    status: "project_delete_ready", generationResourcesRemoved: true, projectResourcesRemoved: true, terraformStateArtifactsRemoved: true, sharedPlatformUntouched: true, verifiedAt: observedAt,
  };
}

async function verifyCanonicalProjection() {
  for (const action of ["deploy", "rollback"] as const) {
    const state = authority(failed(action), "present");
    assert.equal(state.stateAuthority.state, "LIVE", `failed ${action} preserves a positively verified prior runtime`);
    assert.equal(state.stateAuthority.applicationHealth.status, "healthy");
  }
  const intactDestroy = authority(failed("destroy"), "present");
  assert.equal(intactDestroy.stateAuthority.state, "LIVE", "failed Destroy may preserve LIVE only with positive current runtime evidence");
  assert.equal(intactDestroy.stateAuthority.runtime.state, "present");
  assert.equal(intactDestroy.stateAuthority.monitoring.available, true, "failed Destroy does not disable monitoring for a runtime still present");

  const activeIntactDestroy = authority(activeDestroy(), "present");
  assert.equal(activeIntactDestroy.stateAuthority.state, "DESTROYING");
  assert.equal(activeIntactDestroy.stateAuthority.runtime.state, "present");
  assert.equal(activeIntactDestroy.stateAuthority.applicationHealth.status, "healthy");
  assert.equal(activeIntactDestroy.stateAuthority.monitoring.available, true, "operation state does not hide a healthy runtime");

  const activeRemovedDestroy = authority(activeDestroy(), "absent");
  assert.equal(activeRemovedDestroy.stateAuthority.state, "DESTROYING");
  assert.equal(activeRemovedDestroy.stateAuthority.runtime.state, "removed");
  assert.equal(activeRemovedDestroy.stateAuthority.infrastructure.status, "destroyed");
  assert.equal(activeRemovedDestroy.stateAuthority.applicationHealth.status, "unavailable");
  assert.equal(activeRemovedDestroy.stateAuthority.monitoring.available, false);
  assert.equal(activeRemovedDestroy.developerState, "destroying", "resource removal does not erase the still-active Destroy operation");

  const removedDestroy = authority(failed("destroy"), "absent");
  assert.equal(removedDestroy.stateAuthority.state, "BLOCKED");
  assert.equal(removedDestroy.stateAuthority.runtime.state, "removed");
  assert.equal(removedDestroy.stateAuthority.infrastructure.status, "destroyed");
  assert.equal(removedDestroy.stateAuthority.applicationHealth.status, "unavailable");
  assert.equal(removedDestroy.stableRelease, null, "historical stable-release evidence cannot retain LIVE authority after runtime removal");
  assert.equal(removedDestroy.infrastructureEvidence.resources.find((resource: any) => resource.type === "ECS Fargate")?.status, "destroyed");
  assert.equal(removedDestroy.infrastructureEvidence.resources.find((resource: any) => resource.type === "ALB")?.status, "destroyed");
  assert.equal(removedDestroy.infrastructureEvidence.cloudWatch?.status, "destroyed", "known CloudWatch log-group removal is preserved in the shared observation");

  const unknownDestroy = authority(failed("destroy"), "unknown");
  assert.equal(unknownDestroy.stateAuthority.state, "BLOCKED", "missing AWS observation after failed Destroy fails closed");
  assert.equal(unknownDestroy.stateAuthority.applicationHealth.status, "unavailable");
  assert.equal(unknownDestroy.infrastructureEvidence.resources.find((resource: any) => resource.type === "ECS Fargate")?.status, "unavailable");
}

async function verifyDestroyFinalizationAndRetry() {
  const saved: any[] = [];
  const operation: any = { id: operationId, projectId, generationId, status: PipelineRunStatus.RUNNING, currentStage: "release_evidence_pending", metadata: { executionEngine: "railpack", deploymentAction: "destroy" } };
  const service: any = Object.create(RailpackDeploymentService.prototype);
  service.runs = { save: async (row: any) => { saved.push(structuredClone(row)); return row; }, findOne: async () => operation };
  service.sanitizer = new LogSanitizerService();
  let finalizations = 0;
  service.projectDeletion = { finalize: async (_project: any, candidate: any) => { finalizations += 1; assert.equal(candidate.metadata.destroyVerification.deploymentOperationId, operationId); } };
  await service.finalizeVerifiedRelease(project, operation, { releaseArtifact: { destroyed: true }, destroyVerification: destroyEvidence() }, "success");
  assert.equal(finalizations, 1, "successful Railpack Destroy enters exact-scope ProjectDeletionService finalization");
  assert.equal(operation.status, PipelineRunStatus.COMPLETED);
  assert.equal(operation.currentStage, "project_delete_cleanup");
  assert.equal(operation.metadata.destroyEvidenceValidated, true);

  service.projectDeletion = { finalize: async () => { throw new Error("control plane cleanup unavailable"); } };
  operation.status = PipelineRunStatus.RUNNING; operation.currentStage = "release_evidence_pending"; operation.metadata = { executionEngine: "railpack", deploymentAction: "destroy" };
  await service.finalizeVerifiedRelease(project, operation, { releaseArtifact: { destroyed: true }, destroyVerification: destroyEvidence() }, "success");
  assert.equal(operation.status, PipelineRunStatus.FAILED);
  assert.equal(operation.currentStage, "project_delete_cleanup");
  assert.equal(operation.metadata.failureCategory, "project_delete_incomplete");

  let redispatches = 0;
  service.project = async () => project;
  service.dispatch = async () => { redispatches += 1; throw new Error("verified deletion must not redispatch"); };
  service.projectDeletion = { finalize: async () => { finalizations += 1; } };
  const retry = await service.retry({ id: 7 }, projectId);
  assert.equal(retry.deployment.state, "no_op");
  assert.equal(redispatches, 0, "verified AWS deletion retries only control-plane cleanup");

  const ordinary: any = { ...operation, metadata: { executionEngine: "railpack", deploymentAction: "destroy" }, generationId };
  service.runs.findOne = async () => ordinary;
  service.dispatch = async (...args: any[]) => { redispatches += 1; assert.equal(args[2], "destroy"); return { deployment: { state: "accepted" } }; };
  await service.retry({ id: 7 }, projectId);
  assert.equal(redispatches, 1, "Destroy without verified deletion evidence retains the normal full retry path");
}

async function verifyReconcileUsesDestroyFinalizer() {
  const operation: any = {
    id: operationId, projectId, generationId, triggeredByUserId: 7, githubWorkflowRunId: "33252955775", commitSha: "a".repeat(40),
    status: PipelineRunStatus.RUNNING, currentStage: "github_actions", metadata: { executionEngine: "railpack", deploymentAction: "destroy" },
  };
  const service: any = Object.create(RailpackDeploymentService.prototype);
  service.projects = { findOne: async () => project };
  service.users = { findOne: async () => ({ id: 7 }) };
  service.githubApp = { tokenForRepository: async () => ({ token: "ignored" }) };
  service.actions = {
    getWorkflowRun: async () => ({ status: "completed", conclusion: "success" }),
    getResultArtifact: async () => JSON.stringify({ contractVersion: "deployguard.release-result/v4", action: "destroy", sourceSha: operation.commitSha, operationId, destroyed: true, destroyVerification: destroyEvidence() }),
  };
  service.runs = { save: async (row: any) => row };
  service.sanitizer = new LogSanitizerService();
  service.costEvidence = { capture: async () => { throw new Error("Destroy must not collect release cost evidence"); } };
  let finalized = 0;
  service.projectDeletion = { finalize: async () => { finalized += 1; } };
  await service.reconcile(operation);
  assert.equal(finalized, 1, "successful workflow reconciliation invokes the exact destroy finalizer");
  assert.equal(operation.status, PipelineRunStatus.COMPLETED);
  assert.equal(operation.currentStage, "project_delete_cleanup");
  assert.equal(operation.metadata.destroyEvidenceValidated, true);
}

async function verifyAttemptFourContractFailureConverges() {
  const operation: any = {
    id: "f07a2838-82fc-4590-9be5-465f38aa5be4", projectId, generationId, triggeredByUserId: 7,
    githubWorkflowRunId: "33255401081", commitSha: "a".repeat(40), status: PipelineRunStatus.RUNNING,
    currentStage: "materialize_release_runtime", metadata: { executionEngine: "railpack", deploymentAction: "destroy", attempt: 4 },
  };
  const service: any = Object.create(RailpackDeploymentService.prototype);
  service.projects = { findOne: async () => project };
  service.users = { findOne: async () => ({ id: 7 }) };
  service.githubApp = { tokenForRepository: async () => ({ token: "ignored" }) };
  service.actions = {
    getWorkflowRun: async () => ({ status: "completed", conclusion: "success" }),
    // Attempt 4's stale reusable workflow emitted the pre-v2 shape.
    getResultArtifact: async () => JSON.stringify({ action: "destroy", sourceSha: operation.commitSha, operationId: operation.id, destroyed: true }),
  };
  service.runs = { save: async (row: any) => row };
  service.sanitizer = new LogSanitizerService();
  await service.reconcile(operation);
  assert.equal(operation.status, PipelineRunStatus.FAILED, "terminal GitHub success with stale Destroy evidence must converge to failure");
  assert.equal(operation.currentStage, "release_evidence_validation");
  assert.equal(operation.metadata.failureCategory, "release_contract_incompatible");
  assert.match(operation.metadata.safeLog, /deployguard\.release-result\/v4/);
  assert.ok(operation.failedAt && operation.completedAt, "terminal reconciliation persists bounded terminal timestamps");
}

async function verifyDestroyTargetsDeployedRelease() {
  const deployedSource = "d".repeat(40);
  const service: any = Object.create(RailpackDeploymentService.prototype);
  service.releases = { findOne: async ({ where }: any) => ({ ...where, commitSha: deployedSource, metadata: { releaseEvidenceVerified: true } }) };
  const release = await service.authoritativeDestroyRelease(project, "dev", generationId);
  assert.equal(release.commitSha, deployedSource, "Destroy identity comes from the authoritative deployed generation, not repository branch HEAD");
  service.releases.findOne = async () => null;
  await assert.rejects(() => service.authoritativeDestroyRelease(project, "dev", generationId), /authoritative verified deployed release identity/);
  await assert.rejects(() => service.authoritativeDestroyRelease(project, "dev", null), /authoritative verified deployed release identity/);
}

async function verifyRollbackUnsafeReleaseRemainsDestroyable() {
  const service: any = Object.create(RailpackDeploymentService.prototype);
  const release: any = {
    id: "release", generationId, deployedByPipelineRunId: operationId, commitSha: "d".repeat(40),
    metadata: { releaseEvidenceVerified: true },
  };
  const revision = {
    serviceId: "99999999-9999-4999-8999-999999999999", serviceName: "Web", serviceDirectory: ".",
    imageUri: "123456789012.dkr.ecr.us-east-1.amazonaws.com/deployguard-test", imageDigest: `sha256:${"a".repeat(64)}`,
    runtimeConfigRevisionId: "88888888-8888-4888-8888-888888888888",
    runtimeConfigRevision: {
      // This deliberately models an older verified release: it is unsafe to
      // roll back because secrets were not sealed, but Terraform still needs
      // its exact persisted runtime references to destroy it.
      nonSecretEnvironment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: {},
      databaseConfiguration: { attached: false, aliases: [] }, isRollbackSafe: false, sealedAt: null,
    },
  };
  service.serviceRevisions = { find: async () => [revision] };
  await assert.rejects(() => service.rollbackTarget(release), /complete immutable image and runtime-configuration revision set/);
  const target = await service.destroyTarget(release);
  assert.equal(target.services[0].immutableImage, `${revision.imageUri}@${revision.imageDigest}`);
  service.serviceRevisions = { find: async () => [] };
  await assert.rejects(() => service.destroyTarget(release), /complete immutable deployed service revision set/);
}

function verifyDestroyPipelinePresentation() {
  const service: any = Object.create(RailpackDeploymentService.prototype);
  const presented = service.presentOperation({
    id: operationId, projectId, generationId, status: PipelineRunStatus.RUNNING, currentStage: "materialize_release_runtime",
    createdAt: new Date(observedAt), startedAt: new Date(observedAt), completedAt: null, failedAt: null,
    metadata: { deploymentAction: "destroy", attempt: 4, workflowStages: [
      { key: "build_immutable_railpack_image", label: "Building Railpack image", status: "skipped" },
      { key: "materialize_release_runtime", label: "Materializing runtime", status: "running" },
    ] },
  });
  assert.equal(presented.stageLabel, "Destroy Infrastructure");
  assert.deepEqual(presented.workflowStages.map((stage: any) => stage.key), ["materialize_release_runtime"], "Destroy timeline hides action-irrelevant Deploy steps");
  assert.doesNotMatch(presented.stageLabel, /materialize_release_runtime/);
}

function verifySharedPageAuthority() {
  const root = join(__dirname, "..", "..");
  const files = [
    "frontend/src/components/projects/ProjectOverviewLifecycle.jsx",
    "frontend/src/pages/ProjectPipeline.jsx",
    "frontend/src/pages/ProjectInfrastructure.jsx",
    "frontend/src/pages/ProjectMetrics.jsx",
  ];
  for (const file of files) assert.match(readFileSync(join(root, file), "utf8"), /stateAuthority|projectStatePresentation/, `${file} consumes canonical backend state authority`);
  const presentation = readFileSync(join(root, "frontend/src/utils/projectStatePresentation.js"), "utf8");
  assert.match(presentation, /stateAuthority\?\.state/, "browser presentation has one authority adapter");
}

void (async () => {
  await verifyCanonicalProjection();
  await verifyDestroyFinalizationAndRetry();
  await verifyReconcileUsesDestroyFinalizer();
  await verifyAttemptFourContractFailureConverges();
  await verifyDestroyTargetsDeployedRelease();
  await verifyRollbackUnsafeReleaseRemainsDestroyable();
  verifyDestroyPipelinePresentation();
  verifySharedPageAuthority();
  console.log("DESTROY_LIFECYCLE_AUTHORITY=PASS");
})().catch((error) => { console.error(error); process.exitCode = 1; });
