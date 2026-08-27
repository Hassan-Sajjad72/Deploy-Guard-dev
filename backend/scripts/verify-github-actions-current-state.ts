import "reflect-metadata";
import { strict as assert } from "node:assert";
import { ProjectCurrentStateService } from "../src/projects/current-state/project-current-state.service";
import { DetectionStatus } from "../src/projects/project-detection-profile.entity";
import { PipelineRunStatus } from "../src/projects/project-pipeline-run.entity";
import { PreflightValidationStatus } from "../src/projects/project-preflight-report.entity";
import { GITHUB_ACTIONS_INPUT_NAMES, immutableDispatchFingerprint } from "../src/projects/github-actions-operation-contract";

const project: any = { id: "project-1", repositoryFullName: "owner/application", targetBranch: "main" };
const profile: any = { commitSha: "a".repeat(40), detectionStatus: DetectionStatus.SUCCESS };
const preflight: any = { validationStatus: PreflightValidationStatus.PASSED };

function serviceWith(latest: any, stable: any = null, ancestors: Record<string, any> = {}) {
  const service: any = Object.create(ProjectCurrentStateService.prototype);
  const builder = (): any => ({
    stable: false,
    where() { return this; },
    andWhere() { this.stable = true; return this; },
    clone() { return builder(); },
    orderBy() { return this; },
    async getOne() { return this.stable ? stable : latest; },
  });
  service.runRepository = { createQueryBuilder: builder, findOne: async ({ where }: { where: { id: string } }) => ancestors[where.id] || null };
  service.config = { get: (_key: string, fallback?: string) => fallback };
  return service;
}

function operation(status: PipelineRunStatus, currentStage: string, metadata: Record<string, unknown> = {}, errorMessage: string | null = null, withRetrySnapshot = true): any {
  const id = "9ffe6827-f55a-4469-ac80-64530f8cea2e";
  const commitSha = "b".repeat(40);
  const inputs = Object.fromEntries(GITHUB_ACTIONS_INPUT_NAMES.map((name) => [name, ""])) as Record<string, string>;
  Object.assign(inputs, {
    deployment_action: metadata.deploymentAction || "deploy",
    deployment_operation_id: id,
    project_id: project.id,
    repository_full_name: project.repositoryFullName,
    repository_branch: project.targetBranch,
    commit_sha: commitSha,
  });
  return {
    id,
    projectId: project.id,
    generationId: "404cd3c1-a7dd-4b26-85e9-f531b3cb7ef1",
    status,
    currentStage,
    githubWorkflowRunId: null,
    githubWorkflowStatus: "failure",
    metadata: {
      executionEngine: "github_actions", attempt: 2, deploymentAction: "deploy",
      ...(withRetrySnapshot ? { immutableDispatchInputs: inputs, immutableDispatchFingerprint: immutableDispatchFingerprint(inputs as any) } : {}),
      ...metadata,
    },
    repositoryFullName: project.repositoryFullName,
    targetBranch: project.targetBranch,
    commitSha,
    createdAt: new Date("2026-08-03T12:00:00.000Z"),
    updatedAt: new Date("2026-08-03T12:02:00.000Z"),
    completedAt: status === PipelineRunStatus.COMPLETED ? new Date("2026-08-03T12:02:00.000Z") : null,
    failedAt: status === PipelineRunStatus.FAILED ? new Date("2026-08-03T12:02:00.000Z") : null,
    errorMessage,
  };
}

async function projected(latest: any, stable: any = null, liveGenerationId: string | null = stable?.generationId || null, ancestors: Record<string, any> = {}) {
  const service = serviceWith(latest, stable, ancestors);
  const base = service.githubActionsReadinessState(project, profile, preflight);
  return service.withGithubActionsState("project-1", "dev", base, liveGenerationId);
}

