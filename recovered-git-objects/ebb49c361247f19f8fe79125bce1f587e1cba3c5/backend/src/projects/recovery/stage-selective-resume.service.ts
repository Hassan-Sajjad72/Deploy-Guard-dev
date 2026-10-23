import { BadRequestException, ConflictException, Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { Request } from "express";
import { Repository } from "typeorm";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { InfrastructureLifecycleService } from "../../infrastructure-lifecycle/infrastructure-lifecycle.service";
import { User } from "../../users/user.entity";
import { ProjectPreflightReport, PreflightValidationStatus } from "../project-preflight-report.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../project-pipeline-run.entity";
import { ProjectPipelineEvent } from "../project-pipeline-event.entity";
import { ProjectsService } from "../projects.service";
import { PreflightService } from "../templates/preflight.service";
import { PipelineActivityService } from "../pipeline/pipeline-activity.service";
import { PipelineService } from "../pipeline/pipeline.service";
import { EcrService } from "../pipeline/ecr.service";
import { PIPELINE_QUEUE, PipelineJobData } from "../pipeline/pipeline.types";
import { RecoveryIssue } from "./recovery-issue.types";
import { StageCheckpointService } from "./stage-checkpoint.service";
import { RECOVERY_STAGES, RecoveryStage, StageResumeDecision } from "./stage-selective-resume.types";
import { DatabaseServiceBindingService } from "../../infrastructure/database-service-binding.service";

@Injectable()
export class StageSelectiveResumeService {
  constructor(
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent) private readonly events: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectPreflightReport) private readonly preflights: Repository<ProjectPreflightReport>,
    private readonly projects: ProjectsService,
    private readonly preflight: PreflightService,
    private readonly pipeline: PipelineService,
    private readonly checkpoint: StageCheckpointService,
    private readonly audit: AuditLogService,
    @Inject(PIPELINE_QUEUE) private readonly queue: Queue<PipelineJobData>,
    private readonly ecr: EcrService,
    private readonly infrastructureLifecycle: InfrastructureLifecycleService,
    private readonly pipelineActivity: PipelineActivityService,
    private readonly effectiveConfiguration: DatabaseServiceBindingService,
  ) {}

  async preview(user: User, projectId: string, issue: RecoveryIssue) {
    await this.projects.getProjectEntityForManage(user, projectId);
    return this.decide(projectId, issue);
  }

  async execute(user: User, projectId: string, issue: RecoveryIssue, req?: Request) {
    const project = await this.projects.getProjectEntityForManage(user, projectId);
    const latest = await this.runs.findOne({ where: { projectId }, order: { createdAt: "DESC" } });
    const activity = await this.pipelineActivity.inspect(projectId, latest);
    if (activity.isDeploymentJobActive) throw new ConflictException("A deployment run is already active for this project.");
    const decision = await this.decide(projectId, issue);
    if (decision.mode === "cleanup") {
      const inventory = await this.infrastructureLifecycle.refreshProjectResources(user, projectId);
      await this.audit.record({ actorUser: user, action: "RECOVERY_CLEANUP_ROUTED", resourceType: "project", resourceId: projectId, status: "success", metadata: { projectId, stage: decision.resumeFromStage, reason: decision.reason }, req });
      return { decision, pipelineRun: null, queued: false, inventory: inventory.summary, actionRoute: `/projects/${projectId}/settings?recovery=${issue.code}&focus=resource_cleanup` };
    }
    if (decision.mode === "full") {
      const pipelineRun = await this.pipeline.startRun(user, projectId, { triggerGithubActions: false }, req);
      return { decision, pipelineRun, queued: true, actionRoute: `/projects/${projectId}/pipeline` };
    }

    const source = await this.requireSourceRun(projectId, decision.sourcePipelineRunId);
    await this.preflight.getOrGenerateReport(user, projectId, req);
    const report = await this.preflights.findOne({ where: { projectId } });
    if (!report || ![PreflightValidationStatus.PASSED, PreflightValidationStatus.PASSED_WITH_WARNINGS].includes(report.validationStatus as PreflightValidationStatus)) {
      throw new BadRequestException("Pre-flight must pass after the recovery fix before deployment can resume.");
    }
    const run = await this.runs.save(this.runs.create({
      projectId,
      triggeredByUserId: user.id,
      preflightReportId: report.id,
      detectionProfileId: report.detectionProfileId,
      repositoryUrl: project.repositoryUrl,
      repositoryFullName: project.repositoryFullName,
      targetBranch: project.targetBranch,
      commitSha: source.commitSha,
      imageName: source.imageName,
      imageTag: source.imageTag,
      ecrRepositoryName: source.ecrRepositoryName,
      ecrImageUri: source.ecrImageUri,
      status: PipelineRunStatus.QUEUED,
      currentStage: `resume_${decision.resumeFromStage}_queued`,
      metadata: {
        mode: "resume",
        jobType: "full_deploy",
        recoveryIssueCode: issue.code,
        sourcePipelineRunId: source.id,
        resumeFromStage: decision.resumeFromStage,
        skippedStages: decision.skippedStages,
        rerunStages: decision.rerunStages,
        reason: decision.reason,
        options: { triggerGithubActions: false, buildImage: decision.rerunStages.includes("docker_build"), pushToEcr: decision.rerunStages.includes("ecr_push"), runTerraform: decision.rerunStages.includes("terraform_plan") },
      },
    }));
    const configurationSnapshot = await this.effectiveConfiguration.createRunConfigurationSnapshot(projectId, run.id, "production");
    run.configurationSnapshotId = configurationSnapshot.id;
    run.metadata = { ...(run.metadata || {}), configurationFingerprint: configurationSnapshot.configurationFingerprint, configurationSnapshotId: configurationSnapshot.id };
    await this.runs.save(run);
    await this.checkpoint.recordPassed(run, "preflight");
    await this.events.save(this.events.create({ pipelineRunId: run.id, projectId, stage: "preflight", status: "success", message: "Pre-flight was revalidated after the recovery change.", metadata: { projectId, pipelineRunId: run.id, stage: "preflight", status: "success" } }));
    const sourceCheckpoints = await this.checkpoint.latestPassedByStage(projectId);
    for (const stage of decision.skippedStages) {
      const sourceCheckpoint = sourceCheckpoints.get(stage);
      if (sourceCheckpoint) await this.checkpoint.recordReused(run, sourceCheckpoint);
      await this.events.save(this.events.create({ pipelineRunId: run.id, projectId, stage, status: "skipped", message: "Reused from previous successful run.", metadata: { projectId, pipelineRunId: run.id, stage, status: "reused", sourcePipelineRunId: source.id } }));
    }
    await this.events.save(this.events.create({ pipelineRunId: run.id, projectId, stage: decision.resumeFromStage, status: "queued", message: "Stage-selective recovery resume queued.", metadata: { projectId, pipelineRunId: run.id, stage: decision.resumeFromStage, status: "queued", reason: decision.reason } }));
    const payload: PipelineJobData = {
      pipelineRunId: run.id, projectId, triggeredByUserId: user.id,
      jobType: "stage_selective_resume", mode: "resume",
      resumeFromStage: decision.resumeFromStage,
      skippedStages: decision.skippedStages,
      rerunStages: decision.rerunStages,
      reason: decision.reason,
      sourcePipelineRunId: source.id,
      options: { triggerGithubActions: false, buildImage: decision.rerunStages.includes("docker_build"), pushToEcr: decision.rerunStages.includes("ecr_push"), runTerraform: decision.rerunStages.includes("terraform_plan") },
    };
    await this.queue.add("runPipeline", payload, { attempts: 1, jobId: `recovery-${run.id}` });
    await this.audit.record({ actorUser: user, action: "STAGE_SELECTIVE_RESUME_QUEUED", resourceType: "pipeline_run", resourceId: run.id, status: "success", metadata: { projectId, pipelineRunId: run.id, stage: decision.resumeFromStage, reason: decision.reason }, req });
    return { decision, pipelineRun: run, queued: true, actionRoute: `/projects/${projectId}/pipeline` };
  }

  async decide(projectId: string, issue: RecoveryIssue): Promise<StageResumeDecision> {
    const requested = this.normalizeStage(issue.resumeFromStage);
    if (issue.category === "cleanup" || requested === "cleanup_inventory") {
      return { mode: "cleanup", resumeFromStage: "cleanup_inventory", skippedStages: RECOVERY_STAGES.filter((stage) => !stage.startsWith("cleanup_")), rerunStages: ["cleanup_inventory"], reason: "This recovery issue only requires refreshed resource inventory and explicitly selected safe cleanup.", fallbackReason: null, sourcePipelineRunId: null, sourceImageUri: null, sourceImageTag: null };
    }
    const source = await this.requireSourceRun(projectId, (issue.developerDetails?.pipelineRunId as string | null) || null).catch(() => null);
    if (!source) return this.full("No previous pipeline run exists for checkpoint reuse.", null);
    const current = await this.checkpoint.currentFingerprints(projectId, source);
    const previous = await this.checkpoint.latestPassedByStage(projectId);
    const sourceCheckpoint = previous.get("repo_clone");
    if (!sourceCheckpoint) return this.full("No valid repository checkpoint exists.", source.id);
    if (sourceCheckpoint.fingerprint !== current.repo_clone) return this.full("The source commit or application path changed.", source.id);

    let rerun = this.rerunFor(issue.code, requested);
    const initiallyPlannedFirstStage = rerun[0];
    const buildCheckpoint = previous.get("docker_build");
    if (this.afterBuild(rerun) && !buildCheckpoint) return this.full("No valid image-build checkpoint exists.", source.id);
    if (buildCheckpoint && buildCheckpoint.fingerprint !== current.docker_build) rerun = this.from("docker_build");
    const ecrCheckpoint = previous.get("ecr_push");
    if (this.afterEcr(rerun) && (!ecrCheckpoint || !source.ecrImageUri)) return this.full("No reusable ECR image checkpoint exists.", source.id);
    if (ecrCheckpoint && ecrCheckpoint.fingerprint !== current.ecr_push) rerun = this.from("docker_build");
    if (!rerun.includes("docker_build")) {
      if (!ecrCheckpoint?.imageDigest || !source.ecrRepositoryName || !source.imageTag || !this.ecr.hasConfig()) {
        return this.full("The immutable ECR image digest checkpoint is unavailable.", source.id);
      }
      const currentDigest = await this.ecr.getImageDigest(source.ecrRepositoryName, source.imageTag).catch(() => null);
      if (!currentDigest) return this.full("The reusable ECR image could not be verified.", source.id);
      if (currentDigest !== ecrCheckpoint.imageDigest) rerun = this.from("docker_build");
    }
    const securityCheckpoint = previous.get("security_scan");
    if (!rerun.includes("docker_build") && securityCheckpoint?.imageDigest && ecrCheckpoint?.imageDigest && securityCheckpoint.imageDigest !== ecrCheckpoint.imageDigest) {
      rerun = this.from("security_scan");
    }
    if (this.afterSecurity(rerun) && (!securityCheckpoint || securityCheckpoint.fingerprint !== current.security_scan)) rerun = this.from("security_scan");
    if (rerun.includes("security_scan") && !rerun.includes("docker_build") && (!ecrCheckpoint || !source.ecrImageUri)) {
      rerun = this.from("docker_build");
    }

    const firstRerunIndex = RECOVERY_STAGES.indexOf(rerun[0] || requested);
    const skipped = RECOVERY_STAGES
      .slice(0, Math.max(0, firstRerunIndex))
      .filter((stage) => stage !== "preflight") as RecoveryStage[];
    for (const stage of skipped) {
      const prior = previous.get(stage);
      if (!prior || prior.fingerprint !== current[stage]) {
        return this.full(`No valid ${stage.replaceAll("_", " ")} checkpoint exists.`, source.id);
      }
    }
    const resumeFromStage = rerun[0] === initiallyPlannedFirstStage && rerun.includes(requested)
      ? requested
      : rerun[0] || requested;
    return {
      mode: "resume",
      resumeFromStage,
      skippedStages: skipped,
      rerunStages: rerun,
      reason: issue.requiredAction,
      fallbackReason: null,
      sourcePipelineRunId: source.id,
      sourceImageUri: source.ecrImageUri || null,
      sourceImageTag: source.imageTag || null,
    };
  }

  private rerunFor(code: string, requested: RecoveryStage): RecoveryStage[] {
    if (/missing_runtime_env|invalid_env|secret_required|container|runtime|port|bound_to_localhost|task_definition/.test(code)) return ["terraform_plan", "terraform_apply", "ecs_task_definition_update", "ecs_service_deploy", "health_check", "stable_release"];
    if (/database/.test(code) || code === "app_connected_to_localhost_database") return ["terraform_plan", "terraform_apply", "database_tier_setup", "ecs_task_definition_update", "ecs_service_deploy", "health_check", "stable_release"];
    if (/efs|storage|upload_path/.test(code)) return ["terraform_plan", "terraform_apply", "ecs_task_definition_update", "ecs_service_deploy", "health_check", "stable_release"];
    if (/health|target_group|alb_50|no_targets/.test(code)) return ["terraform_plan", "terraform_apply", "ecs_task_definition_update", "ecs_service_deploy", "health_check", "stable_release"];
    if (/security|vulnerability|secret_leaked|unsafe_dockerfile|privileged|base_image/.test(code)) return ["security_scan", "terraform_plan", "terraform_apply", "ecs_task_definition_update", "ecs_service_deploy", "health_check", "stable_release"];
    if (/state_|state_lock|lockfile|terraform_state/.test(code)) return ["terraform_plan"];
    if (/cost|infracost|budget|high_cost|nat_gateway_cost/.test(code)) return ["terraform_apply", "ecs_task_definition_update", "ecs_service_deploy", "health_check", "stable_release"];
    if (/state_|terraform|aws_|quota|vpc|subnet|nat_|cloud_map|secrets_manager/.test(code)) return ["terraform_plan", "terraform_apply", "database_tier_setup", "ecs_task_definition_update", "ecs_service_deploy", "health_check", "stable_release"];
    if (/missing_build_time_env|build_secret|docker|dependency|npm_script|module_not_found|native_dependency|ecr|image_/.test(code)) return this.from("docker_build");
    return this.from(requested);
  }
  private from(stage: RecoveryStage) { const index = RECOVERY_STAGES.indexOf(stage); return RECOVERY_STAGES.slice(index).filter((item) => !item.startsWith("cleanup_")) as RecoveryStage[]; }
  private afterBuild(stages: RecoveryStage[]) { return !stages.includes("docker_build"); }
  private afterSecurity(stages: RecoveryStage[]) { return !stages.includes("docker_build") && !stages.includes("security_scan"); }
  private afterEcr(stages: RecoveryStage[]) { return !stages.includes("docker_build") && !stages.includes("security_scan") && !stages.includes("ecr_push"); }
  private normalizeStage(value: string): RecoveryStage {
    const aliases: Record<string, RecoveryStage> = { ecs_task_definition: "ecs_task_definition_update", alb_health: "health_check", state_recovery: "terraform_plan", storage_setup: "terraform_plan", failed_stage: "repo_clone" };
    const stage = aliases[value] || value;
    return RECOVERY_STAGES.includes(stage as RecoveryStage) ? stage as RecoveryStage : "repo_clone";
  }
  private full(reason: string, sourcePipelineRunId: string | null): StageResumeDecision {
    return { mode: "full", resumeFromStage: "repo_clone", skippedStages: [], rerunStages: RECOVERY_STAGES.filter((stage) => !stage.startsWith("cleanup_")), reason: `A full redeploy is required: ${reason}`, fallbackReason: reason, sourcePipelineRunId, sourceImageUri: null, sourceImageTag: null };
  }
  private requireSourceRun(projectId: string, runId: string | null) {
    return this.runs.findOneOrFail({ where: runId ? { id: runId, projectId } : { projectId }, order: { createdAt: "DESC" } });
  }
}
