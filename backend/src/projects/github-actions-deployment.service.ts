import { createHash, randomUUID } from "crypto";
import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTagsCommand } from "@aws-sdk/client-elastic-load-balancing-v2";
import { LogSanitizerService } from "../observability/log-sanitizer.service";
import { User, UserRole } from "../users/user.entity";
import { ProjectDetectionProfile, DetectionStatus } from "./project-detection-profile.entity";
import { ProjectPipelineRun, PipelineRunStatus } from "./project-pipeline-run.entity";
import { Project } from "./project.entity";
import { GithubAppService } from "./github-app.service";
import { GithubActionsDispatchError, GithubActionsService, githubWorkflowDispatchInputs } from "./pipeline/github-actions.service";
import { GithubActionsOidcTrustService } from "./github-actions-oidc-trust.service";
import { GithubActionsAwsCapabilityService, WorkflowAwsCapabilityError } from "./github-actions-aws-capability.service";
import { githubActionsExecutionStageFromLog, githubActionsPlatformCapabilityFailure, githubActionsStagePresentation, githubActionsWorkflowStepPresentation } from "./pipeline/github-actions-stage-presentation";
import { DeploymentContractService } from "./deployment-contract.service";
import { RepositoryWorkspaceService } from "./detection/repository-workspace.service";
import { ProjectEnvironmentVariable } from "./project-environment-variable.entity";
import { ProjectEnvironmentCryptoService } from "./project-environment-crypto.service";
import {
  assertInitialGithubActionsIdentity,
  decodeEnvironmentReferencesBase64,
  environmentReferencesBase64,
  GithubActionsOperationContractError,
  GithubActionsOperationInputs,
  buildPlanWorkflowInputs,
  immutableDispatchFingerprint,
  immutableImageTag,
  requireRetryInputs,
} from "./github-actions-operation-contract";
import { extractGithubActionsTerraformPlanSummary } from "./github-actions-terraform-plan-evidence";
import { DeploymentProfileService } from "./detection/deployment-profile.service";
import {
  extractGithubActionsReleaseEvidence,
  GithubActionsReleaseEvidence,
  RuntimeEvidenceContractError,
  sanitizedRuntimeEvidenceFailure,
  validateGithubActionsRuntimeEvidence,
} from "./github-actions-release-evidence";
import { extractGithubActionsDestroyEvidence, extractGithubActionsDestroyProgress } from "./github-actions-destroy-evidence";
import { DatabaseServiceBindingService, EffectiveDeploymentConfiguration } from "../infrastructure/database-service-binding.service";
import { GithubActionsRuntimeSecretService, RuntimeSecretMaterialization } from "./github-actions-runtime-secret.service";
import { ProjectConfigurationSnapshot } from "./project-configuration-snapshot.entity";
import { ProjectStableRelease, StableReleaseStatus } from "../orchestration/project-stable-release.entity";
import { ProjectServiceBinding } from "./project-service-binding.entity";
import { GithubActionsRuntimeConfiguration } from "./github-actions-operation-contract";
import { canonicalEnvironmentName } from "./canonical-environment";
import { BuildPlan, requireBuildPlan } from "./build-plan";
import { evaluateBuildPlanReadiness } from "./build-plan-readiness";
import { refreshDeploymentAnalysisIfStale } from "./deployment-analysis-refresh";
import { ManagedDatabaseReconciliationService } from "./managed-database-reconciliation.service";
import { DeploymentRecoveryDecision } from "./deployment-recovery-decision";
import { DeploymentRecoveryDecisionService } from "./deployment-recovery-decision.service";
import { ManagedDatabaseResetService } from "./managed-database-reset.service";
import { DeploymentGenerationService } from "./deployment-generation.service";
import { LegacyDestroyReconciliationService } from "./legacy-destroy-reconciliation.service";
import { materializeStableRelease } from "./stable-release-projection";
import { NotificationDispatcherService } from "../notifications/notification-dispatcher.service";
import { GithubActionsCostEvidenceService } from "./github-actions-cost-evidence.service";
import { GenerationRetentionService } from "./generation-retention.service";
import { ProjectExtinctionIncompleteError, ProjectExtinctionService } from "./project-extinction.service";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { DestroyLifecycleService } from "./destroy-lifecycle.service";
import { ProjectDestroyPhase } from "./project-destroy-lifecycle.entity";

const ACTIVE = [PipelineRunStatus.QUEUED, PipelineRunStatus.RUNNING];
const MAX_STABLE_RELEASE_RECONCILIATION_ATTEMPTS = 3;
const LEGACY_STABLE_RELEASE_FAILURE_MESSAGE = "The healthy workflow result did not satisfy the immutable runtime-configuration evidence contract.";

export class StableReleasePersistenceError extends Error {
  constructor(public readonly cause: unknown) {
    super("Stable release persistence failed.");
  }
}

