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
import { githubActionsExecutionStageFromLog, githubActionsFailureMessage, githubActionsPlatformCapabilityFailure, githubActionsStagePresentation, githubActionsWorkflowStepPresentation } from "./pipeline/github-actions-stage-presentation";
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
  retryOperationEligibility,
  runtimeConfigurationWithPromotionCandidate,
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
import { extractGithubActionsDestroyEvidence } from "./github-actions-destroy-evidence";
import { DatabaseServiceBindingService, EffectiveDeploymentConfiguration } from "../infrastructure/database-service-binding.service";
import { GithubActionsRuntimeSecretService, RuntimeSecretMaterialization } from "./github-actions-runtime-secret.service";
import { ProjectConfigurationSnapshot } from "./project-configuration-snapshot.entity";
import { ProjectStableRelease, StableReleaseStatus } from "../orchestration/project-stable-release.entity";
import { ProjectServiceBinding } from "./project-service-binding.entity";
import { GithubActionsRuntimeConfiguration } from "./github-actions-operation-contract";
import { canonicalEnvironmentName } from "./canonical-environment";
import { BuildPlan, buildPlanComponents, requireBuildPlan } from "./build-plan";
import { evaluateBuildPlanReadiness } from "./build-plan-readiness";
import { refreshDeploymentAnalysisIfStale } from "./deployment-analysis-refresh";
import { ManagedDatabaseReconciliationService } from "./managed-database-reconciliation.service";
import { DeploymentRecoveryDecision } from "./deployment-recovery-decision";
import { DeploymentRecoveryDecisionService } from "./deployment-recovery-decision.service";
import { ManagedDatabaseResetService } from "./managed-database-reset.service";
import { DeploymentGenerationService } from "./deployment-generation.service";
import { materializeStableRelease } from "./stable-release-projection";
import { NotificationDispatcherService } from "../notifications/notification-dispatcher.service";
import { GithubActionsCostEvidenceService } from "./github-actions-cost-evidence.service";
import { GenerationRetentionService } from "./generation-retention.service";
import { ProjectDeletionIncompleteError, ProjectDeletionService } from "./project-deletion.service";
import { ProjectDeploymentGeneration } from "./project-deployment-generation.entity";
import { ProjectEnvironmentRoute } from "./project-environment-route.entity";
import {
  extractGithubActionsCandidateEvidence,
  extractGithubActionsCompensationEvidence,
  GithubActionsCandidateEvidence,
  PromotionIntent,
  promotionIntentFingerprint,
  relationshipVerificationMatchesBuildPlan,
} from "./github-actions-promotion-evidence";
import { managedDatabaseProfile } from "./managed-database-engine";
import { serviceAlias } from "./configuration-ownership";
import { SharedPlatformFoundationService } from "./shared-platform-foundation.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ProductStartSchemaIntegrityService } from "./product-start-schema-integrity.service";

const ACTIVE = [PipelineRunStatus.QUEUED, PipelineRunStatus.RUNNING];
const MAX_STABLE_RELEASE_RECONCILIATION_ATTEMPTS = 3;
const RUNTIME_CONFIGURATION_EVIDENCE_FAILURE_MESSAGE = "The healthy workflow result did not satisfy the immutable runtime-configuration evidence contract.";

