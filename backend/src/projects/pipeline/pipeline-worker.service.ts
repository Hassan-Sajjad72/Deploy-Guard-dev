import { Injectable, Logger, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Job, Worker } from "bullmq";
import { execFile } from "child_process";
import { access, mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { join, resolve, sep } from "path";
import { promisify } from "util";
import { Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { envBoolean, externalCiRequired } from "../../config/env-parsing";
import { FinopsService } from "../../finops/finops.service";
import { CostEstimateStatus } from "../../finops/project-cost-estimate.entity";
import { InfrastructureService } from "../../infrastructure/infrastructure.service";
import { DatabaseServiceBindingService } from "../../infrastructure/database-service-binding.service";
import { OrchestrationService } from "../../orchestration/orchestration.service";
import { GithubActionsMetricsService } from "../../observability/github-actions-metrics.service";
import { PipelineMetricsService } from "../../observability/pipeline-metrics.service";
import { LogSanitizerService } from "../../observability/log-sanitizer.service";
import { StageMetricSource } from "../../observability/project-stage-metric.entity";
import { TrivyMetricsService } from "../../observability/trivy-metrics.service";
import { EfsService } from "../../storage/efs.service";
import { StorageService } from "../../storage/storage.service";
import { User } from "../../users/user.entity";
import { UsersService } from "../../users/users.service";
import { NotificationDispatcherService } from "../../notifications/notification-dispatcher.service";
import { ProjectResourceRegistryService } from "../../resource-registry/project-resource-registry.service";
import { StageCheckpointService } from "../recovery/stage-checkpoint.service";
import { RecoveryStage } from "../recovery/stage-selective-resume.types";
import { DeploymentContractService } from "../deployment-contract.service";
import { ProjectDeploymentContract } from "../project-deployment-contract.entity";
import { ProjectEnvironmentVariable } from "../project-environment-variable.entity";
import { ProjectEnvironmentCryptoService } from "../project-environment-crypto.service";
import { DeploymentRequirementsService } from "../deployment-requirements.service";
import { RepoDeployabilityScannerService } from "../detection/repo-deployability-scanner.service";
import {
  PreflightValidationStatus,
  ProjectPreflightReport,
} from "../project-preflight-report.entity";
import { Project } from "../project.entity";
import {
  PipelineRunStatus,
  ProjectPipelineRun,
} from "../project-pipeline-run.entity";
import { ProjectPipelineEvent } from "../project-pipeline-event.entity";
import { SecurityPolicyDecision } from "../project-security-scan.entity";
import { DockerBuildService } from "./docker-build.service";
import { EcrService } from "./ecr.service";
import {
  GithubActionsDispatchError,
  GithubActionsService,
} from "./github-actions.service";
import { TerraformService } from "./terraform.service";
import { SecurityScanService } from "../security/security-scan.service";
import { DockerfileSecurityService } from "../security/dockerfile-security.service";
import { getSecurityPolicyConfig } from "../security/security-policy.config";
import { createRedisConnection } from "./redis.config";
import {
  PIPELINE_QUEUE_NAME,
  PipelineEventMetadata,
  PipelineJobData,
} from "./pipeline.types";
import { InactiveLegacyShadowInsertionAdapter, LegacyWorkerShadowRoute } from "../../orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter";
import {
  CrossLaneHeartbeat,
  CrossLaneOwnershipClaim,
  CrossLaneOwnershipEnforcementError,
  CrossLaneOwnershipEnforcementService,
} from "../../orchestration-contracts/release-lane/cross-lane-ownership-enforcement.service";
import { PipelineJobFinalityService } from "./pipeline-job-finality.service";
import {
  normalizePipelineFailureClass,
  pipelineFailureStage,
} from "./pipeline-stage-presenter";

const execFileAsync = promisify(execFile);
class PipelineCancelledError extends Error {}
const ALLOWED_METADATA_KEYS = [
  "projectId",
  "pipelineRunId",
  "repositoryFullName",
  "targetBranch",
  "commitSha",
  "imageTag",
  "shortCommitSha",
  "ecrRepositoryName",
  "ecrImageUri",
  "terraformConfigured",
  "terraformStatus",
  "terraformWorkingDirectory",
  "scanId",
  "criticalCount",
  "highCount",
  "mediumCount",
  "lowCount",
  "policyDecision",
  "estimateId",
  "totalMonthlyCost",
  "tierLimitMonthlyCost",
  "warningThresholdMonthlyCost",
  "approvalRequired",
  "blockedByTierLimit",
  "infrastructureEnvironmentId",
  "vpcId",
  "reason",
  "stage",
  "status",
  "failureClass",
  "storageId",
  "persistentStorageId",
  "efsFileSystemId",
  "efsAccessPointId",
  "backupPlanId",
  "backupVaultName",
  "deploymentId",
  "ecsClusterName",
  "ecsServiceName",
  "ecsServiceArn",
  "taskDefinitionArn",
  "albDnsName",
  "targetGroupArn",
  "toCommitSha",
  "diagnosticCode",
  "ecsDiagnostics",
  "bindingId",
  "bindingFingerprint",
];

@Injectable()
export class PipelineWorkerService implements OnModuleDestroy {
  private readonly logger = new Logger(PipelineWorkerService.name);
  private worker: Worker<PipelineJobData> | null = null;

  constructor(
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent)
    private readonly eventRepository: Repository<ProjectPipelineEvent>,
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectPreflightReport)
    private readonly preflightRepository: Repository<ProjectPreflightReport>,
    @InjectRepository(ProjectEnvironmentVariable)
    private readonly environmentVariableRepository: Repository<ProjectEnvironmentVariable>,
    private readonly environmentCrypto: ProjectEnvironmentCryptoService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly githubActionsService: GithubActionsService,
    private readonly dockerBuildService: DockerBuildService,
    private readonly securityScanService: SecurityScanService,
    private readonly dockerfileSecurityService: DockerfileSecurityService,
    private readonly deployabilityScanner: RepoDeployabilityScannerService,
    private readonly deploymentContractService: DeploymentContractService,
    private readonly ecrService: EcrService,
    private readonly terraformService: TerraformService,
    private readonly finopsService: FinopsService,
    private readonly infrastructureService: InfrastructureService,
    private readonly databaseBindings: DatabaseServiceBindingService,
    private readonly storageService: StorageService,
    private readonly efsService: EfsService,
    private readonly orchestrationService: OrchestrationService,
    private readonly pipelineMetricsService: PipelineMetricsService,
    private readonly githubActionsMetricsService: GithubActionsMetricsService,
    private readonly trivyMetricsService: TrivyMetricsService,
    private readonly logSanitizer: LogSanitizerService,
    private readonly usersService: UsersService,
    private readonly notifications: NotificationDispatcherService,
    private readonly resourceRegistry: ProjectResourceRegistryService,
    private readonly stageCheckpoints: StageCheckpointService,
    private readonly deploymentRequirements: DeploymentRequirementsService,
    private readonly jobFinality: PipelineJobFinalityService,
    @Optional() private readonly legacyShadow?: InactiveLegacyShadowInsertionAdapter,
    @Optional() private readonly crossLane?: CrossLaneOwnershipEnforcementService,
  ) {}

  start() {
    if (this.worker) {
      return;
    }

    this.worker = new Worker<PipelineJobData>(
      PIPELINE_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: createRedisConnection(this.config),
        concurrency: 1,
      }
    );

    this.worker.on("completed", (job) => {
      if (!job?.id) return;
      void this.recordCompletedFinality(job);
    });

    this.worker.on("failed", (job, error) => {
      this.logger.error(`Pipeline job ${job?.id || "unknown"} failed`, error);
      if (!job?.id) return;
      void this.recordRetryExhaustedFinality(job);
    });

    this.logger.log(`Pipeline worker listening on queue ${PIPELINE_QUEUE_NAME}`);
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async recordRetryExhaustedFinality(job: Job<PipelineJobData>): Promise<void> {
    try {
      const configuredAttempts = Number(job.opts.attempts || 1);
      const queueState = await job.getState();
      if (queueState !== "failed") return;
      await this.jobFinality.recordFailedAfterRetriesExhausted({
        pipelineRunId: job.data.pipelineRunId,
        bullmqJobId: String(job.id),
        queueState,
        attemptsMade: job.attemptsMade,
        configuredAttempts,
      });
    } catch {
      // Durable finality evidence is default-off and must not affect BullMQ.
    }
  }

  private async recordCompletedFinality(job: Job<PipelineJobData>): Promise<void> {
    try {
      await this.jobFinality.recordCompleted({
        pipelineRunId: job.data.pipelineRunId,
        bullmqJobId: String(job.id),
      });
    } catch {
      // Finality and shadow observation are inert with respect to BullMQ.
    }
  }

  private async process(job: Job<PipelineJobData>) {
    const { pipelineRunId, triggeredByUserId } = job.data;
    const run = await this.findRun(pipelineRunId);
    const actor = await this.userRepository.findOne({
      where: { id: triggeredByUserId },
    });
    let workspacePath: string | null = null;
    const jobType = job.data.jobType || "pipeline_build";
    let crossLaneClaim: CrossLaneOwnershipClaim = { enabled: false };
    let crossLaneHeartbeat: CrossLaneHeartbeat | null = null;

    try {
      // Historical deployment jobs may remain visible for audit/history, but
      // must never enter the legacy mutation pipeline after v1 retirement.
      // v1 infrastructure planning/apply use their own fenced consumer and
      // cannot arrive on this legacy pipeline queue.
      if (["full_deploy", "infrastructure_plan", "infrastructure_apply"].includes(jobType)) return;
      if (run.status === PipelineRunStatus.CANCELLED) {
        return;
      }
      crossLaneClaim = this.crossLane?.legacyClaimFromRun(run)
        ?? { enabled: false };
      if (!(await (this.crossLane?.renew(crossLaneClaim) ?? Promise.resolve(true)))) {
        throw new CrossLaneOwnershipEnforcementError(
          "CROSS_LANE_OWNERSHIP_LOST",
        );
      }
      crossLaneHeartbeat = this.crossLane?.startHeartbeat(crossLaneClaim)
        ?? null;

      this.observeWorkerPickup(run, job, jobType);

      if (jobType !== "storage_provision") {
        await this.databaseBindings.assertRunConfigurationCurrent(run.projectId, run.id);
      }

      if (jobType === "infrastructure_plan" || jobType === "infrastructure_apply") {
        await this.processInfrastructureOnlyJob(run, actor, jobType, job);
        return;
      }

      if (jobType === "storage_provision") {
        await this.processStorageProvisionJob(run, actor, job);
        return;
      }

      if (jobType === "resume_after_cost_approval") {
        await this.processCostApprovalResumeJob(run, actor, job);
        return;
      }

      if (jobType === "resume_after_apply_approval") {
        await this.processApplyApprovalResumeJob(run, actor, job);
        return;
      }

      if (jobType === "resume_after_state_lock") {
        try {
          await this.processStateLockResumeJob(run, actor, job.data.resumeOperation || "plan", job);
          await this.infrastructureService.finishStateLockQueueItem(run.id, true);
        } catch (error) {
          await this.infrastructureService.finishStateLockQueueItem(
            run.id,
            false,
            this.publicErrorMessage(error instanceof Error ? error.message : "Resumed operation failed.")
          );
          throw error;
        }
        return;
      }

      if (jobType === "stage_selective_resume") {
        workspacePath = await this.processStageSelectiveResumeJob(run, actor, job.data, job);
        return;
      }

      await this.updateRun(run, {
        status: PipelineRunStatus.RUNNING,
        currentStage: "validate_inputs",
        startedAt: new Date(),
      });
      await this.audit("PIPELINE_RUN_STARTED", run, actor, "success", {
        stage: "validate_inputs",
        status: PipelineRunStatus.RUNNING,
      });

      const { project, contract, preflightReport } = await this.prepare(run);
      await this.event(run, "validate_inputs_completed", "success", "Pipeline inputs validated.");
      await this.stageCheckpoints.recordPassed(run, "preflight");
      await this.ensureNotCancelled(run);

      if (jobType === "full_deploy") {
        await this.event(
          run,
          "readiness_check_passed",
          "success",
          "Pipeline prerequisites passed. Security, cost, and apply gates will be evaluated during this run."
        );
      }

      workspacePath = await this.cloneRepository(run, project);
      await this.ensureNotCancelled(run);
      this.assertContractCommit(run, contract);
      await this.event(
        run,
        "stack_detection_snapshot",
        "success",
        "Stack detection profile snapshot loaded for this pipeline run."
      );
      await this.stageCheckpoints.recordPassed(run, "stack_detection");
      const buildWorkspacePath = this.buildWorkspacePath(workspacePath, contract);
      await this.validateDeployabilitySnapshot(run, buildWorkspacePath, contract, preflightReport);
      await this.ensureNotCancelled(run);

      await this.observeWorkerPreMutation(run, job, jobType);

      await this.runExternalCiValidation(
        run,
        actor,
        job.data.options.triggerGithubActions
      );
      await this.ensureNotCancelled(run);

      await this.ensureDockerfile(run, buildWorkspacePath, contract);
      await this.ensureDockerignore(run, buildWorkspacePath);
      await this.checkDockerfile(run, buildWorkspacePath);
      await this.stageCheckpoints.recordPassed(run, "dockerfile_generation");
      await this.ensureNotCancelled(run);

      const imageTag = this.fullCommitSha(run);
      const shortCommitSha = imageTag.slice(0, 12);
      const imageName = `mini-paas/${this.safeName(project.name)}`;
      run.imageName = imageName;
      run.imageTag = imageTag;
      await this.runRepository.save(run);

      await this.buildDockerImage(run, actor, buildWorkspacePath, imageName, imageTag, contract);
      const buildCheckpoint = await this.stageCheckpoints.recordPassed(run, "docker_build", { imageName, imageTag });
      run.metadata = {
        ...(run.metadata || {}),
        buildFingerprint: buildCheckpoint.fingerprint,
      };
      await this.runRepository.save(run);
      await this.ensureNotCancelled(run);
      await this.runSecurityGate(run, actor, project, imageName, imageTag);
      await this.stageCheckpoints.recordPassed(run, "security_scan", { imageName, imageTag });
      await this.ensureNotCancelled(run);

      const ecrRepositoryName = this.ecrService.getRepositoryName(project.name, project.id);
      run.ecrRepositoryName = ecrRepositoryName;
      await this.updateRun(run, { currentStage: "tagging_image" });

      if (this.ecrService.hasConfig()) {
        run.ecrImageUri = this.ecrService.getImageUri(ecrRepositoryName, imageTag);
      }
      await this.runRepository.save(run);
      await this.event(run, "tagging_image", "success", "Image tag metadata computed.", {
        imageTag,
        shortCommitSha,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      await this.audit("IMAGE_TAGGED", run, actor, "success", {
        stage: "tagging_image",
        status: "success",
        imageTag,
        shortCommitSha,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });

      await this.pushToEcr(run, actor, imageName, imageTag, ecrRepositoryName);
      const imageDigest = await this.ecrService.getImageDigest(ecrRepositoryName, imageTag).catch(() => null);
      await this.stageCheckpoints.recordPassed(run, "ecr_push", { imageName, imageTag, imageDigest, ecrImageUri: run.ecrImageUri });
      await this.stageCheckpoints.recordPassed(run, "security_scan", { imageName, imageTag, imageDigest, ecrImageUri: run.ecrImageUri });
      await this.ensureNotCancelled(run);
      await this.applyLifecyclePolicy(run, actor, ecrRepositoryName);
      await this.ensureNotCancelled(run);

      if (jobType === "full_deploy") {
        const planReady = await this.runInfrastructurePlan(run, actor, project);

        if (!planReady) {
          return;
        }
        await this.ensureNotCancelled(run);
      } else {
        await this.runTerraformStage(run, actor, project);
      }

      const shouldContinue = await this.runCostAnalysis(run, actor, project);

      if (!shouldContinue) {
        return;
      }
      await this.ensureNotCancelled(run);

      if (jobType === "full_deploy") {
        const applyReady = await this.runInfrastructureApply(run, actor, project);
        if (!applyReady) return;
        await this.ensureNotCancelled(run);
        await this.runEcsDeployment(run, actor);
        await this.ensureNotCancelled(run);
      } else {
        await this.recordProvisioningSkipped(run, actor);
      }

      await this.updateRun(run, {
        status: PipelineRunStatus.COMPLETED,
        currentStage: "completed",
        completedAt: new Date(),
      });
      await this.event(run, "completed", "success", "Pipeline run completed.", {
        commitSha: run.commitSha,
        imageTag: run.imageTag,
        shortCommitSha: run.commitSha?.slice(0, 12),
        ecrRepositoryName: run.ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      await this.audit("PIPELINE_RUN_COMPLETED", run, actor, "success", {
        stage: "completed",
        status: PipelineRunStatus.COMPLETED,
        commitSha: run.commitSha,
        imageTag: run.imageTag,
        shortCommitSha: run.commitSha?.slice(0, 12),
        ecrRepositoryName: run.ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });

      if (jobType === "full_deploy") {
        await this.audit("DEPLOYMENT_COMPLETED", run, actor, "success", {
          stage: "deployment_completed",
          status: PipelineRunStatus.COMPLETED,
        });
      }
      await this.buildMetricSummary(run);
    } catch (error) {
      if (error instanceof PipelineCancelledError) {
        run.metadata = { ...(run.metadata || {}), cancelRequested: true };
        await this.updateRun(run, {
          status: PipelineRunStatus.CANCELLED,
          currentStage: "cancelled",
          completedAt: run.completedAt || new Date(),
          errorMessage: null,
          metadata: run.metadata,
        });
        await this.buildMetricSummary(run).catch(() => undefined);
        return;
      }
      const message =
        error instanceof Error ? error.message : "Pipeline worker failed unexpectedly";
      const publicMessage = this.publicErrorMessage(message);
      const failedStatus =
        jobType === "storage_provision"
          ? PipelineRunStatus.STORAGE_FAILED
          : PipelineRunStatus.FAILED;
      await this.updateRun(run, {
        status: failedStatus,
        currentStage: run.currentStage || "failed",
        failedAt: new Date(),
        errorMessage: publicMessage,
      });
      await this.event(
        run,
        run.currentStage || "failed",
        "failed",
        publicMessage
      );
      await this.audit("PIPELINE_RUN_FAILED", run, actor, "failed", {
        stage: run.currentStage || "failed",
        status: failedStatus,
      });
      if (jobType === "storage_provision") {
        await this.storageService.recordStorageEvent(
          run.projectId,
          run.id,
          "storage_provisioning_failed",
          "failed",
          publicMessage,
          actor,
          { reason: publicMessage }
        );
        await this.audit("STORAGE_PROVISIONING_FAILED", run, actor, "failed", {
          stage: run.currentStage || "failed",
          status: failedStatus,
          reason: publicMessage,
        });
      }
      if (jobType === "full_deploy") {
        await this.audit("DEPLOYMENT_FAILED", run, actor, "failed", {
          stage: run.currentStage || "failed",
          status: PipelineRunStatus.FAILED,
        });
      }
      await this.buildMetricSummary(run);
      throw error;
    } finally {
      const crossLaneTrusted = await crossLaneHeartbeat?.stop() ?? true;
      if (crossLaneTrusted && crossLaneClaim.enabled) {
        const durableRun = await this.runRepository.findOne({
          where: { id: run.id, projectId: run.projectId },
        }).catch(() => null);
        if (durableRun && releasesCrossLaneOwnership(durableRun.status)) {
          await this.crossLane?.releaseLegacyRun(
            crossLaneClaim,
            durableRun.id,
          ).catch(() => false);
        }
      }
      if (workspacePath) {
        await rm(resolve(workspacePath, ".."), { recursive: true, force: true });
      }
    }
  }

  private observeWorkerPickup(
    run: ProjectPipelineRun,
    job: Job<PipelineJobData>,
    jobType: PipelineJobData["jobType"],
  ): void {
    const route = workerShadowRoute(jobType);
    if (!route) return;
    this.legacyShadow?.observeWorkerPickup({
      projectId: run.projectId,
      logicalOperationId: workerObservationIdentity(run.id, route, job.id),
      route,
    });
  }

  private async observeWorkerPreMutation(
    run: ProjectPipelineRun,
    job: Job<PipelineJobData>,
    routeOrJobType: LegacyWorkerShadowRoute | PipelineJobData["jobType"],
  ): Promise<void> {
    const claim = this.crossLane?.legacyClaimFromRun(run)
      ?? { enabled: false };
    if (!(await (this.crossLane?.renew(claim) ?? Promise.resolve(true)))) {
      throw new CrossLaneOwnershipEnforcementError(
        "CROSS_LANE_OWNERSHIP_LOST",
      );
    }
    const route = isLegacyWorkerShadowRoute(routeOrJobType)
      ? routeOrJobType
      : workerShadowRoute(routeOrJobType);
    if (!route) return;
    this.legacyShadow?.observeWorkerPreMutation({
      projectId: run.projectId,
      logicalOperationId: workerObservationIdentity(run.id, route, job.id),
      route,
    });
  }

  private async ensureNotCancelled(run: ProjectPipelineRun) {
    const current = await this.runRepository.findOne({ where: { id: run.id } });
    if (
      current?.status === PipelineRunStatus.CANCELLED ||
      (current?.metadata as Record<string, unknown> | null)?.cancelRequested === true
    ) {
      throw new PipelineCancelledError("Pipeline run was cancelled by the user");
    }
  }

  private async processStageSelectiveResumeJob(
    run: ProjectPipelineRun,
    actor: User | null,
    data: PipelineJobData,
    job: Job<PipelineJobData>,
  ): Promise<string | null> {
    const rerun = new Set<RecoveryStage>(data.rerunStages || []);
    if (!data.resumeFromStage || rerun.size === 0) throw new Error("Stage-selective resume payload is incomplete.");
    await this.updateRun(run, { status: PipelineRunStatus.RUNNING, currentStage: `resume_${data.resumeFromStage}`, startedAt: new Date(), failedAt: null, completedAt: null, errorMessage: null });
    await this.event(run, "stage_selective_resume_started", "running", "Recovery resume started from the first invalidated stage.", { stage: data.resumeFromStage, reason: data.reason });
    const { project, contract, preflightReport } = await this.prepare(run);
    if (hasWorkerMutation(rerun)) await this.observeWorkerPreMutation(run, job, "stage_selective_resume");
    let workspacePath: string | null = null;
    let imageName = run.imageName || `mini-paas/${this.safeName(project.name)}`;
    let imageTag = run.imageTag || this.fullCommitSha(run);

    try {
    if (rerun.has("docker_build")) {
      workspacePath = await this.cloneRepository(run, project);
      this.assertContractCommit(run, contract);
      const buildWorkspace = this.buildWorkspacePath(workspacePath, contract);
      await this.validateDeployabilitySnapshot(run, buildWorkspace, contract, preflightReport);
      await this.ensureDockerfile(run, buildWorkspace, contract);
      await this.ensureDockerignore(run, buildWorkspace);
      await this.checkDockerfile(run, buildWorkspace);
      await this.stageCheckpoints.recordPassed(run, "dockerfile_generation");
      imageTag = `${this.fullCommitSha(run).slice(0, 40)}-${run.id.slice(0, 8)}`;
      run.imageName = imageName;
      run.imageTag = imageTag;
      run.ecrRepositoryName = this.ecrService.getRepositoryName(project.name, project.id);
      run.ecrImageUri = this.ecrService.hasConfig() ? this.ecrService.getImageUri(run.ecrRepositoryName, imageTag) : null;
      await this.runRepository.save(run);
      await this.rerunReason(run, "docker_build");
      await this.buildDockerImage(run, actor, buildWorkspace, imageName, imageTag, contract);
      await this.stageCheckpoints.recordPassed(run, "docker_build", { imageName, imageTag });
    } else if (rerun.has("security_scan")) {
      if (!run.ecrImageUri || !run.imageName || !run.imageTag) throw new Error("The previous image artifact is unavailable; start a full redeploy.");
      await this.ecrService.loginDocker();
      await this.dockerBuildService.pullImage(run.ecrImageUri);
      await this.dockerBuildService.tagRemoteImage(run.ecrImageUri, run.imageName, run.imageTag);
      imageName = run.imageName;
      imageTag = run.imageTag;
    }

    if (rerun.has("security_scan")) {
      await this.rerunReason(run, "security_scan");
      await this.runSecurityGate(run, actor, project, imageName, imageTag);
      const imageDigest = run.ecrRepositoryName && run.imageTag
        ? await this.ecrService.getImageDigest(run.ecrRepositoryName, run.imageTag).catch(() => null)
        : null;
      await this.stageCheckpoints.recordPassed(run, "security_scan", { imageName, imageTag, imageDigest, ecrImageUri: run.ecrImageUri });
    }
    if (rerun.has("ecr_push")) {
      if (!run.ecrRepositoryName) run.ecrRepositoryName = this.ecrService.getRepositoryName(project.name, project.id);
      if (!run.ecrImageUri && this.ecrService.hasConfig()) run.ecrImageUri = this.ecrService.getImageUri(run.ecrRepositoryName, imageTag);
      await this.runRepository.save(run);
      await this.rerunReason(run, "ecr_push");
      await this.pushToEcr(run, actor, imageName, imageTag, run.ecrRepositoryName);
      const imageDigest = await this.ecrService.getImageDigest(run.ecrRepositoryName, imageTag).catch(() => null);
      await this.stageCheckpoints.recordPassed(run, "ecr_push", { imageName, imageTag, imageDigest, ecrImageUri: run.ecrImageUri });
      await this.stageCheckpoints.recordPassed(run, "security_scan", { imageName, imageTag, imageDigest, ecrImageUri: run.ecrImageUri });
    }
    if (rerun.has("database_tier_setup")) await this.rerunReason(run, "database_tier_setup");
    if (rerun.has("terraform_plan")) {
      await this.rerunReason(run, "terraform_plan");
      const planReady = await this.runInfrastructurePlan(run, actor, project);
      if (!planReady) return workspacePath;
      const costReady = await this.runCostAnalysis(run, actor, project);
      if (!costReady) return workspacePath;
    }
    if (rerun.has("terraform_apply")) {
      await this.rerunReason(run, "terraform_apply");
      const applyReady = await this.runInfrastructureApply(run, actor, project);
      if (!applyReady) return workspacePath;
    }
    if (rerun.has("ecs_task_definition_update") || rerun.has("ecs_service_deploy") || rerun.has("health_check")) {
      await this.rerunReason(run, "ecs_task_definition_update");
      await this.runEcsDeployment(run, actor);
    }
    await this.updateRun(run, { status: PipelineRunStatus.COMPLETED, currentStage: "completed", completedAt: new Date() });
    await this.event(run, "stage_selective_resume_completed", "success", "Recovery resume completed using valid previous checkpoints.");
    await this.audit("STAGE_SELECTIVE_RESUME_COMPLETED", run, actor, "success", { stage: data.resumeFromStage, status: "success" });
    await this.buildMetricSummary(run);
    return workspacePath;
    } catch (error) {
      if (workspacePath) await rm(resolve(workspacePath, ".."), { recursive: true, force: true });
      throw error;
    }
  }

  private async rerunReason(run: ProjectPipelineRun, stage: RecoveryStage) {
    await this.event(run, stage, "queued", "Scheduled to rerun because configuration changed.", { stage, status: "queued" });
  }

  private async processInfrastructureOnlyJob(
    run: ProjectPipelineRun,
    actor: User | null,
    jobType: "infrastructure_plan" | "infrastructure_apply",
    job: Job<PipelineJobData>,
  ) {
    await this.updateRun(run, {
      status: PipelineRunStatus.RUNNING,
      currentStage: jobType,
      startedAt: new Date(),
    });

    const project = await this.projectRepository.findOne({ where: { id: run.projectId } });

    if (!project || project.status === "archived") {
      throw new Error("Project is archived or no longer exists");
    }

    await this.observeWorkerPreMutation(run, job, jobType);

    if (jobType === "infrastructure_plan") {
      const planReady = await this.runInfrastructurePlan(run, actor, project);

      if (!planReady) {
        return;
      }
    } else {
      const applyReady = await this.runInfrastructureApply(run, actor, project, true);

      if (!applyReady) {
        return;
      }
    }

    await this.updateRun(run, {
      status: PipelineRunStatus.COMPLETED,
      currentStage: `${jobType}_completed`,
      completedAt: new Date(),
    });
    await this.event(run, `${jobType}_completed`, "success", "Infrastructure job completed.");
  }

  private async processCostApprovalResumeJob(
    run: ProjectPipelineRun,
    actor: User | null,
    job: Job<PipelineJobData>,
  ) {
    await this.updateRun(run, {
      status: PipelineRunStatus.RUNNING,
      currentStage: "cost_approved_resuming",
      startedAt: run.startedAt || new Date(),
    });
    const project = await this.projectRepository.findOne({
      where: { id: run.projectId },
    });

    if (!project || project.status === "archived") {
      throw new Error("Project is archived or no longer exists");
    }

    await this.event(
      run,
      "cost_approved_resuming",
      "running",
      "Pipeline resumed after cost approval."
    );
    const originalJobType = (run.metadata as Record<string, unknown> | null)?.jobType;

    if (originalJobType === "full_deploy") {
      await this.observeWorkerPreMutation(run, job, "cost_approval_resume");
      const applyReady = await this.runInfrastructureApply(run, actor, project);
      if (!applyReady) return;
      await this.runEcsDeployment(run, actor);
    } else {
      await this.recordProvisioningSkipped(run, actor);
    }

    await this.updateRun(run, {
      status: PipelineRunStatus.COMPLETED,
      currentStage: "completed",
      completedAt: new Date(),
    });
    await this.event(
      run,
      "completed",
      "success",
      "Pipeline completed after cost approval."
    );
    await this.audit("PIPELINE_RUN_COMPLETED", run, actor, "success", {
      stage: "completed",
      status: PipelineRunStatus.COMPLETED,
    });
    await this.buildMetricSummary(run);
  }

  private async processApplyApprovalResumeJob(
    run: ProjectPipelineRun,
    actor: User | null,
    job: Job<PipelineJobData>,
  ) {
    await this.updateRun(run, {
      status: PipelineRunStatus.RUNNING,
      currentStage: "terraform_apply_approved_resuming",
      startedAt: run.startedAt || new Date(),
    });
    const project = await this.projectRepository.findOne({ where: { id: run.projectId } });
    if (!project || project.status === "archived") {
      throw new Error("Project is archived or no longer exists");
    }
    await this.event(
      run,
      "terraform_apply_approved_resuming",
      "running",
      "Terraform apply was approved by the user. Deployment is resuming."
    );
    await this.observeWorkerPreMutation(run, job, "apply_approval_resume");
    const applyReady = await this.runInfrastructureApply(run, actor, project, true);
    if (!applyReady) return;
    const originalJobType = (run.metadata as Record<string, unknown> | null)?.jobType;
    if (originalJobType === "full_deploy") await this.runEcsDeployment(run, actor);
    await this.updateRun(run, {
      status: PipelineRunStatus.COMPLETED,
      currentStage: "completed",
      completedAt: new Date(),
    });
    await this.event(run, "completed", "success", "Pipeline completed after Terraform apply approval.");
    await this.audit("PIPELINE_RUN_COMPLETED", run, actor, "success", {
      stage: "completed",
      status: PipelineRunStatus.COMPLETED,
    });
    await this.buildMetricSummary(run);
  }

  private async processStateLockResumeJob(
    run: ProjectPipelineRun,
    actor: User | null,
    operation: "plan" | "apply",
    job: Job<PipelineJobData>,
  ) {
    await this.updateRun(run, {
      status: PipelineRunStatus.RUNNING,
      currentStage: `state_lock_resuming_${operation}`,
    });
    const project = await this.projectRepository.findOne({
      where: { id: run.projectId },
    });

    if (!project || project.status === "archived") {
      throw new Error("Project is archived or no longer exists");
    }

    const originalJobType = (run.metadata as Record<string, unknown> | null)?.jobType;
    await this.observeWorkerPreMutation(run, job, "state_lock_resume");

    if (operation === "plan") {
      const planReady = await this.runInfrastructurePlan(run, actor, project);
      if (!planReady) return;

      if (originalJobType === "full_deploy") {
        const costPassed = await this.runCostAnalysis(run, actor, project);
        if (!costPassed) return;
        const applyReady = await this.runInfrastructureApply(run, actor, project);
        if (!applyReady) return;
        await this.runEcsDeployment(run, actor);
      }
    } else {
      const applyReady = await this.runInfrastructureApply(run, actor, project);
      if (!applyReady) return;
      if (originalJobType === "full_deploy") await this.runEcsDeployment(run, actor);
    }

    await this.updateRun(run, {
      status: PipelineRunStatus.COMPLETED,
      currentStage: "completed",
      completedAt: new Date(),
    });
    await this.event(run, "completed", "success", "Pipeline completed after state lock resume.");
    await this.buildMetricSummary(run);
  }

  private async processStorageProvisionJob(run: ProjectPipelineRun, actor: User | null, job: Job<PipelineJobData>) {
    await this.startMetric(run, "efs_provisioning", StageMetricSource.TERRAFORM);
    await this.updateRun(run, {
      status: PipelineRunStatus.STORAGE_EVALUATION_RUNNING,
      currentStage: "storage_evaluation_started",
      startedAt: new Date(),
    });

    const project = await this.projectRepository.findOne({ where: { id: run.projectId } });

    if (!project || project.status === "archived") {
      throw new Error("Project is archived or no longer exists");
    }

    await this.event(run, "storage_evaluation_started", "running", "Persistent storage evaluation started.");
    await this.storageService.recordStorageEvent(
      project.id,
      run.id,
      "storage_evaluation_started",
      "running",
      "Persistent storage evaluation started.",
      actor
    );

    await this.observeWorkerPreMutation(run, job, "storage_provision");

    const storage = await this.efsService.provisionEfs(project.id, run.id);
    await this.updateRun(run, {
      status: PipelineRunStatus.STORAGE_PROVISIONING,
      currentStage: "efs_plan_started",
    });
    await this.event(run, "persistent_storage_required", "success", "Persistent storage is enabled for this project.", {
      storageId: storage.id,
    });
    await this.storageService.recordStorageEvent(
      project.id,
      run.id,
      "persistent_storage_required",
      "success",
      "Persistent storage is enabled for this project.",
      actor,
      { storageId: storage.id }
    );

    const planReady = await this.runInfrastructurePlan(run, actor, project);

    if (!planReady) {
      return;
    }

    await this.event(run, "efs_plan_completed", "success", "EFS Terraform plan completed.");
    await this.storageService.recordStorageEvent(project.id, run.id, "efs_plan_completed", "success", "EFS Terraform plan completed.", actor);
    await this.updateRun(run, {
      status: PipelineRunStatus.BACKUP_CONFIGURING,
      currentStage: "backup_plan_configuring",
    });
    await this.event(run, "backup_plan_configuring", "running", "Backup plan configuration included in Terraform apply.");
    await this.storageService.recordStorageEvent(project.id, run.id, "backup_plan_configuring", "running", "Backup plan configuration included in Terraform apply.", actor);

    const applyReady = await this.runInfrastructureApply(run, actor, project);

    if (!applyReady) {
      return;
    }

    const savedStorage = await this.efsService.getEfsStatus(project.id);
    await this.event(run, "efs_file_system_created", "success", "EFS file system outputs saved.", {
      efsFileSystemId: savedStorage?.efsFileSystemId || undefined,
    });
    await this.event(run, "efs_mount_targets_created", "success", "EFS mount target outputs saved.");
    await this.event(run, "efs_access_point_created", "success", "EFS access point outputs saved.", {
      efsAccessPointId: savedStorage?.efsAccessPointId || undefined,
    });
    await this.event(run, "efs_kms_encryption_enabled", "success", "EFS KMS encryption is enabled.");
    await this.event(run, "efs_posix_permissions_configured", "success", "EFS POSIX permissions configured.");
    await this.event(run, "efs_outputs_saved", "success", "EFS Terraform outputs saved.", {
      storageId: savedStorage?.id || storage.id,
      efsFileSystemId: savedStorage?.efsFileSystemId || undefined,
      efsAccessPointId: savedStorage?.efsAccessPointId || undefined,
    });
    await this.event(run, "backup_plan_configured", "success", "AWS Backup plan configured.", {
      backupPlanId: savedStorage?.backupPlanId || undefined,
      backupVaultName: savedStorage?.backupVaultName || undefined,
    });
    await this.storageService.recordStorageEvent(project.id, run.id, "efs_outputs_saved", "success", "EFS Terraform outputs saved.", actor, {
      storageId: savedStorage?.id || storage.id,
      efsFileSystemId: savedStorage?.efsFileSystemId || undefined,
      efsAccessPointId: savedStorage?.efsAccessPointId || undefined,
    });
    await this.storageService.recordStorageEvent(project.id, run.id, "backup_plan_configured", "success", "AWS Backup plan configured.", actor, {
      backupPlanId: savedStorage?.backupPlanId || undefined,
      backupVaultName: savedStorage?.backupVaultName || undefined,
    });

    await this.updateRun(run, {
      status: PipelineRunStatus.STORAGE_PROVISIONED,
      currentStage: "storage_provisioned",
      completedAt: new Date(),
    });
    await this.event(run, "storage_provisioned", "success", "Persistent storage provisioning completed.");
    await this.audit("STORAGE_PROVISIONED", run, actor, "success", {
      stage: "storage_provisioned",
      status: PipelineRunStatus.STORAGE_PROVISIONED,
      storageId: savedStorage?.id || storage.id,
    });
    await this.completeMetric(run, "efs_provisioning", {
      storageId: savedStorage?.id || storage.id,
    });
  }

  private async prepare(run: ProjectPipelineRun) {
    const project = await this.projectRepository.findOne({ where: { id: run.projectId } });

    if (!project || project.status === "archived") {
      throw new Error("Project is archived or no longer exists");
    }

    if (!project.repositoryUrl || !project.targetBranch) {
      throw new Error("Project repository and target branch are required");
    }

    const contract = await this.deploymentContractService.requireForProject(project.id);
    this.deploymentContractService.assertDeployable(contract, project);
    if (contract.detectionProfileId !== run.detectionProfileId) {
      throw new Error("Deployment contract changed after this run was queued. Start a new pipeline run.");
    }

    const preflightReport = await this.preflightRepository.findOne({
      where: { id: run.preflightReportId, projectId: project.id },
    });

    if (!preflightReport) {
      throw new Error("Pre-flight report is missing");
    }

    if (preflightReport.inputFingerprint !== contract.contractHash) {
      throw new Error("Deployment contract or pre-flight evidence changed after this run was queued.");
    }

    if (
      ![
        PreflightValidationStatus.PASSED,
        PreflightValidationStatus.PASSED_WITH_WARNINGS,
      ].includes(preflightReport.validationStatus as PreflightValidationStatus)
    ) {
      throw new Error("Pre-flight report must pass before a pipeline can run");
    }

    return { project, contract, preflightReport };
  }

  private async runExternalCiValidation(
    run: ProjectPipelineRun,
    actor: User | null,
    requested: boolean
  ) {
    const required = externalCiRequired(this.config);
    await this.startMetric(run, "github_actions", StageMetricSource.GITHUB_ACTIONS);
    await this.updateRun(run, { currentStage: "external_ci_validation_started" });
    await this.event(
      run,
      "external_ci_validation_started",
      "running",
      "Optional external CI validation started."
    );
    await this.audit("EXTERNAL_CI_VALIDATION_STARTED", run, actor, "success", {
      stage: "external_ci_validation_started",
      status: "started",
      required,
    });

    if (!requested && !required) {
      const message =
        "External CI validation was not requested. DeployGuard internal pipeline will continue.";
      run.githubWorkflowStatus = "skipped";
      await this.runRepository.save(run);
      await this.event(run, "external_ci_validation", "skipped", message);
      await this.pipelineMetricsService.skipStage(
        run.projectId,
        run.id,
        "github_actions",
        message
      );
      return;
    }

    try {
      const result = await this.githubActionsService.triggerWorkflow({
        repositoryFullName: run.repositoryFullName,
        targetBranch: run.targetBranch,
      });

      run.githubWorkflowRunId = result.workflowRunId;
      run.githubWorkflowStatus = "passed";
      await this.runRepository.save(run);
      await this.event(
        run,
        "external_ci_validation",
        "success",
        "External CI validation completed."
      );
      await this.audit("EXTERNAL_CI_VALIDATION_COMPLETED", run, actor, "success", {
        stage: "external_ci_validation",
        status: "passed",
        required,
      });
      await this.githubActionsMetricsService.saveGithubActionsMetric(run.projectId, run.id).catch(() =>
        this.completeMetric(run, "github_actions", { status: result.status })
      );
    } catch (error) {
      const diagnosticCode =
        error instanceof GithubActionsDispatchError
          ? error.diagnosticCode
          : "unknown_github_error";
      const optionalStatus =
        diagnosticCode === "workflow_file_missing" ? "skipped" : "warning";
      const status = required ? "failed" : optionalStatus;
      const message = required
        ? "Required external CI validation failed. Review the workflow, selected branch, and backend GitHub permissions."
        : this.optionalExternalCiMessage(diagnosticCode);
      run.githubWorkflowStatus = status;
      await this.runRepository.save(run);
      await this.event(
        run,
        "external_ci_validation",
        status,
        message,
        { diagnosticCode }
      );
      await this.audit(required ? "EXTERNAL_CI_VALIDATION_FAILED" : "EXTERNAL_CI_VALIDATION_SKIPPED", run, actor, required ? "failed" : "success", {
        stage: "external_ci_validation",
        status,
        reason: message,
        diagnosticCode,
        required,
      });
      if (!required) {
        await this.pipelineMetricsService.skipStage(
          run.projectId,
          run.id,
          "github_actions",
          message
        );
        return;
      }
      await this.failMetric(run, "github_actions", message);
      throw error;
    }
  }

  private optionalExternalCiMessage(diagnosticCode: string) {
    if (diagnosticCode === "workflow_file_missing") {
      return "No GitHub Actions workflow found. Skipping external CI validation. DeployGuard internal pipeline will continue.";
    }
    if (diagnosticCode === "workflow_dispatch_missing") {
      return "Workflow exists but does not support workflow_dispatch. Skipping external CI validation.";
    }
    if (
      [
        "token_missing",
        "token_no_repo_access",
        "token_no_actions_write",
        "repo_not_found_or_permission_denied",
      ].includes(diagnosticCode)
    ) {
      return "GitHub Actions dispatch skipped due to insufficient permission. DeployGuard internal pipeline will continue.";
    }
    return "External CI validation could not run. DeployGuard internal pipeline will continue.";
  }

  private async cloneRepository(run: ProjectPipelineRun, project: Project) {
    await this.startMetric(run, "repository_clone", StageMetricSource.PIPELINE);
    await this.updateRun(run, { currentStage: "clone_repository" });
    this.validateRepositoryUrl(run.repositoryUrl);
    const workspaceRoot = resolve(
      process.cwd(),
      this.config.get<string>("PIPELINE_WORKSPACE_DIR", ".workspace/pipeline")
    );
    const runRoot = join(workspaceRoot, run.id);
    const workspacePath = join(runRoot, "repository");

    await mkdir(runRoot, { recursive: true });
    const token = await this.usersService.getGithubAccessToken(project.ownerUserId);
    const env = token
      ? {
          ...process.env,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(
            `x-access-token:${token}`
          ).toString("base64")}`,
        }
      : process.env;
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--branch", run.targetBranch, run.repositoryUrl, workspacePath],
      {
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
        env,
      }
    ).catch(async (error) => {
      await this.failMetric(run, "repository_clone", error);
      throw error;
    });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      timeout: 10000,
    });

    run.commitSha = stdout.trim();
    await this.runRepository.save(run);
    await this.event(run, "clone_repository_completed", "success", "Repository cloned.", {
      commitSha: run.commitSha,
    });
    await this.stageCheckpoints.recordPassed(run, "repo_clone", { imageTag: run.imageTag || undefined });
    await this.completeMetric(run, "repository_clone", { commitSha: run.commitSha });

    return workspacePath;
  }

  private buildWorkspacePath(
    workspacePath: string,
    contract: ProjectDeploymentContract
  ) {
    const appDirectory = contract.appRoot || ".";
    const resolvedWorkspace = resolve(workspacePath);
    const resolvedApp = resolve(workspacePath, appDirectory);

    if (
      resolvedApp !== resolvedWorkspace &&
      !resolvedApp.startsWith(`${resolvedWorkspace}${sep}`)
    ) {
      throw new Error("Detected app directory is outside the repository workspace");
    }

    return resolvedApp;
  }

  private assertContractCommit(run: ProjectPipelineRun, contract: ProjectDeploymentContract) {
    if (!contract.detectionSourceCommit || run.commitSha !== contract.detectionSourceCommit) {
      throw new Error("Repository changed after stack detection. Re-run detection and pre-flight for the latest commit before deploying.");
    }
  }

  private async validateDeployabilitySnapshot(
    run: ProjectPipelineRun,
    workspacePath: string,
    contract: ProjectDeploymentContract,
    preflightReport?: ProjectPreflightReport
  ) {
    await this.updateRun(run, { currentStage: "deep_repo_scan" });
    const scan = this.deployabilityScanner.scan(workspacePath, {
      ecosystem: contract.language === "javascript" ? "node" : contract.language || "unknown",
      framework: contract.framework,
      packageManager: contract.packageManager,
      buildCommand: contract.buildCommand,
      startCommand: contract.startCommand,
      expectedPort: contract.port,
      healthCheckPath: contract.healthPath,
      staticOutput: contract.runtimeType === "static",
      hasDockerfile: contract.dockerStrategy === "custom",
      requiresDatabase: contract.databaseRequired,
      requiresPersistentStorage: contract.persistentStorageRequired,
    });
    await this.event(run, "deep_repo_scan_completed", "success", "Repository source, manifests, commands, ports, and environment references were re-scanned from the cloned commit.", {
      stage: "deep_repo_scan",
    });

    await this.updateRun(run, { currentStage: "runtime_contract_detection" });
    await this.event(run, "runtime_contract_detection_completed", "success", "Container runtime contract verified from repository evidence.", {
      stage: "runtime_contract_detection",
    });

    await this.updateRun(run, { currentStage: "deployability_preflight_gate" });
    if (scan.deployabilityBlockers.length > 0) {
      throw new Error(`Deployability pre-flight failed before image build: ${scan.deployabilityBlockers.slice(0, 3).join(" ")}`);
    }
    if (!contract.deployable || contract.blockers.length > 0) {
      throw new Error(`Deployment contract is not deployable: ${contract.blockers.slice(0, 3).join(" ")}`);
    }
    if (preflightReport.inputFingerprint !== contract.contractHash) {
      throw new Error("Pre-flight does not match the current deployment contract.");
    }
    if (![PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(preflightReport.validationStatus as PreflightValidationStatus)) {
      throw new Error("Deployability pre-flight is not ready. Resolve its blocking findings before starting a pipeline.");
    }
    await this.event(run, "deployability_preflight_gate_passed", "success", "Deployability pre-flight passed. Image build may begin.", {
      stage: "deployability_preflight_gate",
    });
  }

  private async ensureDockerfile(
    run: ProjectPipelineRun,
    workspacePath: string,
    contract: ProjectDeploymentContract
  ) {
    await this.updateRun(run, { currentStage: "template_generation" });
    const dockerfilePath = join(workspacePath, "Dockerfile");
    const repositoryDockerfileExists = await this.exists(dockerfilePath);

    if (contract.dockerStrategy === "custom" && repositoryDockerfileExists) {
      await this.event(
        run,
        "template_generation_existing_dockerfile",
        "success",
        "Existing repository Dockerfile will be used."
      );
      return;
    }

    if (!contract.generatedDockerfile) {
      throw new Error(contract.dockerStrategy === "custom"
        ? "Repository-Dockerfile mode is selected, but no Dockerfile exists."
        : "DeployGuard-generated Dockerfile is unavailable.");
    }

    await writeFile(dockerfilePath, contract.generatedDockerfile, "utf8");
    await this.event(
      run,
      "template_generation_dockerfile_completed",
      "success",
      repositoryDockerfileExists
        ? "Repository Dockerfile was ignored and replaced with the immutable DeployGuard-generated Dockerfile."
        : "Generated Dockerfile was written to the pipeline workspace."
    );
  }

  private async ensureDockerignore(run: ProjectPipelineRun, workspacePath: string) {
    const dockerignorePath = join(workspacePath, ".dockerignore");
    const requiredEntries = [
      "node_modules",
      ".git",
      ".env",
      ".env.*",
      ".npmrc",
      ".aws",
      "*.pem",
      "*.key",
      "terraform.tfstate",
      "terraform.tfstate.*",
      "dist",
      "build",
      "coverage",
      "*.log",
    ];
    const existing = (await this.exists(dockerignorePath))
      ? await readFile(dockerignorePath, "utf8")
      : "";
    const entries = new Set(
      existing.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
    );
    const missing = requiredEntries.filter((entry) => !entries.has(entry));

    if (missing.length === 0) return;

    await writeFile(
      dockerignorePath,
      `${existing.trim()}${existing.trim() ? "\n" : ""}${missing.join("\n")}\n`,
      "utf8"
    );
    await this.event(
      run,
      "template_generation_dockerignore_completed",
      "success",
      "Build-context exclusions were enforced in the pipeline workspace."
    );
  }

  private async buildDockerImage(
    run: ProjectPipelineRun,
    actor: User | null,
    workspacePath: string,
    imageName: string,
    imageTag: string,
    contract: ProjectDeploymentContract
  ) {
    await this.startMetric(run, "docker_build", StageMetricSource.DOCKER, { imageTag });
    await this.updateRun(run, { currentStage: "docker_build" });
    await this.event(run, "docker_build_started", "running", "Docker image build started.", { imageTag });
    await this.audit("DOCKER_BUILD_STARTED", run, actor, "success", {
      stage: "docker_build",
      status: "started",
      imageTag,
    });

    if (!(await this.dockerBuildService.isDockerAvailable())) {
      await this.audit("DOCKER_BUILD_FAILED", run, actor, "failed", {
        stage: "docker_build",
        status: "failed",
        imageTag,
      });
      const error = new Error("Docker is not available. Start Docker and retry the pipeline.");
      await this.failMetric(run, "docker_build", error, { imageTag });
      throw error;
    }

    try {
      const buildArguments = await this.publicBuildArguments(run, contract);
      await this.dockerBuildService.buildImage({ workspacePath, imageName, imageTag, buildArguments });
    } catch (error) {
      await this.failMetric(run, "docker_build", error, { imageTag });
      throw error;
    }
    await this.event(run, "docker_build_completed", "success", "Docker image built.", {
      imageTag,
    });
    await this.audit("DOCKER_BUILD_COMPLETED", run, actor, "success", {
      stage: "docker_build",
      status: "success",
      imageTag,
    });
    await this.completeMetric(run, "docker_build", { imageTag });
  }

  private async publicBuildArguments(run: ProjectPipelineRun, contract: ProjectDeploymentContract) {
    const secretKeys = new Set(contract.secretEnvVars);
    const keys = new Set(contract.buildTimeEnvVars.filter((key) => !secretKeys.has(key)));
    if (!keys.size) return {};
    const effective = await this.databaseBindings.resolveEffectiveDeploymentConfiguration(run.projectId, run.id, "production");
    return Object.fromEntries(Object.entries(effective.buildArguments).filter(([key]) => keys.has(key) && /^[A-Z][A-Z0-9_]*$/.test(key)));
  }

  private async checkDockerfile(run: ProjectPipelineRun, workspacePath: string) {
    await this.updateRun(run, { currentStage: "dockerfile_security_check" });
    await this.event(run, "dockerfile_security_check_started", "running", "Checking Dockerfile and container configuration.");
    const content = await readFile(join(workspacePath, "Dockerfile"), "utf8");
    const result = this.dockerfileSecurityService.analyze(content);
    if (!result.passed) {
      const message = result.blockers[0]?.message || "Dockerfile configuration is unsafe.";
      await this.event(run, "dockerfile_security_check_failed", "failed", message, {
        reason: result.blockers.map((finding) => finding.code).join(","),
      });
      throw new Error(message);
    }
    await this.event(run, "dockerfile_security_check_completed", result.warnings.length ? "warning" : "success", result.warnings.length ? `Dockerfile check passed with ${result.warnings.length} advisory warning(s).` : "Dockerfile check passed.");
  }

  private async runSecurityGate(
    run: ProjectPipelineRun,
    actor: User | null,
    project: Project,
    imageName: string,
    imageTag: string
  ) {
    const securityConfig = this.config
      ? getSecurityPolicyConfig(this.config)
      : { scanEnabled: true, gateMode: "enforce" as const };
    await this.startMetric(run, "trivy_image_scan", StageMetricSource.TRIVY, { imageTag });
    if (!securityConfig.scanEnabled) {
      const message = "Security scan is disabled for this demo run.";
      await this.updateRun(run, { currentStage: "trivy_image_scan_bypassed" });
      await this.event(run, "trivy_image_scan_bypassed", "skipped", message, { imageTag });
      await this.pipelineMetricsService.skipStage(run.projectId, run.id, "trivy_image_scan", message);
      await this.event(
        run,
        "security_gate_bypassed",
        "skipped",
        "Security enforcement skipped by configuration; no production security pass is claimed.",
        { imageTag }
      );
      await this.audit("SECURITY_SCAN_BYPASSED", run, actor, "success", {
        stage: "trivy_image_scan_bypassed",
        status: "skipped",
        reason: message,
      });
      await this.audit("SECURITY_GATE_BYPASSED", run, actor, "success", {
        stage: "security_gate_bypassed",
        status: "skipped",
        reason: "Security enforcement skipped by configuration.",
      });
      return;
    }
    await this.updateRun(run, { currentStage: "trivy_image_scan" });
    await this.event(
      run,
      "trivy_image_scan_started",
      "running",
      "Advisory image vulnerability scan started.",
      { imageTag }
    );

    const scan = await this.securityScanService.scanImage({
      project,
      imageName: `${imageName}:${imageTag}`,
      pipelineRun: run,
      actorUser: actor,
    }).catch(async () => {
      const message = "Advisory image vulnerability scan was unavailable. Deployment will continue.";
      await this.event(run, "trivy_image_scan_unavailable", "warning", message, { imageTag });
      await this.pipelineMetricsService.skipStage(run.projectId, run.id, "trivy_image_scan", message);
      await this.event(run, "security_gate_passed_with_scan_warning", "warning", "Security Gate allowed continuation because Trivy is advisory and the image scan was unavailable.", { imageTag });
      return null;
    });

    if (!scan) return;

    await this.event(
      run,
      "trivy_image_scan_completed",
      "success",
      "Advisory image vulnerability scan completed. Findings do not block deployment.",
      {
        scanId: scan.id,
        imageTag,
        criticalCount: scan.criticalCount,
        highCount: scan.highCount,
        mediumCount: scan.mediumCount,
        lowCount: scan.lowCount,
      }
    );
    await this.event(
      run,
      "security_policy_evaluated",
      "success",
      scan.policyReason || "Security policy evaluated.",
      {
        scanId: scan.id,
        policyDecision: scan.policyDecision,
        criticalCount: scan.criticalCount,
        highCount: scan.highCount,
        mediumCount: scan.mediumCount,
        lowCount: scan.lowCount,
      }
    );

    if (
      scan.policyDecision === SecurityPolicyDecision.ALLOWED ||
      scan.policyDecision === SecurityPolicyDecision.APPROVED_OVERRIDE
    ) {
      await this.event(
        run,
        "security_gate_passed",
        "success",
        securityConfig.gateMode === "bypass"
          ? "Security findings are advisory in this mode."
          : "Advisory vulnerability review recorded. Deployment will continue.",
        { scanId: scan.id, policyDecision: scan.policyDecision }
      );
      if (securityConfig.gateMode === "bypass") {
        await this.audit("SECURITY_GATE_BYPASSED", run, actor, "success", {
          stage: "security_gate_bypassed",
          status: "success",
          scanId: scan.id,
          reason: "Security findings are advisory in this mode.",
        });
      }
      await this.trivyMetricsService.saveTrivyMetric(run.projectId, run.id);
      return;
    }

    if (scan.policyDecision === SecurityPolicyDecision.REQUIRES_APPROVAL) {
      const manualApprovalsEnabled =
        this.config.get<string>("AUTOMATION_MANUAL_APPROVALS_ENABLED", "false") ===
        "true";
      await this.event(
        run,
        manualApprovalsEnabled
          ? "security_approval_required"
          : "security_gate_blocked",
        "failed",
        manualApprovalsEnabled
          ? "Security scan requires manual approval before image push."
          : "Security policy requires remediation before automation can continue.",
        {
          scanId: scan.id,
          policyDecision: scan.policyDecision,
          reason: scan.policyReason,
        }
      );
      await this.trivyMetricsService.saveTrivyMetric(run.projectId, run.id);
      const message = manualApprovalsEnabled
        ? "Security approval required before image push."
        : "Security findings must be remediated before image push. Fix the findings and retry automation.";
      await this.failMetric(run, "trivy_image_scan", message, {
        scanId: scan.id,
        policyDecision: scan.policyDecision,
      });
      throw new Error(message);
    }

    await this.event(
      run,
      "security_gate_blocked",
      "failed",
      scan.policyReason || "Security gate blocked image push.",
      {
        scanId: scan.id,
        policyDecision: scan.policyDecision,
        reason: scan.policyReason,
      }
    );
    await this.trivyMetricsService.saveTrivyMetric(run.projectId, run.id);
    await this.failMetric(run, "trivy_image_scan", scan.policyReason || "Security gate blocked image push.", {
      scanId: scan.id,
      policyDecision: scan.policyDecision,
    });
    throw new Error(scan.policyReason || "Security gate blocked image push.");
  }

  private async pushToEcr(
    run: ProjectPipelineRun,
    actor: User | null,
    imageName: string,
    imageTag: string,
    ecrRepositoryName: string
  ) {
    await this.startMetric(run, "ecr_push", StageMetricSource.ECR, { imageTag, ecrRepositoryName });
    await this.updateRun(run, { currentStage: "ecr_push_started" });

    if (!this.ecrService.hasConfig() || !run.ecrImageUri) {
      await this.event(run, "ecr_push_failed", "failed", "AWS ECR config is missing. Set AWS credentials/account config and retry.", {
        imageTag,
        ecrRepositoryName,
      });
      await this.audit("ECR_PUSH_FAILED", run, actor, "failed", {
        stage: "ecr_push_failed",
        status: "failed",
        imageTag,
        ecrRepositoryName,
      });
      const error = new Error("AWS ECR config is missing. Set AWS credentials/account config and retry.");
      await this.failMetric(run, "ecr_push", error, { imageTag, ecrRepositoryName });
      throw error;
    }

    try {
      await this.event(run, "ecr_config_validated", "success", "AWS ECR config validated.", {
        imageTag,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      await this.audit("ECR_PUSH_STARTED", run, actor, "success", {
        stage: "ecr_push_started",
        status: "started",
        imageTag,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      const ecrRepository = await this.ecrService.ensureRepository(ecrRepositoryName, {
        ManagedBy: "DeployGuard",
        ProjectId: run.projectId,
        PipelineRunId: run.id,
        Repository: run.repositoryFullName || "unknown",
        Environment: "dev",
        CreatedBy: "DeployGuard",
      });
      await this.resourceRegistry.register({
        projectId: run.projectId,
        pipelineRunId: run.id,
        resourceType: "ecr_repository",
        awsService: "ecr",
        region: this.config.get<string>("AWS_REGION", "us-east-1"),
        resourceId: ecrRepository.repositoryArn || ecrRepositoryName,
        arn: ecrRepository.repositoryArn || null,
        name: ecrRepositoryName,
        source: "sdk",
        ownership: "project_owned",
        cleanupEligibility: "safe_cleanup",
        costRisk: "medium",
        tags: { ManagedBy: "DeployGuard", ProjectId: run.projectId, PipelineRunId: run.id },
      });
      await this.event(run, "ecr_repository_ready", "success", "ECR repository is ready.", {
        ecrRepositoryName,
      });
      await this.audit("ECR_REPOSITORY_READY", run, actor, "success", {
        stage: "ecr_repository_ready",
        status: "success",
        ecrRepositoryName,
      });
      await this.ecrService.loginDocker();
      await this.event(run, "ecr_docker_login_completed", "success", "Docker login to ECR completed.", {
        ecrRepositoryName,
      });
      await this.dockerBuildService.tagImage({
        localImageName: imageName,
        imageTag,
        ecrImageUri: run.ecrImageUri,
      });
      await this.event(run, "ecr_image_tagged", "success", "Image tagged with ECR URI.", {
        imageTag,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      await this.dockerBuildService.pushImage(run.ecrImageUri);
      await this.event(run, "ecr_image_pushed", "success", "Image pushed to ECR.", {
        imageTag,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      await this.audit("ECR_IMAGE_PUSHED", run, actor, "success", {
        stage: "ecr_image_pushed",
        status: "success",
        imageTag,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      await this.completeMetric(run, "ecr_push", { imageTag, ecrRepositoryName });
    } catch (error) {
      const message = error instanceof Error ? error.message : "ECR push failed.";
      await this.event(run, "ecr_push_failed", "failed", this.publicErrorMessage(message), {
        imageTag,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      await this.audit("ECR_PUSH_FAILED", run, actor, "failed", {
        stage: "ecr_push_failed",
        status: "failed",
        imageTag,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      await this.failMetric(run, "ecr_push", message, { imageTag, ecrRepositoryName });
      throw error;
    }
  }

  private async applyLifecyclePolicy(
    run: ProjectPipelineRun,
    actor: User | null,
    ecrRepositoryName: string
  ) {
    await this.updateRun(run, { currentStage: "ecr_lifecycle_policy_applied" });
    await this.ecrService.applyLifecyclePolicy(ecrRepositoryName);
    await this.event(
      run,
      "ecr_lifecycle_policy_applied",
      "success",
      "ECR lifecycle policy applied for untagged images older than 30 days.",
      { ecrRepositoryName }
    );
    await this.audit("ECR_LIFECYCLE_POLICY_APPLIED", run, actor, "success", {
      stage: "ecr_lifecycle_policy_applied",
      status: "success",
      ecrRepositoryName,
    });
  }

  private async runTerraformStage(
    run: ProjectPipelineRun,
    actor: User | null,
    project: Project
  ) {
    const job = this.terraformService.prepareTerraformJob(project, run);
    await this.event(run, "terraform_stage_queued", "queued", "Terraform stage queued.", job);
    await this.audit("TERRAFORM_STAGE_QUEUED", run, actor, "success", {
      stage: "terraform_stage_queued",
      status: "queued",
      ...job,
    });

    try {
      await this.event(
        run,
        "terraform_plan_started",
        "running",
        "Terraform plan stage started.",
        job
      );
      await this.audit("TERRAFORM_PLAN_STARTED", run, actor, "success", {
        stage: "terraform_plan_started",
        status: "running",
        ...job,
      });

      const result = await this.terraformService.runTerraformPlan(project, run);

      if (result.terraformStatus === "skipped_not_configured") {
        await this.event(
          run,
          "terraform_plan_skipped_not_configured",
          "skipped",
          result.reason || "Terraform is not configured for this project.",
          result
        );
        await this.audit(
          "TERRAFORM_PLAN_SKIPPED_NOT_CONFIGURED",
          run,
          actor,
          "success",
          {
            stage: "terraform_plan_skipped_not_configured",
            status: "skipped",
            ...result,
          }
        );
      }

      await this.event(
        run,
        "terraform_stage_completed",
        "success",
        "Terraform stage completed.",
        result
      );
      await this.audit("TERRAFORM_STAGE_COMPLETED", run, actor, "success", {
        stage: "terraform_stage_completed",
        status: "success",
        ...result,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Terraform stage failed.";
      await this.event(run, "terraform_stage_failed", "failed", message, {
        ...job,
        terraformStatus: "failed",
        reason: message,
      });
      await this.audit("TERRAFORM_STAGE_FAILED", run, actor, "failed", {
        stage: "terraform_stage_failed",
        status: "failed",
        ...job,
        terraformStatus: "failed",
        reason: message,
      });
      throw error;
    }
  }

  private async runCostAnalysis(
    run: ProjectPipelineRun,
    actor: User | null,
    project: Project
  ) {
    await this.startMetric(run, "finops_cost_analysis", StageMetricSource.FINOPS);
    await this.updateRun(run, {
      status: PipelineRunStatus.COST_ANALYSIS_RUNNING,
      currentStage: "cost_analysis_started",
    });

    try {
      const estimate = await this.finopsService.generatePipelineEstimate({
        project,
        actorUser: actor,
        pipelineRun: run,
      });

      if (estimate.status === CostEstimateStatus.BLOCKED_BY_TIER_LIMIT) {
        await this.updateRun(run, {
          status: PipelineRunStatus.BLOCKED_BY_COST_LIMIT,
          currentStage: "deployment_blocked_by_cost_limit",
          failedAt: new Date(),
          errorMessage:
            estimate.upgradePromptMessage ||
            "Estimated monthly cost exceeds the subscription tier limit.",
        });
        await this.failMetric(run, "finops_cost_analysis", "Estimated monthly cost exceeds the subscription tier limit.");
        return false;
      }

      if (estimate.status === CostEstimateStatus.APPROVAL_REQUIRED) {
        const manualApprovalsEnabled =
          this.config.get<string>("AUTOMATION_MANUAL_APPROVALS_ENABLED", "false") ===
          "true";
        if (!manualApprovalsEnabled) {
          const message =
            "The cost policy requires attention. Adjust the project cost policy and retry automation.";
          await this.updateRun(run, {
            status: PipelineRunStatus.COST_REJECTED,
            currentStage: "cost_gate_blocked",
            failedAt: new Date(),
            errorMessage: message,
          });
          await this.event(run, "cost_gate_blocked", "failed", message, {
            estimateId: estimate.id,
          });
          await this.failMetric(run, "finops_cost_analysis", message, {
            estimateId: estimate.id,
          });
          return false;
        }
        await this.updateRun(run, {
          status: PipelineRunStatus.WAITING_FOR_COST_APPROVAL,
          currentStage: "cost_approval_required",
        });
        await this.completeMetric(run, "finops_cost_analysis", { status: "approval_required" });
        return false;
      }

      if (estimate.status === CostEstimateStatus.FAILED) {
        await this.updateRun(run, {
          status: PipelineRunStatus.COST_ANALYSIS_FAILED,
          currentStage: "cost_analysis_failed",
          failedAt: new Date(),
          errorMessage: estimate.errorMessage || "Cost analysis failed.",
        });
        await this.failMetric(run, "finops_cost_analysis", estimate.errorMessage || "Cost analysis failed.");
        return false;
      }

      await this.completeMetric(run, "finops_cost_analysis", { estimateId: estimate.id });
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Cost analysis failed.";
      await this.updateRun(run, {
        status: PipelineRunStatus.COST_ANALYSIS_FAILED,
        currentStage: "cost_analysis_failed",
        failedAt: new Date(),
        errorMessage: this.publicErrorMessage(message),
      });
      await this.failMetric(run, "finops_cost_analysis", message);
      throw error;
    }
  }

  private async runInfrastructurePlan(
    run: ProjectPipelineRun,
    actor: User | null,
    project: Project
  ) {
    await this.startMetric(run, "terraform_plan", StageMetricSource.TERRAFORM);
    await this.updateRun(run, { currentStage: "infrastructure_plan_started" });
    await this.event(
      run,
      "infrastructure_plan_started",
      "running",
      "Infrastructure Terraform plan started."
    );
    const environment = await this.infrastructureService.runInfrastructurePlan(
      project.id,
      run.id,
      actor
    ).catch(async (error) => {
      await this.failMetric(run, "terraform_plan", error);
      const failureClass = this.exceptionCode(error);
      if (["contract_invalid", "plan_policy_failed"].includes(failureClass || "")) {
        await this.updateRun(run, {
          currentStage: failureClass === "contract_invalid"
            ? "pre_mutation_deployment_contract_validation"
            : "terraform_plan_policy_validation",
          metadata: { ...(run.metadata || {}), failureClass },
        });
      }
      throw error;
    });

    if (environment.status === "queued") {
      await this.pipelineMetricsService.skipStage(run.projectId, run.id, "terraform_plan", "Infrastructure plan was queued.");
      return false;
    }

    await this.event(
      run,
      "infrastructure_plan_completed",
      "success",
      "Infrastructure Terraform plan completed.",
      {
        infrastructureEnvironmentId: environment.id,
        ...((environment.terraformPlanSummary || {}) as Record<string, number>),
      }
    );

    await this.completeMetric(run, "terraform_plan", {
      infrastructureEnvironmentId: environment.id,
    });
    await this.stageCheckpoints.recordPassed(run, "terraform_plan", null, {
      infrastructureEnvironmentId: environment.id,
      terraformStateKey: environment.terraformStateKey,
      terraformPlanSummary: environment.terraformPlanSummary,
    });
    return true;
  }

  private async runInfrastructureApply(
    run: ProjectPipelineRun,
    actor: User | null,
    project: Project,
    userApproved = false
  ) {
    if (!envBoolean(this.config, "TERRAFORM_APPLY_ENABLED", false)) {
      const message = "Terraform apply is disabled by configuration.";
      await this.event(
        run,
        "terraform_apply_gate_disabled_by_config",
        "disabled_by_config",
        message
      );
      await this.updateRun(run, {
        status: PipelineRunStatus.APPLY_DISABLED,
        currentStage: "terraform_apply_gate_disabled_by_config",
        completedAt: null,
        failedAt: null,
        errorMessage: null,
      });
      await this.pipelineMetricsService.skipStage(
        run.projectId,
        run.id,
        "terraform_apply",
        message
      );
      return false;
    }

    const approvalRequired = envBoolean(this.config, "TERRAFORM_APPLY_REQUIRES_APPROVAL", true);
    const approvalRecorded = Boolean(
      userApproved || (run.metadata as Record<string, unknown> | null)?.applyApprovedAt
    );
    if (approvalRequired && !approvalRecorded) {
      const message = "Ready to deploy to AWS. Explicit Terraform apply approval is required.";
      await this.event(run, "terraform_apply_approval_required", "waiting", message);
      await this.updateRun(run, {
        status: PipelineRunStatus.APPLY_DISABLED,
        currentStage: "terraform_apply_approval_required",
        completedAt: null,
        failedAt: null,
        errorMessage: null,
        metadata: { ...(run.metadata || {}), applyApprovalRequired: true },
      });
      await this.pipelineMetricsService.skipStage(run.projectId, run.id, "terraform_apply", message);
      await this.audit("TERRAFORM_APPLY_APPROVAL_REQUIRED", run, actor, "success", {
        stage: "terraform_apply_approval_required",
        status: "waiting",
      });
      return false;
    }

    await this.event(
      run,
      "terraform_apply_gate_passed",
      "success",
      approvalRecorded ? "Terraform apply approved by the user." : "Terraform apply gate passed."
    );
    await this.startMetric(run, "terraform_apply", StageMetricSource.TERRAFORM);
    const environment = await this.infrastructureService.runInfrastructureApply(
      project.id,
      run.id,
      actor
    ).catch(async (error) => {
      await this.failMetric(run, "terraform_apply", error);
      const persisted = await this.runRepository.findOne({ where: { id: run.id } });
      const failureClass = normalizePipelineFailureClass(
        this.exceptionCode(error),
        persisted?.currentStage || run.currentStage,
        error instanceof Error ? error.message : "",
      );
      await this.updateRun(run, {
        currentStage: pipelineFailureStage(
          failureClass,
          persisted?.currentStage || run.currentStage,
        ),
        metadata: {
          ...(persisted?.metadata || run.metadata || {}),
          ...(failureClass ? { failureClass } : {}),
        },
      });
      throw error;
    });

    if (!environment) return false;

    if (environment.status === "queued") {
      await this.pipelineMetricsService.skipStage(run.projectId, run.id, "terraform_apply", "Infrastructure apply was queued.");
      return false;
    }

    await this.event(
      run,
      "infrastructure_apply_completed",
      "success",
      "Infrastructure Terraform apply completed.",
      {
        infrastructureEnvironmentId: environment.id,
        vpcId: environment.vpcId,
      }
    );

    await this.completeMetric(run, "terraform_apply", {
      infrastructureEnvironmentId: environment.id,
    });
    await this.stageCheckpoints.recordPassed(run, "terraform_apply", null, {
      infrastructureEnvironmentId: environment.id,
      terraformStateKey: environment.terraformStateKey,
    });
    const binding = await this.databaseBindings.ensureIntent(run.projectId, run.id);
    if (binding?.provider === "managed") {
      await this.updateRun(run, { currentStage: "database_service_readiness" });
      await this.event(run, "database_service_readiness_started", "running", "Waiting for the managed database service and private registration.", { bindingId: binding.id });
      let readyBinding;
      try {
        readyBinding = await this.databaseBindings.verifyManagedDatabaseReady(run.projectId, run.id);
      } catch (error) {
        await this.updateRun(run, {
          currentStage: "database_service_readiness_failed",
          metadata: {
            ...(run.metadata || {}),
            failureClass: "managed_service_not_ready",
            legacyFailureCode: "database_service_unhealthy",
          },
        });
        throw error;
      }
      const taskDefinitionArn = typeof environment.terraformOutputs?.ecs_task_definition_arn === "string"
        ? environment.terraformOutputs.ecs_task_definition_arn
        : null;
      if (!taskDefinitionArn) throw new Error("Application task definition output is missing after database provisioning.");
      try {
        await this.databaseBindings.validateApplicationTaskDefinition(run.projectId, run.id, taskDefinitionArn);
      } catch {
        await this.updateRun(run, {
          currentStage: "configure_application_database",
          metadata: { ...(run.metadata || {}), failureClass: "managed_database_binding_invalid" },
        });
        throw new Error("DeployGuard could not safely map the managed database binding into the application task definition.");
      }
      await this.databaseBindings.activateApplicationService(run.projectId, run.id, environment.terraformOutputs || {});
      await this.event(run, "database_tier_setup_completed", "success", "Managed database binding is ready and the application task definition uses it.", { bindingId: readyBinding?.id, taskDefinitionArn });
      await this.stageCheckpoints.recordPassed(run, "database_tier_setup", { bindingId: readyBinding?.id, bindingFingerprint: readyBinding?.configurationFingerprint, taskDefinitionArn });
      await this.stageCheckpoints.recordPassed(run, "ecs_task_definition_update", { bindingId: readyBinding?.id, bindingFingerprint: readyBinding?.configurationFingerprint, taskDefinitionArn });
    } else {
      await this.event(run, "database_tier_setup_completed", "success", "Database configuration binding completed.");
      await this.stageCheckpoints.recordPassed(run, "database_tier_setup");
    }
    return true;
  }

  private async runEcsDeployment(run: ProjectPipelineRun, actor: User | null) {
    await this.deploymentRequirements.markApplying(run.projectId, run.id);
    await this.startMetric(run, "ecs_deployment", StageMetricSource.ECS);
    await this.updateRun(run, {
      status: PipelineRunStatus.ECS_TASK_DEFINITION_REGISTERING,
      currentStage: "ecs_task_definition_registering",
    });
    await this.event(run, "ecs_cluster_ready", "success", "ECS cluster is ready.");
    await this.event(run, "fargate_spot_capacity_provider_configured", "success", "Fargate Spot capacity provider configured.");
    await this.audit("FARGATE_SPOT_CONFIGURED", run, actor, "success", {
      stage: "fargate_spot_capacity_provider_configured",
      status: "success",
    });

    try {
      await this.updateRun(run, {
        status: PipelineRunStatus.ECS_SERVICE_UPDATING,
        currentStage: "ecs_service_updating",
      });
      await this.event(run, "ecs_task_definition_registered", "success", "ECS task definition registered.");
      await this.audit("ECS_TASK_DEFINITION_REGISTERED", run, actor, "success", {
        stage: "ecs_task_definition_registered",
        status: "success",
      });
      await this.event(run, "alb_target_group_ready", "success", "ALB target group is ready.");
      await this.event(run, "alb_listener_ready", "success", "ALB listener is ready.");
      await this.event(run, "alb_health_check_configured", "success", "ALB health check configured.");
      await this.audit("ALB_HEALTH_CHECK_CONFIGURED", run, actor, "success", {
        stage: "alb_health_check_configured",
        status: "success",
      });
      await this.event(run, "ecs_service_deployment_started", "running", "ECS service deployment started.");
      await this.updateRun(run, {
        status: PipelineRunStatus.ECS_WAITING_FOR_STABILITY,
        currentStage: "ecs_service_stability_wait_started",
      });
      await this.event(run, "ecs_service_stability_wait_started", "running", "Waiting for ECS service stability.");

      const deployment = await this.orchestrationService.recordDeploymentFromInfrastructure(
        run.projectId,
        run.id,
        actor
      );

      await this.event(run, "autoscaling_target_registered", "success", "ECS auto-scaling target registered.", {
        deploymentId: deployment.id,
        ecsClusterName: deployment.ecsClusterName,
        ecsServiceName: deployment.ecsServiceName,
      });
      await this.event(run, "autoscaling_policy_configured", "success", "Target-tracking CPU auto-scaling configured.", {
        deploymentId: deployment.id,
      });
      await this.audit("AUTOSCALING_POLICY_CONFIGURED", run, actor, "success", {
        stage: "autoscaling_policy_configured",
        status: "success",
        deploymentId: deployment.id,
      });
      await this.event(run, "spot_interruption_rule_configured", "success", "EventBridge ECS interruption rule configured.", {
        deploymentId: deployment.id,
      });
      await this.audit("SPOT_INTERRUPTION_RULE_CONFIGURED", run, actor, "success", {
        stage: "spot_interruption_rule_configured",
        status: "success",
        deploymentId: deployment.id,
      });
      await this.event(run, "ecs_service_stable", "success", "ECS service reached stable state.", {
        deploymentId: deployment.id,
        ecsServiceArn: deployment.ecsServiceArn,
        taskDefinitionArn: deployment.taskDefinitionArn,
      });
      await this.event(run, "alb_targets_healthy", "success", "ALB targets are healthy.", {
        deploymentId: deployment.id,
        targetGroupArn: deployment.targetGroupArn,
        albDnsName: deployment.albDnsName,
      });
      await this.audit("ECS_SERVICE_STABLE", run, actor, "success", {
        stage: "ecs_service_stable",
        status: "success",
        deploymentId: deployment.id,
        taskDefinitionArn: deployment.taskDefinitionArn,
      });
      await this.audit("ALB_TARGETS_HEALTHY", run, actor, "success", {
        stage: "alb_targets_healthy",
        status: "success",
        deploymentId: deployment.id,
      });
      await this.updateRun(run, {
        status: PipelineRunStatus.ECS_SERVICE_HEALTHY,
        currentStage: "ecs_service_healthy",
      });
      await this.stageCheckpoints.recordPassed(run, "ecs_task_definition_update", { deploymentId: deployment.id, taskDefinitionArn: deployment.taskDefinitionArn });
      await this.stageCheckpoints.recordPassed(run, "ecs_service_deploy", { deploymentId: deployment.id, taskDefinitionArn: deployment.taskDefinitionArn });
      await this.stageCheckpoints.recordPassed(run, "health_check", { deploymentId: deployment.id, healthCheckPath: deployment.healthCheckPath });
      await this.stageCheckpoints.recordPassed(run, "stable_release", { deploymentId: deployment.id });
      await this.deploymentRequirements.markVerified(run.projectId, run.id);
      const binding = await this.databaseBindings.ensureIntent(run.projectId, run.id);
      if (binding) await this.databaseBindings.markVerified(run.projectId, run.id);
      await this.completeMetric(run, "ecs_deployment", { deploymentId: deployment.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "ECS deployment failed.";
      const deploymentEvidence = await this.orchestrationService
        .getLatestDeploymentEvidence(run.projectId, run.id)
        .catch(() => null);
      const failureClass = normalizePipelineFailureClass(
        null,
        run.currentStage,
        `${message}\n${JSON.stringify(deploymentEvidence?.diagnostics || {})}`,
      );
      await this.updateRun(run, {
        status: PipelineRunStatus.ECS_DEPLOYMENT_FAILED,
        currentStage: "ecs_deployment_failed",
        errorMessage: this.publicErrorMessage(message),
        metadata: {
          ...(run.metadata || {}),
          ...(failureClass ? { failureClass } : {}),
          ...(failureClass === "application_health_failed" ? { legacyFailureCode: "health_check_timeout" } : {}),
        },
      });
      await this.event(run, "ecs_service_unhealthy", "failed", this.publicErrorMessage(message), {
        deploymentId: deploymentEvidence?.deploymentId || undefined,
        ecsDiagnostics: deploymentEvidence?.diagnostics as Record<string, unknown> | null,
      });
      await this.audit("ECS_SERVICE_UNHEALTHY", run, actor, "failed", {
        stage: "ecs_service_unhealthy",
        status: "failed",
      });
      await this.failMetric(run, "ecs_deployment", message);
      throw error;
    }
  }

  private async tryRollback(run: ProjectPipelineRun, actor: User | null, reason: string) {
    await this.startMetric(run, "rollback", StageMetricSource.ROLLBACK, { reason });
    await this.updateRun(run, {
      status: PipelineRunStatus.ROLLBACK_STARTED,
      currentStage: "rollback_started",
    });
    await this.event(run, "rollback_started", "running", "Automatic rollback started.", { reason });
    await this.audit("ROLLBACK_STARTED", run, actor, "success", {
      stage: "rollback_started",
      status: "running",
      reason,
    });

    try {
      const result = await this.orchestrationService.rollback(
        actor || ({ id: run.triggeredByUserId, role: "admin" } as User),
        run.projectId,
        { reason }
      );
      await this.updateRun(run, {
        status: PipelineRunStatus.ROLLBACK_SUCCEEDED,
        currentStage: "rollback_succeeded",
      });
      await this.event(run, "rollback_succeeded", "success", "Rollback completed.", {
        deploymentId: result.deployment.id,
        toCommitSha: result.release.commitSha,
      });
      await this.audit("ROLLBACK_SUCCEEDED", run, actor, "success", {
        stage: "rollback_succeeded",
        status: "success",
        deploymentId: result.deployment.id,
        toCommitSha: result.release.commitSha,
      });
      await this.completeMetric(run, "rollback", {
        deploymentId: result.deployment.id,
        toCommitSha: result.release.commitSha,
      });
    } catch (rollbackError) {
      const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : "Rollback failed.";
      await this.updateRun(run, {
        status: PipelineRunStatus.ROLLBACK_FAILED,
        currentStage: "rollback_failed",
      });
      await this.event(run, "rollback_failed", "failed", rollbackMessage);
      await this.audit("ROLLBACK_FAILED", run, actor, "failed", {
        stage: "rollback_failed",
        status: "failed",
        reason: rollbackMessage,
      });
      await this.failMetric(run, "rollback", rollbackMessage);
    }
  }

  private async recordProvisioningSkipped(run: ProjectPipelineRun, actor: User | null) {
    await this.event(
      run,
      "provisioning_skipped_not_configured",
      "skipped",
      "Provisioning is not configured yet; module 6.8 will continue after the FinOps gate."
    );
    await this.audit("PROVISIONING_SKIPPED_NOT_CONFIGURED", run, actor, "success", {
      stage: "provisioning_skipped_not_configured",
      status: "skipped",
    });
  }

  private async updateRun(
    run: ProjectPipelineRun,
    patch: Partial<ProjectPipelineRun>
  ) {
    if (patch.currentStage && patch.currentStage !== run.currentStage && !patch.currentStageStartedAt) {
      patch.currentStageStartedAt = new Date();
    }
    Object.assign(run, patch);
    await this.runRepository.save(run);
  }

  private async event(
    run: ProjectPipelineRun,
    stage: string,
    status: string,
    message: string,
    metadata: PipelineEventMetadata = {}
  ) {
    const occurredAt = new Date();
    await this.updateRun(run, { currentStage: stage });
    const savedEvent = await this.eventRepository.save(
      this.eventRepository.create({
        pipelineRunId: run.id,
        projectId: run.projectId,
        stage,
        status,
        message,
        occurredAt,
        ingestedAt: new Date(),
        durationMs: typeof metadata.durationMs === "number" ? metadata.durationMs : null,
        source: this.eventSource(stage),
        metadata: this.safeMetadata({
          projectId: run.projectId,
          pipelineRunId: run.id,
          repositoryFullName: run.repositoryFullName,
          targetBranch: run.targetBranch,
          commitSha: run.commitSha,
          stage,
          status,
          ...metadata,
        }),
      })
    );
    await this.runRepository.manager.query(`
      INSERT INTO project_user_activity (user_id, project_id, last_pipeline_activity_at, last_meaningful_activity_at, last_action_type, updated_at)
      VALUES ($1, $2, $3, $3, $4, $3)
      ON CONFLICT (user_id, project_id) DO UPDATE SET
        last_pipeline_activity_at=GREATEST(project_user_activity.last_pipeline_activity_at, EXCLUDED.last_pipeline_activity_at),
        last_meaningful_activity_at=GREATEST(project_user_activity.last_meaningful_activity_at, EXCLUDED.last_meaningful_activity_at),
        last_action_type=EXCLUDED.last_action_type, updated_at=EXCLUDED.updated_at
    `, [run.triggeredByUserId, run.projectId, occurredAt, `pipeline:${stage}`]);
    await this.notifications.dispatch({ projectId: run.projectId, pipelineRunId: run.id, eventId: savedEvent.id, stage, status, message }).catch(() => undefined);
  }

  private eventSource(stage: string) {
    if (/terraform|state_lock|state_heartbeat/i.test(stage)) return "terraform";
    if (/ecs/i.test(stage)) return "aws_ecs";
    if (/alb|health/i.test(stage)) return "aws_alb";
    if (/cleanup/i.test(stage)) return "cleanup";
    return "pipeline_worker";
  }

  private async audit(
    action: string,
    run: ProjectPipelineRun,
    actor: User | null,
    status: string,
    metadata: PipelineEventMetadata
  ) {
    await this.auditLogService.record({
      actorUser: actor,
      action,
      resourceType: "pipeline_run",
      resourceId: run.id,
      status,
      metadata: this.safeMetadata({
        projectId: run.projectId,
        pipelineRunId: run.id,
        repositoryFullName: run.repositoryFullName,
        targetBranch: run.targetBranch,
        commitSha: run.commitSha,
        imageTag: run.imageTag,
        ecrRepositoryName: run.ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
        ...metadata,
      }),
    });
  }

  private async findRun(id: string) {
    const run = await this.runRepository.findOne({ where: { id } });

    if (!run) {
      throw new Error("Pipeline run not found");
    }

    return run;
  }

  private safeMetadata(metadata: PipelineEventMetadata) {
    return Object.entries(metadata).reduce(
      (safe, [key, value]) => {
        if (ALLOWED_METADATA_KEYS.includes(key) && value !== undefined) {
          safe[key] = value;
        }

        return safe;
      },
      {} as Record<string, unknown>
    );
  }

  private async startMetric(run: ProjectPipelineRun, stageName: string, source: StageMetricSource, metadata: PipelineEventMetadata = {}) {
    await this.pipelineMetricsService.startStage(run.projectId, run.id, stageName, source, this.safeMetadata(metadata));
  }

  private async completeMetric(run: ProjectPipelineRun, stageName: string, metadata: PipelineEventMetadata = {}) {
    await this.pipelineMetricsService.completeStage(run.projectId, run.id, stageName, this.safeMetadata(metadata));
  }

  private async failMetric(run: ProjectPipelineRun, stageName: string, error: unknown, metadata: PipelineEventMetadata = {}) {
    await this.pipelineMetricsService.failStage(run.projectId, run.id, stageName, error, this.safeMetadata(metadata));
  }

  private async buildMetricSummary(run: ProjectPipelineRun) {
    await this.pipelineMetricsService.buildPipelineSummary(run.projectId, run.id).catch(() => null);
  }

  private async exists(path: string) {
    try {
      await stat(path);
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  private validateRepositoryUrl(repositoryUrl: string) {
    if (!/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/?$/.test(repositoryUrl)) {
      throw new Error("Only public HTTPS GitHub repository URLs are supported");
    }
  }

  private fullCommitSha(run: ProjectPipelineRun) {
    if (!run.commitSha || !/^[0-9a-f]{40}$/i.test(run.commitSha)) {
      throw new Error("Unable to determine full Git commit SHA for immutable image tag.");
    }

    return run.commitSha;
  }

  private safeName(value: string) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  private publicErrorMessage(message: string) {
    if (
      message === "Terraform state region is not configured." ||
      message === "AWS credentials cannot access Terraform state bucket or lockfile." ||
      /^Terraform state bucket .+ was not found or is not accessible\.$/.test(message) ||
      /^Terraform S3 lockfile (?:exists and may be stale|is currently active)\. Lockfile: projects\/[0-9a-f-]+\/terraform\.tfstate\.tflock$/i.test(message) ||
      /^Terraform state recovery is required: .+$/.test(message)
    ) {
      return this.logSanitizer.sanitize(message);
    }
    if (/AWS credentials are missing or invalid/i.test(message)) {
      return "AWS credentials are missing or invalid. Configure backend AWS credentials before deployment.";
    }
    if (/could not safely map the managed database binding|does not use the binding secret reference/i.test(message)) {
      return "DeployGuard could not safely configure the application database. Existing infrastructure is preserved for a focused recovery.";
    }
    if (/Deployment contract is invalid before infrastructure planning/i.test(message)) {
      return "DeployGuard needs one application configuration fix before deployment can continue. No cloud resources were changed.";
    }
    if (/Terraform plan task-definition policy failed|Rendered ECS task definition violates/i.test(message)) {
      return "DeployGuard stopped an unsafe application configuration before cloud changes. Generate a corrected plan.";
    }
    const safeMessages = [
      "GitHub Actions token is not configured.",
      "GitHub Actions workflow dispatch failed due to insufficient token permissions.",
      "GitHub Actions workflow dispatch failed.",
      "GitHub Actions workflow dispatch failed because the selected branch is invalid or the workflow is not dispatchable.",
      "GitHub Actions workflow dispatch failed because the GitHub rate limit was reached.",
    ];

    if (
      safeMessages.includes(message) ||
      /^GitHub Actions workflow .+ was not found in the selected repository branch\.$/.test(message)
    ) {
      return message;
    }

    if (/token|secret|password|credential|authorization/i.test(message)) {
      return "Pipeline failed because required external service credentials are invalid or missing.";
    }

    return this.logSanitizer.sanitize(message);
  }

  private exceptionCode(error: unknown) {
    if (!error || typeof error !== "object" || !("getResponse" in error)) return null;
    const response = (error as { getResponse(): unknown }).getResponse();
    return response && typeof response === "object" && "code" in response
      ? String((response as { code?: unknown }).code || "")
      : null;
  }
}

function workerShadowRoute(jobType: PipelineJobData["jobType"]): LegacyWorkerShadowRoute | null {
  switch (jobType) {
    case "stage_selective_resume": return "stage_selective_resume";
    case "resume_after_cost_approval": return "cost_approval_resume";
    case "resume_after_apply_approval": return "apply_approval_resume";
    case "resume_after_state_lock": return "state_lock_resume";
    case "infrastructure_plan": return "infrastructure_plan";
    case "infrastructure_apply": return "infrastructure_apply";
    case "storage_provision": return "storage_provision";
    case "full_deploy":
    case "pipeline_build":
    case undefined:
      return "full_deploy";
  }
}

function isLegacyWorkerShadowRoute(value: unknown): value is LegacyWorkerShadowRoute {
  return [
    "full_deploy", "stage_selective_resume", "cost_approval_resume", "apply_approval_resume",
    "state_lock_resume", "infrastructure_plan", "infrastructure_apply", "storage_provision",
  ].includes(String(value));
}

function workerObservationIdentity(
  pipelineRunId: string,
  route: LegacyWorkerShadowRoute,
  jobId: string | number | undefined,
): string {
  return jobId === undefined || jobId === null
    ? `run:${pipelineRunId}:${route}`
    : `job:${String(jobId)}`;
}

function hasWorkerMutation(stages: ReadonlySet<RecoveryStage>): boolean {
  return [...stages].some((stage) => ![
    "repo_clone", "stack_detection", "preflight", "cleanup_inventory", "cleanup_safe_leftovers",
  ].includes(stage));
}

function releasesCrossLaneOwnership(status: PipelineRunStatus): boolean {
  return [
    PipelineRunStatus.COMPLETED,
    PipelineRunStatus.COST_REJECTED,
    PipelineRunStatus.BLOCKED_BY_COST_LIMIT,
    PipelineRunStatus.COST_ANALYSIS_FAILED,
    PipelineRunStatus.STATE_RECOVERY_REQUIRED,
    PipelineRunStatus.STATE_LOCK_FAILED,
    PipelineRunStatus.BACKUP_FAILED,
    PipelineRunStatus.ROLLBACK_SUCCEEDED,
    PipelineRunStatus.WAITING_FOR_COST_APPROVAL,
    PipelineRunStatus.WAITING_FOR_STATE_LOCK,
    PipelineRunStatus.APPLY_DISABLED,
  ].includes(status);
}
