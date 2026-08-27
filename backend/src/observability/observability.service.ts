import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { User } from "../users/user.entity";
import { CloudWatchLogsService, LogQueryOptions } from "./cloudwatch-logs.service";
import { CloudWatchMetricsService } from "./cloudwatch-metrics.service";
import { getObservabilityConfig } from "./observability.config";
import { LiveRuntimeResolverService } from "./live-runtime-resolver.service";

@Injectable()
export class ObservabilityService {
  constructor(
    private readonly config: ConfigService,
    private readonly liveRuntime: LiveRuntimeResolverService,
    private readonly metrics: CloudWatchMetricsService,
    private readonly logs: CloudWatchLogsService,
  ) {}

  async getSummary(user: User, projectId: string) {
    const identity = await this.liveRuntime.resolveForUser(user, projectId);
    const config = getObservabilityConfig(this.config);
    return {
      available: config.awsRuntimeMonitoringEnabled,
      source: "aws_cloudwatch",
      environmentName: identity.environmentName,
      generationId: identity.generationId,
      releaseId: identity.releaseId,
      ecs: { cluster: identity.clusterName, service: identity.serviceName, runningTasks: identity.taskArns.length },
      alb: { targetGroupArn: identity.targetGroupArn, targetHealth: identity.targetHealth },
      prometheus: { enabled: config.prometheusEnabled, url: config.prometheusBaseUrl },
      grafana: { enabled: Boolean(config.grafanaBaseUrl), url: config.grafanaBaseUrl },
      logs: { enabled: config.cloudWatchLogsEnabled, logGroupName: identity.logGroupName },
    };
  }

  async getApplicationMetrics(user: User, projectId: string, range = "1h") {
    let identity;
    try {
      identity = await this.liveRuntime.resolveForUser(user, projectId);
    } catch (error) {
      if (error instanceof ServiceUnavailableException) {
        return { available: false, message: error.message, generationId: null };
      }
      throw error;
    }
    if (!getObservabilityConfig(this.config).cloudWatchMetricsEnabled) {
      return { available: false, message: "CloudWatch runtime metrics are disabled.", generationId: identity.generationId };
    }
    const telemetry = await this.metrics.collect(identity, range);
    return { ...telemetry, grafanaUrl: getObservabilityConfig(this.config).grafanaBaseUrl || null };
  }

  getApplicationLogs(user: User, projectId: string, options: LogQueryOptions) {
    return this.logs.getRecentLogs(user, projectId, options);
  }

  async getHealth(user: User, projectId: string) {
    const summary = await this.getSummary(user, projectId);
    return {
      source: summary.source,
      generationId: summary.generationId,
      cloudWatchLogs: summary.logs.enabled ? "available" : "disabled",
      cloudWatchMetrics: summary.available ? "available" : "disabled",
      targetHealth: summary.alb.targetHealth,
      prometheus: summary.prometheus.enabled ? "configured" : "not_configured",
      grafanaUrl: summary.grafana.url,
    };
  }
}
