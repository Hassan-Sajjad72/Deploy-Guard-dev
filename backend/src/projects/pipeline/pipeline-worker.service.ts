import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Job, Worker } from "bullmq";
import { execFile } from "child_process";
import { access, mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { join, resolve, sep } from "path";
import { promisify } from "util";
import { Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { FinopsService } from "../../finops/finops.service";
import { CostEstimateStatus } from "../../finops/project-cost-estimate.entity";
import { InfrastructureService } from "../../infrastructure/infrastructure.service";
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
import { ProjectDetectionProfile } from "../project-detection-profile.entity";
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
import { createRedisConnection } from "./redis.config";
import {
  PIPELINE_QUEUE_NAME,
  PipelineEventMetadata,
  PipelineJobData,
} from "./pipeline.types";

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
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectPreflightReport)
    private readonly preflightRepository: Repository<ProjectPreflightReport>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly githubActionsService: GithubActionsService,
    private readonly dockerBuildService: DockerBuildService,
    private readonly securityScanService: SecurityScanService,
    private readonly dockerfileSecurityService: DockerfileSecurityService,
    private readonly ecrService: EcrService,
    private readonly terraformService: TerraformService,
    private readonly finopsService: FinopsService,
    private readonly infrastructureService: InfrastructureService,
    private readonly storageService: StorageService,
    private readonly efsService: EfsService,
    private readonly orchestrationService: OrchestrationService,
    private readonly pipelineMetricsService: PipelineMetricsService,
    private readonly githubActionsMetricsService: GithubActionsMetricsService,
    private readonly trivyMetricsService: TrivyMetricsService,
    private readonly logSanitizer: LogSanitizerService,
    private readonly usersService: UsersService
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

    this.worker.on("failed", (job, error) => {
      this.logger.error(`Pipeline job ${job?.id || "unknown"} failed`, error);
    });

    this.logger.log(`Pipeline worker listening on queue ${PIPELINE_QUEUE_NAME}`);
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async process(job: Job<PipelineJobData>) {
    const { pipelineRunId, triggeredByUserId } = job.data;
    const run = await this.findRun(pipelineRunId);
    const actor = await this.userRepository.findOne({
      where: { id: triggeredByUserId },
    });
    let workspacePath: string | null = null;
    const jobType = job.data.jobType || "pipeline_build";

    try {
      if (run.status === PipelineRunStatus.CANCELLED) {
        return;
      }

      if (jobType === "infrastructure_plan" || jobType === "infrastructure_apply") {
        await this.processInfrastructureOnlyJob(run, actor, jobType);
        return;
      }

      if (jobType === "storage_provision") {
        await this.processStorageProvisionJob(run, actor);
        return;
      }

      if (jobType === "resume_after_cost_approval") {
        await this.processCostApprovalResumeJob(run, actor);
        return;
      }

      if (jobType === "resume_after_state_lock") {
        await this.processStateLockResumeJob(run, actor, job.data.resumeOperation || "plan");
        return;
      }

      await this.updateRun(run, {
        status: PipelineRunStatus.RUNNING,
        currentStage: "preparing",
        startedAt: new Date(),
      });
      await this.audit("PIPELINE_RUN_STARTED", run, actor, "success", {
        stage: "preparing",
        status: PipelineRunStatus.RUNNING,
      });

      const { project, profile, preflightReport } = await this.prepare(run);
      await this.event(run, "preparing", "success", "Pipeline inputs validated.");
      await this.ensureNotCancelled(run);

      if (jobType === "full_deploy") {
        await this.event(
          run,
          "readiness_check_passed",
          "success",
          "Pipeline prerequisites passed. Security, cost, and apply gates will be evaluated during this run."
        );
      }

      await this.runExternalCiValidation(
        run,
        actor,
        job.data.options.triggerGithubActions
      );
      await this.ensureNotCancelled(run);

      workspacePath = await this.cloneRepository(run, project);
      await this.ensureNotCancelled(run);
      await this.event(
        run,
        "stack_detection_snapshot",
        "success",
        "Stack detection profile snapshot loaded for this pipeline run."
      );
      const buildWorkspacePath = this.buildWorkspacePath(workspacePath, profile);

      await this.ensureDockerfile(run, buildWorkspacePath, preflightReport);
      await this.ensureDockerignore(run, buildWorkspacePath);
      await this.checkDockerfile(run, buildWorkspacePath);
      await this.ensureNotCancelled(run);

      const imageTag = this.fullCommitSha(run);
      const shortCommitSha = imageTag.slice(0, 12);
      const imageName = `mini-paas/${this.safeName(project.name)}`;
      run.imageName = imageName;
      run.imageTag = imageTag;
      await this.runRepository.save(run);

      await this.buildDockerImage(run, actor, buildWorkspacePath, imageName, imageTag);
      await this.ensureNotCancelled(run);
      await this.runSecurityGate(run, actor, project, imageName, imageTag);
      await this.ensureNotCancelled(run);

      const ecrRepositoryName = this.ecrService.getRepositoryName(project.name);
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
      if (workspacePath) {
        await rm(resolve(workspacePath, ".."), { recursive: true, force: true });
      }
    }
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

  private async processInfrastructureOnlyJob(
    run: ProjectPipelineRun,
    actor: User | null,
    jobType: "infrastructure_plan" | "infrastructure_apply"
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

    if (jobType === "infrastructure_plan") {
      const planReady = await this.runInfrastructurePlan(run, actor, project);

      if (!planReady) {
        return;
      }
    } else {
      const applyReady = await this.runInfrastructureApply(run, actor, project);

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
    actor: User | null
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

  private async processStateLockResumeJob(
    run: ProjectPipelineRun,
    actor: User | null,
    operation: "plan" | "apply"
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

  private async processStorageProvisionJob(run: ProjectPipelineRun, actor: User | null) {
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

    const profile = await this.profileRepository.findOne({
      where: { id: run.detectionProfileId, projectId: project.id },
    });

    if (!profile) {
      throw new Error("Detection profile is missing");
    }

    const preflightReport = await this.preflightRepository.findOne({
      where: { id: run.preflightReportId, projectId: project.id },
    });

    if (!preflightReport) {
      throw new Error("Pre-flight report is missing");
    }

    if (
      ![
        PreflightValidationStatus.PASSED,
        PreflightValidationStatus.PASSED_WITH_WARNINGS,
      ].includes(preflightReport.validationStatus as PreflightValidationStatus)
    ) {
      throw new Error("Pre-flight report must pass before a pipeline can run");
    }

    return { project, profile, preflightReport };
  }

  private async runExternalCiValidation(
    run: ProjectPipelineRun,
    actor: User | null,
    requested: boolean
  ) {
    const required =
      this.config.get<string>("GITHUB_ACTIONS_REQUIRED", "false") === "true";
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
    await this.updateRun(run, { currentStage: "cloning" });
    this.validateRepositoryUrl(run.repositoryUrl);
    const workspaceRoot = resolve(
      process.cwd(),
      this.config.get<string>("PIPELINE_WORKSPACE_DIR", ".workspace/pipeline")
    );
    const runRoot = join(workspaceRoot, run.id);
    const workspacePath = join(runRoot, "repository");

    await mkdir(runRoot, { recursive: true });
    const token = await this.usersService.getGithubAccessToken(project.ownerUserId) || this.config.get<string>("GITHUB_TOKEN")?.trim();
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
    await this.event(run, "cloning", "success", "Repository cloned.", {
      commitSha: run.commitSha,
    });
    await this.completeMetric(run, "repository_clone", { commitSha: run.commitSha });

    return workspacePath;
  }

  private buildWorkspacePath(
    workspacePath: string,
    profile: ProjectDetectionProfile
  ) {
    const rawProfile = (profile.rawProfile || {}) as Record<string, unknown>;
    const appDirectory =
      typeof rawProfile.appDirectory === "string" ? rawProfile.appDirectory : ".";
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

  private async ensureDockerfile(
    run: ProjectPipelineRun,
    workspacePath: string,
    preflightReport: ProjectPreflightReport
  ) {
    await this.updateRun(run, { currentStage: "dockerfile_generated" });
    const dockerfilePath = join(workspacePath, "Dockerfile");

    if (await this.exists(dockerfilePath)) {
      await this.event(
        run,
        "dockerfile_generated",
        "success",
        "Existing repository Dockerfile will be used."
      );
      return;
    }

    if (!preflightReport.generatedDockerfile) {
      throw new Error("No Dockerfile exists and no generated Dockerfile is available");
    }

    await writeFile(dockerfilePath, preflightReport.generatedDockerfile, "utf8");
    await this.event(
      run,
      "dockerfile_generated",
      "success",
      "Generated Dockerfile was written to the pipeline workspace."
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
      "dockerignore_generated",
      "success",
      "Build-context exclusions were enforced in the pipeline workspace."
    );
  }

  private async buildDockerImage(
    run: ProjectPipelineRun,
    actor: User | null,
    workspacePath: string,
    imageName: string,
    imageTag: string
  ) {
    await this.startMetric(run, "docker_build", StageMetricSource.DOCKER, { imageTag });
    await this.updateRun(run, { currentStage: "building_image" });
    await this.audit("DOCKER_BUILD_STARTED", run, actor, "success", {
      stage: "building_image",
      status: "started",
      imageTag,
    });

    if (!(await this.dockerBuildService.isDockerAvailable())) {
      await this.audit("DOCKER_BUILD_FAILED", run, actor, "failed", {
        stage: "building_image",
        status: "failed",
        imageTag,
      });
      const error = new Error("Docker is not available. Start Docker and retry the pipeline.");
      await this.failMetric(run, "docker_build", error, { imageTag });
      throw error;
    }

    try {
      await this.dockerBuildService.buildImage({ workspacePath, imageName, imageTag });
    } catch (error) {
      await this.failMetric(run, "docker_build", error, { imageTag });
      throw error;
    }
    await this.event(run, "building_image", "success", "Docker image built.", {
      imageTag,
    });
    await this.audit("DOCKER_BUILD_COMPLETED", run, actor, "success", {
      stage: "building_image",
      status: "success",
      imageTag,
    });
    await this.completeMetric(run, "docker_build", { imageTag });
  }

  private async checkDockerfile(run: ProjectPipelineRun, workspacePath: string) {
    await this.updateRun(run, { currentStage: "dockerfile_check_started" });
    await this.event(run, "dockerfile_check_started", "running", "Checking container configuration.");
    const content = await readFile(join(workspacePath, "Dockerfile"), "utf8");
    const result = this.dockerfileSecurityService.analyze(content);
    if (!result.passed) {
      const message = result.blockers[0]?.message || "Dockerfile configuration is unsafe.";
      await this.event(run, "dockerfile_check_blocked", "failed", message, {
        reason: result.blockers.map((finding) => finding.code).join(","),
      });
      throw new Error(message);
    }
    await this.event(run, "dockerfile_check_passed", result.warnings.length ? "warning" : "success", result.warnings.length ? `Dockerfile check passed with ${result.warnings.length} advisory warning(s).` : "Dockerfile check passed.");
  }

  private async runSecurityGate(
    run: ProjectPipelineRun,
    actor: User | null,
    project: Project,
    imageName: string,
    imageTag: string
  ) {
    await this.startMetric(run, "trivy_scan", StageMetricSource.TRIVY, { imageTag });
    await this.updateRun(run, { currentStage: "security_scan_started" });
    await this.event(
      run,
      "security_scan_started",
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
      await this.event(run, "security_scan_unavailable", "warning", message, { imageTag });
      await this.pipelineMetricsService.skipStage(run.projectId, run.id, "trivy_scan", message);
      return null;
    });

    if (!scan) return;

    await this.event(
      run,
      "security_scan_completed",
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
        "Advisory vulnerability review recorded. Deployment will continue.",
        { scanId: scan.id, policyDecision: scan.policyDecision }
      );
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
      await this.failMetric(run, "trivy_scan", message, {
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
    await this.failMetric(run, "trivy_scan", scan.policyReason || "Security gate blocked image push.", {
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
      await this.ecrService.ensureRepository(ecrRepositoryName);
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
    return true;
  }

  private async runInfrastructureApply(
    run: ProjectPipelineRun,
    actor: User | null,
    project: Project
  ) {
    if (this.config.get<string>("TERRAFORM_APPLY_ENABLED", "false") !== "true") {
      const message = "Terraform apply is disabled by configuration.";
      await this.event(
        run,
        "terraform_apply_gate_disabled_by_config",
        "disabled_by_config",
        message
      );
      await this.updateRun(run, {
        status: PipelineRunStatus.COMPLETED,
        currentStage: "terraform_apply_gate_disabled_by_config",
        completedAt: new Date(),
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

    await this.event(
      run,
      "terraform_apply_gate_passed",
      "success",
      "Terraform apply gate passed."
    );
    await this.startMetric(run, "terraform_apply", StageMetricSource.TERRAFORM);
    await this.updateRun(run, { currentStage: "infrastructure_apply_started" });
    await this.event(
      run,
      "infrastructure_apply_started",
      "running",
      "Infrastructure Terraform apply started."
    );
    const environment = await this.infrastructureService.runInfrastructureApply(
      project.id,
      run.id,
      actor
    ).catch(async (error) => {
      await this.failMetric(run, "terraform_apply", error);
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
    return true;
  }

  private async runEcsDeployment(run: ProjectPipelineRun, actor: User | null) {
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
      await this.completeMetric(run, "ecs_deployment", { deploymentId: deployment.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "ECS deployment failed.";
      await this.updateRun(run, {
        status: PipelineRunStatus.ECS_DEPLOYMENT_FAILED,
        currentStage: "ecs_deployment_failed",
        errorMessage: this.publicErrorMessage(message),
      });
      await this.event(run, "ecs_service_unhealthy", "failed", this.publicErrorMessage(message));
      await this.audit("ECS_SERVICE_UNHEALTHY", run, actor, "failed", {
        stage: "ecs_service_unhealthy",
        status: "failed",
      });
      await this.failMetric(run, "ecs_deployment", message);
      await this.tryRollback(run, actor, this.publicErrorMessage(message));
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
    await this.updateRun(run, { currentStage: stage });
    await this.eventRepository.save(
      this.eventRepository.create({
        pipelineRunId: run.id,
        projectId: run.projectId,
        stage,
        status,
        message,
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
}