function generationCleanupEvidence(log: string) {
  const line = log.split(/\r?\n/).filter((value) => value.includes("DEPLOYGUARD_GENERATION_CLEANUP_RESULT=")).pop();
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(line.indexOf("DEPLOYGUARD_GENERATION_CLEANUP_RESULT=") + "DEPLOYGUARD_GENERATION_CLEANUP_RESULT=".length)) as Record<string, unknown>;
    return typeof value.generationId === "string" && ["cleaned", "cleanup_pending"].includes(String(value.status))
      ? { generationId: value.generationId, status: String(value.status), error: typeof value.error === "string" ? value.error : null }
      : null;
  } catch { return null; }
}

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
    private readonly notifications: NotificationDispatcherService,
    private readonly costEvidence: GithubActionsCostEvidenceService,
    private readonly retention: GenerationRetentionService,
    private readonly projectDeletion: ProjectDeletionService,
    private readonly sharedPlatformFoundation: SharedPlatformFoundationService,
    @InjectRepository(ProjectConfigurationSnapshot) private readonly configurationSnapshots: Repository<ProjectConfigurationSnapshot>,
    @InjectRepository(ProjectStableRelease) private readonly stableReleases: Repository<ProjectStableRelease>,
    private readonly auditLogs: AuditLogService,
    private readonly schemaIntegrity: ProductStartSchemaIntegrityService,
  ) {}

  async onModuleInit() {
    await this.schemaIntegrity.assertReady();
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
      await this.retryPendingGenerationCleanup();
      return { skipped: false, reconciled };
    } finally {
      this.reconciliationSweepRunning = false;
    }
  }

  async deploy(user: User, projectId: string) {
    const project = await this.project(user, projectId);
    const foundation = this.platformFoundation();
    await this.sharedPlatformFoundation.assertActive(foundation);
    return this.withProjectLock(projectId, async (runRepository) => {
      const active = await this.reconcileActive(user, project, runRepository);
      if (active) return this.result("no_op", "This deployment is already progressing.", active);
      const environmentName = canonicalEnvironmentName(project);
      const previousLive = await this.deploymentGenerations.live(projectId, environmentName, runRepository.manager);
      const previousStable = previousLive ? await this.currentLiveRun(projectId, runRepository, previousLive.id) : null;
      const generation = await this.deploymentGenerations.createCandidate(projectId, environmentName, runRepository.manager);
      try {
        return await this.dispatch(user, projectId, runRepository, "deploy", previousStable?.id || null, { generationId: generation.id });
      } catch (error) {
        await this.failCandidateBeforeDispatch(user, project, runRepository, generation.id, error, { requestedMode: "DEPLOY" });
        throw error;
      }
    });
  }

  async retry(user: User, projectId: string) {
    const project = await this.project(user, projectId);
    return this.withProjectLock(projectId, async (runRepository) => {
      const active = await this.reconcileActive(user, project, runRepository);
      if (active) return this.result("no_op", "This deployment is already progressing.", active);
      const failed = await this.latestRun(projectId, runRepository);
      if (!failed || failed.status !== PipelineRunStatus.FAILED) throw new BadRequestException("Only the latest failed GitHub Actions deployment can be retried.");
      const action = String(failed.metadata?.deploymentAction || "deploy");
      if (action === "destroy") {
        const verifiedAncestor = await this.verifiedDestroyAncestor(failed, project, runRepository);
        if (verifiedAncestor) {
          try {
            await this.projectDeletion.finalize(project, verifiedAncestor);
            // The project was deleted transactionally. Do not create a new
            // attempt or dispatch GitHub Actions merely to repeat proven AWS
            // absence; callers will refresh to the project's 404 state.
            return this.result("no_op", "Verified AWS deletion was already complete; DeployGuard control-plane cleanup is now complete.", verifiedAncestor);
          } catch (error) {
            return this.result(
              "rejected",
              error instanceof Error ? error.message : "Project deletion control-plane cleanup remains incomplete.",
              failed,
            );
          }
        }
      }
      if (action !== "destroy") await this.sharedPlatformFoundation.assertActive(this.platformFoundation());
      const generation = action === "destroy"
        ? await this.deploymentGenerations.requireActiveGeneration(failed.generationId, project.id, canonicalEnvironmentName(project), runRepository.manager)
        : await this.deploymentGenerations.requireRetryableGeneration(failed.generationId, project.id, canonicalEnvironmentName(project), runRepository.manager);
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
        const live = await this.deploymentGenerations.live(projectId, canonicalEnvironmentName(project), runRepository.manager);
        const previousStable = live ? await this.currentLiveRun(projectId, runRepository, live.id) : null;
        try {
          return await this.dispatch(user, projectId, runRepository, "deploy", previousStable?.id || null, {
            requestedMode: "RETRY",
            retryOfOperationId: failed.id,
            expectedRetryInputs: retryInputs,
            retryDetectionProfileId: failed.detectionProfileId,
            generationId: generation.id,
          });
        } catch (error) {
          const persisted = await runRepository.createQueryBuilder("run")
            .where("run.projectId = :projectId", { projectId })
            .andWhere("run.metadata ->> 'retryOfOperationId' = :sourceId", { sourceId: failed.id })
            .orderBy("run.createdAt", "DESC")
            .getOne();
          if (persisted) {
            await this.failCandidateBeforeDispatch(user, project, runRepository, generation.id, error, {
              requestedMode: "RETRY",
              retryOfOperationId: failed.id,
              source: failed,
            });
            return this.result("rejected", persisted.errorMessage || "Retry failed before GitHub Actions dispatch.", persisted);
          }
          const rejected = await this.persistRejectedRetry(user, project, runRepository, failed, retryInputs, error);
          await this.failCandidateBeforeDispatch(user, project, runRepository, generation.id, error, {
            requestedMode: "RETRY",
            retryOfOperationId: failed.id,
            source: failed,
          });
          return rejected;
        }
      }
      const retryEligibility = retryOperationEligibility(failed, project);
      if (retryEligibility === "undispatched_destroy_recovery") {
        return this.dispatch(user, projectId, runRepository, "destroy", null, {
          retryOfOperationId: failed.id,
          retryDetectionProfileId: failed.detectionProfileId,
          generationId: generation.id,
          recoveryCommitSha: failed.commitSha,
        });
      }
      try {
        return await this.redispatch(user, project, runRepository, failed, generation.id);
      } catch (error) {
        if (action !== "destroy") {
          await this.failCandidateBeforeDispatch(user, project, runRepository, generation.id, error, {
            requestedMode: "RETRY",
            retryOfOperationId: failed.id,
            source: failed,
            action: action === "rollback" ? "rollback" : "deploy",
          });
        }
        throw error;
      }
    });
  }

  async resetAndDeployFresh(user: User, projectId: string, confirmationPhrase: string, req?: unknown) {
    if (confirmationPhrase !== "RESET AND DEPLOY FRESH") {
      throw new BadRequestException("Type RESET AND DEPLOY FRESH to confirm a new empty managed-database generation.");
    }
    await this.sharedPlatformFoundation.assertActive(this.platformFoundation());
    await this.managedDatabaseReset.reset(user, projectId, "RESET MANAGED DATABASE", req);
    const project = await this.project(user, projectId);
    return this.withProjectLock(projectId, async (runRepository) => {
      const active = await this.reconcileActive(user, project, runRepository);
      if (active) return this.result("no_op", "A GitHub Actions operation is already progressing.", active);
      const generation = await this.deploymentGenerations.createCandidate(projectId, canonicalEnvironmentName(project), runRepository.manager);
      try {
        return await this.dispatch(user, projectId, runRepository, "deploy", null, { requestedMode: "RESET_FRESH", generationId: generation.id });
      } catch (error) {
        await this.failCandidateBeforeDispatch(user, project, runRepository, generation.id, error, { requestedMode: "RESET_FRESH" });
        throw error;
      }
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
    const platformFoundation = this.platformFoundation();
    await this.sharedPlatformFoundation.assertActive(platformFoundation);
    return this.withProjectLock(projectId, async (runRepository) => {
      const active = await this.reconcileActive(user, project, runRepository);
      if (active) return this.result("no_op", "A GitHub Actions operation is already progressing.", active);
      const liveGeneration = await this.deploymentGenerations.live(projectId, canonicalEnvironmentName(project), runRepository.manager);
      if (!liveGeneration) throw new BadRequestException({ code: "generation_missing", message: "There is no live deployment generation to roll back." });
      const current = await this.currentLiveRun(projectId, runRepository, liveGeneration.id);
      if (!current) throw new BadRequestException({ code: "rollback_live_release_missing", message: "A verified current live release is required for rollback." });
      const currentEvidence = this.releaseEvidence(current);
      if (!currentEvidence) throw new BadRequestException({ code: "rollback_live_evidence_missing", message: "The current LIVE release does not contain immutable routing evidence." });
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
      const generation = await this.deploymentGenerations.createCandidate(projectId, canonicalEnvironmentName(project), runRepository.manager);
      const route = await this.deploymentGenerations.route(projectId, canonicalEnvironmentName(project), runRepository.manager);
      if (!route) throw new BadRequestException("The project environment has no collision-safe routing allocation.");
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
      const sourceRuntime = decodeEnvironmentReferencesBase64(targetInputs.environment_references_base64);
      const rollbackRuntime: GithubActionsRuntimeConfiguration = {
        ...sourceRuntime,
        platformFoundation,
        projectId,
        generationId: generation.id,
        generationStateKey: generation.terraformStateKey,
        routing: {
          listenerPriority: route.listenerPriority,
          verificationPriority: this.deploymentGenerations.verificationPriority(generation, route),
          productionHost: `p-${projectId}.${this.config.get<string>("DEPLOYGUARD_ROUTING_DOMAIN", "deployguard.local")}`,
          candidateHost: `g-${generation.id}.${this.config.get<string>("DEPLOYGUARD_ROUTING_DOMAIN", "deployguard.local")}`,
        },
        retiredGenerationCleanup: {
          generationId: liveGeneration.id,
          terraformStateKey: liveGeneration.terraformStateKey,
          resourceManifest: liveGeneration.resourceManifest || {},
        },
        environment: {
          ...sourceRuntime.environment,
          DEPLOYGUARD_OPERATION_ID: operationId,
          DEPLOYGUARD_GENERATION_ID: generation.id,
        },
        promotion: {
          contractVersion: "deployguard.promotion-intent/v1",
          operationId,
          projectId,
          environmentName: canonicalEnvironmentName(project),
          generationId: generation.id,
          candidate: null,
          previousLiveGenerationId: liveGeneration.id,
          previousTargetGroupArn: currentEvidence.targetGroupArn,
          previousListenerRuleArn: currentEvidence.listenerRuleArn,
          previousProductionUrl: typeof current.metadata?.deployedUrl === "string" ? current.metadata.deployedUrl : null,
          intentFingerprint: null,
        },
      };
      const inputs: GithubActionsOperationInputs = {
        ...targetInputs,
        deployment_action: "rollback",
        deployment_operation_id: operationId,
        infrastructure_namespace: `/deployguard/${projectId}/${canonicalEnvironmentName(project)}/${generation.id}`,
        environment_references_base64: environmentReferencesBase64(rollbackRuntime),
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
        configurationSnapshotId: sourceRuntime.configurationSnapshotId,
        databaseServiceBindingId: sourceRuntime.managedDatabase?.bindingId || null,
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
          workflowPhase: "candidate",
          promotionState: "awaiting_candidate_evidence",
          promotionIntent: rollbackRuntime.promotion,
        },
      }));
      await this.deploymentGenerations.bindCreatingOperation(generation.id, operation.id, runRepository.manager);
      try {
        await this.scheduleOperation(runRepository, operation, credential.token, inputs);
      } catch (error) {
        await this.deploymentGenerations.markFailed(generation.id, operation.id, error instanceof Error ? error.message : "Rollback candidate dispatch failed.", runRepository.manager);
        throw error;
      }
      return this.result("accepted", `Rollback to release ${Number(target.metadata?.attempt || 1)} was dispatched.`, operation);
    });
  }

  async latest(user: User, projectId: string) {
    const project = await this.project(user, projectId);
    let operation = await this.latestRun(projectId, this.runs);
    if (!operation) return { operation: null };
    await this.reconcile(user, project, operation);
    const stableUrl = await this.stableUrl(projectId, operation.generationId, operation.id);
    return { operation: this.response(operation, stableUrl) };
  }

  async history(user: User, projectId: string) {
    // Pipeline is a persisted operation-history view. Reconciliation and
    // GitHub job inspection are background responsibilities; doing either
    // here made page rendering wait on GitHub for every active/historical run.
    await this.project(user, projectId);
    const operations = await this.runs.createQueryBuilder("run")
      .where("run.projectId = :projectId", { projectId })
      .andWhere("run.metadata ->> 'executionEngine' = 'github_actions'")
      .andWhere("COALESCE(run.metadata ->> 'internalMaintenance', 'false') != 'true'")
      .orderBy("run.createdAt", "DESC").getMany();
    return {
      operations: operations.map((run) => ({
        ...this.response(run, null),
        // Stage timestamps are written by background reconciliation. A page
        // read must never fetch them from GitHub itself.
        workflowStages: this.persistedWorkflowStages(run),
      })),
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
      recoveryCommitSha?: string;
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
    const operationCommit = options.expectedRetryInputs?.commit_sha || options.recoveryCommitSha || contract.commitSha || profile?.commitSha || "";
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
    if (action === "deploy") {
      await this.deploymentGenerations.bindCreatingOperation(generation.id, operation.id, runRepository.manager);
    }
    let runtimeConfiguration: GithubActionsRuntimeConfiguration | null = null;
    if (action === "deploy") {
      try {
        const protectedRelease = previousStableOperationId
          ? await runRepository.manager.getRepository(ProjectStableRelease).findOne({
            where: {
              projectId,
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
        const route = await this.deploymentGenerations.route(project.id, environmentName, runRepository.manager);
        if (!route) throw new BadRequestException("The project environment has no collision-safe routing allocation.");
        const previousGeneration = protectedRelease?.generationId
          ? await runRepository.manager.getRepository(ProjectDeploymentGeneration).findOne({ where: { id: protectedRelease.generationId, projectId: project.id } })
          : null;
        runtimeConfiguration = this.runtimeConfiguration(plan, snapshot, effective, materialized, deploymentContext!, generation, route, protectedRelease, previousGeneration, operationId, stableUrl);
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
      ? await this.destroyEnvironmentReferences(project.id, environmentName, generation.id, {
        publicNames: contract.ecsPlan.environmentMappings.map((item) => item.name),
        secretNames: contract.ecsPlan.secretMappings.map((item) => item.name),
      }, runRepository)
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
      dispatchStartedAt: new Date().toISOString(),
      dispatchState: "dispatch_prepared",
      ...(runtimeConfiguration ? {
        workflowPhase: "candidate",
        promotionState: "awaiting_candidate_evidence",
        promotionIntent: runtimeConfiguration.promotion,
      } : {}),
    };
    await runRepository.save(operation);
    const credential = deployCredential || await this.githubApp.tokenForRepository(user.id, project.repositoryFullName, project.githubInstallationId);
    if (action === "destroy") {
      await this.scheduleNewOperation(runRepository, operation, credential.token, inputs);
      return this.result("accepted", "Confirmed destroy dispatched to GitHub Actions.", operation);
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

  private async failCandidateOperation(
    operation: ProjectPipelineRun,
    jobs: { jobs?: Array<{ conclusion?: string; steps?: Array<{ conclusion?: string; name?: string }> }> },
    log: string | null,
    message?: string,
    cleanup?: { project: Project; token: string },
    failedStage?: string,
  ) {
    const failedJob = jobs.jobs?.find((job) => job.conclusion === "failure");
    const failedStep = failedJob?.steps?.find((step) => step.conclusion === "failure");
    operation.status = PipelineRunStatus.FAILED;
    operation.failedAt = new Date();
    operation.completedAt = null;
    operation.currentStage = this.stage(failedStep?.name || failedStage || "candidate_health_verification");
    const action = ["destroy", "rollback"].includes(String(operation.metadata?.deploymentAction))
      ? operation.metadata!.deploymentAction as "destroy" | "rollback"
      : "deploy";
    const failureMessage = message || `GitHub Actions failed during ${githubActionsStagePresentation(operation.currentStage, action).label}.`;
    operation.errorMessage = failureMessage;
    operation.metadata = {
      ...(operation.metadata || {}),
      conclusion: "failure",
      failedStage: operation.currentStage,
      promotionState: "candidate_failed_before_cutover",
      safeLog: this.sanitizer.sanitize(log || failureMessage).slice(-24_000),
    };
    const saved = await this.runs.save(operation);
    if (saved.generationId) {
      await this.deploymentGenerations.markFailed(saved.generationId, saved.id, failureMessage, undefined, {
        cleanupRequired: Boolean(cleanup),
      });
      if (cleanup) {
        await this.scheduleFailedCandidateCleanup(cleanup.project, saved, cleanup.token)
          .catch((error) => this.logger.warn(`Failed-candidate cleanup scheduling failed for ${saved.generationId}: ${error instanceof Error ? error.message : "unknown error"}`));
      }
    }
    return saved;
  }

  private async beginPromotion(project: Project, operation: ProjectPipelineRun, candidate: GithubActionsCandidateEvidence, token: string) {
    const originalInputs = this.releaseInputs(operation);
    if (!originalInputs) return this.failCandidateOperation(operation, { jobs: [] }, null, "Immutable candidate inputs are unavailable.", { project, token });
    const runtime = decodeEnvironmentReferencesBase64(originalInputs.environment_references_base64);
    let immutablePlan: BuildPlan | null = null;
    try { immutablePlan = JSON.parse(Buffer.from(originalInputs.build_plan_base64, "base64").toString("utf8")) as BuildPlan; } catch { /* fail closed below */ }
    const plannedComponents = immutablePlan ? buildPlanComponents(immutablePlan) : [];
    const candidateComponents = candidate.components || [];
    const relationshipEvidenceMatches = relationshipVerificationMatchesBuildPlan(candidate, immutablePlan);
    const componentEvidenceMatches = !immutablePlan?.components
      ? candidateComponents.length === 0 || candidateComponents.length === 1
      : candidateComponents.length === plannedComponents.length
        && plannedComponents.every((planned) => candidateComponents.some((actual) => actual.id === planned.id
          && actual.role === planned.role
          && actual.root === planned.root
          && actual.buildContext === planned.buildContext
          && actual.port === planned.port
          && actual.healthPath === planned.healthPath
          && actual.taskDefinitionArn === candidate.taskDefinitionArn
          && actual.ecsServiceArn === candidate.ecsServiceArn
          && actual.verified === true));
    const expectedSecretNames = Object.keys(runtime.secretReferences).sort();
    if (
      !componentEvidenceMatches
      || !relationshipEvidenceMatches
      || candidate.deploymentOperationId !== operation.id
      || candidate.projectId !== operation.projectId
      || candidate.generationId !== operation.generationId
      || candidate.environmentName !== runtime.environmentName
      || candidate.commitSha !== operation.commitSha
      || candidate.configurationSnapshotId !== (operation.configurationSnapshotId || null)
      || candidate.configurationFingerprint !== runtime.configurationFingerprint
      || candidate.databaseBindingId !== (operation.databaseServiceBindingId || null)
      || JSON.stringify(candidate.secretReferenceNames) !== JSON.stringify(expectedSecretNames)
      || candidate.appPort !== Number(originalInputs.app_port)
      || candidate.healthCheckPath !== originalInputs.health_check_path
    ) {
      return this.failCandidateOperation(operation, { jobs: [] }, null, "Candidate evidence does not match the immutable operation and generation.", { project, token });
    }
    const promotionRuntime = runtimeConfigurationWithPromotionCandidate(runtime, candidate);
    const intent = promotionRuntime.promotion;
    const promotionInputs: GithubActionsOperationInputs = {
      ...originalInputs,
      deployment_action: "promote",
      environment_references_base64: environmentReferencesBase64(promotionRuntime),
    };
    await this.awsCapabilities.ensure({
      action: "promote",
      projectId: operation.projectId,
      environmentName: runtime.environmentName,
      generationId: operation.generationId!,
    });
    operation.metadata = {
      ...(operation.metadata || {}),
      candidateWorkflowRunId: operation.githubWorkflowRunId,
      candidateEvidence: candidate,
      promotionIntent: intent,
      promotionIntentFingerprint: intent.intentFingerprint,
      promotionState: "route_change_pending",
      workflowPhase: "promotion",
      promotionDispatchInputs: promotionInputs,
    };
    operation.status = PipelineRunStatus.QUEUED;
    operation.currentStage = "promotion_dispatch";
    operation.githubWorkflowRunId = null;
    operation.githubWorkflowStatus = "dispatching";
    await this.runs.save(operation);
    try {
      await this.scheduleOperation(this.runs, operation, token, promotionInputs);
    } catch {
      // scheduleOperation persisted a safe terminal dispatch failure. No stable
      // route was changed because the promotion workflow never started.
    }
    return operation;
  }

  private async beginCompensation(operation: ProjectPipelineRun, token: string, reason: string) {
    const promotionInputs = operation.metadata?.promotionDispatchInputs as GithubActionsOperationInputs | undefined;
    const intent = operation.metadata?.promotionIntent as PromotionIntent | undefined;
    if (!promotionInputs || !intent?.intentFingerprint) {
      operation.status = PipelineRunStatus.FAILED;
      operation.currentStage = "promotion_compensation_required";
      operation.failedAt = new Date();
      operation.errorMessage = "Stable routing may have changed, but immutable compensation evidence is unavailable.";
      operation.metadata = { ...(operation.metadata || {}), promotionState: "compensation_blocked", failureCategory: "promotion_compensation" };
      const saved = await this.runs.save(operation);
      if (saved.generationId) await this.deploymentGenerations.markFailed(saved.generationId, saved.id, saved.errorMessage || "Promotion compensation is blocked.");
      return saved;
    }
    const compensationInputs: GithubActionsOperationInputs = { ...promotionInputs, deployment_action: "compensate" };
    await this.awsCapabilities.ensure({
      action: "compensate",
      projectId: operation.projectId,
      environmentName: intent.environmentName,
      generationId: operation.generationId!,
    });
    operation.metadata = {
      ...(operation.metadata || {}),
      promotionWorkflowRunId: operation.githubWorkflowRunId,
      promotionState: "compensation_pending",
      promotionFailureReason: reason,
      workflowPhase: "compensation",
      compensationDispatchInputs: compensationInputs,
    };
    operation.status = PipelineRunStatus.QUEUED;
    operation.currentStage = "promotion_compensation_dispatch";
    operation.githubWorkflowRunId = null;
    operation.githubWorkflowStatus = "dispatching";
    await this.runs.save(operation);
    try {
      await this.scheduleOperation(this.runs, operation, token, compensationInputs);
    } catch {
      operation.metadata = { ...(operation.metadata || {}), promotionState: "compensation_dispatch_failed" };
      await this.runs.save(operation);
    }
    return operation;
  }

  private async finishCompensation(operation: ProjectPipelineRun, evidence: Record<string, unknown> | null, workflowSucceeded: boolean) {
    const expectedFingerprint = String(operation.metadata?.promotionIntentFingerprint || "");
    const valid = workflowSucceeded
      && evidence?.deploymentOperationId === operation.id
      && evidence?.generationId === operation.generationId
      && evidence?.intentFingerprint === expectedFingerprint
      && evidence?.status === "compensated";
    operation.status = PipelineRunStatus.FAILED;
    operation.failedAt = new Date();
    operation.completedAt = null;
    operation.currentStage = valid ? "promotion_compensated" : "promotion_compensation_failed";
    operation.errorMessage = valid
      ? "Candidate routing was compensated because authoritative LIVE promotion could not be finalized."
      : "Candidate routing compensation did not produce matching recovery evidence.";
    operation.metadata = {
      ...(operation.metadata || {}),
      conclusion: "failure",
      promotionState: valid ? "compensated" : "compensation_failed",
      compensationEvidence: valid ? evidence : null,
      failedStage: operation.currentStage,
      failureCategory: "promotion_compensation",
      safeLog: operation.errorMessage,
    };
    const saved = await this.runs.save(operation);
    if (saved.generationId) await this.deploymentGenerations.markFailed(saved.generationId, saved.id, saved.errorMessage || "Promotion compensation failed.");
    return saved;
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

  /**
   * A candidate exists before several admission checks can fail. Always leave
   * that generation terminal through the operation that records the failure;
   * never use the pre-dispatch generation object's stale creator field.
   */
  private async failCandidateBeforeDispatch(
    user: User,
    project: Project,
    runRepository: Repository<ProjectPipelineRun>,
    generationId: string,
    error: unknown,
    options: {
      requestedMode: "DEPLOY" | "RETRY" | "RESET_FRESH";
      retryOfOperationId?: string;
      source?: ProjectPipelineRun;
      action?: "deploy" | "rollback";
    },
  ) {
    const message = error instanceof Error ? error.message : "Candidate preparation failed.";
    let operationQuery = runRepository.createQueryBuilder("run")
      .where("run.projectId = :projectId", { projectId: project.id })
      .andWhere("run.generationId = :generationId", { generationId });
    if (options.retryOfOperationId) {
      operationQuery = operationQuery.andWhere("run.metadata ->> 'retryOfOperationId' = :retryOfOperationId", {
        retryOfOperationId: options.retryOfOperationId,
      });
    }
    let operation = await operationQuery.orderBy("run.createdAt", "DESC").getOne();
    if (!operation) {
      const now = new Date();
      const source = options.source;
      operation = await runRepository.save(runRepository.create({
        id: randomUUID(),
        projectId: project.id,
        generationId,
        triggeredByUserId: user.id,
        detectionProfileId: source?.detectionProfileId || null,
        repositoryUrl: source?.repositoryUrl || project.repositoryUrl,
        repositoryFullName: source?.repositoryFullName || project.repositoryFullName,
        targetBranch: source?.targetBranch || project.targetBranch,
        commitSha: source?.commitSha || null,
        imageTag: null,
        status: PipelineRunStatus.FAILED,
        currentStage: "candidate_preparation",
        startedAt: now,
        failedAt: now,
        githubWorkflowStatus: "not_dispatched",
        errorMessage: message.slice(0, 1000),
        metadata: {
          executionEngine: "github_actions",
          deploymentAction: options.action || "deploy",
          deploymentMode: options.requestedMode,
          attempt: await this.nextAttempt(runRepository, project.id),
          ...(options.retryOfOperationId ? { retryOfOperationId: options.retryOfOperationId } : {}),
          conclusion: "failure",
          failedStage: "candidate_preparation",
          safeLog: "DeployGuard rejected candidate preparation before GitHub Actions dispatch.",
        },
      }));
    }
    await this.deploymentGenerations.bindCreatingOperation(generationId, operation.id, runRepository.manager);
    await this.deploymentGenerations.markFailed(generationId, operation.id, message, runRepository.manager);
    return operation;
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

  /**
   * A Destroy retry can outlive the workflow that proved all AWS resources
   * absent. Follow only its immutable retry lineage; never copy or relabel the
   * proof for a later attempt.
   */
  private async verifiedDestroyAncestor(
    source: ProjectPipelineRun,
    project: Project,
    runRepository: Repository<ProjectPipelineRun>,
  ) {
    const environmentName = canonicalEnvironmentName(project);
    const generationId = source.generationId;
    if (!generationId) return null;
    let current: ProjectPipelineRun | null = source;
    const visited = new Set<string>();
    for (let depth = 0; current && depth < 32; depth += 1) {
      if (visited.has(current.id)
        || current.projectId !== project.id
        || current.generationId !== generationId
        || current.metadata?.deploymentAction !== "destroy") return null;
      visited.add(current.id);
      const evidence = current.metadata?.destroyVerification as Record<string, unknown> | undefined;
      const finalizedAfterAwsDeletion = current.status === PipelineRunStatus.COMPLETED
        || (current.status === PipelineRunStatus.FAILED
          && current.currentStage === "project_delete_cleanup"
          && current.metadata?.failureCategory === "project_delete_incomplete");
      if (
        finalizedAfterAwsDeletion
        && evidence?.contractVersion === "deployguard.destroy-result/v2"
        && evidence.deploymentOperationId === current.id
        && evidence.projectId === project.id
        && evidence.environmentName === environmentName
        && evidence.status === "project_delete_ready"
        && evidence.generationResourcesRemoved === true
        && evidence.projectResourcesRemoved === true
        && evidence.terraformStateArtifactsRemoved === true
        && evidence.sharedPlatformUntouched === true
        && Array.isArray(evidence.generationIds)
        && evidence.generationIds.includes(generationId)
      ) return current;
      const parentId = current.metadata?.retryOfOperationId;
      if (typeof parentId !== "string" || !parentId) return null;
      current = await runRepository.findOne({ where: { id: parentId, projectId: project.id } });
    }
    return null;
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
      action: inputs.deployment_action === "destroy"
        ? "destroy"
        : inputs.deployment_action === "rollback"
          ? "rollback"
          : inputs.deployment_action === "promote"
            ? "promote"
            : inputs.deployment_action === "compensate"
              ? "compensate"
              : "deploy",
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
    };
    if (retryInputs.deployment_action === "destroy") {
      const references = this.destroyReferenceNames(inputs.environment_references_base64);
      retryInputs.environment_references_base64 = (
        await this.destroyEnvironmentReferences(
          project.id,
          canonicalEnvironmentName(project),
          generationId,
          references,
          runRepository,
        )
      ).encoded;
    }
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
      dispatchStartedAt: new Date().toISOString(),
      dispatchState: "dispatch_prepared",
    }}));
    if (retryInputs.deployment_action === "destroy") {
      await this.scheduleNewOperation(runRepository, retry, credential.token, retryInputs);
      return this.result("accepted", "Destroy retry dispatched as a new immutable attempt.", retry);
    }
    await this.scheduleOperation(runRepository, retry, credential.token, retryInputs);
    return this.result("accepted", "Retry dispatched as a new immutable attempt.", retry);
  }

  private async scheduleNewOperation(runRepository: Repository<ProjectPipelineRun>, operation: ProjectPipelineRun, token: string, inputs: GithubActionsOperationInputs) {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      await runner.query("SELECT pg_advisory_lock(hashtext($1))", [`github-actions-reconcile:${operation.id}`]);
      await this.scheduleOperation(runRepository, operation, token, inputs);
    } finally {
      try {
        await runner.query("SELECT pg_advisory_unlock(hashtext($1))", [`github-actions-reconcile:${operation.id}`]);
      } finally {
        await runner.release();
      }
    }
  }

  private async scheduleOperation(
    runRepository: Repository<ProjectPipelineRun>,
    operation: ProjectPipelineRun,
    token: string,
    inputs: GithubActionsOperationInputs,
    excludedWorkflowRunIds: string[] = [],
  ) {
    try {
      const result = await this.actions.triggerWorkflow({
        repositoryFullName: inputs.repository_full_name,
        targetBranch: inputs.repository_branch,
        token,
        inputs,
        excludedWorkflowRunIds,
      });
      operation.githubWorkflowRunId = result.workflowRunId;
      operation.githubWorkflowStatus = "queued";
      operation.status = PipelineRunStatus.RUNNING;
      operation.currentStage = "github_actions";
      operation.metadata = {
        ...(operation.metadata || {}),
        dispatchAcceptedAt: new Date().toISOString(),
        dispatchState: "run_discovered",
        dispatchReceipt: result.receipt,
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
    const bindingVariables = new Map((plan.serviceBindings || [])
      .map((binding) => [binding.envAlias, `${binding.platformPathPrefix}${binding.preservedPathname || ""}`]));
    const names = [...new Set([...plan.buildTimeEnvVars, ...bindingVariables.keys()])];
    if (!names.length) return {};
    const rows = await this.environmentVariables.createQueryBuilder("variable")
      .addSelect("variable.value")
      .where({ projectId, environment, isActive: true, key: In(names) })
      .getMany();
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const required = new Set(plan.requiredInputs);
    const config: Record<string, string> = {};
    for (const key of names) {
      if (!/^(VITE_|NEXT_PUBLIC_|REACT_APP_)[A-Z0-9_]*$/.test(key) || plan.secretEnvVars.includes(key)) {
        throw new ForbiddenException(`Build-time variable ${key} is not proven public.`);
      }
      if (bindingVariables.has(key)) {
        config[key] = bindingVariables.get(key)!;
        continue;
      }
      const row = byKey.get(key);
      if (!row) {
        if (required.has(key)) throw new ForbiddenException(`Required public build configuration is missing: ${key}.`);
        continue;
      }
      if (row.isSecret) throw new ForbiddenException(`Build-time variable ${key} is not proven public.`);
      config[key] = this.environmentCrypto.decrypt(row.value);
    }
    return config;
  }

  private platformFoundation(): GithubActionsRuntimeConfiguration["platformFoundation"] {
    const routingDomain = this.config.get<string>("DEPLOYGUARD_ROUTING_DOMAIN", "").trim();
    const foundation = {
      vpcId: this.config.get<string>("DEPLOYGUARD_VPC_ID", "").trim(),
      publicSubnetIds: this.config.get<string>("DEPLOYGUARD_PUBLIC_SUBNET_IDS", "").split(",").map((item) => item.trim()).filter(Boolean),
      ecsClusterArn: this.config.get<string>("DEPLOYGUARD_SHARED_ECS_CLUSTER_ARN", "").trim(),
      ecsClusterName: this.config.get<string>("DEPLOYGUARD_SHARED_ECS_CLUSTER_NAME", "").trim(),
      albArn: this.config.get<string>("DEPLOYGUARD_SHARED_ALB_ARN", "").trim(),
      albDnsName: this.config.get<string>("DEPLOYGUARD_SHARED_ALB_DNS_NAME", "").trim(),
      listenerArn: this.config.get<string>("DEPLOYGUARD_SHARED_ALB_LISTENER_ARN", "").trim(),
      albSecurityGroupId: this.config.get<string>("DEPLOYGUARD_SHARED_ALB_SECURITY_GROUP_ID", "").trim(),
    };
    if (!foundation.vpcId || foundation.publicSubnetIds.length < 2
      || !foundation.ecsClusterArn.startsWith("arn:") || !foundation.ecsClusterName
      || !foundation.albArn.startsWith("arn:") || !foundation.albDnsName
      || !foundation.listenerArn.startsWith("arn:") || !foundation.albSecurityGroupId || !routingDomain) {
      throw new ServiceUnavailableException({
        code: "shared_platform_foundation_unconfigured",
        message: "DeployGuard shared VPC, ECS cluster and ALB routing configuration must be complete before creating a deployment generation.",
      });
    }
    return foundation;
  }

  private runtimeConfiguration(
    plan: BuildPlan,
    snapshot: ProjectConfigurationSnapshot,
    effective: EffectiveDeploymentConfiguration,
    materialized: RuntimeSecretMaterialization | null,
    deploymentContext: DeploymentRecoveryDecision,
    generation: ProjectDeploymentGeneration,
    route: ProjectEnvironmentRoute,
    protectedRelease: ProjectStableRelease | null,
    previousGeneration: ProjectDeploymentGeneration | null,
    operationId: string,
    previousProductionUrl: string | null,
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
          .map(([key]) => [key, serviceAlias(key, binding.engine)?.property === "url" ? "url" : "password"] as const)
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
    const databaseOwnerComponentId = plan.components?.find((component) => component.database.required)?.id || null;
    const componentRuntime = Object.fromEntries(buildPlanComponents(plan).map((component) => {
      const owned = new Set(component.environmentOwnership
        .filter((item) => item.componentId === component.id)
        .map((item) => item.key));
      const required = component.environmentOwnership
        .filter((item) => item.componentId === component.id && item.required && item.phase === "runtime" && item.source !== "repository")
        .map((item) => item.key);
      const environment = Object.fromEntries(Object.entries(snapshot.plainValues)
        .filter(([key]) => owned.has(key)));
      const secrets = Object.fromEntries(Object.entries(secretReferences)
        .filter(([key]) => owned.has(key)));
      // These values are intentionally platform-wide metadata, but PORT is
      // still component-specific and derives only from that component's plan.
      Object.assign(environment, {
        HOST: "0.0.0.0",
        PORT: String(component.port),
        NODE_ENV: "production",
        DEPLOYGUARD_PROJECT_ID: generation.projectId,
        DEPLOYGUARD_GENERATION_ID: generation.id,
        DEPLOYGUARD_ENVIRONMENT: snapshot.environment,
        DEPLOYGUARD_OPERATION_ID: operationId,
      });
      if (databaseOwnerComponentId === component.id && binding) {
        Object.assign(environment, runtimeAliases);
      }
      // Fresh managed database credentials are deliberately deferred until
      // Terraform creates their real Secrets Manager ARNs. They are satisfied
      // only for the canonical database owner and only by the exact alias the
      // managed binding declared; no placeholder may enter ECS references.
      const deferredManagedDatabaseSecrets = component.id === databaseOwnerComponentId && binding
        ? new Set(Object.keys(secretAliases))
        : new Set<string>();
      const missing = required.filter((key) => environment[key] === undefined && secrets[key] === undefined && !deferredManagedDatabaseSecrets.has(key));
      if (missing.length) throw new BadRequestException(`Required runtime configuration is missing for component ${component.id}: ${missing.sort().join(", ")}.`);
      return [component.id, { environment, secretReferences: secrets }];
    }));
    const databaseProfile = binding ? managedDatabaseProfile(binding.engine) : null;
    if (binding && (binding.provider !== "managed" || !databaseProfile || !binding.usernameReference)) {
      throw new BadRequestException("GitHub Actions requires a canonical supported managed database binding for this database-backed release.");
    }
    const protectedImageDigest = protectedRelease?.imageUri.match(/@(sha256:[0-9a-f]{64})$/)?.[1] || null;
    const protectedComponentDigests = Array.isArray(protectedRelease?.metadata?.components)
      ? (protectedRelease.metadata.components as Array<Record<string, unknown>>)
          .map((component) => String(component.imageDigest || ""))
          .filter((digest) => /^sha256:[0-9a-f]{64}$/.test(digest))
      : [];
    return {
      schemaVersion: 1,
      configurationSnapshotId: snapshot.id,
      configurationFingerprint: snapshot.configurationFingerprint,
      environmentName: snapshot.environment,
      projectId: generation.projectId,
      generationId: generation.id,
      generationStateKey: generation.terraformStateKey,
      platformFoundation: this.platformFoundation(),
      routing: {
        listenerPriority: route.listenerPriority,
        verificationPriority: this.deploymentGenerations.verificationPriority(generation, route),
        productionHost: `p-${generation.projectId}.${this.config.get<string>("DEPLOYGUARD_ROUTING_DOMAIN", "deployguard.local")}`,
        candidateHost: `g-${generation.id}.${this.config.get<string>("DEPLOYGUARD_ROUTING_DOMAIN", "deployguard.local")}`,
      },
      projectPersistence: {
        stateKey: `projects/${generation.projectId}/${snapshot.environment}/project/terraform.tfstate`,
        ecrRepositoryName: `deployguard-${generation.projectId}`,
        runtimeSecretName: `deployguard/${generation.projectId}/${snapshot.environment}/application/runtime`,
        ownershipScope: "project",
      },
      retiredGenerationCleanup: previousGeneration && previousGeneration.id !== generation.id ? {
        generationId: previousGeneration.id,
        terraformStateKey: previousGeneration.terraformStateKey,
        resourceManifest: previousGeneration.resourceManifest || {},
      } : null,
      environment: { ...snapshot.plainValues },
      secretReferences,
      componentRuntime,
      deploymentContext,
      retentionProtectedRelease: {
        imageDigests: [...new Set([...(protectedImageDigest ? [protectedImageDigest] : []), ...protectedComponentDigests])],
        taskDefinitionArns: protectedRelease?.taskDefinitionArn ? [protectedRelease.taskDefinitionArn] : [],
      },
      promotion: {
        contractVersion: "deployguard.promotion-intent/v1",
        operationId,
        projectId: generation.projectId,
        environmentName: snapshot.environment,
        generationId: generation.id,
        candidate: null,
        previousLiveGenerationId: protectedRelease?.generationId || null,
        previousTargetGroupArn: typeof protectedRelease?.metadata?.targetGroupArn === "string" ? protectedRelease.metadata.targetGroupArn : null,
        previousListenerRuleArn: typeof protectedRelease?.metadata?.listenerRuleArn === "string" ? protectedRelease.metadata.listenerRuleArn : null,
        previousProductionUrl,
        intentFingerprint: null,
      },
      managedDatabase: binding ? {
        bindingId: binding.id,
        bindingFingerprint: binding.configurationFingerprint,
        provider: "managed",
        engine: binding.engine,
        ownerComponentId: databaseOwnerComponentId || (() => { throw new BadRequestException("Managed database binding has no canonical BuildPlan component owner."); })(),
        image: databaseProfile!.image,
        dataPath: databaseProfile!.dataPath,
        healthCheck: databaseProfile!.healthCheck,
        initializationEnvironment: databaseProfile!.initializationEnvironment,
        initializationSecretNames: databaseProfile!.initializationSecretNames,
        urlScheme: databaseProfile!.urlScheme,
        urlQuery: databaseProfile!.urlQuery,
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
    references: { publicNames: string[]; secretNames: string[] },
    runRepository: Repository<ProjectPipelineRun>,
  ) {
    const publicNames = [...new Set(references.publicNames)].sort();
    const secretNames = [...new Set(references.secretNames)].sort();
    const generations = await runRepository.manager.getRepository(ProjectDeploymentGeneration).find({
      where: { projectId, environmentName },
      select: { id: true, status: true, terraformStateKey: true, resourceManifest: true },
      order: { ordinal: "ASC" },
    });
    if (!generations.some((generation) => generation.id === generationId)) {
      throw new BadRequestException("The active generation is missing from the project deletion context.");
    }
    const stableRelease = await runRepository.manager.getRepository(ProjectStableRelease).findOne({
      where: { projectId, environmentName, status: StableReleaseStatus.STABLE },
      order: { deployedAt: "DESC" },
    });
    const stableListenerRuleArn = stableRelease?.metadata?.listenerRuleArn;
    if (
      stableListenerRuleArn != null
      && (
        typeof stableListenerRuleArn !== "string"
        || !/^arn:(aws|aws-us-gov|aws-cn):elasticloadbalancing:[a-z0-9-]+:\d{12}:listener-rule\/.+$/i.test(stableListenerRuleArn)
      )
    ) {
      throw new BadRequestException("The authoritative stable listener route is invalid for exact project deletion.");
    }
    const projectDeletion = {
      contractVersion: "deployguard.project-delete/v2",
      projectId,
      environmentName,
      targetGenerationId: generationId,
      generations: generations.map((generation) => ({
        generationId: generation.id,
        status: generation.status,
        terraformStateKey: generation.terraformStateKey,
        resourceManifest: generation.resourceManifest || {},
      })),
      projectResources: {
        terraformStateKey: `projects/${projectId}/${environmentName}/project/terraform.tfstate`,
        ecrRepositoryName: `deployguard-${projectId}`,
        runtimeSecretName: `deployguard/${projectId}/${environmentName}/application/runtime`,
        stableListenerRuleArn: stableListenerRuleArn || null,
      },
    };
    return {
      encoded: Buffer.from(JSON.stringify({
        public: publicNames,
        secret: secretNames,
        configurationFingerprint: createHash("sha256").update(JSON.stringify({ public: publicNames, secret: secretNames })).digest("hex"),
        projectDeletion,
      }), "utf8").toString("base64"),
    };
  }

  private destroyReferenceNames(encoded: string) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    } catch {
      throw new GithubActionsOperationContractError("invalid_contract", "Immutable Destroy deletion context is invalid.");
    }
    const value = decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : null;
    const names = (key: "public" | "secret") => {
      const candidate = value?.[key];
      if (!Array.isArray(candidate) || !candidate.every((name) => typeof name === "string" && /^[A-Z][A-Z0-9_]{0,127}$/.test(name))) {
        throw new GithubActionsOperationContractError("invalid_contract", "Immutable Destroy deletion context is invalid.");
      }
      return candidate as string[];
    };
    return { publicNames: names("public"), secretNames: names("secret") };
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
    return operation.status === PipelineRunStatus.FAILED
      && ["deploy", "rollback"].includes(String(metadata.deploymentAction || ""))
      && operation.githubWorkflowStatus === "completed"
      && attempts < MAX_STABLE_RELEASE_RECONCILIATION_ATTEMPTS
      && classifiedPersistenceFailure;
  }

  /** Reconciliation updates an existing immutable operation; it must never
   * recreate a row that project deletion has already removed. A detection
   * profile is mutable project analysis, so a stale historical association is
   * detached while its identity/version remains in immutable run metadata. */
  private async persistReconciledOperation(operation: ProjectPipelineRun) {
    let detectionProfileId = operation.detectionProfileId || null;
    let metadata = operation.metadata ? { ...operation.metadata } : null;
    if (detectionProfileId) {
      const profile = await this.profiles.findOne({
        where: { id: detectionProfileId, projectId: operation.projectId },
        select: { id: true },
      });
      if (!profile) {
        const immutableInputs = metadata?.immutableDispatchInputs as Partial<GithubActionsOperationInputs> | undefined;
        metadata = {
          ...(metadata || {}),
          historicalDetectionProfile: {
            id: detectionProfileId,
            version: typeof immutableInputs?.detection_profile_version === "string"
              ? immutableInputs.detection_profile_version
              : null,
          },
        };
        detectionProfileId = null;
      }
    }
    await this.runs.update(
      { id: operation.id, projectId: operation.projectId },
      {
        detectionProfileId,
        githubWorkflowRunId: operation.githubWorkflowRunId,
        githubWorkflowStatus: operation.githubWorkflowStatus,
        status: operation.status,
        currentStage: operation.currentStage,
        startedAt: operation.startedAt,
        currentStageStartedAt: operation.currentStageStartedAt,
        completedAt: operation.completedAt,
        failedAt: operation.failedAt,
        errorMessage: operation.errorMessage,
        metadata,
      },
    );
    operation.detectionProfileId = detectionProfileId;
    operation.metadata = metadata;
    return operation;
  }

  private async reconcileLocked(user: User, project: Project, operation: ProjectPipelineRun) {
    if (!ACTIVE.includes(operation.status)) {
      if (this.stableReleaseReconciliationCandidate(operation)) {
        operation.metadata = {
          ...(operation.metadata || {}),
          stableReleaseReconciliationAttempts: Number(operation.metadata?.stableReleaseReconciliationAttempts || 0) + 1,
        };
        await this.persistReconciledOperation(operation);
      } else {
      if (
        operation.status === PipelineRunStatus.COMPLETED
        && operation.currentStage === "healthy"
        && ["deploy", "rollback"].includes(String(operation.metadata?.deploymentAction || ""))
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
          await this.persistReconciledOperation(operation);
        }
      }
      return operation;
      }
    }
    const immutableInputs = operation.metadata?.immutableDispatchInputs as Partial<GithubActionsOperationInputs> | undefined;
    const repositoryFullName = immutableInputs?.repository_full_name || operation.repositoryFullName || project.repositoryFullName;
    const targetBranch = immutableInputs?.repository_branch || operation.targetBranch || project.targetBranch;
    if (!operation.githubWorkflowRunId) {
      const dispatchAgeMs = Date.now() - new Date(operation.startedAt || operation.createdAt).getTime();
      if (operation.githubWorkflowStatus === "dispatching" && !operation.metadata?.dispatchAcceptedAt) {
        if (dispatchAgeMs < 300_000) return operation;
        operation.status = PipelineRunStatus.FAILED;
        operation.githubWorkflowStatus = "dispatch_interrupted";
        operation.currentStage = "workflow_dispatch";
        operation.failedAt = new Date();
        operation.errorMessage = "GitHub Actions dispatch did not complete, and no workflow run identity was recorded.";
        operation.metadata = {
          ...(operation.metadata || {}),
          conclusion: "failure",
          failedStage: "workflow_dispatch",
          safeLog: "The dispatch process ended before GitHub returned an immutable run identity. No GitHub Actions run is claimed for this operation.",
        };
        return this.persistReconciledOperation(operation);
      }
      const credential = await this.githubApp.tokenForRepository(user.id, repositoryFullName, project.githubInstallationId);
      const knownRows = await this.runs.createQueryBuilder("run")
        .select("run.githubWorkflowRunId", "current")
        .addSelect("run.metadata ->> 'candidateWorkflowRunId'", "candidate")
        .addSelect("run.metadata ->> 'promotionWorkflowRunId'", "promotion")
        .where("run.projectId = :projectId", { projectId: project.id })
        .getRawMany<{ current: string | null; candidate: string | null; promotion: string | null }>();
      const known = [...new Set(knownRows.flatMap((row) => [row.current, row.candidate, row.promotion]).filter((value): value is string => Boolean(value)))];
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
          return this.persistReconciledOperation(operation);
        }
        return operation;
      }
    }
    const credential = await this.githubApp.tokenForRepository(user.id, repositoryFullName, project.githubInstallationId);
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
      return this.persistReconciledOperation(operation);
    }
    operation.metadata = { ...(operation.metadata || {}), workflowUrl: remote.html_url };
    const jobs = await this.actions.getWorkflowJobs(repositoryFullName, operation.githubWorkflowRunId, credential.token);
    operation.metadata = {
      ...(operation.metadata || {}),
      workflowStages: this.workflowStagesFromJobs(operation, jobs),
    };
    const currentStep = jobs.jobs?.flatMap((job) => job.steps || []).find((step) => step.status === "in_progress");
    if (currentStep?.name) operation.currentStage = this.stage(currentStep.name);
    let retiredCleanup: ReturnType<typeof generationCleanupEvidence> = null;
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
          const marker = operation.metadata?.workflowPhase === "candidate"
            ? "DEPLOYGUARD_CANDIDATE_RESULT"
            : operation.metadata?.workflowPhase === "compensation"
              ? "DEPLOYGUARD_COMPENSATION_RESULT"
              : operation.metadata?.deploymentAction === "destroy"
                ? "DEPLOYGUARD_DESTROY_RESULT"
                : "DEPLOYGUARD_RELEASE_RESULT";
          durableResultLog = `${marker}=${artifact.trim()}`;
        }
      } catch (error) {
        this.logger.warn(`Durable result artifact for operation ${operation.id} was unavailable: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      const completionEvidence = [completedJobLog || "", durableResultLog].filter(Boolean).join("\n");
      let workflowPhase = String(operation.metadata?.workflowPhase || "candidate");
      const releaseAction = ["deploy", "rollback"].includes(String(operation.metadata?.deploymentAction || ""));
      if (releaseAction && workflowPhase === "candidate" && remote.conclusion !== "success") {
        return this.failCandidateOperation(operation, jobs, completedJobLog, undefined, { project, token: credential.token });
      }
      if (releaseAction && workflowPhase === "candidate") {
        const cleanup = { project, token: credential.token };
        const candidate = extractGithubActionsCandidateEvidence(completionEvidence);
        if (!candidate) return this.failCandidateOperation(operation, jobs, completedJobLog, "Exact healthy-candidate evidence was missing or invalid.", cleanup);
        let immutablePlan: BuildPlan | null = null;
        try {
          const originalInputs = this.releaseInputs(operation);
          immutablePlan = originalInputs ? JSON.parse(Buffer.from(originalInputs.build_plan_base64, "base64").toString("utf8")) as BuildPlan : null;
        } catch { /* fail closed below */ }
        if (!relationshipVerificationMatchesBuildPlan(candidate, immutablePlan)) {
          return this.failCandidateOperation(operation, jobs, completedJobLog, "Candidate relationship evidence does not match the immutable BuildPlan.", cleanup);
        }
        if (completionEvidence.includes("DEPLOYGUARD_RELEASE_RESULT=")) {
          try {
            const originalInputs = this.releaseInputs(operation);
            if (!originalInputs) {
              return this.failCandidateOperation(operation, jobs, completedJobLog, "Immutable candidate inputs are unavailable.", cleanup);
            }
            const runtime = decodeEnvironmentReferencesBase64(originalInputs.environment_references_base64);
            const promotionRuntime = runtimeConfigurationWithPromotionCandidate(runtime, candidate);
            operation.metadata = {
              ...(operation.metadata || {}),
              candidateWorkflowRunId: operation.githubWorkflowRunId,
              candidateEvidence: candidate,
              promotionIntent: promotionRuntime.promotion,
              promotionIntentFingerprint: promotionRuntime.promotion.intentFingerprint,
              promotionState: "route_changed_awaiting_finalization",
              workflowPhase: "promotion",
            };
            workflowPhase = "promotion";
          } catch (error) {
            return this.failCandidateOperation(
              operation,
              jobs,
              completedJobLog,
              error instanceof GithubActionsOperationContractError
                ? "Promotion rejected the persisted immutable runtime configuration."
                : "Inline promotion evidence could not be prepared.",
              cleanup,
            );
          }
        } else {
        try {
          return await this.beginPromotion(project, operation, candidate, credential.token);
        } catch (error) {
          if (error instanceof GithubActionsOperationContractError && error.code === "invalid_contract") {
            return this.failCandidateOperation(
              operation,
              jobs,
              completedJobLog,
              "Promotion rejected the persisted immutable runtime configuration.",
              cleanup,
            );
          }
          throw error;
        }
        }
      }
      if (releaseAction && workflowPhase === "compensation") {
        const compensation = extractGithubActionsCompensationEvidence(completionEvidence);
        return this.finishCompensation(operation, compensation, remote.conclusion === "success");
      }
      if (releaseAction && workflowPhase === "promotion" && remote.conclusion !== "success") {
        return this.beginCompensation(operation, credential.token, "Stable-route promotion failed or could not be verified.");
      }
      retiredCleanup = generationCleanupEvidence(completionEvidence);
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
      const destroyEvidenceValid = Boolean(
        destroyEvidence && destroyEvidence.deploymentOperationId === operation.id,
      );
      if (destroyEvidenceValid) {
        operation.metadata = { ...(operation.metadata || {}), destroyVerification: destroyEvidence };
      }
      const rollbackEvidenceMissing = success
        && operation.metadata?.deploymentAction === "rollback"
        && !releaseEvidence;
      const destroyEvidenceMissing = success && destroyRequested && !destroyEvidenceValid;
      let effectiveSuccess = success && !rollbackEvidenceMissing && !destroyEvidenceMissing && !releaseEvidenceContractError;
      let runtimeEvidenceFailure: string | null = null;
      let stableReleasePersistenceFailure: string | null = null;
      let runtimeEvidenceError: RuntimeEvidenceContractError | null = releaseEvidenceContractError;
      let stableReleaseFinalized = false;
      if (
        effectiveSuccess
        && ["deploy", "rollback"].includes(
          String(operation.metadata?.deploymentAction || ""),
        )
      ) {
        try {
          await this.verifyAndPersistStableRelease(operation, releaseEvidence);
          stableReleaseFinalized = true;
        } catch (error) {
          if (workflowPhase === "promotion") {
            return this.beginCompensation(
              operation,
              credential.token,
              error instanceof RuntimeEvidenceContractError
                ? "Promoted route evidence failed the immutable contract."
                : "Authoritative LIVE finalization failed after route cutover.",
            );
          }
          effectiveSuccess = false;
          if (error instanceof RuntimeEvidenceContractError) {
            runtimeEvidenceError = error;
            runtimeEvidenceFailure = RUNTIME_CONFIGURATION_EVIDENCE_FAILURE_MESSAGE;
          } else {
            stableReleasePersistenceFailure = "The workflow and runtime evidence succeeded, but DeployGuard could not persist the authoritative stable release.";
          }
        }
      }
      if (stableReleaseFinalized) {
        // Cleanup dispatch is intentionally outside finalization's failure
        // boundary: a retired cleanup problem can never compensate a route
        // that is already authoritatively LIVE.
        await this.scheduleRetiredGenerationCleanup(project, operation, credential.token)
          .catch((error) => this.logger.warn(`Retired cleanup scheduling failed after ${operation.id} became LIVE: ${error instanceof Error ? error.message : "unknown error"}`));
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
        operation.metadata = {
          ...successfulMetadata,
          conclusion: "success",
          rollbackAvailable,
          ...(!destroyed && workflowPhase === "promotion" ? { promotionState: "finalized" } : {}),
          ...(destroyed ? { destroyedAt: new Date().toISOString() } : url ? { deployedUrl: url, stableDeployedUrl: url } : {}),
        };
        if (destroyed && !operation.generationId) throw new Error("Verified destroy has no immutable generation identity.");
      } else {
        const failedJob = jobs.jobs?.find((job) => job.conclusion === "failure");
        const failedStep = failedJob?.steps?.find((step) => step.conclusion === "failure");
        operation.currentStage = stableReleasePersistenceFailure ? "stable_release_persistence"
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
        operation.errorMessage = stableReleasePersistenceFailure || runtimeEvidenceFailure || (platformCapabilityFailure
          ? `DeployGuard execution role is missing the platform-required AWS permission ${platformCapabilityFailure.action}.`
          : rollbackEvidenceMissing
          ? "Rollback completed without immutable release evidence and was not promoted."
          : destroyEvidenceMissing
            ? "Project deletion cleanup did not produce matching exact-scope evidence."
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
          safeLog = "Project deletion was rejected because exact project/generation cleanup evidence was missing or did not match this operation.";
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
    const saved = await this.persistReconciledOperation(operation);
    if (saved.status === PipelineRunStatus.COMPLETED && saved.metadata?.deploymentAction !== "destroy" && retiredCleanup) {
      if (retiredCleanup.status === "cleaned") {
        await this.deploymentGenerations.markCleaned(retiredCleanup.generationId, { cleanupOperationId: saved.id });
      } else {
        await this.deploymentGenerations.markCleanupPending(retiredCleanup.generationId, { cleanupOperationId: saved.id, error: retiredCleanup.error });
      }
    }
    if (saved.status === PipelineRunStatus.FAILED && ["deploy", "rollback"].includes(String(saved.metadata?.deploymentAction)) && saved.generationId) {
      await this.deploymentGenerations.markFailed(
        saved.generationId,
        saved.id,
        saved.errorMessage || "Candidate release verification failed.",
      );
    }
    if (saved.status === PipelineRunStatus.COMPLETED && saved.metadata?.deploymentAction === "destroy") {
      try {
        await this.notifications.dispatch({
          projectId: saved.projectId,
          pipelineRunId: saved.id,
          eventId: `${saved.id}:completed:destroyed`,
          stage: "destroy_completed",
          status: "completed",
          message: "Project deletion completed successfully.",
          action: "destroy",
          environmentName: canonicalEnvironmentName(project),
          generationId: saved.generationId,
          commitSha: saved.commitSha,
          projectUrl: `${this.config.get<string>("FRONTEND_URL", "http://localhost:5173").replace(/\/$/, "")}/projects/${saved.projectId}`,
        }).catch((error) => this.logger.warn(`Destroy success notification failed for ${saved.id}: ${error instanceof Error ? error.message : "unknown error"}`));
        await this.projectDeletion.finalize(project, saved);
        return saved;
      } catch (error) {
        saved.status = PipelineRunStatus.FAILED;
        saved.completedAt = null;
        saved.failedAt = new Date();
        saved.currentStage = "project_delete_cleanup";
        saved.errorMessage = "PROJECT_DELETE_INCOMPLETE";
        saved.metadata = {
          ...(saved.metadata || {}),
          conclusion: "failure",
          failedStage: "project_delete_cleanup",
          failureCategory: "project_delete_incomplete",
          safeLog: error instanceof ProjectDeletionIncompleteError
            ? error.message
            : "PROJECT_DELETE_INCOMPLETE: final control-plane cleanup did not complete.",
        };
        const failed = await this.persistReconciledOperation(saved);
        await this.notifications.dispatch({
          projectId: failed.projectId,
          pipelineRunId: failed.id,
          eventId: `${failed.id}:failed:project_delete_cleanup`,
          stage: "destroy_failed",
          status: "failed",
          message: failed.errorMessage,
          action: "destroy",
          environmentName: canonicalEnvironmentName(project),
          generationId: failed.generationId,
          commitSha: failed.commitSha,
          failedStage: failed.currentStage,
          projectUrl: `${this.config.get<string>("FRONTEND_URL", "http://localhost:5173").replace(/\/$/, "")}/projects/${failed.projectId}/pipeline`,
        }).catch((notificationError) => this.logger.warn(`Destroy failure notification failed for ${failed.id}: ${notificationError instanceof Error ? notificationError.message : "unknown error"}`));
        return failed;
      }
    }
    if (saved.status === PipelineRunStatus.COMPLETED && saved.metadata?.internalMaintenance !== true) {
      await this.costEvidence.capture(saved, repositoryFullName, credential.token, canonicalEnvironmentName(project));
      if (saved.generationId) await this.retention.apply(saved.projectId, saved.generationId);
    }
    const deploymentAction = String(saved.metadata?.deploymentAction || "deploy");
    const notificationAction = deploymentAction === "deploy" && ["UPDATE", "REDEPLOY"].includes(String(saved.metadata?.deploymentMode || "").toUpperCase())
      ? "redeploy"
      : deploymentAction;
    if (saved.metadata?.internalMaintenance === true) return saved;
    await this.notifications.dispatch({
      projectId: saved.projectId,
      pipelineRunId: saved.id,
      eventId: `${saved.id}:${saved.status}:${saved.currentStage}`,
      stage: `${notificationAction}_${saved.currentStage || saved.status}`,
      status: saved.status,
      message: saved.status === PipelineRunStatus.COMPLETED
        ? `${deploymentAction} completed successfully.`
        : saved.errorMessage || `${deploymentAction} failed.`,
      action: notificationAction,
      environmentName: canonicalEnvironmentName(project),
      generationId: saved.generationId,
      commitSha: saved.commitSha,
      failedStage: saved.status === PipelineRunStatus.FAILED ? String(saved.metadata?.failedStage || saved.currentStage || "") : null,
      projectUrl: `${this.config.get<string>("FRONTEND_URL", "http://localhost:5173").replace(/\/$/, "")}/projects/${saved.projectId}/${saved.status === PipelineRunStatus.FAILED ? "pipeline" : ""}`.replace(/\/$/, ""),
    }).catch((error) => this.logger.warn(`Notification dispatch failed for ${saved.id}: ${error instanceof Error ? error.message : "unknown error"}`));
    return saved;
  }

  /** Cleanup is a separate internal operation. A retired target is scheduled
   * only after its successor is LIVE; a failed candidate target is scheduled
   * only after its immutable candidate workflow has terminally failed. */
  private async scheduleRetiredGenerationCleanup(project: Project, release: ProjectPipelineRun, token: string) {
    const inputs = this.releaseInputs(release);
    if (!inputs) return;
    let runtime: GithubActionsRuntimeConfiguration;
    try {
      runtime = decodeEnvironmentReferencesBase64(inputs.environment_references_base64);
    } catch {
      this.logger.warn(`Retired cleanup was not scheduled for ${release.id}: immutable runtime configuration is unavailable.`);
      return;
    }
    const retired = runtime.retiredGenerationCleanup;
    if (!retired) return;
    await this.dispatchGenerationCleanup(project, release, token, runtime, {
      ...retired,
      cleanupReason: "retired",
    });
  }

  private async scheduleFailedCandidateCleanup(project: Project, failed: ProjectPipelineRun, token: string) {
    const inputs = this.releaseInputs(failed);
    if (!inputs || !failed.generationId) return;
    let runtime: GithubActionsRuntimeConfiguration;
    try {
      runtime = decodeEnvironmentReferencesBase64(inputs.environment_references_base64);
    } catch {
      this.logger.warn(`Failed-candidate cleanup was not scheduled for ${failed.id}: immutable runtime configuration is unavailable.`);
      return;
    }
    const target = await this.deploymentGenerations.cleanupTarget(failed.generationId);
    await this.dispatchGenerationCleanup(project, failed, token, runtime, {
      generationId: target.generationId,
      terraformStateKey: target.terraformStateKey,
      resourceManifest: target.resources,
      cleanupReason: "failed_candidate",
    });
  }

  private async dispatchGenerationCleanup(
    project: Project,
    source: ProjectPipelineRun,
    token: string,
    sourceRuntime: GithubActionsRuntimeConfiguration,
    target: NonNullable<GithubActionsRuntimeConfiguration["retiredGenerationCleanup"]>,
  ) {
    // cleanupTarget validates the exact state key and rejects any project or
    // shared-persistence manifest before an IAM-capable workflow is dispatched.
    try {
      await this.deploymentGenerations.cleanupTarget(target.generationId);
    } catch (error) {
      this.logger.warn(`Generation cleanup target ${target.generationId} was rejected: ${error instanceof Error ? error.message : "unknown error"}`);
      return;
    }
    const existing = await this.runs.createQueryBuilder("run")
      .where("run.generationId = :generationId", { generationId: target.generationId })
      .andWhere("COALESCE(run.metadata ->> 'internalMaintenance', 'false') = 'true'")
      .andWhere("run.status IN (:...statuses)", { statuses: ACTIVE })
      .getOne();
    if (existing) return;

    const cleanupId = randomUUID();
    const cleanupRuntime: GithubActionsRuntimeConfiguration = {
      ...sourceRuntime,
      retiredGenerationCleanup: target,
      environment: { ...sourceRuntime.environment, DEPLOYGUARD_OPERATION_ID: cleanupId },
      promotion: {
        ...sourceRuntime.promotion,
        operationId: cleanupId,
        candidate: null,
        intentFingerprint: null,
      },
    };
    const cleanupInputs: GithubActionsOperationInputs = {
      ...this.releaseInputs(source)!,
      deployment_action: "cleanup",
      deployment_operation_id: cleanupId,
      image_tag: immutableImageTag(source.commitSha, cleanupId),
      environment_references_base64: environmentReferencesBase64(cleanupRuntime),
    };
    const cleanup = await this.runs.save(this.runs.create({
      id: cleanupId,
      projectId: source.projectId,
      generationId: target.generationId,
      triggeredByUserId: source.triggeredByUserId,
      // Detection is a mutable project-level readiness projection, not part of
      // a retired generation's immutable cleanup identity. The source entity
      // can still carry a profile ID that PostgreSQL has already SET NULL after
      // that profile was replaced/deleted, so maintenance operations must not
      // copy the stale in-memory association.
      detectionProfileId: null,
      repositoryUrl: source.repositoryUrl,
      repositoryFullName: source.repositoryFullName,
      targetBranch: source.targetBranch,
      commitSha: source.commitSha,
      imageTag: cleanupInputs.image_tag,
      configurationSnapshotId: source.configurationSnapshotId,
      databaseServiceBindingId: source.databaseServiceBindingId,
      status: PipelineRunStatus.QUEUED,
      currentStage: "generation_cleanup_dispatch",
      startedAt: new Date(),
      githubWorkflowStatus: "dispatching",
      metadata: {
        executionEngine: "github_actions",
        deploymentAction: "cleanup",
        internalMaintenance: true,
        cleanupGenerationId: target.generationId,
        cleanupKind: target.cleanupReason || "retired",
        sourceOperationId: source.id,
        sourceReleaseOperationId: source.id,
        immutableDispatchInputs: cleanupInputs,
        immutableDispatchFingerprint: immutableDispatchFingerprint(cleanupInputs),
      },
    }));
    await this.deploymentGenerations.markCleanupPending(target.generationId, {
      cleanupOperationId: cleanup.id,
      cleanupKind: target.cleanupReason || "retired",
      sourceOperationId: source.id,
      sourceReleaseOperationId: source.id,
      dispatchState: "prepared",
    });
    try {
      // The cleanup workflow destroys only the retired generation's exact
      // state/ownership scope. It receives Destroy's generation-scoped AWS
      // capability admission, never project-delete instructions.
      await this.awsCapabilities.ensure({
        action: "destroy",
        projectId: project.id,
        environmentName: sourceRuntime.environmentName,
        generationId: target.generationId,
      });
      await this.scheduleNewOperation(this.runs, cleanup, token, cleanupInputs);
    } catch (error) {
      await this.deploymentGenerations.markCleanupPending(target.generationId, {
        cleanupOperationId: cleanup.id,
        cleanupKind: target.cleanupReason || "retired",
        sourceOperationId: source.id,
        sourceReleaseOperationId: source.id,
        error: error instanceof Error ? error.message.slice(0, 1000) : "Generation cleanup dispatch failed.",
      });
      this.logger.warn(`Generation cleanup dispatch failed for ${target.generationId}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  /** Retry cleanup debt at a bounded cadence. It is intentionally not in
   * the developer operation lane, so a temporary cleanup failure never holds
   * a later Deploy/Rollback hostage. */
  private async retryPendingGenerationCleanup() {
    const retryAfterMs = 5 * 60 * 1_000;
    const pending = await this.dataSource.getRepository(ProjectDeploymentGeneration)
      .createQueryBuilder("generation")
      .where("generation.status = :cleanupPending", { cleanupPending: "cleanup_pending" })
      .orWhere("generation.status = :failed AND generation.cleanupMetadata ->> 'cleanupKind' = :failedCandidate AND generation.cleanupMetadata ->> 'cleanupStatus' = :pending", {
        failed: "failed",
        failedCandidate: "failed_candidate",
        pending: "pending",
      })
      .orderBy("generation.updatedAt", "ASC")
      .take(10)
      .getMany();
    for (const generation of pending) {
      const metadata = generation.cleanupMetadata || {};
      const lastAttempt = typeof metadata.lastAttemptAt === "string" ? Date.parse(metadata.lastAttemptAt) : Number.NaN;
      if (Number.isFinite(lastAttempt) && Date.now() - lastAttempt < retryAfterMs) continue;
      const existing = await this.runs.createQueryBuilder("run")
        .where("run.generationId = :generationId", { generationId: generation.id })
        .andWhere("COALESCE(run.metadata ->> 'internalMaintenance', 'false') = 'true'")
        .andWhere("run.status IN (:...statuses)", { statuses: ACTIVE })
        .getOne();
      if (existing) continue;
      const sourceId = typeof metadata.sourceOperationId === "string"
        ? metadata.sourceOperationId
        : typeof metadata.sourceReleaseOperationId === "string" ? metadata.sourceReleaseOperationId : null;
      if (!sourceId) continue;
      const release = await this.runs.findOne({ where: { id: sourceId, projectId: generation.projectId } });
      const project = await this.projects.findOne({ where: { id: generation.projectId } });
      if (!release || !project) continue;
      try {
        const credential = await this.githubApp.tokenForRepository(release.triggeredByUserId, project.repositoryFullName, project.githubInstallationId);
        if (metadata.cleanupKind === "failed_candidate") {
          await this.scheduleFailedCandidateCleanup(project, release, credential.token);
        } else {
          await this.scheduleRetiredGenerationCleanup(project, release, credential.token);
        }
      } catch (error) {
        this.logger.warn(`Generation cleanup retry could not be scheduled for ${generation.id}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
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

  private latestRun(projectId: string, repository: Repository<ProjectPipelineRun>, statuses?: PipelineRunStatus[]) {
    const query = repository.createQueryBuilder("run").where("run.projectId = :projectId", { projectId })
      .andWhere("run.metadata ->> 'executionEngine' = 'github_actions'")
      .andWhere("COALESCE(run.metadata ->> 'internalMaintenance', 'false') != 'true'");
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

  private async rollbackTarget(projectId: string, current: ProjectPipelineRun, repository: Repository<ProjectPipelineRun>) {
    const targetId = current.metadata?.previousStableOperationId;
    if (typeof targetId !== "string" || !targetId || targetId === current.id) return null;
    const target = await repository.findOne({ where: { id: targetId, projectId } });
    const metadata = (target?.metadata || {}) as Record<string, unknown>;
    if (
      !target
      || target.status !== PipelineRunStatus.COMPLETED
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
    const active = await repository.createQueryBuilder("run").where("run.projectId = :projectId", { projectId: project.id })
      .andWhere("run.metadata ->> 'executionEngine' = 'github_actions'")
      .andWhere("COALESCE(run.metadata ->> 'internalMaintenance', 'false') != 'true'")
      .andWhere("run.status IN (:...statuses)", { statuses: ACTIVE }).orderBy("run.createdAt", "DESC").getMany();
    for (const operation of active) {
      await this.reconcile(user, project, operation);
      if (ACTIVE.includes(operation.status)) return operation;
    }
    return null;
  }

  private async stableUrl(projectId: string, generationId: string | null, excludingId?: string) {
    const stableRelease = await this.dataSource.getRepository(ProjectStableRelease).findOne({
      where: { projectId, status: StableReleaseStatus.STABLE },
      order: { deployedAt: "DESC" },
    });
    const authoritativeGenerationId = stableRelease?.generationId || generationId;
    if (!authoritativeGenerationId) return null;
    const query = this.runs.createQueryBuilder("run").where("run.projectId = :projectId", { projectId }).andWhere("run.generationId = :generationId", { generationId: authoritativeGenerationId }).andWhere("run.status = :status", { status: PipelineRunStatus.COMPLETED }).andWhere("run.metadata ->> 'executionEngine' = 'github_actions'").andWhere("run.metadata ->> 'deployedUrl' IS NOT NULL");
    if (excludingId) query.andWhere("run.id != :excludingId", { excludingId });
    const stable = await query.orderBy("run.completedAt", "DESC").getOne();
    return typeof stable?.metadata?.deployedUrl === "string" ? stable.metadata.deployedUrl : null;
  }

  private async verifyAndPersistStableRelease(operation: ProjectPipelineRun, evidence: GithubActionsReleaseEvidence | null) {
    const inputs = this.releaseInputs(operation);
    if (!inputs) throw new RuntimeEvidenceContractError([{ field: "immutableReleaseInputs", reason: "missing" }]);
    const runtime = decodeEnvironmentReferencesBase64(inputs.environment_references_base64);
    let buildPlan: BuildPlan | null = null;
    try { buildPlan = JSON.parse(Buffer.from(inputs.build_plan_base64, "base64").toString("utf8")) as BuildPlan; } catch { /* validation records the mismatch */ }
    const issues = validateGithubActionsRuntimeEvidence(evidence, {
      deploymentOperationId: operation.id,
      generationId: operation.generationId,
      commitSha: operation.commitSha,
      environmentName: inputs.environment_name,
      configurationSnapshotId: operation.configurationSnapshotId ?? null,
      configurationFingerprint: runtime.configurationFingerprint,
      databaseBindingId: operation.databaseServiceBindingId ?? null,
      runtimeDatabaseBindingId: runtime.managedDatabase?.bindingId ?? null,
      secretReferenceNames: Object.keys(runtime.secretReferences),
      promotionIntentFingerprint: String(operation.metadata?.promotionIntentFingerprint || ""),
    });
    if (runtime.environmentName !== inputs.environment_name) issues.push({ field: "runtime.environmentName", reason: "mismatched" });
    if (runtime.configurationSnapshotId !== (operation.configurationSnapshotId ?? null)) issues.push({ field: "runtime.configurationSnapshotId", reason: "mismatched" });
    if (buildPlan?.components) {
      const components = evidence?.components || [];
      const planned = buildPlanComponents(buildPlan);
      if (components.length !== planned.length || planned.some((item) => !components.some((component) => component.id === item.id
        && component.role === item.role
        && component.root === item.root
        && component.buildContext === item.buildContext
        && component.port === item.port
        && component.healthPath === item.healthPath
        && component.taskDefinitionArn === evidence?.taskDefinitionArn
        && component.ecsServiceArn === evidence?.ecsServiceArn
        && component.verified === true))) {
        issues.push({ field: "components", reason: "mismatched" });
      }
    }
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
        const stableRelease = await materializeStableRelease(manager, {
          operationId: operation.id,
          projectId: operation.projectId,
          generationId: operation.generationId,
          environmentName: runtime.environmentName,
          commitSha: operation.commitSha,
          imageUri: evidence.imageUri,
          taskDefinitionArn: evidence.taskDefinitionArn,
          ecsServiceArn: evidence.ecsServiceArn,
          healthCheckPath: evidence.healthCheckPath,
          appPort: evidence.appPort,
          metadata: {
            operationId: operation.id,
          imageDigest: evidence.imageDigest,
          targetGroupArn: evidence.targetGroupArn,
          listenerRuleArn: evidence.listenerRuleArn,
          routingVerified: evidence.routingVerified,
          candidateRouteRemoved: evidence.candidateRouteRemoved,
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
          components: evidence.components || [],
          port: evidence.appPort,
            healthPath: evidence.healthCheckPath,
          },
        });
        await this.deploymentGenerations.promoteVerified(operation.generationId, operation.id, {
          ecsServiceArn: evidence.ecsServiceArn,
          taskDefinitionArn: evidence.taskDefinitionArn,
          targetGroupArn: evidence.targetGroupArn,
          listenerRuleArn: evidence.listenerRuleArn,
          routingVerified: evidence.routingVerified,
          candidateRouteRemoved: evidence.candidateRouteRemoved,
        }, manager);
        return stableRelease;
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
      || JSON.stringify(evidence.components || []) !== JSON.stringify(sourceEvidence.components || [])
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
        || JSON.stringify(targetMetadata.components || []) !== JSON.stringify(sourceEvidence.components || [])
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

  private workflowStagesFromJobs(run: ProjectPipelineRun, response: { jobs?: Array<Record<string, any>> }) {
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
  }

  private persistedWorkflowStages(run: ProjectPipelineRun) {
    const stages = run.metadata?.workflowStages;
    return Array.isArray(stages) ? stages : [];
  }

  private async loadBalancerUrl(project: Project, generationId: string) {
    const environment = canonicalEnvironmentName(project);
    const route = await this.deploymentGenerations.route(project.id, environment);
    if (!route || route.liveGenerationId !== generationId) return null;
    const domain = this.config.get<string>("DEPLOYGUARD_ROUTING_DOMAIN", "").trim().toLowerCase();
    return domain ? `http://p-${project.id}.${domain}` : null;
  }

  private stage(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || "github_actions"; }
  private async project(user: User, id: string) { const project = await this.projects.findOne({ where: { id } }); if (!project) throw new NotFoundException("Project not found."); if (project.ownerUserId !== user.id) throw new ForbiddenException("Project operations are restricted to the project owner."); return project; }
  private result(state: "accepted" | "no_op" | "rejected", message: string, run: ProjectPipelineRun) { return { deployment: { state, message, operation: this.response(run, typeof run.metadata?.stableDeployedUrl === "string" ? run.metadata.stableDeployedUrl : null) } }; }
  private response(run: ProjectPipelineRun, stableUrl: string | null = null) {
    const verification = run.metadata?.destroyVerification as Record<string, unknown> | undefined;
    const deleted = run.metadata?.deploymentAction === "destroy"
      && run.status === PipelineRunStatus.COMPLETED
      && verification?.contractVersion === "deployguard.destroy-result/v2"
      && verification.deploymentOperationId === run.id
      && verification.status === "project_delete_ready"
      && verification.generationResourcesRemoved === true
      && verification.projectResourcesRemoved === true
      && verification.terraformStateArtifactsRemoved === true
      && verification.sharedPlatformUntouched === true;
    const deploymentAction = run.metadata?.deploymentAction === "destroy"
      ? "destroy"
      : run.metadata?.deploymentAction === "rollback" ? "rollback" : "deploy";
    const verificationPending = deploymentAction === "destroy"
      && run.status === PipelineRunStatus.COMPLETED
      && run.currentStage === "destroyed"
      && !deleted;
    const stage = verificationPending
      ? { key: "project_delete_verification_pending", label: "Project deletion verification pending" }
      : githubActionsStagePresentation(run.currentStage, deploymentAction);
    const failedStage = typeof run.metadata?.failedStage === "string"
      ? githubActionsStagePresentation(run.metadata.failedStage, deploymentAction)
      : null;
    const oidcFailure = failedStage?.key === "configure_aws_credentials_through_oidc";
    const platformFailure = oidcFailure || run.metadata?.failureOwner === "platform" || run.metadata?.failureCategory === "platform_configuration";
    return {
      id: run.id,
      generationId: run.generationId,
      status: run.status,
      phase: verificationPending ? "project_delete_verification_pending" : run.status === PipelineRunStatus.QUEUED ? "queued" : run.currentStage,
      stage: stage.key,
      stageLabel: stage.label,
      deploymentAction,
      destroyVerificationStatus: deleted ? "project_delete_ready" : verificationPending ? "pending" : null,
      destroyVerificationUnresolved: [],
      deploymentMode: typeof run.metadata?.deploymentMode === "string" ? run.metadata.deploymentMode : null,
      deploymentContext: run.metadata?.deploymentContext || null,
      workflowRunId: run.githubWorkflowRunId,
      workflowStatus: run.githubWorkflowStatus,
      deployedUrl: deleted ? null : (typeof run.metadata?.deployedUrl === "string" ? run.metadata.deployedUrl : stableUrl) || null,
      workflowUrl: typeof run.metadata?.workflowUrl === "string" ? run.metadata.workflowUrl : null,
      commitSha: run.commitSha,
      attempt: Number(run.metadata?.attempt || 1),
      retryOfOperationId: typeof run.metadata?.retryOfOperationId === "string" ? run.metadata.retryOfOperationId : null,
      rollbackSourceOperationId: typeof run.metadata?.rollbackSourceOperationId === "string" ? run.metadata.rollbackSourceOperationId : null,
      conclusion: typeof run.metadata?.conclusion === "string" ? run.metadata.conclusion : null,
      failedStage: failedStage?.key || null,
      failedStageLabel: failedStage?.label || null,
      failureOwner: platformFailure ? "platform" : null,
      safeLog: typeof run.metadata?.safeLog === "string" ? run.metadata.safeLog : null,
      advancedSafeLog: typeof run.metadata?.advancedSafeLog === "string" ? run.metadata.advancedSafeLog : null,
      aiAnalysisEligible: run.status === PipelineRunStatus.FAILED
        && Boolean(run.githubWorkflowRunId)
        && typeof run.metadata?.safeLog === "string"
        && run.metadata.safeLog.trim().length > 0,
      errorMessage: oidcFailure
        ? "DeployGuard could not connect securely to AWS. This is a platform configuration defect; no application credential or project setting is required."
        : run.status === PipelineRunStatus.FAILED
          ? githubActionsFailureMessage(run.errorMessage, run.metadata?.failedStage || run.currentStage, deploymentAction)
          : run.errorMessage || null,
      requestedAt: run.createdAt,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      failedAt: run.failedAt,
    };
  }
}
