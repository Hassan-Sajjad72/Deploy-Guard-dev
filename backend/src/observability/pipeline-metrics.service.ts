import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { ProjectOrchestrationEvent } from "../orchestration/project-orchestration-event.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { PipelineRunStatus, ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { LogSanitizerService } from "./log-sanitizer.service";
import { ProjectPipelineMetricSummary } from "./project-pipeline-metric-summary.entity";
import { ProjectStageMetric, StageMetricSource, StageMetricStatus } from "./project-stage-metric.entity";

const STAGE_SOURCE: Record<string, StageMetricSource> = {
  github_actions: StageMetricSource.GITHUB_ACTIONS,
  repository_clone: StageMetricSource.PIPELINE,
  docker_build: StageMetricSource.DOCKER,
  ecr_push: StageMetricSource.ECR,
  terraform_plan: StageMetricSource.TERRAFORM,
  finops_cost_analysis: StageMetricSource.FINOPS,
  terraform_apply: StageMetricSource.TERRAFORM,
  state_lock: StageMetricSource.TERRAFORM,
  efs_provisioning: StageMetricSource.TERRAFORM,
  ecs_deployment: StageMetricSource.ECS,
  ecs_service_stability: StageMetricSource.ECS,
  alb_health_check: StageMetricSource.ALB,
  rollback: StageMetricSource.ROLLBACK,
  spot_recovery: StageMetricSource.ECS,
};