async function run() {
  const readiness = serviceWith(null).githubActionsReadinessState(project, profile, preflight);
  assert.deepEqual(
    { state: readiness.developerState, action: readiness.developerAction, progress: readiness.progress, attempt: readiness.latestAttempt },
    { state: "ready", action: "deploy", progress: { percentage: 40, phase: "prepare", label: "Ready to Deploy" }, attempt: null },
  );
  assert.equal(readiness.developerState === "platform_attention", false, "no GitHub Actions operation must not inherit legacy platform attention");
  const readyAuthority = serviceWith(null).withStateAuthority("project-1", "dev", readiness, profile, preflight, null, null, null);
  assert.deepEqual(
    {
      state: readyAuthority.stateAuthority?.state,
      activeOperation: readyAuthority.stateAuthority?.activeOperation,
      infrastructure: readyAuthority.stateAuthority?.infrastructure.status,
      monitoring: readyAuthority.stateAuthority?.monitoring.status,
    },
    { state: "READY", activeOperation: null, infrastructure: "unknown", monitoring: "not_deployed" },
  );

  const blocked = serviceWith(null).githubActionsReadinessState(project, { ...profile, detectionStatus: DetectionStatus.FAILED }, preflight);
  assert.deepEqual([blocked.developerState, blocked.developerAction], ["unsupported", "none"]);

  const building = await projected(operation(PipelineRunStatus.RUNNING, "build_and_push_immutable_image"));
  assert.deepEqual([building.developerState, building.progress.phase, building.progress.percentage], ["building", "build", 40]);

  const failed = await projected(operation(PipelineRunStatus.FAILED, "build_and_push_immutable_image", { failedStage: "build_and_push_immutable_image" }, "The application build failed."));
  const failedAuthority = serviceWith(null).withStateAuthority("project-1", "dev", failed, profile, preflight, null, null, null);
  assert.deepEqual(
    [failed.developerState, failed.canRetry, failed.latestAttempt?.operationType, failedAuthority.stateAuthority?.latestCompletedOperation?.type],
    ["failed_application", true, "deploy", "deploy"],
    "a failed Deploy remains typed as Deploy through the authoritative projection",
  );

  const setupFailed = await projected(operation(
    PipelineRunStatus.FAILED,
    "set_up_job",
    { failedStage: "set_up_job" },
    null,
  ));
  assert.deepEqual(
    [setupFailed.applicationError?.category, setupFailed.progress, setupFailed.latestAttempt?.message],
    ["build", { percentage: 40, phase: "build", label: "Failed" }, "GitHub Actions failed during Setting up GitHub Actions runner."],
    "a pre-step action resolution failure fails the Build phase without presenting Build as completed",
  );

  const failedDestroy = await projected(operation(
    PipelineRunStatus.FAILED,
    "remove_immutable_image_repository_after_destroy",
    { deploymentAction: "destroy", failedStage: "remove_immutable_image_repository_after_destroy" },
    "Post-Destroy cleanup failed.",
  ));
  const failedDestroyAuthority = serviceWith(null).withStateAuthority("project-1", "dev", failedDestroy, profile, preflight, null, null, null);
  assert.deepEqual(
    [failedDestroy.developerState, failedDestroy.canRetry, failedDestroy.latestAttempt?.operationType, failedDestroyAuthority.stateAuthority?.latestCompletedOperation?.type],
    ["failed_application", true, "destroy", "destroy"],
    "a failed Destroy remains typed as Destroy through the authoritative projection",
  );

  const undispatchedDestroyOperation = operation(
    PipelineRunStatus.FAILED,
    "workflow_run_discovery",
    { deploymentAction: "destroy", failedStage: "workflow_run_discovery" },
    "GitHub Actions did not expose a workflow run for the accepted dispatch.",
    false,
  );
  undispatchedDestroyOperation.githubWorkflowStatus = "run_not_found";
  const undispatchedDestroy = await projected(undispatchedDestroyOperation);
  assert.equal(undispatchedDestroy.canRetry, true, "an undispatched Destroy with a race-lost snapshot remains recoverable through a newly persisted snapshot");
  const missingDeploySnapshot = await projected(operation(
    PipelineRunStatus.FAILED,
    "workflow_run_discovery",
    { failedStage: "workflow_run_discovery" },
    "Dispatch evidence is missing.",
    false,
  ));
  assert.equal(missingDeploySnapshot.canRetry, false, "a missing Deploy snapshot is not presented as safely retryable");

  const failedRollback = await projected(operation(
    PipelineRunStatus.FAILED,
    "roll_back_to_immutable_application_release",
    { deploymentAction: "rollback", failedStage: "roll_back_to_immutable_application_release" },
    "Rollback failed.",
  ));
  const failedRollbackAuthority = serviceWith(null).withStateAuthority("project-1", "dev", failedRollback, profile, preflight, null, null, null);
  assert.deepEqual(
    [failedRollback.latestAttempt?.operationType, failedRollbackAuthority.stateAuthority?.latestCompletedOperation?.type],
    ["rollback", "rollback"],
    "a failed Rollback remains typed as Rollback through the authoritative projection",
  );

  const stable = operation(PipelineRunStatus.COMPLETED, "healthy", {
    deployedUrl: "https://app.example.test",
    previousStableOperationId: "previous-operation-id",
    rollbackAvailable: true,
  });
  const live = await projected(stable, stable, stable.generationId);
  assert.deepEqual([live.developerState, live.developerAction, live.progress.percentage, live.latestAttempt?.operationType], ["live", "open_application", 100, "deploy"]);
  assert.equal(live.stableRelease?.rollbackAvailable, true, "a successful redeploy retains explicit previous-release eligibility");

  const failedRedeployOperation = operation(
    PipelineRunStatus.FAILED,
    "verify_alb_health_and_write_result",
    { failedStage: "verify_alb_health_and_write_result", previousStableOperationId: "previous-operation-id" },
    "The replacement release failed health verification.",
  );
  failedRedeployOperation.generationId = "505cd3c1-a7dd-4b26-85e9-f531b3cb7ef1";
  const failedRedeploy = await projected(failedRedeployOperation, stable, stable.generationId);
  const failedRedeployAuthority = serviceWith(null).withStateAuthority("project-1", "dev", failedRedeploy, profile, preflight, null, null, null);
  assert.deepEqual(
    [failedRedeploy.developerState, failedRedeploy.stableUrl, failedRedeploy.stableRelease?.commit, failedRedeploy.latestAttempt?.status, failedRedeployAuthority.stateAuthority?.state],
    ["live", "https://app.example.test", stable.commitSha, "failed_application", "LIVE"],
    "a failed redeploy remains a separate failed operation while the prior healthy runtime stays LIVE",
  );

  const deployingRedeploy = operation(PipelineRunStatus.RUNNING, "terraform_plan_and_apply");
  deployingRedeploy.generationId = "606cd3c1-a7dd-4b26-85e9-f531b3cb7ef1";
  const liveDuringRedeploy = await projected(deployingRedeploy, stable, stable.generationId);
  const liveDuringRedeployAuthority = serviceWith(null).withStateAuthority("project-1", "dev", liveDuringRedeploy, profile, preflight, null, null, null);
  assert.deepEqual(
    [liveDuringRedeploy.developerState, liveDuringRedeploy.stableRelease?.generationId, liveDuringRedeploy.latestAttempt?.generationId, liveDuringRedeploy.latestAttempt?.status, liveDuringRedeployAuthority.stateAuthority?.state, liveDuringRedeployAuthority.stateAuthority?.activeOperation?.type, liveDuringRedeployAuthority.stateAuthority?.applicationHealth.status],
    ["live", stable.generationId, deployingRedeploy.generationId, "deploying", "DEPLOYING", "deploy", "healthy"],
    "a candidate deployment is presented as active while the prior healthy runtime remains authoritative",
  );

  const retryingWithLiveOperation = operation(
    PipelineRunStatus.RUNNING,
    "build_and_push_immutable_image",
    { retryOfOperationId: "failed-operation-id" },
  );
  const retryingWithLive = await projected(retryingWithLiveOperation, stable, stable.generationId);
  const retryingWithLiveAuthority = serviceWith(null).withStateAuthority("project-1", "dev", retryingWithLive, profile, preflight, null, null, null);
  assert.deepEqual(
    [retryingWithLiveAuthority.stateAuthority?.state, retryingWithLiveAuthority.stateAuthority?.activeOperation?.type, retryingWithLive.stableRelease?.generationId],
    ["DEPLOYING", "deploy", stable.generationId],
    "a Retry remains active while preserving the authoritative stable runtime",
  );

  const rollingBackWithLiveOperation = operation(
    PipelineRunStatus.RUNNING,
    "verify_candidate_release",
    { deploymentAction: "rollback" },
  );
  const rollingBackWithLive = await projected(rollingBackWithLiveOperation, stable, stable.generationId);
  const rollingBackWithLiveAuthority = serviceWith(null).withStateAuthority("project-1", "dev", rollingBackWithLive, profile, preflight, null, null, null);
  assert.deepEqual(
    [rollingBackWithLiveAuthority.stateAuthority?.state, rollingBackWithLiveAuthority.stateAuthority?.activeOperation?.type, rollingBackWithLive.progress.label, rollingBackWithLive.stableRelease?.generationId],
    ["DEPLOYING", "rollback", "Rolling back", stable.generationId],
    "a Rollback remains active while preserving the authoritative stable runtime",
  );

  const runningDestroyWithLiveOperation = operation(
    PipelineRunStatus.RUNNING,
    "terraform_destroy_plan_and_apply",
    { deploymentAction: "destroy" },
  );
  const runningDestroyWithLive = await projected(runningDestroyWithLiveOperation, stable, stable.generationId);
  const runningDestroyWithLiveAuthority = serviceWith(null).withStateAuthority("project-1", "dev", runningDestroyWithLive, profile, preflight, null, null, null);
  assert.deepEqual(
    [runningDestroyWithLive.developerState, runningDestroyWithLive.stableUrl, runningDestroyWithLive.latestAttempt?.status, runningDestroyWithLive.progress.label, runningDestroyWithLiveAuthority.stateAuthority?.state, runningDestroyWithLiveAuthority.stateAuthority?.activeOperation?.status, runningDestroyWithLiveAuthority.stateAuthority?.applicationHealth.status],
    ["live", "https://app.example.test", "destroying", "Destroying application", "DESTROYING", "destroying", "healthy"],
    "a running Destroy remains visible without hiding the still-healthy stable runtime",
  );

  const failedDestroyWithLive = operation(
    PipelineRunStatus.FAILED,
    "workflow_run_discovery",
    { deploymentAction: "destroy", failedStage: "workflow_run_discovery" },
    "GitHub Actions did not expose a workflow run for the accepted dispatch.",
  );
  const liveAfterFailedDestroy = await projected(failedDestroyWithLive, stable, stable.generationId);
  assert.deepEqual(
    [liveAfterFailedDestroy.developerState, liveAfterFailedDestroy.latestAttempt?.operationType, liveAfterFailedDestroy.latestAttempt?.status, liveAfterFailedDestroy.stableRelease?.generationId, serviceWith(null).withStateAuthority("project-1", "dev", liveAfterFailedDestroy, profile, preflight, null, null, null).stateAuthority?.latestCompletedOperation?.type],
    ["live", "destroy", "failed_application", stable.generationId, "destroy"],
    "a failed Destroy does not downgrade a verified LIVE generation",
  );
  assert.equal(liveAfterFailedDestroy.progress.label, "Failed", "the failed operation remains visible instead of borrowing the stable runtime's Live progress");
  assert.equal(liveAfterFailedDestroy.latestAttempt?.releaseRevision, null, "an operation attempt is never displayed as a release revision");

  const verifiedAwsDeleteButControlPlaneIncomplete = operation(
    PipelineRunStatus.FAILED,
    "project_delete_cleanup",
    {
      deploymentAction: "destroy",
      failedStage: "project_delete_cleanup",
      failureCategory: "project_delete_incomplete",
      destroyVerification: {
        contractVersion: "deployguard.destroy-result/v2",
        status: "project_delete_ready",
        deploymentOperationId: "9ffe6827-f55a-4469-ac80-64530f8cea2e",
        projectId: "project-1",
        environmentName: "dev",
        generationIds: ["404cd3c1-a7dd-4b26-85e9-f531b3cb7ef1"],
        generationResourcesRemoved: true,
        projectResourcesRemoved: true,
        terraformStateArtifactsRemoved: true,
        sharedPlatformUntouched: true,
      },
    },
    "PROJECT_DELETE_INCOMPLETE",
  );
  const destroyCleanupIncomplete = await projected(verifiedAwsDeleteButControlPlaneIncomplete, stable, stable.generationId);
  const destroyCleanupIncompleteAuthority = serviceWith(null).withStateAuthority("project-1", "dev", destroyCleanupIncomplete, profile, preflight, null, null, null);
  assert.deepEqual(
    [
      destroyCleanupIncomplete.developerState,
      destroyCleanupIncomplete.destroyCleanupIncomplete,
      destroyCleanupIncomplete.stableRelease,
      destroyCleanupIncomplete.stableUrl,
      destroyCleanupIncomplete.canRetry,
      destroyCleanupIncompleteAuthority.stateAuthority?.state,
      destroyCleanupIncompleteAuthority.stateAuthority?.infrastructure.status,
      destroyCleanupIncompleteAuthority.stateAuthority?.monitoring.status,
    ],
    ["platform_attention", true, null, null, true, "BLOCKED", "destroyed", "not_deployed"],
    "verified AWS deletion with incomplete control-plane cleanup never revives a historical LIVE runtime",
  );

  const verifiedDestroyAncestor = operation(
    PipelineRunStatus.FAILED,
    "project_delete_cleanup",
    {
      deploymentAction: "destroy",
      failureCategory: "project_delete_incomplete",
      destroyVerification: {
        contractVersion: "deployguard.destroy-result/v2",
        status: "project_delete_ready",
        deploymentOperationId: "9ffe6827-f55a-4469-ac80-64530f8cea2e",
        projectId: "project-1",
        environmentName: "dev",
        generationIds: ["404cd3c1-a7dd-4b26-85e9-f531b3cb7ef1"],
        generationResourcesRemoved: true,
        projectResourcesRemoved: true,
        terraformStateArtifactsRemoved: true,
        sharedPlatformUntouched: true,
      },
    },
    "PROJECT_DELETE_INCOMPLETE",
  );
  const dispatchFailedDestroyRetry = operation(
    PipelineRunStatus.FAILED,
    "workflow_dispatch",
    { deploymentAction: "destroy", retryOfOperationId: verifiedDestroyAncestor.id, destroyVerification: verifiedDestroyAncestor.metadata.destroyVerification },
    "GitHub Actions dispatch failed.",
  );
  dispatchFailedDestroyRetry.id = "505cd3c1-a7dd-4b26-85e9-f531b3cb7ef1";
  const setupFailedDestroyRetry = operation(
    PipelineRunStatus.FAILED,
    "set_up_job",
    { deploymentAction: "destroy", retryOfOperationId: dispatchFailedDestroyRetry.id, destroyVerification: verifiedDestroyAncestor.metadata.destroyVerification },
    "GitHub Actions runner setup failed.",
  );
  setupFailedDestroyRetry.id = "606cd3c1-a7dd-4b26-85e9-f531b3cb7ef1";
  const lineageBlocked = await projected(
    setupFailedDestroyRetry,
    stable,
    stable.generationId,
    { [dispatchFailedDestroyRetry.id]: dispatchFailedDestroyRetry, [verifiedDestroyAncestor.id]: verifiedDestroyAncestor },
  );
  assert.deepEqual(
    [lineageBlocked.developerState, lineageBlocked.destroyCleanupIncomplete, lineageBlocked.stableRelease, lineageBlocked.stableUrl],
    ["platform_attention", true, null, null],
    "a pre-execution Destroy retry inherits ancestor deletion authority without resurrecting LIVE",
  );

  const incompleteVerification = await projected(operation(PipelineRunStatus.COMPLETED, "terraform_plan_and_apply"));
  assert.deepEqual(
    [incompleteVerification.developerState, incompleteVerification.progress, incompleteVerification.stableUrl],
    ["platform_attention", { percentage: 80, phase: "verify", label: "Verification needs attention" }, null],
    "workflow completion without a verified health stage and public endpoint is never LIVE",
  );

  const unhealthy = await projected(operation(
    PipelineRunStatus.FAILED,
    "verify_alb_health_and_write_result",
    { failedStage: "verify_alb_health_and_write_result" },
    "GitHub Actions failed during Verifying application health.",
  ));
  assert.deepEqual(
    [unhealthy.developerState, unhealthy.applicationError?.category, unhealthy.progress],
    ["failed_application", "health", { percentage: 80, phase: "verify", label: "Failed" }],
    "a failed health check remains a failure even when infrastructure may exist",
  );

  const destroying = await projected(operation(PipelineRunStatus.RUNNING, "terraform_plan_and_apply", { deploymentAction: "destroy" }));
  assert.deepEqual([destroying.developerState, destroying.developerAction, destroying.progress.label], ["destroying", "none", "Destroying application"]);

  const unverifiedDestroy = await projected(operation(PipelineRunStatus.COMPLETED, "destroyed", { deploymentAction: "destroy" }));
  assert.deepEqual(
    [unverifiedDestroy.developerState, unverifiedDestroy.progress.phase],
    ["platform_attention", "verify"],
    "Terraform completion without matched absence evidence must not project DESTROYED",
  );
  const destroyedOperation = operation(PipelineRunStatus.COMPLETED, "destroyed", { deploymentAction: "destroy" });
  destroyedOperation.metadata = {
    ...destroyedOperation.metadata,
    destroyVerification: {
      contractVersion: "deployguard.destroy-result/v2",
      status: "project_delete_ready",
      deploymentOperationId: destroyedOperation.id,
      projectId: "project-1",
      environmentName: "dev",
      generationIds: [destroyedOperation.generationId],
      generationResourcesRemoved: true,
      projectResourcesRemoved: true,
      terraformStateArtifactsRemoved: true,
      sharedPlatformUntouched: true,
    },
  };
  const destroyed = await projected(destroyedOperation);
  const destroyedAuthority = serviceWith(null).withStateAuthority("project-1", "dev", destroyed, profile, preflight, null, null, null);
  assert.deepEqual(
    [destroyed.developerState, destroyed.developerAction, destroyed.progress, destroyed.latestAttempt?.operationType, destroyedAuthority.stateAuthority?.latestCompletedOperation?.type],
    ["destroyed", "deploy_again", { percentage: 40, phase: "prepare", label: "Ready to Deploy" }, "destroy", "destroy"],
  );
  console.log("GitHub Actions canonical current-state matrix passed: ready, blocked, building, failed, verified live, health-unverified completion, destroying and destroyed.");
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
