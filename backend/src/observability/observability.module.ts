import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AuditLogModule } from "../audit-log/audit-log.module";
import { AlbService } from "../orchestration/alb.service";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { ProjectOrchestrationEvent } from "../orchestration/project-orchestration-event.entity";
import { ProjectPipelineEvent } from "../projects/project-pipeline-event.entity";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { ProjectSecurityFinding } from "../projects/project-security-finding.entity";
import { ProjectSecurityScan } from "../projects/project-security-scan.entity";
import { Project } from "../projects/project.entity";
import { CloudWatchLogsService } from "./cloudwatch-logs.service";
import { CloudWatchMetricsService } from "./cloudwatch-metrics.service";
import { GithubActionsMetricsService } from "./github-actions-metrics.service";
import { LogSanitizerService } from "./log-sanitizer.service";
import { ObservabilityController } from "./observability.controller";
import { ObservabilityService } from "./observability.service";
import { PipelineMetricsService } from "./pipeline-metrics.service";
import { ProjectLogStreamSession } from "./project-log-stream-session.entity";
import { ProjectObservabilityEvent } from "./project-observability-event.entity";
import { ProjectPipelineMetricSummary } from "./project-pipeline-metric-summary.entity";
import { ProjectRuntimeMetricSnapshot } from "./project-runtime-metric-snapshot.entity";
import { ProjectStageMetric } from "./project-stage-metric.entity";
import { PrometheusService } from "./prometheus.service";
import { SseLogStreamService } from "./sse-log-stream.service";
import { TrivyMetricsService } from "./trivy-metrics.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Project,
      ProjectPipelineRun,
      ProjectPipelineEvent,
      ProjectSecurityScan,
      ProjectSecurityFinding,
      ProjectDeployment,
      ProjectOrchestrationEvent,
      ProjectStageMetric,
      ProjectPipelineMetricSummary,
      ProjectRuntimeMetricSnapshot,
      ProjectLogStreamSession,
      ProjectObservabilityEvent,
    ]),
    AuditLogModule,
  ],
  controllers: [ObservabilityController],
  providers: [
    ObservabilityService,
    PipelineMetricsService,
    GithubActionsMetricsService,
    TrivyMetricsService,
    CloudWatchLogsService,
    CloudWatchMetricsService,
    PrometheusService,
    LogSanitizerService,
    SseLogStreamService,
    AlbService,
  ],
  exports: [
    ObservabilityService,
    PipelineMetricsService,
    GithubActionsMetricsService,
    TrivyMetricsService,
    CloudWatchLogsService,
    CloudWatchMetricsService,
    PrometheusService,
    LogSanitizerService,
  ],
})
export class ObservabilityModule {}
