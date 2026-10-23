import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { Request } from "express";
import { In, Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { User } from "../../users/user.entity";
import { StartPipelineRunDto } from "../dto/start-pipeline-run.dto";
import { ProjectDetectionProfile } from "../project-detection-profile.entity";
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

@Injectable()
export class PipelineService {
  constructor(
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent)
    private readonly eventRepository: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectDetectionProfile)
    private readonly profileRepository: Repository<ProjectDetectionProfile>,
    @InjectRepository(ProjectPreflightReport)
    private readonly preflightRepository: Repository<ProjectPreflightReport>,
    @Inject(PIPELINE_QUEUE)
    private readonly pipelineQueue: Queue<PipelineJobData>,
    private readonly projectsService: ProjectsService,
    private readonly auditLogService: AuditLogService
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
        status: In(this.activeStatuses()),
      },
      order: { createdAt: "DESC" },
    });

    if (activeRun) {
      return this.toRunResponse(activeRun);
    }

    const profile = await this.profileRepository.findOne({
      where: { projectId: project.id },
    });

    if (!profile) {
      throw new BadRequestException("Run stack detection before starting a pipeline");
    }

    const preflightReport = await this.preflightRepository.findOne({
      where: { projectId: project.id },
    });

    if (!preflightReport) {
      throw new BadRequestException(
        "Generate a pre-flight report before starting a pipeline"
      );
    }

    if (
      ![
        PreflightValidationStatus.PASSED,
        PreflightValidationStatus.PASSED_WITH_WARNINGS,
      ].includes(preflightReport.validationStatus as PreflightValidationStatus)
    ) {
      throw new BadRequestException(
        "Pipeline requires a passed pre-flight report or warnings-only report"
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
        detectionProfileId: profile.id,
        repositoryUrl: project.repositoryUrl,
        repositoryFullName: project.repositoryFullName,
        targetBranch: project.targetBranch,
        status: PipelineRunStatus.QUEUED,
        currentStage: "queued",
        metadata: { options, jobType: "full_deploy" },
      })
    );

    await this.eventRepository.save(
      this.eventRepository.create({
        pipelineRunId: pipelineRun.id,
        projectId: project.id,
        stage: "queued",
        status: "queued",
        message: "Pipeline run queued.",
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

    if ([PipelineRunStatus.COMPLETED, PipelineRunStatus.CANCELLED].includes(run.status)) {
      throw new BadRequestException(`Pipeline run is already ${run.status}`);
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

    return this.toRunResponse(savedRun);
  }

  async retryRun(
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

    if (this.isActive(run.status)) {
      throw new BadRequestException("Cancel the active automation run before retrying it");
    }

    const retriedRun = await this.startRun(
      user,
      project.id,
      { triggerGithubActions: false },
      req
    );

    await this.auditLogService.record({
      actorUser: user,
      action: "PIPELINE_RUN_RETRIED",
      resourceType: "pipeline_run",
      resourceId: retriedRun.id,
      status: "success",
      metadata: {
        projectId: project.id,
        pipelineRunId: retriedRun.id,
        previousPipelineRunId: run.id,
        stage: "queued",
        status: PipelineRunStatus.QUEUED,
      },
      req,
    });

    return retriedRun;
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

    return this.eventRepository.find({
      where: { pipelineRunId: run.id, projectId: project.id },
      order: { createdAt: "ASC" },
    });
  }

  private toRunResponse(run: ProjectPipelineRun) {
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
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      failedAt: run.failedAt,
      errorMessage: run.errorMessage,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    };
  }

  private activeStatuses() {
    return [
      PipelineRunStatus.QUEUED,
      PipelineRunStatus.RUNNING,
      PipelineRunStatus.COST_ANALYSIS_RUNNING,
      PipelineRunStatus.STATE_LOCK_ACQUIRING,
      PipelineRunStatus.WAITING_FOR_STATE_LOCK,
      PipelineRunStatus.STATE_LOCK_ACQUIRED,
      PipelineRunStatus.STATE_HEARTBEAT_ACTIVE,
      PipelineRunStatus.STATE_VALIDATION_RUNNING,
      PipelineRunStatus.STORAGE_EVALUATION_RUNNING,
      PipelineRunStatus.STORAGE_PROVISIONING,
      PipelineRunStatus.ECS_DEPLOYMENT_QUEUED,
      PipelineRunStatus.ECS_TASK_DEFINITION_REGISTERING,
      PipelineRunStatus.ECS_SERVICE_UPDATING,
      PipelineRunStatus.ECS_WAITING_FOR_STABILITY,
    ];
  }

  private isActive(status: PipelineRunStatus) {
    return this.activeStatuses().includes(status);
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
