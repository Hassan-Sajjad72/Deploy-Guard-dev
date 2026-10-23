import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import { Job, Worker } from "bullmq";
import { execFile } from "child_process";
import { access, mkdir, rm, stat, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { promisify } from "util";
import { Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { User } from "../../users/user.entity";
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
import { GithubActionsService } from "./github-actions.service";
import { SecurityScanService } from "../security/security-scan.service";
import { createRedisConnection } from "./redis.config";
import {
  PIPELINE_QUEUE_NAME,
  PipelineEventMetadata,
  PipelineJobData,
} from "./pipeline.types";

const execFileAsync = promisify(execFile);
const ALLOWED_METADATA_KEYS = [
  "projectId",
  "pipelineRunId",
  "repositoryFullName",
  "targetBranch",
  "commitSha",
  "imageTag",
  "ecrRepositoryName",
  "ecrImageUri",
  "scanId",
  "criticalCount",
  "highCount",
  "mediumCount",
  "lowCount",
  "policyDecision",
  "reason",
  "stage",
  "status",
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
    private readonly ecrService: EcrService
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
    const { pipelineRunId, triggeredByUserId, options } = job.data;
    const run = await this.findRun(pipelineRunId);
    const actor = await this.userRepository.findOne({
      where: { id: triggeredByUserId },
    });
    let workspacePath: string | null = null;

    try {
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

      if (options.triggerGithubActions) {
        await this.triggerGithubActions(run, actor);
      } else {
        await this.event(
          run,
          "github_workflow_triggered",
          "skipped",
          "GitHub Actions trigger was not requested."
        );
        await this.audit("GITHUB_ACTIONS_WORKFLOW_SKIPPED", run, actor, "success", {
          stage: "github_workflow_triggered",
          status: "skipped",
        });
      }

      workspacePath = await this.cloneRepository(run);

      await this.ensureDockerfile(run, workspacePath, preflightReport);

      const imageTag = (run.commitSha || "").slice(0, 12);
      const imageName = `mini-paas/${this.safeName(project.name)}`;
      run.imageName = imageName;
      run.imageTag = imageTag;
      await this.runRepository.save(run);

      if (options.buildImage) {
        await this.buildDockerImage(run, actor, workspacePath, imageName, imageTag);
        await this.runSecurityGate(run, actor, project, imageName, imageTag);
      } else {
        await this.event(
          run,
          "building_image",
          "skipped",
          "Docker image build was not requested.",
          { imageTag }
        );
      }

      const ecrRepositoryName = this.ecrService.getRepositoryName(project.name);
      run.ecrRepositoryName = ecrRepositoryName;
      await this.updateRun(run, { currentStage: "tagging_image" });

      if (this.ecrService.hasConfig()) {
        run.ecrImageUri = this.ecrService.getImageUri(ecrRepositoryName, imageTag);
      }

      await this.runRepository.save(run);
      await this.event(run, "tagging_image", "success", "Image tag metadata computed.", {
        imageTag,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      await this.audit("IMAGE_TAGGED", run, actor, "success", {
        stage: "tagging_image",
        status: "success",
        imageTag,
        ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });

      if (options.pushToEcr) {
        if (!options.buildImage) {
          throw new Error("ECR push requires Docker image build to be enabled");
        }
        await this.pushToEcr(run, actor, imageName, imageTag, ecrRepositoryName);
        await this.applyLifecyclePolicy(run, actor, ecrRepositoryName);
      } else {
        await this.event(
          run,
          "pushing_to_ecr",
          "skipped",
          "ECR push was not requested.",
          { imageTag, ecrRepositoryName, ecrImageUri: run.ecrImageUri }
        );
        await this.event(
          run,
          "applying_ecr_lifecycle_policy",
          "skipped",
          "ECR lifecycle policy was not applied because ECR push was skipped.",
          { ecrRepositoryName }
        );
      }

      await this.updateRun(run, {
        status: PipelineRunStatus.COMPLETED,
        currentStage: "completed",
        completedAt: new Date(),
      });
      await this.event(run, "completed", "success", "Pipeline run completed.", {
        commitSha: run.commitSha,
        imageTag: run.imageTag,
        ecrRepositoryName: run.ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
      await this.audit("PIPELINE_RUN_COMPLETED", run, actor, "success", {
        stage: "completed",
        status: PipelineRunStatus.COMPLETED,
        commitSha: run.commitSha,
        imageTag: run.imageTag,
        ecrRepositoryName: run.ecrRepositoryName,
        ecrImageUri: run.ecrImageUri,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Pipeline worker failed unexpectedly";
      const publicMessage = this.publicErrorMessage(message);
      await this.updateRun(run, {
        status: PipelineRunStatus.FAILED,
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
        status: PipelineRunStatus.FAILED,
      });
      throw error;
    } finally {
      if (workspacePath) {
        await rm(resolve(workspacePath, ".."), { recursive: true, force: true });
      }
    }
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

  private async triggerGithubActions(run: ProjectPipelineRun, actor: User | null) {
    await this.updateRun(run, { currentStage: "github_workflow_triggered" });

    if (!this.githubActionsService.hasConfig()) {
      run.githubWorkflowStatus = "skipped_missing_config";
      await this.runRepository.save(run);
      await this.event(
        run,
        "github_workflow_triggered",
        "skipped",
        "GitHub Actions config is missing; workflow dispatch was skipped."
      );
      await this.audit("GITHUB_ACTIONS_WORKFLOW_SKIPPED", run, actor, "success", {
        stage: "github_workflow_triggered",
        status: "skipped",
      });
      return;
    }

    const result = await this.githubActionsService.triggerWorkflow({
      repositoryFullName: run.repositoryFullName,
      targetBranch: run.targetBranch,
    });

    run.githubWorkflowRunId = result.workflowRunId;
    run.githubWorkflowStatus = result.status;
    await this.runRepository.save(run);
    await this.event(
      run,
      "github_workflow_triggered",
      "success",
      "GitHub Actions workflow dispatch requested."
    );
    await this.audit("GITHUB_ACTIONS_WORKFLOW_TRIGGERED", run, actor, "success", {
      stage: "github_workflow_triggered",
      status: result.status,
    });
  }

  private async cloneRepository(run: ProjectPipelineRun) {
    await this.updateRun(run, { currentStage: "cloning" });
    this.validateRepositoryUrl(run.repositoryUrl);
    const workspaceRoot = resolve(
      process.cwd(),
      this.config.get<string>("PIPELINE_WORKSPACE_DIR", ".workspace/pipeline")
    );
    const runRoot = join(workspaceRoot, run.id);
    const workspacePath = join(runRoot, "repository");

    await mkdir(runRoot, { recursive: true });
    await execFileAsync(
      "git",
      ["clone", "--depth", "1", "--branch", run.targetBranch, run.repositoryUrl, workspacePath],
      {
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
      }
    );
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      timeout: 10000,
    });

    run.commitSha = stdout.trim();
    await this.runRepository.save(run);
    await this.event(run, "cloning", "success", "Repository cloned.", {
      commitSha: run.commitSha,
    });

    return workspacePath;
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

  private async buildDockerImage(
    run: ProjectPipelineRun,
    actor: User | null,
    workspacePath: string,
    imageName: string,
    imageTag: string
  ) {
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
      throw new Error("Docker is not available. Start Docker and retry the pipeline.");
    }

    await this.dockerBuildService.buildImage({ workspacePath, imageName, imageTag });
    await this.event(run, "building_image", "success", "Docker image built.", {
      imageTag,
    });
    await this.audit("DOCKER_BUILD_COMPLETED", run, actor, "success", {
      stage: "building_image",
      status: "success",
      imageTag,
    });
  }

  private async runSecurityGate(
    run: ProjectPipelineRun,
    actor: User | null,
    project: Project,
    imageName: string,
    imageTag: string
  ) {
    await this.updateRun(run, { currentStage: "security_scan_started" });
    await this.event(
      run,
      "security_scan_started",
      "running",
      "Security scan started.",
      { imageTag }
    );

    const scan = await this.securityScanService.scanImage({
      project,
      imageName: `${imageName}:${imageTag}`,
      pipelineRun: run,
      actorUser: actor,
    });

    await this.event(
      run,
      "security_scan_completed",
      "success",
      "Security scan completed.",
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
        "Security gate passed.",
        { scanId: scan.id, policyDecision: scan.policyDecision }
      );
      return;
    }

    if (scan.policyDecision === SecurityPolicyDecision.REQUIRES_APPROVAL) {
      await this.event(
        run,
        "security_approval_required",
        "failed",
        "Security scan requires manual approval before image push.",
        {
          scanId: scan.id,
          policyDecision: scan.policyDecision,
          reason: scan.policyReason,
        }
      );
      throw new Error("Security approval required before image push.");
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
    throw new Error(scan.policyReason || "Security gate blocked image push.");
  }

  private async pushToEcr(
    run: ProjectPipelineRun,
    actor: User | null,
    imageName: string,
    imageTag: string,
    ecrRepositoryName: string
  ) {
    await this.updateRun(run, { currentStage: "pushing_to_ecr" });

    if (!this.ecrService.hasConfig() || !run.ecrImageUri) {
      await this.audit("ECR_PUSH_FAILED", run, actor, "failed", {
        stage: "pushing_to_ecr",
        status: "failed",
        imageTag,
        ecrRepositoryName,
      });
      throw new Error("AWS ECR config is missing. Set AWS credentials/account config and retry.");
    }

    await this.audit("ECR_PUSH_STARTED", run, actor, "success", {
      stage: "pushing_to_ecr",
      status: "started",
      imageTag,
      ecrRepositoryName,
      ecrImageUri: run.ecrImageUri,
    });
    await this.ecrService.ensureRepository(ecrRepositoryName);
    await this.ecrService.loginDocker();
    await this.dockerBuildService.tagImage({
      localImageName: imageName,
      imageTag,
      ecrImageUri: run.ecrImageUri,
    });
    await this.dockerBuildService.pushImage(run.ecrImageUri);
    await this.event(run, "pushing_to_ecr", "success", "Image pushed to ECR.", {
      imageTag,
      ecrRepositoryName,
      ecrImageUri: run.ecrImageUri,
    });
    await this.audit("ECR_PUSH_COMPLETED", run, actor, "success", {
      stage: "pushing_to_ecr",
      status: "success",
      imageTag,
      ecrRepositoryName,
      ecrImageUri: run.ecrImageUri,
    });
  }

  private async applyLifecyclePolicy(
    run: ProjectPipelineRun,
    actor: User | null,
    ecrRepositoryName: string
  ) {
    await this.updateRun(run, { currentStage: "applying_ecr_lifecycle_policy" });
    await this.ecrService.applyLifecyclePolicy(ecrRepositoryName);
    await this.event(
      run,
      "applying_ecr_lifecycle_policy",
      "success",
      "ECR lifecycle policy applied for untagged images older than 30 days.",
      { ecrRepositoryName }
    );
    await this.audit("ECR_LIFECYCLE_POLICY_APPLIED", run, actor, "success", {
      stage: "applying_ecr_lifecycle_policy",
      status: "success",
      ecrRepositoryName,
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

  private safeName(value: string) {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  private publicErrorMessage(message: string) {
    if (/token|secret|password|credential|authorization/i.test(message)) {
      return "Pipeline failed because required external service credentials are invalid or missing.";
    }

    return message;
  }
}
