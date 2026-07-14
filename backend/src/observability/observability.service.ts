import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { AuditLogService } from "../audit-log/audit-log.service";
import { AlbService } from "../orchestration/alb.service";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { Project, ProjectStatus, ProjectVisibility } from "../projects/project.entity";
import { User, UserRole } from "../users/user.entity";
import { CloudWatchLogsService, LogQueryOptions } from "./cloudwatch-logs.service";
import { CloudWatchMetricsService } from "./cloudwatch-metrics.service";
import { GithubActionsMetricsService } from "./github-actions-metrics.service";
import { LogSanitizerService } from "./log-sanitizer.service";
import { PipelineMetricsService } from "./pipeline-metrics.service";
import { ProjectObservabilityEvent } from "./project-observability-event.entity";
import { ProjectRuntimeMetricSnapshot } from "./project-runtime-metric-snapshot.entity";
import { PrometheusService } from "./prometheus.service";
import { TrivyMetricsService } from "./trivy-metrics.service";

@Injectable()
export class ObservabilityService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepository: Repository<Project>,
    @InjectRepository(ProjectPipelineRun)
    private readonly runRepository: Repository<ProjectPipelineRun>,
    @InjectRepository(ProjectDeployment)
    private readonly deploymentRepository: Repository<ProjectDeployment>,
    @InjectRepository(ProjectRuntimeMetricSnapshot)
    private readonly runtimeSnapshotRepository: Repository<ProjectRuntimeMetricSnapshot>,
    @InjectRepository(ProjectObservabilityEvent)
    private readonly eventRepository: Repository<ProjectObservabilityEvent>,
    private readonly pipelineMetrics: PipelineMetricsService,
    private readonly githubMetrics: GithubActionsMetricsService,
    private readonly trivyMetrics: TrivyMetricsService,
    private readonly prometheus: PrometheusService,
    private readonly cloudWatchMetrics: CloudWatchMetricsService,
    private readonly cloudWatchLogs: CloudWatchLogsService,
    private readonly albService: AlbService,
    private readonly auditLogService: AuditLogService,
    private readonly sanitizer: LogSanitizerService
  ) {}

  async getSummary(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    const latestRun = await this.runRepository.findOne({ where: { projectId: project.id }, order: { createdAt: "DESC" } });
    const deployment = await this.latestDeployment(project.id);
    const latestPipelineSummary = latestRun
      ? await this.pipelineMetrics.buildPipelineSummary(project.id, latestRun.id)
      : await this.pipelineMetrics.getLatestPipelineSummary(project.id);
    const targetHealth = await this.albService.getTargetHealth(project.id);

    await this.audit(user, "OBSERVABILITY_SUMMARY_VIEWED", project.id, "success", {});

    return {
      latestPipelineSummary,
      latestDeploymentStatus: deployment?.status || "not_deployed",
      logStreaming: { available: true, source: "cloudwatch_logs" },
      prometheus: this.prometheus.isEnabled()
        ? { enabled: true, message: "Prometheus is enabled." }
        : { enabled: false, message: "Prometheus is not configured." },
      cloudWatchFallback: {
        logsEnabled: true,
        metricsEnabled: this.cloudWatchMetrics.isEnabled(),
      },
      latestHealthSummary: targetHealth,
    };
  }

  async getPipelineMetrics(user: User, projectId: string, pipelineRunId?: string) {
    const project = await this.findProjectForView(user, projectId);
    const run = pipelineRunId
      ? await this.runRepository.findOne({ where: { id: pipelineRunId, projectId: project.id } })
      : await this.runRepository.findOne({ where: { projectId: project.id }, order: { createdAt: "DESC" } });

    if (!run) {
      return { stageMetrics: [], summary: null, githubActions: null, trivyScan: null };
    }

    const [metrics, githubActions, trivyScan] = await Promise.all([
      this.pipelineMetrics.getPipelineMetrics(project.id, run.id),
      this.githubMetrics.fetchWorkflowRun(project.id, run.id).catch(() => null),
      this.trivyMetrics.getLatest(project.id, run.id),
    ]);

    await this.audit(user, "PIPELINE_METRICS_VIEWED", project.id, "success", { pipelineRunId: run.id });

    return {
      pipelineRunId: run.id,
      ...metrics,
      githubActions,
      trivyScan: trivyScan ? {
        id: trivyScan.id,
        scanStatus: trivyScan.scanStatus,
        startedAt: trivyScan.startedAt,
        completedAt: trivyScan.completedAt,
        durationMs: trivyScan.startedAt && trivyScan.completedAt ? trivyScan.completedAt.getTime() - trivyScan.startedAt.getTime() : null,
        totalVulnerabilities: trivyScan.totalVulnerabilities,
        criticalCount: trivyScan.criticalCount,
        highCount: trivyScan.highCount,
        mediumCount: trivyScan.mediumCount,
        lowCount: trivyScan.lowCount,
        unknownCount: trivyScan.unknownCount,
        policyDecision: trivyScan.policyDecision,
      } : null,
    };
  }

  async getRuntimeMetrics(user: User, projectId: string, source = "auto", range = "1h") {
    const project = await this.findProjectForView(user, projectId);
    const deployment = await this.latestDeployment(project.id);
    let runtime;

    if (source === "prometheus" || (source === "auto" && this.prometheus.isEnabled())) {
      runtime = await this.prometheus.getRuntimeMetrics(project.id, deployment, range);
      if (runtime.enabled !== false) {
        await this.saveRuntimeSnapshots(project.id, deployment, "prometheus", runtime);
      }
    }

    if (source === "prometheus") {
      await this.audit(user, "RUNTIME_METRICS_VIEWED", project.id, "success", { source, range });
      return runtime;
    }

    if (!runtime || runtime.enabled === false || source === "cloudwatch") {
      runtime = await this.cloudWatchMetrics.getRuntimeMetricFallback(project.id, deployment, range);
      if (runtime.enabled !== false) {
        await this.saveRuntimeSnapshots(project.id, deployment, "cloudwatch", runtime);
      }
    }

    await this.audit(user, "RUNTIME_METRICS_VIEWED", project.id, "success", { source, range });
    return runtime;
  }

  async getLogs(user: User, projectId: string, options: LogQueryOptions) {
    const project = await this.findProjectForView(user, projectId);
    const result = await this.cloudWatchLogs.getRecentLogs(project.id, options);
    await this.audit(user, "CLOUDWATCH_LOGS_QUERIED", project.id, "success", {
      deploymentId: options.deploymentId,
      stream: options.stream || "all",
      limit: options.limit,
    });
    return result;
  }

  async getHealth(user: User, projectId: string) {
    const project = await this.findProjectForView(user, projectId);
    const deployment = await this.latestDeployment(project.id);
    const targetHealth = await this.albService.getTargetHealth(project.id);
    const cloudWatchLogGroup = await this.cloudWatchLogs.resolveLogGroupForProject(project.id, deployment?.id).catch(() => null);
    const health = {
      prometheus: this.prometheus.isEnabled() ? "configured" : "not_configured",
      cloudWatchLogs: cloudWatchLogGroup ? "available" : "unavailable",
      cloudWatchMetrics: this.cloudWatchMetrics.isEnabled() ? "available" : "disabled",
      latestEcsStatus: deployment?.status || "not_deployed",
      latestAlbHealth: targetHealth,
    };

    return health;
  }

  async recordEvent(projectId: string, eventType: string, status: string, message: string, actorUser?: User | null, metadata: Record<string, unknown> = {}) {
    return this.eventRepository.save(
      this.eventRepository.create({
        projectId,
        eventType,
        status,
        message,
        actorUserId: actorUser?.id || null,
        metadata: this.sanitizer.sanitizeMetadata({ projectId, eventType, status, ...metadata }),
      })
    );
  }

  async findProjectForView(user: User, projectId: string) {
    const project = await this.projectRepository.findOne({ where: { id: projectId } });

    if (!project || project.status === ProjectStatus.ARCHIVED) {
      throw new NotFoundException("Project not found");
    }

    if (
      user.role === UserRole.ADMIN ||
      project.ownerUserId === user.id ||
      (user.role === UserRole.READONLY && project.visibility === ProjectVisibility.WORKSPACE)
    ) {
      return project;
    }

    throw new ForbiddenException("Insufficient permissions");
  }

  private latestDeployment(projectId: string) {
    return this.deploymentRepository.findOne({ where: { projectId }, order: { createdAt: "DESC" } });
  }

  private async saveRuntimeSnapshots(projectId: string, deployment: ProjectDeployment | null, source: string, runtime: any) {
    const metrics = ["cpu", "memory", "httpLatency", "requestRate"];

    for (const metricName of metrics) {
      const metric = runtime?.[metricName];
      const latest = metric?.points?.at?.(-1);

      if (!latest) {
        continue;
      }

      await this.runtimeSnapshotRepository.save(
        this.runtimeSnapshotRepository.create({
          projectId,
          deploymentId: deployment?.id || null,
          pipelineRunId: deployment?.pipelineRunId || null,
          source,
          metricName,
          metricUnit: metricName === "memory" ? "bytes" : null,
          value: Number(latest.value || 0),
          timestamp: new Date(latest.timestamp),
          labels: this.sanitizer.sanitizeMetadata(latest.labels || {}),
        })
      );
    }
  }

  private audit(user: User, action: string, projectId: string, status: string, metadata: Record<string, unknown>) {
    return this.auditLogService.record({
      actorUser: user,
      action,
      resourceType: "observability",
      resourceId: projectId,
      status,
      metadata: this.sanitizer.sanitizeMetadata({ projectId, ...metadata }),
    });
  }
}