@Injectable()
export class GithubActionsDeploymentService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GithubActionsDeploymentService.name);
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private reconciliationSweepRunning = false;

  constructor(
    @InjectRepository(Project) private readonly projects: Repository<Project>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectDetectionProfile) private readonly profiles: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectEnvironmentVariable) private readonly environmentVariables: Repository<ProjectEnvironmentVariable>,
    private readonly dataSource: DataSource,
    private readonly githubApp: GithubAppService,
    private readonly actions: GithubActionsService,
    private readonly oidcTrust: GithubActionsOidcTrustService,
    private readonly awsCapabilities: GithubActionsAwsCapabilityService,
    private readonly sanitizer: LogSanitizerService,
    private readonly config: ConfigService,
    private readonly deploymentContracts: DeploymentContractService,
    private readonly repositoryWorkspace: RepositoryWorkspaceService,
    private readonly environmentCrypto: ProjectEnvironmentCryptoService,
    private readonly deploymentProfiles: DeploymentProfileService,
    private readonly databaseBindings: DatabaseServiceBindingService,
    private readonly runtimeSecrets: GithubActionsRuntimeSecretService,
    private readonly managedDatabaseReconciliation: ManagedDatabaseReconciliationService,
    private readonly deploymentRecovery: DeploymentRecoveryDecisionService,
    private readonly managedDatabaseReset: ManagedDatabaseResetService,
    private readonly deploymentGenerations: DeploymentGenerationService,
    private readonly legacyDestroyReconciliation: LegacyDestroyReconciliationService,
    private readonly notifications: NotificationDispatcherService,
    private readonly costEvidence: GithubActionsCostEvidenceService,
    private readonly retention: GenerationRetentionService,
    private readonly extinction: ProjectExtinctionService,
    private readonly destroyLifecycles: DestroyLifecycleService,
    @InjectRepository(ProjectConfigurationSnapshot) private readonly configurationSnapshots: Repository<ProjectConfigurationSnapshot>,
    @InjectRepository(ProjectStableRelease) private readonly stableReleases: Repository<ProjectStableRelease>,
  ) {}

  onModuleInit() {
    const configured = Number(this.config.get<string>("GITHUB_ACTIONS_RECONCILIATION_INTERVAL_MS", "15000"));
    const intervalMs = Math.max(5_000, Math.min(300_000, Number.isFinite(configured) ? configured : 15_000));
    this.reconciliationTimer = setInterval(() => void this.reconcileActiveOperations(), intervalMs);
    this.reconciliationTimer.unref();
    void this.reconcileActiveOperations();
  }

  onModuleDestroy() {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = null;
  }

  async reconcileActiveOperations() {
    if (this.reconciliationSweepRunning) return { skipped: true, reconciled: 0 };
    this.reconciliationSweepRunning = true;
    let reconciled = 0;
    try {
      const configured = Number(this.config.get<string>("GITHUB_ACTIONS_RECONCILIATION_BATCH_SIZE", "25"));
      const limit = Math.max(1, Math.min(100, Number.isFinite(configured) ? configured : 25));
      const active = await this.runs.createQueryBuilder("run")
        .innerJoinAndSelect("run.project", "project")
        .innerJoinAndSelect("run.triggeredByUser", "triggeredByUser")
        .where("run.metadata ->> 'executionEngine' = 'github_actions'")
        .andWhere("run.status IN (:...statuses)", { statuses: ACTIVE })
        .orderBy("run.createdAt", "ASC")
        .take(limit)
        .getMany();
      for (const operation of active) {
        try {
          await this.reconcile(operation.triggeredByUser, operation.project, operation);
          reconciled += 1;
        } catch (error) {
          this.logger.warn(`GitHub Actions operation ${operation.id} did not converge in this bounded sweep: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
      const dueDestroy = await this.destroyLifecycles.due(limit);
      for (const lifecycle of dueDestroy) {
        if (lifecycle.remaining.some((item) => item.retryable === false && /ownership|foreign|validation/i.test(`${item.reason} ${item.errorCode || ""}`))) continue;
        try {
          await this.resumeDestroyLifecycle(lifecycle.projectId, lifecycle.operationId);
          reconciled += 1;
        } catch (error) {
          this.logger.warn(`Destroy lifecycle ${lifecycle.id} did not resume in this bounded sweep: ${error instanceof Error ? error.message : "unknown error"}`);
        }
      }
      return { skipped: false, reconciled };
    } finally {
      this.reconciliationSweepRunning = false;
    }
  }

  private async resumeDestroyLifecycle(projectId: string, sourceOperationId: string) {
    const project = await this.projects.findOne({ where: { id: projectId } });
    if (!project) return;
    const source = await this.runs.findOne({ where: { id: sourceOperationId, projectId }, relations: { triggeredByUser: true } });
    if (!source || source.metadata?.deploymentAction !== "destroy" || !source.triggeredByUser) return;
    const environmentName = canonicalEnvironmentName(project);
    const lifecycle = await this.destroyLifecycles.active(project.id, environmentName);
    if (!lifecycle) return;
    if (lifecycle.phase !== ProjectDestroyPhase.AWS_CLEANUP) {
      const lease = await this.destroyLifecycles.acquire(project.id, environmentName, source.id);
      if (!lease) return;
      const credential = await this.githubApp.tokenForRepository(
        source.triggeredByUser.id,
        project.repositoryFullName,
        project.githubInstallationId,
      );
      const heartbeat = setInterval(() => {
        void this.destroyLifecycles.heartbeat(project.id, environmentName, source.id);
      }, 30_000);
      heartbeat.unref();
      try {
        await this.extinction.extinguish(project, source, credential.token, async (phase) => {
          await this.destroyLifecycles.phase(project.id, environmentName, source.id, phase);
        });
      } catch (error) {
        const currentLifecycle = await this.destroyLifecycles.active(project.id, environmentName) || lifecycle;
        await this.destroyLifecycles.recordIncomplete({
          projectId: project.id,
          environmentName,
          operationId: source.id,
          phase: currentLifecycle.phase,
          remaining: [{
            resourceType: "control_plane_extinction",
            resourceId: `${project.id}:${currentLifecycle.phase}`,
            ownershipScope: "project",
            reason: "The verified AWS Destroy completed, but control-plane extinction is incomplete.",
            errorCode: error instanceof ProjectExtinctionIncompleteError ? error.code : "CONTROL_PLANE_EXTINCTION_FAILED",
            errorMessage: error instanceof Error ? error.message : "Control-plane extinction could not be verified.",
            retryable: true,
            attemptCount: currentLifecycle.retryCount + 1,
            firstSeenAt: currentLifecycle.firstStartedAt.toISOString(),
            lastSeenAt: new Date().toISOString(),
          }],
        });
      } finally {
        clearInterval(heartbeat);
      }
      return;
    }
    if (source.status !== PipelineRunStatus.FAILED) return;
    await this.withProjectLock(projectId, async (runRepository) => {
      const active = await runRepository.findOne({ where: { projectId, status: In(ACTIVE) } });
      if (active) return;
      const generation = await this.deploymentGenerations.requireActiveGeneration(source.generationId, project.id, canonicalEnvironmentName(project), runRepository.manager);
      await this.redispatch(source.triggeredByUser, project, runRepository, source, generation.id);
    });
  }

  async deploy(user: User, projectId: string) {
    const project = await this.project(user, projectId);
    return this.withProjectLock(projectId, async (runRepository) => {
      await this.assertNoDestroyLifecycle(project, runRepository);
      const active = await this.reconcileActive(user, project, runRepository);
      if (active) return this.result("no_op", "This deployment is already progressing.", active);
      const environmentName = canonicalEnvironmentName(project);
      const generation = await this.deploymentGenerations.ensureActive(projectId, environmentName, runRepository.manager);
      const previousStable = await this.currentLiveRun(projectId, runRepository, generation.id);
      return this.dispatch(user, projectId, runRepository, "deploy", previousStable?.id || null, { generationId: generation.id });
    });
  }

  async retry(user: User, projectId: string) {
    const project = await this.project(user, projectId);
    return this.withProjectLock(projectId, async (runRepository) => {
      const active = await this.reconcileActive(user, project, runRepository);
      if (active) return this.result("no_op", "This deployment is already progressing.", active);
      const failed = await this.latestRun(projectId, runRepository);
      if (!failed || failed.status !== PipelineRunStatus.FAILED) throw new BadRequestException("Only the latest failed GitHub Actions deployment can be retried.");
      const generation = await this.deploymentGenerations.requireActiveGeneration(failed.generationId, project.id, canonicalEnvironmentName(project), runRepository.manager);
      const action = String(failed.metadata?.deploymentAction || "deploy");
      if (action !== "destroy") await this.assertNoDestroyLifecycle(project, runRepository);
      if (action === "deploy") {
        let retryInputs: GithubActionsOperationInputs;
        try {
          retryInputs = requireRetryInputs(failed.metadata, {
            operationId: failed.id,
            projectId: project.id,
            repositoryFullName: project.repositoryFullName,
            targetBranch: project.targetBranch,
            commitSha: failed.commitSha,
          });
        } catch (error) {
          throw this.operationContractException(error);
        }
        const previousStable = await this.currentLiveRun(projectId, runRepository, generation.id);
        try {
          return await this.dispatch(user, projectId, runRepository, "deploy", previousStable?.id || null, {
            requestedMode: "RETRY",
            retryOfOperationId: failed.id,
            expectedRetryInputs: retryInputs,
            retryDetectionProfileId: failed.detectionProfileId,
            generationId: generation.id,
          });
        } catch (error) {
          if (error instanceof WorkflowAwsCapabilityError) throw error;
          const persisted = await runRepository.createQueryBuilder("run")
            .where("run.projectId = :projectId", { projectId })
            .andWhere("run.metadata ->> 'retryOfOperationId' = :sourceId", { sourceId: failed.id })
            .orderBy("run.createdAt", "DESC")
            .getOne();
          if (persisted) return this.result("rejected", persisted.errorMessage || "Retry failed before GitHub Actions dispatch.", persisted);
          return this.persistRejectedRetry(user, project, runRepository, failed, retryInputs, error);
        }
      }
      return this.redispatch(user, project, runRepository, failed, generation.id);
    });
  }

  async resetAndDeployFresh(user: User, projectId: string, confirmationPhrase: string, req?: unknown) {
    if (confirmationPhrase !== "RESET AND DEPLOY FRESH") {
      throw new BadRequestException("Type RESET AND DEPLOY FRESH to confirm a new empty managed-database generation.");
    }
    await this.managedDatabaseReset.reset(user, projectId, "RESET MANAGED DATABASE", req);
    const project = await this.project(user, projectId);
    return this.withProjectLock(projectId, async (runRepository) => {
      await this.assertNoDestroyLifecycle(project, runRepository);
      const active = await this.reconcileActive(user, project, runRepository);
      if (active) return this.result("no_op", "A GitHub Actions operation is already progressing.", active);
      const generation = await this.deploymentGenerations.ensureActive(projectId, canonicalEnvironmentName(project), runRepository.manager);
      return this.dispatch(user, projectId, runRepository, "deploy", null, { requestedMode: "RESET_FRESH", generationId: generation.id });
    });
  }

  async destroy(user: User, projectId: string, confirmationPhrase: string) {
    if (confirmationPhrase !== "DESTROY") throw new BadRequestException("Type DESTROY to confirm permanent infrastructure removal.");
    const project = await this.project(user, projectId);
    return this.withProjectLock(projectId, async (runRepository) => {
      const active = await this.reconcileActive(user, project, runRepository);
      if (active) return this.result("no_op", "A GitHub Actions operation is already progressing.", active);
      const generation = await this.deploymentGenerations.active(projectId, canonicalEnvironmentName(project), runRepository.manager);
      if (!generation) throw new BadRequestException("There is no active deployment generation to destroy.");
      return this.dispatch(user, projectId, runRepository, "destroy", null, { generationId: generation.id });
    });
  }

  async rollbackCandidates(user: User, projectId: string) {
    await this.project(user, projectId);
    const generation = await this.deploymentGenerations.active(projectId, canonicalEnvironmentName(await this.project(user, projectId)));
    const current = generation ? await this.currentLiveRun(projectId, this.runs, generation.id) : null;
    if (!current) return { candidates: [] };
    const target = await this.rollbackTarget(projectId, current, this.runs);
    if (!target) return { candidates: [] };
    const evidence = this.releaseEvidence(target);
    const inputs = this.releaseInputs(target);
    if (!evidence || !inputs) return { candidates: [] };
    return {
      candidates: [{
        operationId: target.id,
        releaseRevision: Number(target.metadata?.attempt || 1),
        commitSha: target.commitSha,
        imageDigest: evidence.imageDigest,
        deployedAt: target.completedAt || target.updatedAt,
        appPort: evidence.appPort,
        healthCheckPath: evidence.healthCheckPath,
      }],
    };
  }

  async rollback(user: User, projectId: string, targetOperationId: string) {
    const project = await this.project(user, projectId);
    return this.withProjectLock(projectId, async (runRepository) => {
      await this.assertNoDestroyLifecycle(project, runRepository);
      const active = await this.reconcileActive(user, project, runRepository);
      if (active) return this.result("no_op", "A GitHub Actions operation is already progressing.", active);
      const generation = await this.deploymentGenerations.active(projectId, canonicalEnvironmentName(project), runRepository.manager);
      if (!generation) throw new BadRequestException({ code: "generation_missing", message: "There is no active deployment generation to roll back." });
      const current = await this.currentLiveRun(projectId, runRepository, generation.id);
      if (!current) throw new BadRequestException({ code: "rollback_live_release_missing", message: "A verified current live release is required for rollback." });
      const target = await this.rollbackTarget(projectId, current, runRepository);
      if (!target || target.id !== targetOperationId) {
        throw new BadRequestException({ code: "rollback_target_ineligible", message: "The selected release is not the previous eligible release." });
      }
      const targetInputs = this.releaseInputs(target);
      const targetEvidence = this.releaseEvidence(target);
      if (!targetInputs || !targetEvidence) {
        throw new BadRequestException({ code: "rollback_evidence_missing", message: "The selected release does not contain complete immutable rollback evidence." });
      }
      if (
        targetEvidence.appPort !== Number(targetInputs.app_port)
        || targetEvidence.healthCheckPath !== targetInputs.health_check_path
      ) {
        throw new BadRequestException({ code: "rollback_evidence_mismatch", message: "The selected release runtime evidence is inconsistent." });
      }
      const oidcTrustSubject = await this.githubApp.oidcTrustSubject(user.id, project.repositoryFullName, project.githubInstallationId);
      await this.oidcTrust.ensureRepositoryAuthorized(project.repositoryFullName, oidcTrustSubject);
      const capability = await this.awsCapabilities.ensure({
        action: "rollback",
        projectId: project.id,
        environmentName: canonicalEnvironmentName(project),
        generationId: generation.id,
      });
      const workflow = await this.githubApp.ensureWorkflow(user.id, project.repositoryFullName, project.targetBranch, project.githubInstallationId);
      const credential = await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId);
      const operationId = randomUUID();
      const inputs: GithubActionsOperationInputs = {
        ...targetInputs,
        deployment_action: "rollback",
        deployment_operation_id: operationId,
        rollback_source_operation_id: target.id,
        rollback_image_uri: targetEvidence.imageUri,
        rollback_task_definition_arn: targetEvidence.taskDefinitionArn,
        generated_dockerfile_base64: "",
        build_time_public_config_base64: "",
      };
      const attempt = await this.nextAttempt(runRepository, projectId);
      const operation = await runRepository.save(runRepository.create({
        id: operationId,
        projectId,
        generationId: generation.id,
        triggeredByUserId: user.id,
        detectionProfileId: target.detectionProfileId,
        repositoryUrl: target.repositoryUrl,
        repositoryFullName: target.repositoryFullName,
        targetBranch: target.targetBranch,
        commitSha: target.commitSha,
        imageTag: target.imageTag,
        ecrImageUri: targetEvidence.imageUri,
        status: PipelineRunStatus.QUEUED,
        currentStage: "workflow_dispatch",
        startedAt: new Date(),
        githubWorkflowStatus: "dispatching",
        metadata: {
          executionEngine: "github_actions",
          workflowPath: workflow.path,
          deploymentAction: "rollback",
          attempt,
          rollbackSourceOperationId: target.id,
          previousStableOperationId: current.id,
          releaseEvidence: targetEvidence,
          workflowAwsCapabilityContract: capability,
          stableDeployedUrl: current.metadata?.deployedUrl,
          immutableDispatchInputs: inputs,
          immutableDispatchFingerprint: immutableDispatchFingerprint(inputs),
          immutableDispatchInputNames: Object.keys(githubWorkflowDispatchInputs(inputs) || {}).sort(),
        },
      }));
      await this.scheduleOperation(runRepository, operation, credential.token, inputs);
      return this.result("accepted", `Rollback to release ${Number(target.metadata?.attempt || 1)} was dispatched.`, operation);
    });
  }

  async latest(user: User, projectId: string) {
    const project = await this.project(user, projectId);
    let operation = await this.latestRun(projectId, this.runs);
    if (!operation) return { operation: null };
    await this.reconcile(user, project, operation);
    operation = await this.legacyDestroyReconciliation.reconcile(project, operation);
    const stableUrl = await this.stableUrl(projectId, operation.generationId, operation.id);
    return { operation: this.response(operation, stableUrl) };
  }

  async history(user: User, projectId: string) {
    const project = await this.project(user, projectId);
    const operations = await this.runs.createQueryBuilder("run")
      .where("run.projectId = :projectId", { projectId })
      .andWhere("run.metadata ->> 'executionEngine' = 'github_actions'")
      .orderBy("run.createdAt", "DESC").getMany();
    for (const operation of operations.filter((run) => ACTIVE.includes(run.status))) await this.reconcile(user, project, operation);
    for (let index = 0; index < operations.length; index += 1) {
      operations[index] = await this.legacyDestroyReconciliation.reconcile(project, operations[index]);
    }
    let workflowToken: string | null = null;
    if (operations.some((run) => run.githubWorkflowRunId)) {
      try {
        workflowToken = (await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId)).token;
      } catch { /* persisted history remains available without remote step detail */ }
    }
    return {
      operations: await Promise.all(operations.map(async (run) => ({
        ...this.response(run, null),
        workflowStages: await this.workflowStages(project, run, workflowToken),
      }))),
    };
  }

  private async dispatch(
    user: User,
    projectId: string,
    runRepository: Repository<ProjectPipelineRun>,
    action: "deploy" | "destroy",
    previousStableOperationId: string | null = null,
    options: {
      requestedMode?: "DEPLOY" | "RETRY" | "RESET_FRESH";
      retryOfOperationId?: string;
      expectedRetryInputs?: GithubActionsOperationInputs;
      retryDetectionProfileId?: string | null;
      generationId?: string;
    } = {},
  ) {
    let project = await this.project(user, projectId);
    const environmentName = canonicalEnvironmentName(project);
    const generation = await this.deploymentGenerations.requireActiveGeneration(options.generationId, projectId, environmentName, runRepository.manager);
    let deploymentContext: DeploymentRecoveryDecision | null = null;
    if (action === "deploy") {
      const database = await this.managedDatabaseReconciliation.reconcile(project, generation.id);
      deploymentContext = await this.deploymentRecovery.decide(projectId, database, options.requestedMode || "DEPLOY");
      if (!deploymentContext.deploymentAllowed) {
        throw new ForbiddenException({
          code: deploymentContext.recoveryState,
          message: deploymentContext.reason,
          deploymentContext,
          databaseReconciliation: database,
        });
      }
    }
    let profile = await this.profiles.findOne({ where: { projectId } });
    if (!options.expectedRetryInputs && (!profile || profile.detectionStatus !== DetectionStatus.SUCCESS)) throw new ForbiddenException("Run successful stack detection before deploying.");
    let contract = await this.deploymentContracts.requireForProject(projectId);
    let plan = options.expectedRetryInputs
      ? this.retryBuildPlan(options.expectedRetryInputs, project)
      : requireBuildPlan(contract);
    const deployCredential = action === "deploy"
      ? await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId)
      : null;
    const oidcTrustSubject = await this.githubApp.oidcTrustSubject(user.id, project.repositoryFullName, project.githubInstallationId);
    await this.oidcTrust.ensureRepositoryAuthorized(project.repositoryFullName, oidcTrustSubject);
    const capability = await this.awsCapabilities.ensure({
      action,
      projectId: project.id,
      environmentName,
      generationId: generation.id,
    });
    let workflow: Awaited<ReturnType<GithubAppService["ensureWorkflow"]>> | null = null;
    if (action === "deploy" && !options.expectedRetryInputs) {
      // Validate and update the managed caller before binding analysis to the
      // branch head, because a caller update itself advances that branch.
      workflow = await this.githubApp.ensureWorkflow(user.id, project.repositoryFullName, project.targetBranch, project.githubInstallationId);
      let remoteCommit = await this.repositoryWorkspace.resolveRemoteCommit({
        repositoryUrl: project.repositoryUrl,
        targetBranch: project.targetBranch,
        accessToken: deployCredential!.token,
      });
      const freshness = await refreshDeploymentAnalysisIfStale({
        project,
        profile: profile!,
        contract,
        remoteCommit,
        runAuthoritativeDetection: () => this.deploymentProfiles.runDetection(user, projectId),
        reload: async () => ({
          project: await this.project(user, projectId),
          profile: await this.profiles.findOne({ where: { projectId } }),
          contract: await this.deploymentContracts.requireForProject(projectId),
        }),
        resolveRemoteCommit: (current) => this.repositoryWorkspace.resolveRemoteCommit({
          repositoryUrl: current.repositoryUrl,
          targetBranch: current.targetBranch,
          accessToken: deployCredential!.token,
        }),
      });
      project = freshness.project;
      profile = freshness.profile;
      contract = freshness.contract;
      remoteCommit = freshness.remoteCommit;
      plan = requireBuildPlan(contract);
      try {
        assertInitialGithubActionsIdentity(project, profile!, contract, remoteCommit);
      } catch (error) {
        throw this.operationContractException(error);
      }
    }
    if (!options.expectedRetryInputs) this.deploymentContracts.assertDeployable(contract, project);
    if (action === "deploy") {
      const preDispatchConfiguration = await this.databaseBindings.resolveEffectiveDeploymentConfiguration(projectId, null, environmentName, { throwOnBlockers: false, requireReady: false, useSnapshot: false, generationId: generation.id });
      const readiness = evaluateBuildPlanReadiness(plan, preDispatchConfiguration);
      if (readiness.status === "INPUT_REQUIRED") throw new BadRequestException({ code: "INPUT_REQUIRED", requiredInputs: readiness.requiredInputs });
      if (readiness.status === "BLOCKED") throw new ForbiddenException({ code: "BLOCKED", blockers: readiness.blockers });
    }
    workflow ||= await this.githubApp.ensureWorkflow(user.id, project.repositoryFullName, project.targetBranch, project.githubInstallationId);
    const attempt = await this.nextAttempt(runRepository, projectId);
    const stableUrl = await this.stableUrl(projectId, generation.id);
    const operationId = randomUUID();
    const buildTimePublicConfig = action === "deploy" ? await this.buildTimePublicConfig(plan, contract.projectId, environmentName) : {};
    const operationCommit = options.expectedRetryInputs?.commit_sha || contract.commitSha || profile?.commitSha || "";
    const operation = await runRepository.save(runRepository.create({
      id: operationId, projectId, generationId: generation.id, triggeredByUserId: user.id, detectionProfileId: options.retryDetectionProfileId || profile?.id || undefined,
      repositoryUrl: project.repositoryUrl, repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch, commitSha: operationCommit,
      imageTag: immutableImageTag(operationCommit, operationId),
      status: PipelineRunStatus.QUEUED, currentStage: action === "deploy" ? "configuration_snapshot" : "workflow_dispatch", startedAt: new Date(),
      githubWorkflowStatus: "dispatching", metadata: {
        executionEngine: "github_actions", workflowPath: workflow.path, deploymentAction: action, attempt,
        workflowAwsCapabilityContract: capability,
        ...(deploymentContext ? { deploymentMode: deploymentContext.deploymentMode, deploymentContext } : {}),
        ...(options.retryOfOperationId ? { retryOfOperationId: options.retryOfOperationId } : {}),
        ...(previousStableOperationId ? { previousStableOperationId } : {}),
        ...(stableUrl ? { stableDeployedUrl: stableUrl } : {}),
      },
    }));
    await this.deploymentGenerations.bindCreatingOperation(generation.id, operation.id, runRepository.manager);
    let runtimeConfiguration: GithubActionsRuntimeConfiguration | null = null;
    if (action === "deploy") {
      try {
        const protectedRelease = previousStableOperationId
          ? await runRepository.manager.getRepository(ProjectStableRelease).findOne({
            where: {
              projectId,
              generationId: generation.id,
              environmentName,
              deployedByPipelineRunId: previousStableOperationId,
              status: StableReleaseStatus.STABLE,
            },
          })
          : null;
        const snapshot = await this.databaseBindings.createRunConfigurationSnapshot(projectId, operationId, environmentName, runRepository.manager);
        const effective = await this.databaseBindings.resolveEffectiveDeploymentConfiguration(projectId, operationId, environmentName, {
          requireReady: false,
          useSnapshot: true,
          manager: runRepository.manager,
        });
        const materialized = await this.runtimeSecrets.materialize({
          projectId,
          generationId: generation.id,
          environment: environmentName,
          configurationFingerprint: snapshot.configurationFingerprint,
          secretValues: effective.projectSecretValues,
        });
        runtimeConfiguration = this.runtimeConfiguration(snapshot, effective, materialized, deploymentContext!, generation.id, protectedRelease);
        snapshot.secretReferences = {
          ...snapshot.secretReferences,
          ...(materialized?.valueFromByName || {}),
        };
        await runRepository.manager.getRepository(ProjectConfigurationSnapshot).save(snapshot);
        operation.configurationSnapshotId = snapshot.id;
        operation.databaseServiceBindingId = effective.binding?.id || null;
        operation.metadata = {
          ...(operation.metadata || {}),
          configurationSnapshotId: snapshot.id,
          configurationFingerprint: snapshot.configurationFingerprint,
          databaseBindingId: effective.binding?.id || null,
          secretReferenceNames: Object.keys(runtimeConfiguration.secretReferences).sort(),
        };
      } catch (error) {
        operation.status = PipelineRunStatus.FAILED;
        operation.currentStage = "configuration_snapshot";
        operation.githubWorkflowStatus = "not_dispatched";
        operation.failedAt = new Date();
        operation.errorMessage = "Immutable runtime configuration could not be prepared.";
        operation.metadata = { ...(operation.metadata || {}), conclusion: "failure", failedStage: "configuration_snapshot", safeLog: "DeployGuard rejected the runtime configuration before dispatch. No secret value was persisted in operation evidence." };
        await runRepository.save(operation);
        if (error instanceof HttpException) throw error;
        throw new BadRequestException({ code: "runtime_configuration_invalid", message: operation.errorMessage });
      }
    }
    const destroyContext = action === "destroy"
      ? await this.destroyEnvironmentReferences(project.id, environmentName, generation.id, contract, runRepository)
      : null;
    const inputs: GithubActionsOperationInputs = {
      deployment_action: action,
      deployment_operation_id: operationId,
      project_id: project.id,
      environment_name: environmentName,
      repository_full_name: project.repositoryFullName,
      repository_branch: project.targetBranch,
      detection_profile_version: options.expectedRetryInputs?.detection_profile_version || profile?.inputFingerprint || profile?.id || "",
      deployment_contract_version: options.expectedRetryInputs?.deployment_contract_version || contract.contractHash,
      image_tag: operation.imageTag,
      environment_references_base64: runtimeConfiguration
        ? environmentReferencesBase64(runtimeConfiguration)
        : destroyContext!.encoded,
      infrastructure_namespace: `/deployguard/${project.id}/${environmentName}/${generation.id}`,
      aws_region: this.config.get("AWS_REGION", "us-east-1"),
      aws_role_arn: this.config.get("DEPLOYGUARD_GITHUB_ACTIONS_ROLE_ARN", ""),
      vpc_id: this.config.get("DEPLOYGUARD_VPC_ID", ""),
      public_subnet_ids: this.config.get("DEPLOYGUARD_PUBLIC_SUBNET_IDS", ""),
      commit_sha: operationCommit,
      ...buildPlanWorkflowInputs(plan),
      terraform_state_bucket: this.config.get("DEPLOYGUARD_TERRAFORM_STATE_BUCKET", ""),
      generated_dockerfile_base64: options.expectedRetryInputs
        ? options.expectedRetryInputs.generated_dockerfile_base64
        : (action === "deploy" && plan.dockerStrategy === "generated"
          ? Buffer.from(contract.generatedDockerfile || "", "utf8").toString("base64")
          : ""),
      build_time_public_config_base64: options.expectedRetryInputs
        ? options.expectedRetryInputs.build_time_public_config_base64
        : Object.keys(buildTimePublicConfig).length
          ? Buffer.from(JSON.stringify(buildTimePublicConfig), "utf8").toString("base64")
          : "",
      rollback_source_operation_id: "",
      rollback_image_uri: "",
      rollback_task_definition_arn: "",
    };
    operation.currentStage = "workflow_dispatch";
    operation.commitSha = inputs.commit_sha;
    operation.imageTag = inputs.image_tag;
    operation.metadata = {
      ...(operation.metadata || {}),
      immutableDispatchInputs: inputs,
      immutableDispatchFingerprint: immutableDispatchFingerprint(inputs),
      immutableDispatchInputNames: Object.keys(githubWorkflowDispatchInputs(inputs) || {}).sort(),
    };
    await runRepository.save(operation);
    if (action === "destroy") {
      await this.destroyLifecycles.begin({
        projectId: project.id,
        environmentName,
        generationId: generation.id,
        operationId: operation.id,
        resourceManifest: destroyContext!.resourceManifest,
      }, runRepository.manager);
      const lease = await this.destroyLifecycles.acquire(project.id, environmentName, operation.id);
      if (!lease) throw new ServiceUnavailableException("Another valid Destroy cleanup execution owns this generation lease.");
      operation.metadata = {
        ...(operation.metadata || {}),
        destroyLifecycleId: lease.id,
        destroyStatus: lease.status,
        extinctionPhase: lease.phase,
      };
      await runRepository.save(operation);
    }
    const credential = deployCredential || await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId);
    if (action === "destroy") {
      this.schedulePersistedOperation(operation, credential.token, inputs);
      return this.result("accepted", "Confirmed destroy queued for GitHub Actions.", operation);
    }
    await this.scheduleOperation(runRepository, operation, credential.token, inputs);
    return this.result(
      "accepted",
      previousStableOperationId
        ? "Redeployment dispatched to GitHub Actions. The current healthy release remains available until verification succeeds."
        : deploymentContext?.deploymentMode === "FRESH" || deploymentContext?.deploymentMode === "RESET_FRESH"
          ? deploymentContext.reason
          : options.retryOfOperationId
            ? "Retry dispatched as a new historical attempt while retaining the existing Terraform state."
            : "Deployment dispatched to GitHub Actions.",
      operation,
    );
  }

  private retryBuildPlan(inputs: GithubActionsOperationInputs, project: Project) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(inputs.build_plan_base64, "base64").toString("utf8"));
    } catch {
      throw new BadRequestException({ code: "immutable_snapshot_tampered", message: "The immutable retry BuildPlan is invalid." });
    }
    let plan: BuildPlan;
    try {
      plan = requireBuildPlan({ buildPlan: decoded as BuildPlan });
    } catch {
      throw new BadRequestException({ code: "immutable_snapshot_tampered", message: "The immutable retry BuildPlan is incompatible." });
    }
    const planInputs = buildPlanWorkflowInputs(plan);
    if (
      plan.repositoryFullName !== project.repositoryFullName
      || plan.branch !== project.targetBranch
      || plan.commitSha !== inputs.commit_sha
      || Object.entries(planInputs).some(([key, value]) => inputs[key as keyof GithubActionsOperationInputs] !== value)
    ) {
      throw new BadRequestException({ code: "immutable_snapshot_tampered", message: "The immutable retry BuildPlan does not match the failed attempt." });
    }
    return plan;
  }

  private async persistRejectedRetry(
    user: User,
    project: Project,
    runRepository: Repository<ProjectPipelineRun>,
    source: ProjectPipelineRun,
    sourceInputs: GithubActionsOperationInputs,
    error: unknown,
  ) {
    const operationId = randomUUID();
    const attempt = await this.nextAttempt(runRepository, project.id);
    const failure = this.retryAdmissionFailure(error);
    const inputs: GithubActionsOperationInputs = {
      ...sourceInputs,
      deployment_operation_id: operationId,
      image_tag: immutableImageTag(source.commitSha, operationId),
    };
    const now = new Date();
    const operation = await runRepository.save(runRepository.create({
      id: operationId,
      projectId: project.id,
      generationId: source.generationId,
      triggeredByUserId: user.id,
      detectionProfileId: source.detectionProfileId,
      repositoryUrl: source.repositoryUrl,
      repositoryFullName: source.repositoryFullName,
      targetBranch: source.targetBranch,
      commitSha: source.commitSha,
      imageTag: inputs.image_tag,
      status: PipelineRunStatus.FAILED,
      currentStage: "retry_admission",
      startedAt: now,
      failedAt: now,
      githubWorkflowStatus: "not_dispatched",
      errorMessage: failure.message,
      metadata: {
        executionEngine: "github_actions",
        workflowPath: source.metadata?.workflowPath,
        deploymentAction: "deploy",
        deploymentMode: "RETRY",
        attempt,
        retryOfOperationId: source.id,
        conclusion: "failure",
        failedStage: "retry_admission",
        admissionFailureCode: failure.code,
        safeLog: failure.message,
        ...(failure.deploymentContext ? { deploymentContext: failure.deploymentContext } : {}),
        immutableDispatchInputs: inputs,
        immutableDispatchFingerprint: immutableDispatchFingerprint(inputs),
        immutableDispatchInputNames: Object.keys(githubWorkflowDispatchInputs(inputs) || {}).sort(),
      },
    }));
    return this.result("rejected", failure.message, operation);
  }

  private retryAdmissionFailure(error: unknown) {
    const response = error instanceof HttpException ? error.getResponse() : null;
    const detail = response && typeof response === "object" ? response as Record<string, unknown> : null;
    const responseMessage = typeof response === "string"
      ? response
      : typeof detail?.message === "string"
        ? detail.message
        : "Retry failed before GitHub Actions dispatch.";
    return {
      code: typeof detail?.code === "string" ? detail.code : "retry_admission_failed",
      message: this.sanitizer.sanitize(responseMessage).slice(0, 1000),
      deploymentContext: detail?.deploymentContext && typeof detail.deploymentContext === "object"
        ? detail.deploymentContext
        : null,
    };
  }

  private async nextAttempt(runRepository: Repository<ProjectPipelineRun>, projectId: string) {
    const row = await runRepository.createQueryBuilder("run")
      .select("COALESCE(MAX(CASE WHEN run.metadata ->> 'attempt' ~ '^[0-9]+$' THEN CAST(run.metadata ->> 'attempt' AS integer) ELSE 0 END), 0)", "maximum")
      .where("run.projectId = :projectId", { projectId })
      .andWhere("run.metadata ->> 'executionEngine' = 'github_actions'")
      .getRawOne<{ maximum: string | number }>();
    return Number(row?.maximum || 0) + 1;
  }

  private async redispatch(user: User, project: Project, runRepository: Repository<ProjectPipelineRun>, operation: ProjectPipelineRun, generationId: string) {
    let inputs: GithubActionsOperationInputs;
    try {
      inputs = requireRetryInputs(operation.metadata, {
        operationId: operation.id,
        projectId: project.id,
        repositoryFullName: project.repositoryFullName,
        targetBranch: project.targetBranch,
        commitSha: operation.commitSha,
      });
    } catch (error) {
      throw this.operationContractException(error);
    }
    const oidcTrustSubject = await this.githubApp.oidcTrustSubject(user.id, inputs.repository_full_name, project.githubInstallationId);
    await this.oidcTrust.ensureRepositoryAuthorized(inputs.repository_full_name, oidcTrustSubject);
    const capability = await this.awsCapabilities.ensure({
      action: inputs.deployment_action === "destroy" ? "destroy" : inputs.deployment_action === "rollback" ? "rollback" : "deploy",
      projectId: project.id,
      environmentName: canonicalEnvironmentName(project),
      generationId,
    });
    const workflow = await this.githubApp.ensureWorkflow(user.id, inputs.repository_full_name, inputs.repository_branch, project.githubInstallationId);
    const credential = await this.githubApp.tokenForRepository(user.id, inputs.repository_full_name, project.githubInstallationId);
    const operationId = randomUUID();
    const retryImageTag = immutableImageTag(operation.commitSha, operationId);
    const retryInputs: GithubActionsOperationInputs = {
      ...inputs,
      deployment_operation_id: operationId,
      image_tag: retryImageTag,
      ...(inputs.deployment_action === "destroy" ? {
        environment_references_base64: await this.refreshDestroyExtinctionReferences(
          project.id, canonicalEnvironmentName(project), generationId, inputs.environment_references_base64, runRepository,
        ),
      } : {}),
    };
    const retry = await runRepository.save(runRepository.create({
      id: operationId, projectId: project.id, generationId, triggeredByUserId: user.id,
      detectionProfileId: operation.detectionProfileId, repositoryUrl: operation.repositoryUrl,
      repositoryFullName: operation.repositoryFullName, targetBranch: operation.targetBranch,
      commitSha: operation.commitSha, imageTag: retryImageTag,
      githubWorkflowRunId: null, githubWorkflowStatus: "dispatching",
      status: PipelineRunStatus.QUEUED, currentStage: "workflow_dispatch", startedAt: new Date(),
      metadata: {
      ...(operation.metadata || {}),
      workflowPath: workflow.path,
      attempt: await this.nextAttempt(runRepository, project.id),
      retryOfOperationId: operation.id,
      conclusion: null,
      failedStage: null,
      safeLog: null,
      workflowAwsCapabilityContract: capability,
      immutableDispatchInputs: retryInputs,
      immutableDispatchFingerprint: immutableDispatchFingerprint(retryInputs),
    }}));
    if (retryInputs.deployment_action === "destroy") {
      const context = JSON.parse(Buffer.from(retryInputs.environment_references_base64, "base64").toString("utf8")) as Record<string, unknown>;
      const manifest = ((context.extinction as Record<string, unknown> | undefined)?.resourceManifest || {}) as Record<string, unknown>;
      const environmentName = canonicalEnvironmentName(project);
      await this.destroyLifecycles.begin({
        projectId: project.id,
        environmentName,
        generationId,
        operationId: retry.id,
        resourceManifest: manifest,
      }, runRepository.manager);
      const lease = await this.destroyLifecycles.acquire(project.id, environmentName, retry.id);
      if (!lease) throw new ServiceUnavailableException("Another valid Destroy cleanup execution owns this generation lease.");
      retry.metadata = { ...(retry.metadata || {}), destroyLifecycleId: lease.id, destroyStatus: lease.status, extinctionPhase: lease.phase };
      await runRepository.save(retry);
      this.schedulePersistedOperation(retry, credential.token, retryInputs);
      return this.result("accepted", "Destroy retry queued as a new immutable attempt.", retry);
    }
    await this.scheduleOperation(runRepository, retry, credential.token, retryInputs);
    return this.result("accepted", "Retry dispatched as a new immutable attempt.", retry);
  }

  private schedulePersistedOperation(operation: ProjectPipelineRun, token: string, inputs: GithubActionsOperationInputs) {
    setImmediate(() => {
      void this.scheduleOperation(this.runs, operation, token, inputs).catch(() => {
        // scheduleOperation persists a sanitized terminal failure before it
        // rejects. The immediate HTTP response remains the queued operation.
      });
    });
  }

  private async scheduleOperation(runRepository: Repository<ProjectPipelineRun>, operation: ProjectPipelineRun, token: string, inputs: GithubActionsOperationInputs) {
    try {
      const result = await this.actions.triggerWorkflow({
        repositoryFullName: inputs.repository_full_name,
        targetBranch: inputs.repository_branch,
        token,
        inputs,
      });
      operation.githubWorkflowRunId = result.workflowRunId;
      operation.githubWorkflowStatus = result.workflowRunId ? "queued" : "run_pending";
      operation.status = PipelineRunStatus.RUNNING;
      operation.currentStage = result.workflowRunId ? "github_actions" : "workflow_run_discovery";
      operation.metadata = {
        ...(operation.metadata || {}),
        dispatchAcceptedAt: new Date().toISOString(),
        dispatchState: result.workflowRunId ? "run_discovered" : "dispatch_accepted",
      };
      await runRepository.save(operation);
    } catch (error) {
      operation.status = PipelineRunStatus.FAILED;
      operation.currentStage = "workflow_dispatch";
      operation.githubWorkflowStatus = "dispatch_failed";
      operation.failedAt = new Date();
      operation.errorMessage = "GitHub Actions dispatch failed.";
      operation.metadata = {
        ...(operation.metadata || {}),
        conclusion: "failure",
        failedStage: "workflow_dispatch",
        dispatchFailureEvidence: error instanceof GithubActionsDispatchError ? error.evidence : null,
        safeLog: error instanceof GithubActionsDispatchError && error.evidence
          ? this.dispatchFailureLog(error.evidence)
          : error instanceof GithubActionsDispatchError && error.safeDetail
            ? error.safeDetail
            : "GitHub rejected the workflow dispatch before creating a run.",
      };
      await runRepository.save(operation);
      if (error instanceof GithubActionsDispatchError) {
        throw new ServiceUnavailableException({ code: error.diagnosticCode, message: "GitHub Actions dispatch failed safely." });
      }
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({ code: "unknown_github_error", message: "GitHub Actions dispatch failed safely." });
    }
  }

  private dispatchFailureLog(evidence: NonNullable<GithubActionsDispatchError["evidence"]>) {
    return [
      "GitHub workflow dispatch rejected",
      `HTTP: ${evidence.httpStatus ?? "not sent"}`,
      `Classification: ${evidence.classification}`,
      `Repository: ${evidence.repository}`,
      `Workflow: ${evidence.workflow}`,
      `Ref: ${evidence.ref}`,
      `Input names: ${evidence.inputNames.join(", ")}`,
      `Operation: ${evidence.operationId || "unknown"}`,
      `Failed at: ${evidence.failedAt}`,
      `Message: ${evidence.message}`,
    ].join("\n");
  }

  private operationContractException(error: unknown) {
    if (error instanceof GithubActionsOperationContractError) {
      return new BadRequestException({ code: error.code, message: error.message });
    }
    return error instanceof HttpException
      ? error
      : new BadRequestException({ code: "invalid_contract", message: "Immutable deployment evidence is invalid." });
  }

  private safeOutputDirectory(staticOutput: boolean, outputDirectory: string | null) {
    if (!staticOutput) return ".";
    const value = outputDirectory?.trim() || "";
    if (!value || value.startsWith("/") || value.split("/").includes("..") || !/^[A-Za-z0-9._/-]+$/.test(value)) {
      throw new ForbiddenException("Run successful stack detection with a safe build output directory before deploying.");
    }
    return value;
  }

  private safeApplicationRoot(value: string) {
    const normalized = value.trim();
    if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..") || !/^(?:\.|[A-Za-z0-9._/-]+)$/.test(normalized)) {
      throw new ForbiddenException("Deployment contract contains an unsafe application root.");
    }
    return normalized;
  }

  private async buildTimePublicConfig(plan: BuildPlan, projectId: string, environment: string) {
    if (!plan.buildTimeEnvVars.length) return {};
    const rows = await this.environmentVariables.createQueryBuilder("variable")
      .addSelect("variable.value")
      .where({ projectId, environment, isActive: true, key: In(plan.buildTimeEnvVars) })
      .getMany();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const config: Record<string, string> = {};
    for (const key of plan.buildTimeEnvVars) {
      if (!/^(VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*$/.test(key) || plan.secretEnvVars.includes(key)) {
        throw new ForbiddenException(`Build-time variable ${key} is not proven public.`);
      }
      const row = byKey.get(key);
      if (!row || row.isSecret) throw new ForbiddenException(`Required public build configuration is missing: ${key}.`);
      config[key] = this.environmentCrypto.decrypt(row.value);
    }
    return config;
  }

  private runtimeConfiguration(
    snapshot: ProjectConfigurationSnapshot,
    effective: EffectiveDeploymentConfiguration,
    materialized: RuntimeSecretMaterialization | null,
    deploymentContext: DeploymentRecoveryDecision,
    generationId: string,
    protectedRelease: ProjectStableRelease | null,
  ): GithubActionsRuntimeConfiguration {
    const binding = effective.binding;
    const runtimeAliases = binding
      ? Object.fromEntries(Object.entries(snapshot.plainValues)
          .filter(([key]) => effective.ownership[key]?.serviceBindingId === binding.id)
          .sort(([left], [right]) => left.localeCompare(right)))
      : {};
    const secretAliases = binding
      ? Object.fromEntries(Object.entries(effective.ownership)
          .filter(([, owner]) => owner.serviceBindingId === binding.id && owner.secret)
          .map(([key]) => [key, key.includes("URL") ? "url" : "password"] as const)
          .sort(([left], [right]) => left.localeCompare(right)))
      : {};
    const existingReferences = Object.fromEntries(Object.entries(effective.secretReferences)
      .filter(([key, reference]) => effective.ownership[key]?.serviceBindingId !== binding?.id && reference.startsWith("arn:")));
    const secretReferences = {
      ...existingReferences,
      ...(materialized?.valueFromByName || {}),
    };
    if (Object.keys(effective.projectSecretValues).some((key) => !secretReferences[key])) {
      throw new BadRequestException("A required application secret could not be converted to an ECS secret reference.");
    }
    if (binding && (binding.provider !== "managed" || binding.engine !== "postgres" || !binding.usernameReference)) {
      throw new BadRequestException("GitHub Actions currently requires the canonical managed PostgreSQL binding for this database-backed release.");
    }
    const protectedImageDigest = protectedRelease?.imageUri.match(/@(sha256:[0-9a-f]{64})$/)?.[1] || null;
    return {
      schemaVersion: 1,
      configurationSnapshotId: snapshot.id,
      configurationFingerprint: snapshot.configurationFingerprint,
      environmentName: snapshot.environment,
      generationId,
      environment: { ...snapshot.plainValues },
      secretReferences,
      deploymentContext,
      retentionProtectedRelease: {
        imageDigests: protectedImageDigest ? [protectedImageDigest] : [],
        taskDefinitionArns: protectedRelease?.taskDefinitionArn ? [protectedRelease.taskDefinitionArn] : [],
      },
      managedDatabase: binding ? {
        bindingId: binding.id,
        bindingFingerprint: binding.configurationFingerprint,
        provider: "managed",
        engine: "postgres",
        host: binding.hostReference,
        port: binding.port,
        databaseName: binding.databaseName,
        databaseUser: binding.usernameReference!,
        runtimeAliases,
        secretAliases: secretAliases as Record<string, "password" | "url">,
        persistenceEnabled: true,
      } : null,
    };
  }

  private async destroyEnvironmentReferences(
    projectId: string,
    environmentName: string,
    generationId: string,
    contract: Awaited<ReturnType<DeploymentContractService["requireForProject"]>>,
    runRepository: Repository<ProjectPipelineRun>,
  ) {
    const publicNames = [...new Set(contract.ecsPlan.environmentMappings.map((item) => item.name))].sort();
    const secretNames = [...new Set(contract.ecsPlan.secretMappings.map((item) => item.name))].sort();
    const generationIds = (await runRepository.manager.getRepository(ProjectDeploymentGeneration).find({
      where: { projectId },
      select: { id: true },
      order: { ordinal: "ASC" },
    })).map((generation) => generation.id);
    const resourceManifest = await this.destroyResourceManifest(projectId, environmentName, generationId, runRepository);
    const encoded = Buffer.from(JSON.stringify({
      public: publicNames,
      secret: secretNames,
      configurationFingerprint: createHash("sha256").update(JSON.stringify({ public: publicNames, secret: secretNames })).digest("hex"),
      extinction: { projectId, knownGenerationIds: generationIds, resourceManifest },
    }), "utf8").toString("base64");
    return { encoded, resourceManifest };
  }

  private async refreshDestroyExtinctionReferences(
    projectId: string,
    environmentName: string,
    generationId: string,
    encoded: string,
    runRepository: Repository<ProjectPipelineRun>,
  ) {
    let immutable: Record<string, unknown>;
    try {
      immutable = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new BadRequestException("The failed Destroy has invalid immutable environment references.");
    }
    if (!Array.isArray(immutable.public) || !Array.isArray(immutable.secret)
      || typeof immutable.configurationFingerprint !== "string") {
      throw new BadRequestException("The failed Destroy has incomplete immutable environment references.");
    }
    const generationIds = (await runRepository.manager.getRepository(ProjectDeploymentGeneration).find({
      where: { projectId }, select: { id: true }, order: { ordinal: "ASC" },
    })).map((generation) => generation.id);
    const resourceManifest = await this.destroyResourceManifest(projectId, environmentName, generationId, runRepository);
    return Buffer.from(JSON.stringify({
      public: immutable.public,
      secret: immutable.secret,
      configurationFingerprint: immutable.configurationFingerprint,
      extinction: { projectId, knownGenerationIds: generationIds, resourceManifest },
    }), "utf8").toString("base64");
  }

  private async destroyResourceManifest(projectId: string, environmentName: string, generationId: string, runRepository: Repository<ProjectPipelineRun>) {
    const manager = runRepository.manager;
    const [releases, runs, bindings, terraformStates, environments] = await Promise.all([
      manager.query(`SELECT task_definition_arn AS "taskDefinitionArn", image_uri AS "imageUri" FROM project_stable_releases WHERE project_id=$1 AND generation_id=$2`, [projectId, generationId]),
      manager.query(`SELECT ecr_repository_name AS "ecrRepositoryName", ecr_image_uri AS "ecrImageUri", metadata->'releaseEvidence' AS "releaseEvidence" FROM project_pipeline_runs WHERE project_id=$1 AND generation_id=$2`, [projectId, generationId]),
      manager.query(`SELECT efs_file_system_id AS "efsFileSystemId", efs_access_point_id AS "efsAccessPointId", password_secret_reference AS "passwordSecretReference", database_url_secret_reference AS "databaseUrlSecretReference", cloud_map_service_arn AS "cloudMapServiceArn", ecs_database_service_arn AS "ecsDatabaseServiceArn" FROM project_service_bindings WHERE project_id=$1 AND generation_id=$2`, [projectId, generationId]),
      manager.query(`SELECT state_bucket AS "stateBucket", state_key AS "stateKey", current_version_id AS "currentVersionId", previous_version_id AS "previousVersionId" FROM project_terraform_states WHERE project_id=$1`, [projectId]),
      manager.query(`SELECT terraform_outputs AS "terraformOutputs" FROM project_infrastructure_environments WHERE project_id=$1`, [projectId]),
    ]);
    const exact = (values: unknown[]) => [...new Set(values.flatMap((value) => this.manifestStrings(value)).filter(Boolean))].sort();
    const resourceEvidence = exact([
      ...runs.map((row: Record<string, unknown>) => row.releaseEvidence),
      ...environments.map((row: Record<string, unknown>) => row.terraformOutputs),
    ]);
    const matching = (pattern: RegExp) => resourceEvidence.filter((value) => pattern.test(value));
    return {
      schemaVersion: 1,
      projectId,
      environmentName,
      generationId,
      ownership: { managedBy: "DeployGuard", projectId, generationId },
      terraformStateKeys: exact(terraformStates.map((row: Record<string, unknown>) => row.stateKey)),
      terraformStateBuckets: exact(terraformStates.map((row: Record<string, unknown>) => row.stateBucket)),
      taskDefinitionArns: exact(releases.map((row: Record<string, unknown>) => row.taskDefinitionArn)),
      imageUris: exact([...releases.map((row: Record<string, unknown>) => row.imageUri), ...runs.map((row: Record<string, unknown>) => row.ecrImageUri)]),
      ecrRepositoryNames: exact(runs.map((row: Record<string, unknown>) => row.ecrRepositoryName)),
      efsFileSystemIds: exact(bindings.map((row: Record<string, unknown>) => row.efsFileSystemId)),
      efsAccessPointIds: exact(bindings.map((row: Record<string, unknown>) => row.efsAccessPointId)),
      secretArns: exact(bindings.flatMap((row: Record<string, unknown>) => [row.passwordSecretReference, row.databaseUrlSecretReference])),
      ecsClusterArns: matching(/^arn:aws[^:]*:ecs:[^:]+:\d{12}:cluster\//),
      ecsServiceArns: exact([...matching(/^arn:aws[^:]*:ecs:[^:]+:\d{12}:service\//), ...bindings.map((row: Record<string, unknown>) => row.ecsDatabaseServiceArn)]),
      loadBalancerArns: matching(/^arn:aws[^:]*:elasticloadbalancing:[^:]+:\d{12}:loadbalancer\//),
      listenerArns: matching(/^arn:aws[^:]*:elasticloadbalancing:[^:]+:\d{12}:listener\//),
      targetGroupArns: matching(/^arn:aws[^:]*:elasticloadbalancing:[^:]+:\d{12}:targetgroup\//),
      securityGroupIds: matching(/^sg-[0-9a-f]+$/),
      subnetIds: matching(/^subnet-[0-9a-f]+$/),
      routeTableIds: matching(/^rtb-[0-9a-f]+$/),
      internetGatewayIds: matching(/^igw-[0-9a-f]+$/),
      vpcIds: matching(/^vpc-[0-9a-f]+$/),
      resourceEvidence,
      capturedAt: new Date().toISOString(),
    };
  }

  private manifestStrings(value: unknown): string[] {
    if (typeof value === "string" && value.length > 0 && value.length <= 2_048) return [value];
    if (Array.isArray(value)) return value.flatMap((item) => this.manifestStrings(item));
    if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).flatMap((item) => this.manifestStrings(item));
    return [];
  }

  private async reconcile(user: User, project: Project, operation: ProjectPipelineRun) {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query("SELECT pg_advisory_lock(hashtext($1))", [`github-actions-reconcile:${operation.id}`]);
      const current = await this.runs.findOne({ where: { id: operation.id, projectId: operation.projectId } });
      const reconciled = await this.reconcileLocked(user, project, current || operation);
      Object.assign(operation, reconciled);
      return reconciled;
    } finally {
      try {
        await runner.query("SELECT pg_advisory_unlock(hashtext($1))", [`github-actions-reconcile:${operation.id}`]);
      } finally {
        await runner.release();
      }
    }
  }

  private stableReleaseReconciliationCandidate(operation: ProjectPipelineRun) {
    const metadata = (operation.metadata || {}) as Record<string, unknown>;
    const attempts = Number(metadata.stableReleaseReconciliationAttempts || 0);
    const classifiedPersistenceFailure = metadata.failureCategory === "stable_release_persistence";
    const legacyMisclassifiedPersistenceFailure = operation.currentStage === "stable_release_evidence"
      && operation.errorMessage === LEGACY_STABLE_RELEASE_FAILURE_MESSAGE
      && metadata.conclusion === "success"
      && Boolean(metadata.releaseEvidence);
    return operation.status === PipelineRunStatus.FAILED
      && metadata.deploymentAction === "deploy"
      && operation.githubWorkflowStatus === "completed"
      && attempts < MAX_STABLE_RELEASE_RECONCILIATION_ATTEMPTS
      && (classifiedPersistenceFailure || legacyMisclassifiedPersistenceFailure);
  }

  private async reconcileLocked(user: User, project: Project, operation: ProjectPipelineRun) {
    if (ACTIVE.includes(operation.status) && operation.metadata?.deploymentAction === "destroy") {
      const environmentName = canonicalEnvironmentName(project);
      if (!await this.destroyLifecycles.heartbeat(project.id, environmentName, operation.id)) {
        const lease = await this.destroyLifecycles.acquire(project.id, environmentName, operation.id);
        if (!lease) return operation;
      }
    }
    if (!ACTIVE.includes(operation.status)) {
      if (this.stableReleaseReconciliationCandidate(operation)) {
        operation.metadata = {
          ...(operation.metadata || {}),
          stableReleaseReconciliationAttempts: Number(operation.metadata?.stableReleaseReconciliationAttempts || 0) + 1,
        };
        await this.runs.save(operation);
      } else {
      if (
        operation.status === PipelineRunStatus.COMPLETED
        && operation.currentStage === "healthy"
        && operation.metadata?.deploymentAction === "deploy"
        && operation.errorMessage
      ) {
        const materialized = await this.stableReleases.findOne({
          where: { deployedByPipelineRunId: operation.id, generationId: operation.generationId },
        });
        if (materialized?.status === StableReleaseStatus.STABLE) {
          operation.errorMessage = null;
          operation.failedAt = null;
          const metadata = { ...(operation.metadata || {}) };
          delete metadata.failureCategory;
          delete metadata.failedStage;
          delete metadata.safeLog;
          delete metadata.advancedSafeLog;
          operation.metadata = metadata;
          await this.runs.save(operation);
        }
      }
      if (
        operation.status === PipelineRunStatus.COMPLETED
        && operation.metadata?.deploymentAction === "rollback"
      ) {
        await this.verifyAndReconcileRollbackStableRelease(
          operation,
          this.releaseEvidence(operation),
        );
      }
      return operation;
      }
    }
    const immutableInputs = operation.metadata?.immutableDispatchInputs as Partial<GithubActionsOperationInputs> | undefined;
    const repositoryFullName = immutableInputs?.repository_full_name || operation.repositoryFullName || project.repositoryFullName;
    const targetBranch = immutableInputs?.repository_branch || operation.targetBranch || project.targetBranch;
    const credential = await this.githubApp.tokenForRepository(user.id, repositoryFullName, project.githubInstallationId);
    if (!operation.githubWorkflowRunId) {
      const known = (await this.runs.createQueryBuilder("run").select("run.githubWorkflowRunId", "id").where("run.projectId = :projectId", { projectId: project.id }).andWhere("run.githubWorkflowRunId IS NOT NULL").getRawMany()).map((row) => String(row.id));
      operation.githubWorkflowRunId = await this.actions.findWorkflowRunAfter(repositoryFullName, targetBranch, operation.startedAt || operation.createdAt, credential.token, known);
      if (!operation.githubWorkflowRunId) {
        const ageMs = Date.now() - new Date(operation.startedAt || operation.createdAt).getTime();
        if (ageMs >= 120_000) {
          operation.status = PipelineRunStatus.FAILED;
          operation.githubWorkflowStatus = "run_not_found";
          operation.currentStage = "workflow_run_discovery";
          operation.failedAt = new Date();
          operation.errorMessage = "GitHub Actions did not expose a workflow run for the accepted dispatch.";
          operation.metadata = { ...(operation.metadata || {}), conclusion: "failure", failedStage: "workflow_run_discovery", safeLog: "No GitHub Actions run was found after the dispatch recovery window. No secret-bearing log was stored." };
          return this.runs.save(operation);
        }
        return operation;
      }
    }
    const remote = await this.actions.getWorkflowRun(repositoryFullName, operation.githubWorkflowRunId, credential.token);
    operation.githubWorkflowStatus = String(remote.status || "unknown");
    const remoteRepository = (remote.head_repository && typeof remote.head_repository === "object")
      ? String((remote.head_repository as Record<string, unknown>).full_name || "")
      : "";
    const remoteBranch = String(remote.head_branch || "");
    if ((remoteRepository && remoteRepository !== repositoryFullName) || (remoteBranch && remoteBranch !== targetBranch)) {
      operation.status = PipelineRunStatus.FAILED;
      operation.githubWorkflowStatus = "identity_mismatch";
      operation.currentStage = "immutable_operation_validation";
      operation.failedAt = new Date();
      operation.errorMessage = "GitHub Actions returned a run for a different immutable operation identity.";
      operation.metadata = { ...(operation.metadata || {}), conclusion: "failure", failedStage: "immutable_operation_validation", safeLog: "Workflow run repository, branch or commit did not match the persisted immutable operation. No credential or input value was stored." };
      return this.runs.save(operation);
    }
    operation.metadata = { ...(operation.metadata || {}), workflowUrl: remote.html_url };
    const jobs = await this.actions.getWorkflowJobs(repositoryFullName, operation.githubWorkflowRunId, credential.token);
    const currentStep = jobs.jobs?.flatMap((job) => job.steps || []).find((step) => step.status === "in_progress");
    if (currentStep?.name) operation.currentStage = this.stage(currentStep.name);
    if (remote.status === "completed") {
      const success = remote.conclusion === "success";
      const evidenceJob = jobs.jobs?.find((job) => job.id && (job.conclusion === "success" || job.conclusion === "failure"));
      let completedJobLog: string | null = null;
      if (evidenceJob?.id) {
        try { completedJobLog = await this.actions.getJobLog(repositoryFullName, evidenceJob.id, credential.token); } catch { /* operation completion remains reconcilable without log evidence */ }
      }
      let durableResultLog = "";
      try {
        const artifact = await this.actions.getResultArtifact(repositoryFullName, operation.githubWorkflowRunId, operation.id, credential.token);
        if (artifact) {
          const marker = operation.metadata?.deploymentAction === "destroy" ? "DEPLOYGUARD_DESTROY_RESULT" : "DEPLOYGUARD_RELEASE_RESULT";
          durableResultLog = `${marker}=${artifact.trim()}`;
        }
      } catch (error) {
        this.logger.warn(`Durable result artifact for operation ${operation.id} was unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      const completionEvidence = [completedJobLog || "", durableResultLog].filter(Boolean).join("\n");
      const terraformPlanSummary = extractGithubActionsTerraformPlanSummary(completedJobLog || "");
      if (terraformPlanSummary) {
        operation.metadata = { ...(operation.metadata || {}), terraformPlanSummary, terraformPlanSafety: "passed" };
      }
      let releaseEvidenceContractError: RuntimeEvidenceContractError | null = null;
      let releaseEvidence: GithubActionsReleaseEvidence | null = null;
      try {
        releaseEvidence = extractGithubActionsReleaseEvidence(completionEvidence)
          || (operation.metadata?.deploymentAction === "rollback" ? this.releaseEvidence(operation) : null);
      } catch (error) {
        releaseEvidenceContractError = error instanceof RuntimeEvidenceContractError
          ? error
          : new RuntimeEvidenceContractError([{ field: "deploymentResult", reason: "invalid" }]);
      }
      if (releaseEvidence) operation.metadata = { ...(operation.metadata || {}), releaseEvidence };
      const destroyRequested = operation.metadata?.deploymentAction === "destroy";
      const destroyEvidence = destroyRequested
        ? extractGithubActionsDestroyEvidence(completionEvidence)
        : null;
      const destroyProgress = destroyRequested
        ? extractGithubActionsDestroyProgress(completionEvidence)
        : null;
      const destroyEvidenceValid = Boolean(
        destroyEvidence && destroyEvidence.deploymentOperationId === operation.id,
      );
      if (destroyEvidenceValid) {
        operation.metadata = { ...(operation.metadata || {}), destroyVerification: destroyEvidence };
      }
      if (destroyProgress?.deploymentOperationId === operation.id) {
        operation.metadata = { ...(operation.metadata || {}), destroyProgress };
      }
      const rollbackEvidenceMissing = success
        && operation.metadata?.deploymentAction === "rollback"
        && !releaseEvidence;
      const destroyEvidenceMissing = success && destroyRequested && !destroyEvidenceValid;
      let effectiveSuccess = success && !rollbackEvidenceMissing && !destroyEvidenceMissing && !releaseEvidenceContractError;
      let runtimeEvidenceFailure: string | null = null;
      let stableReleasePersistenceFailure: string | null = null;
      let runtimeEvidenceError: RuntimeEvidenceContractError | null = releaseEvidenceContractError;
      if (
        effectiveSuccess
        && ["deploy", "rollback"].includes(
          String(operation.metadata?.deploymentAction || ""),
        )
      ) {
        try {
          if (operation.metadata?.deploymentAction === "rollback") {
            await this.verifyAndReconcileRollbackStableRelease(
              operation,
              releaseEvidence,
            );
          } else {
            await this.verifyAndPersistStableRelease(operation, releaseEvidence);
          }
        } catch (error) {
          effectiveSuccess = false;
          if (error instanceof RuntimeEvidenceContractError) {
            runtimeEvidenceError = error;
            runtimeEvidenceFailure = LEGACY_STABLE_RELEASE_FAILURE_MESSAGE;
          } else {
            stableReleasePersistenceFailure = "The workflow and runtime evidence succeeded, but DeployGuard could not persist the authoritative stable release.";
          }
        }
      }
      if (releaseEvidenceContractError) {
        runtimeEvidenceFailure = "The healthy workflow result did not satisfy the immutable runtime-configuration evidence contract.";
      }
      operation.status = effectiveSuccess ? PipelineRunStatus.COMPLETED : PipelineRunStatus.FAILED;
      operation.completedAt = effectiveSuccess ? new Date() : null;
      operation.failedAt = effectiveSuccess ? null : new Date();
      if (effectiveSuccess) {
        operation.errorMessage = null;
        const destroyed = operation.metadata?.deploymentAction === "destroy";
        operation.currentStage = destroyed ? "destroyed" : "healthy";
        const url = destroyed || !operation.generationId ? null : await this.loadBalancerUrl(project, operation.generationId);
        const previousId = operation.metadata?.previousStableOperationId;
        const previous = typeof previousId === "string"
          ? await this.runs.findOne({ where: { id: previousId, projectId: project.id } })
          : null;
        const rollbackAvailable = Boolean(previous && this.releaseInputs(previous) && this.releaseEvidence(previous));
        const successfulMetadata = { ...(operation.metadata || {}) };
        delete successfulMetadata.failureCategory;
        delete successfulMetadata.failedStage;
        delete successfulMetadata.safeLog;
        delete successfulMetadata.advancedSafeLog;
        operation.metadata = { ...successfulMetadata, conclusion: "success", rollbackAvailable, ...(destroyed ? { destroyedAt: new Date().toISOString() } : url ? { deployedUrl: url, stableDeployedUrl: url } : {}) };
        if (destroyed && !operation.generationId) throw new Error("Verified destroy has no immutable generation identity.");
      } else {
        const failedJob = jobs.jobs?.find((job) => job.conclusion === "failure");
        const failedStep = failedJob?.steps?.find((step) => step.conclusion === "failure");
        operation.currentStage = destroyProgress ? "destroy_incomplete"
          : stableReleasePersistenceFailure ? "stable_release_persistence"
          : runtimeEvidenceFailure ? "stable_release_evidence"
          : rollbackEvidenceMissing
          ? "rollback_evidence_validation"
          : destroyEvidenceMissing
            ? "destroy_absence_verification"
            : this.stage(failedStep?.name || failedJob?.name || "github_actions");
        let safeLog = "GitHub Actions did not return a failed-job log.";
        let advancedSafeLog: string | null = null;
        let platformCapabilityFailure: { action: string; classification: "platform_configuration" } | null = null;
        if (failedJob?.id) {
          try {
            const failedLog = failedJob.id === evidenceJob?.id && completedJobLog
              ? completedJobLog
              : await this.actions.getJobLog(repositoryFullName, failedJob.id, credential.token);
            operation.currentStage = githubActionsExecutionStageFromLog(failedLog) || operation.currentStage;
            platformCapabilityFailure = githubActionsPlatformCapabilityFailure(failedLog);
            safeLog = this.sanitizer.sanitize(failedLog).slice(-24_000);
            // These phrases include historical workflow revisions. This maps
            // already-produced evidence only; it never classifies persistence
            // or changes the immutable backend deployment context.
            if (/A retained database filesystem is required but was not found|Managed database data is unavailable and no retained filesystem was found|authoritative deployment context requires an established persistent filesystem|retained EFS filesystem failed ownership verification/i.test(safeLog)) {
              advancedSafeLog = safeLog;
              safeLog = "Managed database data is unavailable. Review database recovery evidence; if no usable backup exists, reset the managed database before deploying a fresh instance.";
            }
          } catch { /* retain safe fallback */ }
        }
        const failedPresentation = githubActionsStagePresentation(
          operation.currentStage,
          operation.metadata?.deploymentAction === "destroy" ? "destroy" : operation.metadata?.deploymentAction === "rollback" ? "rollback" : "deploy",
        );
        operation.errorMessage = destroyProgress ? "DESTROY_INCOMPLETE"
          : stableReleasePersistenceFailure || runtimeEvidenceFailure || (platformCapabilityFailure
          ? `DeployGuard execution role is missing the platform-required AWS permission ${platformCapabilityFailure.action}.`
          : rollbackEvidenceMissing
          ? "Rollback completed without immutable release evidence and was not promoted."
          : destroyEvidenceMissing
            ? "Terraform completed, but DeployGuard could not verify that project infrastructure is absent."
          : operation.currentStage === "configure_aws_credentials_through_oidc"
          ? "DeployGuard could not connect securely to AWS. This is a platform configuration defect; no application credential or project setting is required."
          : `GitHub Actions failed during ${failedPresentation.label}.`);
        if (runtimeEvidenceFailure) {
          safeLog = sanitizedRuntimeEvidenceFailure(runtimeEvidenceError, operation.githubWorkflowRunId, operation.commitSha);
        }
        if (stableReleasePersistenceFailure) {
          safeLog = "Stable release persistence failed after runtime evidence validation passed. No immutable runtime evidence was rejected.";
        }
        if (destroyEvidenceMissing) {
          safeLog = "Destroy completion was rejected because the bounded infrastructure-absence attestation was missing or did not match this operation.";
        }
        operation.metadata = {
          ...(operation.metadata || {}),
          conclusion: rollbackEvidenceMissing || destroyEvidenceMissing ? "failure" : String(remote.conclusion || "failure"),
          failedStage: operation.currentStage,
          ...(platformCapabilityFailure ? { failureCategory: platformCapabilityFailure.classification, failureOwner: "platform", missingAwsCapability: platformCapabilityFailure.action } : {}),
          safeLog,
          ...(stableReleasePersistenceFailure ? { failureCategory: "stable_release_persistence" } : {}),
          ...(runtimeEvidenceFailure ? { failureCategory: "runtime_evidence_contract" } : {}),
          ...(advancedSafeLog ? { advancedSafeLog } : {}),
        };
      }
    }
    const saved = await this.runs.save(operation);
    const destroyProgress = saved.metadata?.destroyProgress as NonNullable<ReturnType<typeof extractGithubActionsDestroyProgress>> | undefined;
    if (saved.status === PipelineRunStatus.FAILED && saved.metadata?.deploymentAction === "destroy" && destroyProgress) {
      const lifecycle = await this.destroyLifecycles.recordIncomplete({
        projectId: saved.projectId,
        environmentName: canonicalEnvironmentName(project),
        operationId: saved.id,
        remaining: destroyProgress.remaining,
        terraformEvidence: destroyProgress.terraform,
        verificationEvidence: { verifiedAt: destroyProgress.verifiedAt, phase: destroyProgress.phase },
      });
      saved.metadata = {
        ...(saved.metadata || {}),
        destroyStatus: lifecycle.status,
        extinctionPhase: lifecycle.phase,
        remaining: lifecycle.remaining,
        nextRetryAt: lifecycle.nextRetryAt?.toISOString() || null,
        escalation: lifecycle.escalation,
      };
      return this.runs.save(saved);
    }
    if (saved.status === PipelineRunStatus.COMPLETED && saved.metadata?.deploymentAction === "destroy") {
      try {
        const environmentName = canonicalEnvironmentName(project);
        await this.destroyLifecycles.recordAwsVerified(project.id, environmentName, saved.id, saved.metadata?.destroyVerification as Record<string, unknown>);
        await this.extinction.extinguish(project, saved, credential.token, async (phase) => {
          await this.destroyLifecycles.phase(project.id, environmentName, saved.id, phase);
        });
        saved.metadata = { ...(saved.metadata || {}), projectExtinction: "verified_extinct" };
        return saved;
      } catch (error) {
        const environmentName = canonicalEnvironmentName(project);
        const lifecycle = await this.destroyLifecycles.active(project.id, environmentName);
        saved.status = PipelineRunStatus.FAILED;
        saved.completedAt = null;
        saved.failedAt = new Date();
        saved.currentStage = "project_extinction";
        saved.errorMessage = "DESTROY_INCOMPLETE";
        saved.metadata = {
          ...(saved.metadata || {}),
          conclusion: "failure",
          failedStage: "project_extinction",
          failureCategory: "project_extinction_incomplete",
          safeLog: error instanceof ProjectExtinctionIncompleteError ? error.message : "DESTROY_INCOMPLETE: final project extinction could not be verified.",
        };
        if (lifecycle) {
          const message = error instanceof Error ? error.message : "Final project extinction could not be verified.";
          const incomplete = await this.destroyLifecycles.recordIncomplete({
            projectId: project.id,
            environmentName,
            operationId: saved.id,
            phase: lifecycle.phase,
            remaining: [{
              resourceType: "control_plane_extinction",
              resourceId: `${project.id}:${lifecycle.phase}`,
              ownershipScope: "project",
              reason: "AWS absence is verified, but control-plane extinction is incomplete.",
              errorCode: error instanceof ProjectExtinctionIncompleteError ? error.code : "CONTROL_PLANE_EXTINCTION_FAILED",
              errorMessage: message,
              retryable: true,
              attemptCount: lifecycle.retryCount + 1,
              firstSeenAt: lifecycle.firstStartedAt.toISOString(),
              lastSeenAt: new Date().toISOString(),
            }],
          });
          saved.metadata = {
            ...saved.metadata,
            destroyStatus: incomplete.status,
            extinctionPhase: incomplete.phase,
            remaining: incomplete.remaining,
            nextRetryAt: incomplete.nextRetryAt?.toISOString() || null,
            escalation: incomplete.escalation,
          };
        }
        return this.runs.save(saved);
      }
    }
    if (saved.status === PipelineRunStatus.COMPLETED) {
      await this.costEvidence.capture(saved, repositoryFullName, credential.token, canonicalEnvironmentName(project));
      if (saved.generationId) await this.retention.apply(saved.projectId, saved.generationId);
    }
    const deploymentAction = String(saved.metadata?.deploymentAction || "deploy");
    await this.notifications.dispatch({
      projectId: saved.projectId,
      pipelineRunId: saved.id,
      eventId: `${saved.id}:${saved.status}:${saved.currentStage}`,
      stage: `${deploymentAction}_${saved.currentStage || saved.status}`,
      status: saved.status,
      message: saved.status === PipelineRunStatus.COMPLETED
        ? `${deploymentAction} completed successfully.`
        : saved.errorMessage || `${deploymentAction} failed.`,
    }).catch((error) => this.logger.warn(`Notification dispatch failed for ${saved.id}: ${error instanceof Error ? error.message : "unknown error"}`));
    return saved;
  }

  private async withProjectLock<T>(projectId: string, work: (runs: Repository<ProjectPipelineRun>) => Promise<T>) {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query("SELECT pg_advisory_lock(hashtext($1))", [`github-actions:${projectId}`]);
      return await work(runner.manager.getRepository(ProjectPipelineRun));
    } finally {
      try { await runner.query("SELECT pg_advisory_unlock(hashtext($1))", [`github-actions:${projectId}`]); } finally { await runner.release(); }
    }
  }

  private async assertNoDestroyLifecycle(project: Project, runRepository: Repository<ProjectPipelineRun>) {
    const lifecycle = await this.destroyLifecycles.active(project.id, canonicalEnvironmentName(project), runRepository.manager);
    if (lifecycle) {
      throw new BadRequestException({
        code: "destroy_in_progress",
        message: "Project extinction is unresolved. Deploy, redeploy and rollback remain frozen until Destroy reaches verified extinction.",
        destroyOperationId: lifecycle.operationId,
        generationId: lifecycle.generationId,
        status: lifecycle.status,
        phase: lifecycle.phase,
        remaining: lifecycle.remaining,
      });
    }
  }

  private latestRun(projectId: string, repository: Repository<ProjectPipelineRun>, statuses?: PipelineRunStatus[]) {
    const query = repository.createQueryBuilder("run").where("run.projectId = :projectId", { projectId }).andWhere("run.metadata ->> 'executionEngine' = 'github_actions'");
    if (statuses?.length) query.andWhere("run.status IN (:...statuses)", { statuses });
    return query.orderBy("run.createdAt", "DESC").getOne();
  }

  private async currentLiveRun(projectId: string, repository: Repository<ProjectPipelineRun>, generationId: string) {
    const latest = await repository.createQueryBuilder("run")
      .where("run.projectId = :projectId", { projectId })
      .andWhere("run.generationId = :generationId", { generationId })
      .andWhere("run.metadata ->> 'executionEngine' = 'github_actions'")
      .andWhere("run.status = :completed", { completed: PipelineRunStatus.COMPLETED })
      .andWhere("run.currentStage = 'healthy'")
      .andWhere("run.metadata ->> 'deploymentAction' IN (:...releaseActions)", { releaseActions: ["deploy", "rollback"] })
      .andWhere("NULLIF(run.metadata ->> 'deployedUrl', '') IS NOT NULL")
      .orderBy("run.completedAt", "DESC")
      .addOrderBy("run.createdAt", "DESC")
      .getOne();
    const metadata = (latest?.metadata || {}) as Record<string, unknown>;
    return latest
      && typeof metadata.deployedUrl === "string"
      && metadata.deployedUrl.length > 0
      ? latest
      : null;
  }

  private isVerifiedDestroyed(operation: ProjectPipelineRun | null) {
    const metadata = (operation?.metadata || {}) as Record<string, unknown>;
    const verification = metadata.destroyVerification as Record<string, unknown> | undefined;
    return Boolean(
      operation
      && operation.status === PipelineRunStatus.COMPLETED
      && metadata.deploymentAction === "destroy"
      && verification?.status === "verified_destroyed"
      && verification.deploymentOperationId === operation.id
      && verification.projectOwnedAwsResourcesAbsent === true
      && verification.allProjectTerraformArtifactsAbsent === true,
    );
  }

  private async rollbackTarget(projectId: string, current: ProjectPipelineRun, repository: Repository<ProjectPipelineRun>) {
    const targetId = current.metadata?.previousStableOperationId;
    if (typeof targetId !== "string" || !targetId || targetId === current.id) return null;
    const target = await repository.findOne({ where: { id: targetId, projectId } });
    const metadata = (target?.metadata || {}) as Record<string, unknown>;
    if (
      !target
      || target.status !== PipelineRunStatus.COMPLETED
      || target.generationId !== current.generationId
      || target.currentStage !== "healthy"
      || !["deploy", "rollback"].includes(String(metadata.deploymentAction || ""))
      || typeof metadata.deployedUrl !== "string"
      || !target.completedAt
      || !current.completedAt
      || target.completedAt.getTime() >= current.completedAt.getTime()
    ) return null;
    return target;
  }

  private releaseInputs(operation: ProjectPipelineRun) {
    try {
      const inputs = requireRetryInputs(operation.metadata, {
        operationId: operation.id,
        projectId: operation.projectId,
        repositoryFullName: operation.repositoryFullName,
        targetBranch: operation.targetBranch,
        commitSha: operation.commitSha,
      });
      return inputs;
    } catch {
      return null;
    }
  }

  private releaseEvidence(operation: ProjectPipelineRun): GithubActionsReleaseEvidence | null {
    const candidate = operation.metadata?.releaseEvidence;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const evidence = extractGithubActionsReleaseEvidence(`DEPLOYGUARD_RELEASE_RESULT=${JSON.stringify(candidate)}`);
    const inputs = this.releaseInputs(operation);
    if (!evidence || !inputs) return null;
    try {
      const references = JSON.parse(Buffer.from(inputs.environment_references_base64, "base64").toString("utf8")) as Record<string, unknown>;
      return references.configurationFingerprint === evidence.configurationFingerprint ? evidence : null;
    } catch {
      return null;
    }
  }

  private async reconcileActive(user: User, project: Project, repository: Repository<ProjectPipelineRun>) {
    const active = await repository.createQueryBuilder("run").where("run.projectId = :projectId", { projectId: project.id }).andWhere("run.metadata ->> 'executionEngine' = 'github_actions'").andWhere("run.status IN (:...statuses)", { statuses: ACTIVE }).orderBy("run.createdAt", "DESC").getMany();
    for (const operation of active) {
      await this.reconcile(user, project, operation);
      if (ACTIVE.includes(operation.status)) return operation;
    }
    return null;
  }

  private async stableUrl(projectId: string, generationId: string | null, excludingId?: string) {
    const query = this.runs.createQueryBuilder("run").where("run.projectId = :projectId", { projectId }).andWhere("run.generationId = :generationId", { generationId }).andWhere("run.status = :status", { status: PipelineRunStatus.COMPLETED }).andWhere("run.metadata ->> 'executionEngine' = 'github_actions'").andWhere("run.metadata ->> 'deployedUrl' IS NOT NULL");
    if (excludingId) query.andWhere("run.id != :excludingId", { excludingId });
    const stable = await query.orderBy("run.completedAt", "DESC").getOne();
    return typeof stable?.metadata?.deployedUrl === "string" ? stable.metadata.deployedUrl : null;
  }

  private async verifyAndPersistStableRelease(operation: ProjectPipelineRun, evidence: GithubActionsReleaseEvidence | null) {
    const inputs = this.releaseInputs(operation);
    if (!inputs) throw new RuntimeEvidenceContractError([{ field: "immutableReleaseInputs", reason: "missing" }]);
    const runtime = decodeEnvironmentReferencesBase64(inputs.environment_references_base64);
    const issues = validateGithubActionsRuntimeEvidence(evidence, {
      deploymentOperationId: operation.id,
      commitSha: operation.commitSha,
      environmentName: inputs.environment_name,
      configurationSnapshotId: operation.configurationSnapshotId ?? null,
      configurationFingerprint: runtime.configurationFingerprint,
      databaseBindingId: operation.databaseServiceBindingId ?? null,
      runtimeDatabaseBindingId: runtime.managedDatabase?.bindingId ?? null,
      secretReferenceNames: Object.keys(runtime.secretReferences),
    });
    if (runtime.environmentName !== inputs.environment_name) issues.push({ field: "runtime.environmentName", reason: "mismatched" });
    if (runtime.configurationSnapshotId !== (operation.configurationSnapshotId ?? null)) issues.push({ field: "runtime.configurationSnapshotId", reason: "mismatched" });
    if (issues.length) throw new RuntimeEvidenceContractError(issues);
    if (!evidence) throw new RuntimeEvidenceContractError([{ field: "deploymentResult", reason: "missing" }]);
    if (runtime.managedDatabase) {
      if (!evidence.databaseOutputs) throw new RuntimeEvidenceContractError([{ field: "databaseOutputs", reason: "missing" }]);
      await this.databaseBindings.applyTerraformOutputs(operation.projectId, operation.id, evidence.databaseOutputs, evidence.taskDefinitionArn);
      await this.databaseBindings.verifyManagedDatabaseReady(operation.projectId, operation.id);
    }
    try {
      await this.databaseBindings.validateApplicationTaskDefinition(operation.projectId, operation.id, evidence.taskDefinitionArn, {
        imageUri: evidence.imageUri,
        appPort: evidence.appPort,
        environmentName: evidence.environmentName,
      });
    } catch (error) {
      if (error instanceof RuntimeEvidenceContractError) throw error;
      throw new RuntimeEvidenceContractError([{ field: "taskDefinition", reason: "invalid" }]);
    }
    if (runtime.managedDatabase) await this.databaseBindings.markVerified(operation.projectId, operation.id);
    try {
      await this.dataSource.transaction(async (manager) => {
        return materializeStableRelease(manager, {
          operationId: operation.id,
          projectId: operation.projectId,
          generationId: operation.generationId,
          environmentName: runtime.environmentName,
          commitSha: operation.commitSha,
          imageUri: evidence.imageUri,
          taskDefinitionArn: evidence.taskDefinitionArn,
          healthCheckPath: evidence.healthCheckPath,
          appPort: evidence.appPort,
          metadata: {
            operationId: operation.id,
          imageDigest: evidence.imageDigest,
          configurationSnapshotId: runtime.configurationSnapshotId,
          configurationFingerprint: runtime.configurationFingerprint,
          deploymentContext: runtime.deploymentContext,
          secretReferences: Object.entries(runtime.secretReferences).map(([name, valueFrom]) => ({ name, valueFrom })),
          managedDatabaseBinding: runtime.managedDatabase ? {
            id: runtime.managedDatabase.bindingId,
            fingerprint: runtime.managedDatabase.bindingFingerprint,
            provider: runtime.managedDatabase.provider,
            engine: runtime.managedDatabase.engine,
          } : null,
          port: evidence.appPort,
            healthPath: evidence.healthCheckPath,
          },
        });
      });
    } catch (error) {
      if (error instanceof RuntimeEvidenceContractError) throw error;
      throw new StableReleasePersistenceError(error);
    }
  }

  private async verifyAndReconcileRollbackStableRelease(
    operation: ProjectPipelineRun,
    evidence: GithubActionsReleaseEvidence | null,
  ) {
    const sourceOperationId = operation.metadata?.rollbackSourceOperationId;
    const previousStableOperationId = operation.metadata?.previousStableOperationId;
    if (
      operation.metadata?.deploymentAction !== "rollback"
      || typeof sourceOperationId !== "string"
      || typeof previousStableOperationId !== "string"
      || sourceOperationId === previousStableOperationId
      || !evidence
      || evidence.deploymentOperationId !== operation.id
    ) {
      throw new Error("Rollback release identity mismatch.");
    }

    const [sourceOperation, previousStableOperation] = await Promise.all([
      this.runs.findOne({
        where: { id: sourceOperationId, projectId: operation.projectId },
      }),
      this.runs.findOne({
        where: {
          id: previousStableOperationId,
          projectId: operation.projectId,
        },
      }),
    ]);
    if (
      !sourceOperation
      || !previousStableOperation
      || sourceOperation.generationId !== operation.generationId
      || previousStableOperation.generationId !== operation.generationId
      || sourceOperation.status !== PipelineRunStatus.COMPLETED
      || sourceOperation.currentStage !== "healthy"
      || previousStableOperation.status !== PipelineRunStatus.COMPLETED
      || previousStableOperation.currentStage !== "healthy"
    ) {
      throw new Error("Rollback release history mismatch.");
    }

    const sourceInputs = this.releaseInputs(sourceOperation);
    const rollbackInputs = this.releaseInputs(operation);
    const sourceEvidence = this.releaseEvidence(sourceOperation);
    if (!sourceInputs || !rollbackInputs || !sourceEvidence) {
      throw new Error("Rollback immutable release evidence is unavailable.");
    }
    const sourceRuntime = decodeEnvironmentReferencesBase64(
      sourceInputs.environment_references_base64,
    );
    const rollbackRuntime = decodeEnvironmentReferencesBase64(
      rollbackInputs.environment_references_base64,
    );
    const sameRuntime = JSON.stringify(sourceRuntime) === JSON.stringify(rollbackRuntime);
    const sourceSecretNames = Object.keys(sourceRuntime.secretReferences).sort();
    if (
      rollbackInputs.deployment_action !== "rollback"
      || rollbackInputs.deployment_operation_id !== operation.id
      || rollbackInputs.rollback_source_operation_id !== sourceOperationId
      || rollbackInputs.rollback_image_uri !== sourceEvidence.imageUri
      || rollbackInputs.rollback_task_definition_arn !== sourceEvidence.taskDefinitionArn
      || operation.commitSha !== sourceOperation.commitSha
      || !sameRuntime
      || sourceEvidence.deploymentOperationId !== sourceOperationId
      || sourceEvidence.commitSha !== sourceOperation.commitSha
      || sourceEvidence.configurationSnapshotId !== sourceRuntime.configurationSnapshotId
      || sourceEvidence.databaseBindingId !== (sourceRuntime.managedDatabase?.bindingId || null)
      || JSON.stringify(sourceEvidence.secretReferenceNames) !== JSON.stringify(sourceSecretNames)
      || evidence.commitSha !== sourceEvidence.commitSha
      || evidence.imageUri !== sourceEvidence.imageUri
      || evidence.imageDigest !== sourceEvidence.imageDigest
      || evidence.taskDefinitionArn !== sourceEvidence.taskDefinitionArn
      || evidence.appPort !== sourceEvidence.appPort
      || evidence.healthCheckPath !== sourceEvidence.healthCheckPath
      || evidence.configurationFingerprint !== sourceRuntime.configurationFingerprint
      || (evidence.configurationSnapshotId !== null
        && evidence.configurationSnapshotId !== sourceRuntime.configurationSnapshotId)
      || (evidence.databaseBindingId !== null
        && evidence.databaseBindingId !== (sourceRuntime.managedDatabase?.bindingId || null))
      || (evidence.secretReferenceNames.length > 0
        && JSON.stringify(evidence.secretReferenceNames) !== JSON.stringify(sourceSecretNames))
    ) {
      throw new Error("Rollback runtime release evidence mismatch.");
    }

    await this.deploymentGenerations.requireActiveGeneration(
      operation.generationId,
      operation.projectId,
      sourceRuntime.environmentName,
    );

    return this.dataSource.transaction(async (manager) => {
      const releases = manager.getRepository(ProjectStableRelease);
      // TypeORM transactions share a single pg client, so these reads must not
      // overlap under pg 8.16+.
      const target = await releases.findOne({
          where: {
            projectId: operation.projectId,
            generationId: operation.generationId,
            environmentName: sourceRuntime.environmentName,
            deployedByPipelineRunId: sourceOperationId,
          },
        });
      const previous = await releases.findOne({
          where: {
            projectId: operation.projectId,
            generationId: operation.generationId,
            environmentName: sourceRuntime.environmentName,
            deployedByPipelineRunId: previousStableOperationId,
          },
        });
      const stable = await releases.find({
          where: {
            projectId: operation.projectId,
            generationId: operation.generationId,
            environmentName: sourceRuntime.environmentName,
            status: StableReleaseStatus.STABLE,
          },
        });
      if (!target || !previous || target.id === previous.id) {
        throw new Error("Rollback canonical release target mismatch.");
      }

      const targetMetadata = (target.metadata || {}) as Record<string, unknown>;
      const storedSecretReferences = Array.isArray(targetMetadata.secretReferences)
        ? targetMetadata.secretReferences
            .map((item) => {
              const reference = item as Record<string, unknown>;
              return {
                name: String(reference.name || ""),
                valueFrom: String(reference.valueFrom || ""),
              };
            })
            .sort((left, right) => left.name.localeCompare(right.name))
        : [];
      const expectedSecretReferences = Object.entries(sourceRuntime.secretReferences)
        .map(([name, valueFrom]) => ({ name, valueFrom }))
        .sort((left, right) => left.name.localeCompare(right.name));
      const storedDatabaseBinding = targetMetadata.managedDatabaseBinding && typeof targetMetadata.managedDatabaseBinding === "object"
        ? targetMetadata.managedDatabaseBinding as Record<string, unknown>
        : null;
      const expectedDatabaseBinding = sourceRuntime.managedDatabase
        ? {
            id: sourceRuntime.managedDatabase.bindingId,
            fingerprint: sourceRuntime.managedDatabase.bindingFingerprint,
            provider: sourceRuntime.managedDatabase.provider,
            engine: sourceRuntime.managedDatabase.engine,
          }
        : null;
      if (
        target.commitSha !== sourceEvidence.commitSha
        || target.imageUri !== sourceEvidence.imageUri
        || target.taskDefinitionArn !== sourceEvidence.taskDefinitionArn
        || target.appPort !== sourceEvidence.appPort
        || target.healthCheckPath !== sourceEvidence.healthCheckPath
        || targetMetadata.operationId !== sourceOperationId
        || targetMetadata.imageDigest !== sourceEvidence.imageDigest
        || targetMetadata.configurationSnapshotId !== sourceRuntime.configurationSnapshotId
        || targetMetadata.configurationFingerprint !== sourceRuntime.configurationFingerprint
        || JSON.stringify(storedSecretReferences) !== JSON.stringify(expectedSecretReferences)
        || JSON.stringify(Object.keys(storedDatabaseBinding || {}).sort())
          !== JSON.stringify(Object.keys(expectedDatabaseBinding || {}).sort())
        || Object.entries(expectedDatabaseBinding || {}).some(
          ([key, value]) => storedDatabaseBinding?.[key] !== value,
        )
      ) {
        throw new Error("Rollback canonical release evidence mismatch.");
      }

      if (target.status === StableReleaseStatus.STABLE) {
        if (
          stable.length !== 1
          || stable[0].id !== target.id
          || previous.status !== StableReleaseStatus.ROLLBACK_TARGET
        ) {
          throw new Error("Rollback canonical release state mismatch.");
        }
        return target;
      }
      if (
        target.status !== StableReleaseStatus.ROLLBACK_TARGET
        || previous.status !== StableReleaseStatus.STABLE
        || stable.length !== 1
        || stable[0].id !== previous.id
      ) {
        throw new Error("Rollback canonical release state mismatch.");
      }

      previous.status = StableReleaseStatus.ROLLBACK_TARGET;
      await releases.save(previous);
      target.status = StableReleaseStatus.STABLE;
      return releases.save(target);
    });
  }

  private async workflowStages(project: Project, run: ProjectPipelineRun, token: string | null) {
    if (!run.githubWorkflowRunId || !token) return [];
    try {
      const response = await this.actions.getWorkflowJobs(project.repositoryFullName, run.githubWorkflowRunId, token);
      return (response.jobs || []).flatMap((job) => (job.steps || []).flatMap((step) => {
        const presentation = githubActionsWorkflowStepPresentation(
          step.name,
          run.metadata?.deploymentAction === "destroy" ? "destroy" : run.metadata?.deploymentAction === "rollback" ? "rollback" : "deploy",
        );
        if (!presentation) return [];
        const startedAt = typeof step.started_at === "string" ? step.started_at : null;
        const completedAt = typeof step.completed_at === "string" ? step.completed_at : null;
        const durationMs = startedAt && completedAt
          ? Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime())
          : null;
        const conclusion = String(step.conclusion || "").toLowerCase();
        const status = conclusion === "success" ? "passed"
          : conclusion === "failure" ? "failed"
          : conclusion === "skipped" ? "skipped"
          : String(step.status || "pending").toLowerCase() === "in_progress" ? "running"
          : "pending";
        return [{
          ...presentation,
          status,
          startedAt,
          completedAt,
          durationMs,
          evidenceSource: "github_actions",
          jobUrl: typeof job.html_url === "string" ? job.html_url : null,
          failureReason: status === "failed" ? "GitHub Actions reports this workflow stage failed." : null,
        }];
      }));
    } catch {
      // History remains useful even when GitHub no longer exposes job detail.
      return [];
    }
  }

  private async loadBalancerUrl(project: Project, generationId: string) {
    const projectId = project.id;
    const environment = canonicalEnvironmentName(project);
    const name = `dg-${projectId.toLowerCase().replaceAll("_", "-").slice(0, 25)}`;
    const client = new ElasticLoadBalancingV2Client({ region: this.config.get("AWS_REGION", "us-east-1") });
    const response = await client.send(new DescribeLoadBalancersCommand({ Names: [name] }));
    const loadBalancer = response.LoadBalancers?.[0];
    if (!loadBalancer?.LoadBalancerArn || !loadBalancer.DNSName) return null;
    const tagResponse = await client.send(new DescribeTagsCommand({ ResourceArns: [loadBalancer.LoadBalancerArn] }));
    const tags = Object.fromEntries((tagResponse.TagDescriptions?.[0]?.Tags || []).map((tag) => [tag.Key || "", tag.Value || ""]));
    return tags.ManagedBy === "DeployGuard"
      && tags.DeployGuardProjectId === projectId
      && tags.Environment === environment
      && tags.DeployGuardGenerationId === generationId
      ? `http://${loadBalancer.DNSName}`
      : null;
  }

  private stage(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || "github_actions"; }
  private async project(user: User, id: string) { const project = await this.projects.findOne({ where: { id } }); if (!project) throw new NotFoundException("Project not found."); if (project.ownerUserId !== user.id) throw new ForbiddenException("Project operations are restricted to the project owner."); return project; }
  private result(state: "accepted" | "no_op" | "rejected", message: string, run: ProjectPipelineRun) { return { deployment: { state, message, operation: this.response(run, typeof run.metadata?.stableDeployedUrl === "string" ? run.metadata.stableDeployedUrl : null) } }; }
  private response(run: ProjectPipelineRun, stableUrl: string | null = null) { const verification = run.metadata?.destroyVerification as Record<string, unknown> | undefined; const destroyed = run.metadata?.deploymentAction === "destroy" && run.status === PipelineRunStatus.COMPLETED && verification?.status === "verified_destroyed" && verification?.deploymentOperationId === run.id && verification?.projectOwnedAwsResourcesAbsent === true && verification?.allProjectTerraformArtifactsAbsent === true; const deploymentAction = run.metadata?.deploymentAction === "destroy" ? "destroy" : run.metadata?.deploymentAction === "rollback" ? "rollback" : "deploy"; const verificationPending = deploymentAction === "destroy" && run.status === PipelineRunStatus.COMPLETED && run.currentStage === "destroyed" && !destroyed; const reconciliation = run.metadata?.legacyDestroyReconciliation as Record<string, unknown> | undefined; const stage = verificationPending ? { key: "destroy_verification_pending", label: "Destroy verification pending" } : githubActionsStagePresentation(run.currentStage, deploymentAction); const failedStage = typeof run.metadata?.failedStage === "string" ? githubActionsStagePresentation(run.metadata.failedStage, deploymentAction) : null; const oidcFailure = failedStage?.key === "configure_aws_credentials_through_oidc"; const platformFailure = oidcFailure || run.metadata?.failureOwner === "platform" || run.metadata?.failureCategory === "platform_configuration"; return { id: run.id, generationId: run.generationId, status: run.status, phase: verificationPending ? "destroy_verification_pending" : run.status === PipelineRunStatus.QUEUED ? "queued" : run.currentStage, stage: stage.key, stageLabel: stage.label, deploymentAction, destroyVerificationStatus: destroyed ? "verified_destroyed" : verificationPending ? "pending" : null, destroyVerificationUnresolved: verificationPending && Array.isArray(reconciliation?.unresolvedComponents) ? reconciliation.unresolvedComponents : [], deploymentMode: typeof run.metadata?.deploymentMode === "string" ? run.metadata.deploymentMode : null, deploymentContext: run.metadata?.deploymentContext || null, workflowRunId: run.githubWorkflowRunId, workflowStatus: run.githubWorkflowStatus, deployedUrl: destroyed ? null : (typeof run.metadata?.deployedUrl === "string" ? run.metadata.deployedUrl : stableUrl) || null, workflowUrl: typeof run.metadata?.workflowUrl === "string" ? run.metadata.workflowUrl : null, commitSha: run.commitSha, attempt: Number(run.metadata?.attempt || 1), retryOfOperationId: typeof run.metadata?.retryOfOperationId === "string" ? run.metadata.retryOfOperationId : null, rollbackSourceOperationId: typeof run.metadata?.rollbackSourceOperationId === "string" ? run.metadata.rollbackSourceOperationId : null, conclusion: typeof run.metadata?.conclusion === "string" ? run.metadata.conclusion : null, failedStage: failedStage?.key || null, failedStageLabel: failedStage?.label || null, failureOwner: platformFailure ? "platform" : null, safeLog: typeof run.metadata?.safeLog === "string" ? run.metadata.safeLog : null, advancedSafeLog: typeof run.metadata?.advancedSafeLog === "string" ? run.metadata.advancedSafeLog : null, errorMessage: oidcFailure ? "DeployGuard could not connect securely to AWS. This is a platform configuration defect; no application credential or project setting is required." : run.errorMessage || null, requestedAt: run.createdAt, createdAt: run.createdAt, completedAt: run.completedAt, failedAt: run.failedAt }; }
}