@Injectable()
export class PipelineMetricsService {
  constructor(
    @InjectRepository(ProjectStageMetric)
    private readonly metricRepository: Repository<ProjectStageMetric>,
    @InjectRepository(ProjectPipelineMetricSummary)
    private readonly summaryRepository: Repository<ProjectPipelineMetricSummary>,
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectPipelineEvent)
    private readonly eventRepository: Repository<ProjectPipelineEvent>,
    @InjectRepository(ProjectOrchestrationEvent)
    private readonly orchestrationEventRepository: Repository<ProjectOrchestrationEvent>,
    private readonly sanitizer: LogSanitizerService
  ) {}

  async startStage(projectId: string, pipelineRunId: string, stageName: string, source: StageMetricSource | string, metadata: Record<string, unknown> = {}) {
    const existing = await this.metricRepository.findOne({
      where: { projectId, pipelineRunId, stageName },
      order: { createdAt: "DESC" },
    });

    const metric = existing || this.metricRepository.create({ projectId, pipelineRunId, stageName });
    metric.status = StageMetricStatus.RUNNING;
    metric.source = source;
    metric.startedAt = metric.startedAt || new Date();
    metric.metadata = this.sanitizer.sanitizeMetadata({ ...metric.metadata, ...metadata, stageName, source });
    return this.metricRepository.save(metric);
  }

  async completeStage(projectId: string, pipelineRunId: string, stageName: string, metadata: Record<string, unknown> = {}) {
    return this.finishStage(projectId, pipelineRunId, stageName, StageMetricStatus.SUCCEEDED, undefined, metadata);
  }

  async failStage(projectId: string, pipelineRunId: string, stageName: string, error: unknown, metadata: Record<string, unknown> = {}) {
    const reason = error instanceof Error ? error.message : String(error || "Stage failed.");
    return this.finishStage(projectId, pipelineRunId, stageName, StageMetricStatus.FAILED, reason, metadata);
  }

  async skipStage(projectId: string, pipelineRunId: string, stageName: string, reason = "Stage skipped.") {
    return this.finishStage(projectId, pipelineRunId, stageName, StageMetricStatus.SKIPPED, reason, {});
  }

  async getPipelineMetrics(projectId: string, pipelineRunId: string) {
    await this.buildStageMetricsFromEvents(projectId, pipelineRunId);
    const stageMetrics = await this.metricRepository.find({
      where: { projectId, pipelineRunId },
      order: { startedAt: "ASC", createdAt: "ASC" },
    });
    const summary = await this.buildPipelineSummary(projectId, pipelineRunId);

    return { stageMetrics, summary };
  }

  async getLatestPipelineSummary(projectId: string) {
    const existing = await this.summaryRepository.findOne({
      where: { projectId },
      order: { updatedAt: "DESC" },
    });

    if (existing) {
      return existing;
    }

    const latestRun = await this.runRepository.findOne({
      where: { projectId },
      order: { createdAt: "DESC" },
    });

    return latestRun ? this.buildPipelineSummary(projectId, latestRun.id) : null;
  }

  async buildPipelineSummary(projectId: string, pipelineRunId: string) {
    const run = await this.runRepository.findOne({ where: { id: pipelineRunId, projectId } });
    const metrics = await this.metricRepository.find({ where: { projectId, pipelineRunId } });
    const summary = await this.summaryRepository.findOne({ where: { projectId, pipelineRunId } })
      || this.summaryRepository.create({ projectId, pipelineRunId });

    summary.totalDurationMs = this.duration(run?.startedAt, run?.completedAt || run?.failedAt);
    summary.githubActionsDurationMs = this.stageDuration(metrics, "github_actions");
    summary.dockerBuildDurationMs = this.stageDuration(metrics, "docker_build");
    summary.ecrPushDurationMs = this.stageDuration(metrics, "ecr_push");
    summary.terraformPlanDurationMs = this.stageDuration(metrics, "terraform_plan");
    summary.terraformApplyDurationMs = this.stageDuration(metrics, "terraform_apply");
    summary.finopsDurationMs = this.stageDuration(metrics, "finops_cost_analysis");
    summary.ecsDeploymentDurationMs = this.stageDuration(metrics, "ecs_deployment");
    summary.albHealthCheckDurationMs = this.stageDuration(metrics, "alb_health_check");
    summary.rollbackDurationMs = this.stageDuration(metrics, "rollback");
    summary.status = run?.status || PipelineRunStatus.QUEUED;
    summary.metadata = this.sanitizer.sanitizeMetadata({
      projectId,
      pipelineRunId,
      status: summary.status,
    });

    return this.summaryRepository.save(summary);
  }

  private async finishStage(
    projectId: string,
    pipelineRunId: string,
    stageName: string,
    status: StageMetricStatus,
    reason?: string,
    metadata: Record<string, unknown> = {}
  ) {
    const metric = await this.metricRepository.findOne({
      where: { projectId, pipelineRunId, stageName },
      order: { createdAt: "DESC" },
    }) || this.metricRepository.create({
      projectId,
      pipelineRunId,
      stageName,
      source: STAGE_SOURCE[stageName] || StageMetricSource.PIPELINE,
      startedAt: new Date(),
    });
    const endedAt = new Date();
    metric.status = status;
    metric.endedAt = endedAt;
    metric.durationMs = this.duration(metric.startedAt, endedAt);
    metric.metadata = this.sanitizer.sanitizeMetadata({
      ...metric.metadata,
      ...metadata,
      stageName,
      reason,
      durationMs: metric.durationMs,
    });
    return this.metricRepository.save(metric);
  }

  private async buildStageMetricsFromEvents(projectId: string, pipelineRunId: string) {
    const existing = await this.metricRepository.find({ where: { projectId, pipelineRunId } });
    const byStage = new Map(existing.map((metric) => [metric.stageName, metric]));
    const pipelineEvents = await this.eventRepository.find({
      where: { projectId, pipelineRunId },
      order: { occurredAt: "ASC", sequenceNumber: "ASC" },
    });
    const orchestrationEvents = await this.orchestrationEventRepository.find({
      where: { projectId, pipelineRunId },
      order: { occurredAt: "ASC", sequenceNumber: "ASC" },
    });

    const candidates = [
      this.fromEvents("github_actions", pipelineEvents, ["github_actions_trigger_started"], ["github_actions_triggered"], ["github_actions_trigger_failed"]),
      this.fromEvents("repository_clone", pipelineEvents, ["cloning"], ["cloning"], []),
      this.fromEvents("docker_build", pipelineEvents, ["building_image"], ["building_image"], []),
      this.fromEvents("ecr_push", pipelineEvents, ["ecr_push_started"], ["ecr_image_pushed"], ["ecr_push_failed"]),
      this.fromEvents("terraform_plan", pipelineEvents, ["terraform_plan_started", "infrastructure_plan_started"], ["terraform_stage_completed", "infrastructure_plan_completed"], ["terraform_stage_failed"]),
      this.fromEvents("finops_cost_analysis", pipelineEvents, ["cost_analysis_started"], ["cost_approval_required", "deployment_blocked_by_cost_limit"], ["cost_analysis_failed"]),
      this.fromEvents("terraform_apply", pipelineEvents, ["infrastructure_apply_started"], ["infrastructure_apply_completed"], []),
      this.fromEvents("efs_provisioning", pipelineEvents, ["storage_evaluation_started"], ["storage_provisioned"], ["storage_provisioning_failed"]),
      this.fromEvents("ecs_deployment", pipelineEvents, ["ecs_service_deployment_started"], ["ecs_service_stable"], ["ecs_service_unhealthy"]),
      this.fromEvents("ecs_service_stability", orchestrationEvents, ["ecs_service_stability_wait_started"], ["ecs_service_stable"], ["ecs_service_stability_failed", "ecs_service_stability_timeout", "ecs_service_deployment_failed"]),
      this.fromEvents("alb_health_check", orchestrationEvents, ["alb_health_check_wait_started"], ["alb_targets_healthy"], ["alb_health_check_failed", "alb_health_check_timeout", "alb_targets_unhealthy"]),
      this.fromEvents("rollback", pipelineEvents, ["rollback_started"], ["rollback_succeeded"], ["rollback_failed"]),
      this.fromEvents("spot_recovery", orchestrationEvents, ["spot_interruption_detected"], ["spot_interruption_handled", "spot_interruption_recovery_skipped"], ["spot_interruption_recovery_failed"]),
    ].filter(Boolean) as ProjectStageMetric[];

    for (const candidate of candidates) {
      if (byStage.has(candidate.stageName)) {
        continue;
      }
      await this.metricRepository.save(candidate);
    }
  }

  private fromEvents(
    stageName: string,
    events: Array<{ stage?: string; eventType?: string; status: string; createdAt: Date; occurredAt?: Date; metadata?: Record<string, unknown> | null }>,
    starts: string[],
    successes: string[],
    failures: string[]
  ) {
    const named = (event: { stage?: string; eventType?: string }) => event.stage || event.eventType || "";
    const start = events.find((event) => starts.includes(named(event)));
    const success = [...events].reverse().find((event) => successes.includes(named(event)));
    const failure = [...events].reverse().find((event) => failures.includes(named(event)));
    const terminal = failure || success || start;

    if (!terminal) {
      return null;
    }

    const startedAt = start?.occurredAt || start?.createdAt || terminal.occurredAt || terminal.createdAt;
    const endedAt = terminal === start && terminal.status === "running" ? null : terminal.occurredAt || terminal.createdAt;
    const status = failure
      ? StageMetricStatus.FAILED
      : success
        ? StageMetricStatus.SUCCEEDED
        : terminal.status === "skipped"
          ? StageMetricStatus.SKIPPED
          : StageMetricStatus.RUNNING;

    return this.metricRepository.create({
      projectId: (terminal as any).projectId,
      pipelineRunId: (terminal as any).pipelineRunId,
      deploymentId: (terminal as any).deploymentId || null,
      stageName,
      source: STAGE_SOURCE[stageName] || StageMetricSource.PIPELINE,
      status,
      startedAt,
      endedAt,
      durationMs: endedAt ? this.duration(startedAt, endedAt) : null,
      metadata: this.sanitizer.sanitizeMetadata({
        stageName,
        source: STAGE_SOURCE[stageName] || StageMetricSource.PIPELINE,
        status,
        durationMs: endedAt ? this.duration(startedAt, endedAt) : null,
      }),
    });
  }

  private stageDuration(metrics: ProjectStageMetric[], stageName: string) {
    const metric = metrics.find((item) => item.stageName === stageName);
    return metric?.durationMs || null;
  }

  private duration(start?: Date | null, end?: Date | null) {
    if (!start || !end) {
      return null;
    }

    return Math.max(0, end.getTime() - start.getTime());
  }
}
