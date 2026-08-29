import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ProjectStableRelease } from "../orchestration/project-stable-release.entity";
import { ProjectDeploymentGeneration } from "../projects/project-deployment-generation.entity";
import { Project } from "../projects/project.entity";
import { NotificationsModule } from "../notifications/notifications.module";
import { AwsPrometheusExportService } from "./aws-prometheus-export.service";
import { CloudWatchLogsService } from "./cloudwatch-logs.service";
import { CloudWatchMetricsService } from "./cloudwatch-metrics.service";
import { LiveRuntimeResolverService } from "./live-runtime-resolver.service";
import { LogSanitizerService } from "./log-sanitizer.service";
import { ObservabilityController } from "./observability.controller";
import { ObservabilityService } from "./observability.service";
import { PrometheusMetricsController } from "./prometheus-metrics.controller";
import { ProjectsModule } from "../projects/projects.module";

/** Read-only AWS monitoring for the authoritative GitHub Actions LIVE generation. */
@Module({
  imports: [TypeOrmModule.forFeature([Project, ProjectDeploymentGeneration, ProjectStableRelease]), NotificationsModule, ProjectsModule],
  controllers: [ObservabilityController, PrometheusMetricsController],
  providers: [
    LiveRuntimeResolverService,
    CloudWatchLogsService,
    CloudWatchMetricsService,
    AwsPrometheusExportService,
    LogSanitizerService,
    ObservabilityService,
  ],
  exports: [LiveRuntimeResolverService, CloudWatchLogsService, CloudWatchMetricsService],
})
export class ObservabilityModule {}
