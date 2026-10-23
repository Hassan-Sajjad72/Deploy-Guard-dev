import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { Request } from "express";
import { In, Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { LogSanitizerService } from "../../observability/log-sanitizer.service";
import { User } from "../../users/user.entity";
import { DeploymentContractService } from "../deployment-contract.service";
import { StartPipelineRunDto } from "../dto/start-pipeline-run.dto";
import {
  PreflightValidationStatus,
  ProjectPreflightReport,
} from "../project-preflight-report.entity";
import {
  PipelineRunStatus,
  ProjectPipelineRun,
} from "../project-pipeline-run.entity";
import { ProjectPipelineEvent } from "../project-pipeline-event.entity";
import { ProjectsService } from "../projects.service";
import { PIPELINE_QUEUE, PipelineJobData } from "./pipeline.types";
import {
  PIPELINE_IN_PROGRESS_STATUSES,
  isPipelineActive,
  isPipelineCancelable,
  isPipelineFailed,
  isPipelinePaused,
  isPipelineRetryable,
  isPipelineTerminal,
} from "./pipeline-status";
import { presentPipelineStage } from "./pipeline-stage-presenter";
import { ProjectActivityService } from "../project-activity.service";
import { DatabaseServiceBindingService } from "../../infrastructure/database-service-binding.service";
import {
  TERRAFORM_APPROVAL_MESSAGES,
  TerraformApprovalBlockedReason,
  TerraformApprovalStateService,
} from "../../infrastructure/terraform-approval-state.service";

@Injectable()
export class PipelineService {
  constructor(
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent)
    private readonly eventRepository: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectPreflightReport)
    private readonly preflightRepository: Repository<ProjectPreflightReport>,
    private readonly deploymentContractService: DeploymentContractService,
    @Inject(PIPELINE_QUEUE)
    private readonly pipelineQueue: Queue<PipelineJobData>,
    private readonly projectsService: ProjectsService,
    private readonly auditLogService: AuditLogService,
    private readonly logSanitizer: LogSanitizerService,
    private readonly projectActivity: ProjectActivityService,
    private readonly effectiveConfiguration: DatabaseServiceBindingService,
    private readonly terraformApprovalStates: TerraformApprovalStateService,
  ) {}

  async startRun(
    user: User,
    projectId: string,
    dto: StartPipelineRunDto,
    req?: Request
  ) {
    const project = await this.projectsService.getProjectEntityForManage(
      user,
      projectId
    );

    if (!project.repositoryUrl) {
      throw new BadRequestException("Project repository is not linked");
    }

    if (!project.targetBranch) {
      throw new BadRequestException("Project target branch is not selected");
    }

    const activeRun = await this.runRepository.findOne({
      where: {
        projectId: project.id,
        status: In([...PIPELINE_IN_PROGRESS_STATUSES]),
      },
      order: { createdAt: "DESC" },
    });

    if (activeRun) {
      return this.toRunResponse(activeRun);
    }

    const contract = await this.deploymentContractService.requireForProject(project.id);
    this.deploymentContractService.assertDeployable(contract, project);
    if (!contract.detectionProfileId) {
      throw new BadRequestException("Deployment contract has no detection profile. Run stack detection again.");
    }

    const preflightReport = await this.preflightRepository.findOne({
      where: { projectId: project.id },
    });

    if (!preflightReport) {
      throw new BadRequestException(
        "Generate a pre-flight report before starting a pipeline"
      );
    }

    if (preflightReport.inputFingerprint !== contract.contractHash) {
      throw new BadRequestException("Pre-flight evidence is stale. Start automation to regenerate it.");
    }

    if (
      ![
        PreflightValidationStatus.PASSED,
        PreflightValidationStatus.PASSED_WITH_WARNINGS,
      ].includes(preflightReport.validationStatus as PreflightValidationStatus)
    ) {
      const blockers = Array.isArray(preflightReport.errors)
        ? preflightReport.errors.slice(0, 3).join(" ")
        : "Resolve the blocking pre-flight findings.";
      throw new BadRequestException(
        `Deployability pre-flight failed. ${blockers}`
      );
    }

    const options = {
      triggerGithubActions: dto.triggerGithubActions ?? false,
      buildImage: true,
      pushToEcr: true,
      runTerraform: true,
    };

    const pipelineRun = await this.runRepository.save(
      this.runRepository.create({
        projectId: project.id,
        triggeredByUserId: user.id,
        preflightReportId: preflightReport.id,
        detectionProfileId: contract.detectionProfileId,
        repositoryUrl: project.repositoryUrl,
        repositoryFullName: project.repositoryFullName,
        targetBranch: project.targetBranch,
        status: PipelineRunStatus.QUEUED,
        currentStage: "queued",
        currentStageStartedAt: new Date(),
        metadata: { options, jobType: "full_deploy" },
      })
    );

    try {
      const snapshot = await this.effectiveConfiguration.createRunConfigurationSnapshot(project.id, pipelineRun.id, "production");
      pipelineRun.configurationSnapshotId = snapshot.id;
      pipelineRun.metadata = { ...(pipelineRun.metadata || {}), configurationFingerprint: snapshot.configurationFingerprint, configurationSnapshotId: snapshot.id };
      await this.runRepository.save(pipelineRun);
    } catch (error) {
      await this.runRepository.remove(pipelineRun);
      throw error;
    }

    await this.eventRepository.save(
      this.eventRepository.create({
        pipelineRunId: pipelineRun.id,
        projectId: project.id,
        stage: "queued",
        status: "queued",
        message: "Pipeline run queued.",
        occurredAt: new Date(),
        source: "user",
        metadata: {
          projectId: project.id,
          pipelineRunId: pipelineRun.id,
          repositoryFullName: project.repositoryFullName,
          targetBranch: project.targetBranch,
          stage: "queued",
          status: "queued",
        },
      })
    );

    await this.pipelineQueue.add(
      "runPipeline",
      {
        pipelineRunId: pipelineRun.id,
        projectId: project.id,
        triggeredByUserId: user.id,
        jobType: "full_deploy",
        options,
      },
      {
        attempts: Number(process.env.PIPELINE_JOB_ATTEMPTS || "1"),
        backoff: { type: "fixed", delay: 5000 },
      }
    );

    await this.auditLogService.record({
      actorUser: user,
      action: "PIPELINE_RUN_QUEUED",
      resourceType: "pipeline_run",
      resourceId: pipelineRun.id,
      status: "success",
      metadata: {
        projectId: project.id,
        pipelineRunId: pipelineRun.id,
        repositoryFullName: project.repositoryFullName,
        targetBranch: project.targetBranch,
        stage: "queued",
        status: PipelineRunStatus.QUEUED,
      },
      req,
    });
    await this.projectActivity.recordUserAction(user.id, project.id, "pipeline_started", { route: `/projects/${project.id}/pipeline`, section: "pipeline" });

    return this.toRunResponse(pipelineRun);
  }

  async cancelRun(
    user: User,
    projectId: string,
    runId: string,
    req?: Request
  ) {
    const project = await this.projectsService.getProjectEntityForManage(user, projectId);
    const run = await this.runRepository.findOne({
      where: { id: runId, projectId: project.id },
    });

    if (!run) {
      throw new NotFoundException("Pipeline run not found");
    }

    if (!isPipelineCancelable(run.status)) {
      throw new BadRequestException(`Pipeline run cannot be cancelled from ${run.status}`);
    }

    run.status = PipelineRunStatus.CANCELLED;
    run.currentStage = "cancelled";
    run.completedAt = new Date();
    run.errorMessage = null;
    run.metadata = {
      ...(run.metadata || {}),
      cancelRequested: true,
      cancelledByUserId: user.id,
      cancelledAt: run.completedAt.toISOString(),
    };
    const savedRun = await this.runRepository.save(run);

    await this.eventRepository.save(
      this.eventRepository.create({
        pipelineRunId: savedRun.id,
        projectId: project.id,
        stage: "cancelled",
        status: "cancelled",
        message: "Automation run cancelled by the user.",
        occurredAt: new Date(),
        source: "user",
        metadata: {
          projectId: project.id,
          pipelineRunId: savedRun.id,
          stage: "cancelled",
          status: "cancelled",
        },
      })
    );

    await this.removeQueuedJob(savedRun.id);
    await this.auditLogService.record({
      actorUser: user,
      action: "PIPELINE_RUN_CANCELLED",
      resourceType: "pipeline_run",
      resourceId: savedRun.id,
      status: "success",
      metadata: {
        projectId: project.id,
        pipelineRunId: savedRun.id,
        stage: "cancelled",
        status: PipelineRunStatus.CANCELLED,
      },
      req,
    });
    await this.projectActivity.recordUserAction(user.id, project.id, "pipeline_cancelled", { route: `/projects/${project.id}/pipeline`, section: "pipeline" });

    return this.toRunResponse(savedRun);
  }

  async assertRetryableRun(
    user: User,
    projectId: string,
    runId: string
  ) {
    const project = await this.projectsService.getProjectEntityForManage(user, projectId);
    const run = await this.runRepository.findOne({
      where: { id: runId, projectId: project.id },
    });

    if (!run) {
      throw new NotFoundException("Pipeline run not found");
    }

    if (!isPipelineRetryable(run.status)) {
      throw new BadRequestException(`Pipeline run cannot be retried from ${run.status}`);
    }

    return run;
  }

  async approveTerraformApply(
    user: User,
    projectId: string,
    runId: string,
    req?: Request
  ) {
    const project = await this.projectsService.getProjectEntityForManage(user, projectId);
    const run = await this.runRepository.findOne({ where: { id: runId, projectId: project.id } });
    if (!run) this.throwApprovalRejected("run_not_found");
    const approval = await this.terraformApprovalStates.evaluate(project.id, run);
    if (!approval.eligible) this.throwApprovalRejected(approval.blockedReason || "not_at_apply_gate");
    const metadata: Record<string, unknown> = {
      ...(run.metadata || {}),
      applyApprovalRequired: false,
      applyApprovedByUserId: user.id,
      applyApprovedAt: new Date().toISOString(),
    };
    const updated = await this.runRepository.update(
      {
        id: run.id,
        projectId: project.id,
        status: PipelineRunStatus.APPLY_DISABLED,
        currentStage: "terraform_apply_approval_required",
      },
      {
        status: PipelineRunStatus.QUEUED,
        currentStage: "terraform_apply_approval_queued",
        metadata,
      }
    );
    if (updated.affected !== 1) {
      const refreshed = await this.runRepository.findOne({ where: { id: run.id, projectId: project.id } });
      const refreshedApproval = await this.terraformApprovalStates.evaluate(project.id, refreshed);
      this.throwApprovalRejected(refreshedApproval.blockedReason || "not_at_apply_gate");
    }
    run.status = PipelineRunStatus.QUEUED;
    run.currentStage = "terraform_apply_approval_queued";
    run.metadata = metadata;
    await this.eventRepository.save(this.eventRepository.create({
      pipelineRunId: run.id,
      projectId: project.id,
      stage: "terraform_apply_approval_queued",
      status: "queued",
      message: "Terraform apply approval recorded. Deployment resume queued.",
      occurredAt: new Date(),
      source: "user",
      metadata: { projectId: project.id, pipelineRunId: run.id, stage: "terraform_apply_approval_queued", status: "queued" },
    }));
    await this.pipelineQueue.add("runPipeline", {
      pipelineRunId: run.id,
      projectId: project.id,
      triggeredByUserId: user.id,
      jobType: "resume_after_apply_approval",
      options: (metadata.options || {
        triggerGithubActions: false,
        buildImage: true,
        pushToEcr: true,
        runTerraform: true,
      }) as PipelineJobData["options"],
    }, { attempts: 1, jobId: `apply-approval-${run.id}` });
    await this.auditLogService.record({
      actorUser: user,
      action: "TERRAFORM_APPLY_APPROVED",
      resourceType: "pipeline_run",
      resourceId: run.id,
      status: "success",
      metadata: { projectId: project.id, pipelineRunId: run.id, stage: "terraform_apply_approval_queued" },
      req,
    });
    await this.projectActivity.recordUserAction(user.id, project.id, "terraform_apply_approved", { route: `/projects/${project.id}/pipeline`, section: "pipeline" });
    return this.toRunResponse(run);
  }

  private throwApprovalRejected(reason: TerraformApprovalBlockedReason): never {
    const payload = { code: reason, message: TERRAFORM_APPROVAL_MESSAGES[reason] };
    if (reason === "run_not_found") throw new NotFoundException(payload);
    if (["run_superseded", "already_approved"].includes(reason)) throw new ConflictException(payload);
    throw new BadRequestException(payload);
  }

  async listRuns(user: User, projectId: string) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const runs = await this.runRepository.find({
      where: { projectId: project.id },
      order: { createdAt: "DESC" },
      take: 50,
    });

    return runs.map((run) => this.toRunResponse(run));
  }

  async getRun(user: User, projectId: string, runId: string) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const run = await this.runRepository.findOne({
      where: { id: runId, projectId: project.id },
    });

    if (!run) {
      throw new NotFoundException("Pipeline run not found");
    }

    return this.toRunResponse(run);
  }

  async listEvents(user: User, projectId: string, runId: string) {
    const project = await this.projectsService.getProjectEntityForView(user, projectId);
    const run = await this.runRepository.findOne({
      where: { id: runId, projectId: project.id },
    });

    if (!run) {
      throw new NotFoundException("Pipeline run not found");
    }

    const events = await this.eventRepository.find({
      where: { pipelineRunId: run.id, projectId: project.id },
      order: { occurredAt: "ASC", sequenceNumber: "ASC" },
    });
    return events.map((event) => this.toEventResponse(event));
  }

  private toRunResponse(run: ProjectPipelineRun) {
    const presentedStage = presentPipelineStage(run.currentStage);
    return {
      id: run.id,
      projectId: run.projectId,
      triggeredByUserId: run.triggeredByUserId,
      preflightReportId: run.preflightReportId,
      detectionProfileId: run.detectionProfileId,
      repositoryUrl: run.repositoryUrl,
      repositoryFullName: run.repositoryFullName,
      targetBranch: run.targetBranch,
      commitSha: run.commitSha,
      imageName: run.imageName,
      imageTag: run.imageTag,
      shortCommitSha: run.commitSha ? run.commitSha.slice(0, 12) : null,
      ecrRepositoryName: run.ecrRepositoryName,
      ecrImageUri: run.ecrImageUri,
      githubWorkflowRunId: run.githubWorkflowRunId,
      githubWorkflowStatus: run.githubWorkflowStatus,
      status: run.status,
      currentStage: run.currentStage,
      internalStageKey: run.currentStage,
      userFacingStageKey: presentedStage.key,
      userFacingStageName: presentedStage.label,
      startedAt: run.startedAt,
      currentStageStartedAt: run.currentStageStartedAt,
      completedAt: run.completedAt,
      failedAt: run.failedAt,
      errorMessage: run.errorMessage ? this.logSanitizer.sanitize(run.errorMessage) : null,
      isActive: isPipelineActive(run.status),
      isPaused: isPipelinePaused(run.status),
      isFailed: isPipelineFailed(run.status),
      isTerminal: isPipelineTerminal(run.status),
      canCancel: isPipelineCancelable(run.status),
      canRetry: isPipelineRetryable(run.status),
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private toEventResponse(event: ProjectPipelineEvent) {
    const presented = presentPipelineStage(event.stage);
    const safeMessage = this.logSanitizer.sanitize(event.message);
    const safeMetadata = this.logSanitizer.sanitizeMetadata(event.metadata || {});
    return {
      id: event.id,
      pipelineRunId: event.pipelineRunId,
      projectId: event.projectId,
      stage: event.stage,
      internalStageKey: event.stage,
      userFacingStageKey: presented.key,
      userFacingStageName: presented.label,
      eventType: event.status,
      status: event.status,
      message: safeMessage,
      sanitizedTechnicalDetail: safeMessage,
      metadata: safeMetadata,
      createdAt: event.createdAt,
      occurredAt: event.occurredAt || event.createdAt,
      ingestedAt: event.ingestedAt || event.createdAt,
      timestamp: event.occurredAt || event.createdAt,
      durationMs: event.durationMs ?? (typeof safeMetadata.durationMs === "number" ? safeMetadata.durationMs : null),
      source: event.source || "pipeline_worker",
      sequenceNumber: event.sequenceNumber || 0,
    };
  }

  private async removeQueuedJob(pipelineRunId: string) {
    const jobs = await this.pipelineQueue.getJobs([
      "wait",
      "delayed",
      "prioritized",
    ]);
    const matchingJobs = jobs.filter(
      (job) => job.data.pipelineRunId === pipelineRunId
    );
    await Promise.all(matchingJobs.map((job) => job.remove()));
  }
}
