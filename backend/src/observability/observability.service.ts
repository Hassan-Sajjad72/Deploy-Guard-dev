import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { User } from "../users/user.entity";
import { CloudWatchLogsService, LogQueryOptions } from "./cloudwatch-logs.service";
import { CloudWatchMetricsService } from "./cloudwatch-metrics.service";
import { getObservabilityConfig } from "./observability.config";
import { AwsRuntimeUnavailableException, LiveRuntimeResolverService, RuntimeIdentityUnavailableException } from "./live-runtime-resolver.service";

@Injectable()
export class ObservabilityService {
  constructor(
    private readonly config: ConfigService,
    private readonly liveRuntime: LiveRuntimeResolverService,
    private readonly metrics: CloudWatchMetricsService,
    private readonly logs: CloudWatchLogsService,
  ) {}

  async getSummary(user: User, projectId: string, serviceId?: string) {
    const identity = await this.liveRuntime.resolveForUser(user, projectId, serviceId);
    const config = getObservabilityConfig(this.config);
    return {
      available: config.awsRuntimeMonitoringEnabled,
      source: "aws_cloudwatch",
      environmentName: identity.environmentName,
      generationId: identity.generationId,
      releaseId: identity.releaseId,
      serviceId: identity.serviceId,
      serviceName: identity.serviceDisplayName,
      publicUrl: identity.publicUrl,
      ecs: { cluster: identity.clusterName, service: identity.serviceName, runningTasks: identity.taskArns.length },
      alb: { targetGroupArn: identity.targetGroupArn, targetHealth: identity.targetHealth },
      prometheus: { enabled: config.prometheusEnabled, url: config.prometheusBaseUrl },
      grafana: { enabled: Boolean(config.grafanaBaseUrl), url: config.grafanaBaseUrl },
      logs: { enabled: config.cloudWatchLogsEnabled, logGroupName: identity.logGroupName },
    };
  }

  async getApplicationMetrics(user: User, projectId: string, range = "1h", serviceId?: string) {
    const config = getObservabilityConfig(this.config);
    const grafana = { configured: Boolean(config.grafanaBaseUrl), url: config.grafanaBaseUrl || null };
    let identity;
    try {
      identity = await this.liveRuntime.resolveForUser(user, projectId, serviceId);
    } catch (error) {
      if (error instanceof RuntimeIdentityUnavailableException) {
        return { available: false, availabilityState: "runtime_identity_unavailable", message: error.message, generationId: null, grafana };
      }
      if (error instanceof AwsRuntimeUnavailableException) {
        return { available: false, availabilityState: "runtime_unavailable", message: error.message, generationId: null, grafana };
      }
      if (error instanceof ServiceUnavailableException) {
        return { available: false, availabilityState: "temporarily_unavailable", message: error.message, generationId: null, grafana };
      }
      throw error;
    }
    if (!config.awsRuntimeMonitoringEnabled || !config.cloudWatchMetricsEnabled) {
      return { available: false, availabilityState: "disabled_by_configuration", message: "CloudWatch runtime metrics are disabled by configuration.", generationId: identity.generationId, grafana };
    }
    try {
      const telemetry = await this.metrics.collect(identity, range);
      const sampledSeries = [telemetry.cpu, telemetry.memory, telemetry.httpLatency, telemetry.healthyHosts, telemetry.unhealthyHosts];
      const hasSamples = sampledSeries.some((series) => series.points.length > 0);
      return {
        ...telemetry,
        available: hasSamples,
        availabilityState: hasSamples ? "available" : "no_samples_yet",
        message: hasSamples ? null : "CloudWatch is available, but no metric samples exist in this time range yet.",
        grafana,
      };
    } catch (error) {
      return {
        available: false,
        availabilityState: "temporarily_unavailable",
        message: error instanceof Error ? error.message : "CloudWatch metrics are temporarily unavailable.",
        generationId: identity.generationId,
        grafana,
      };
    }
  }

  getApplicationLogs(user: User, projectId: string, options: LogQueryOptions, serviceId?: string) {
    return this.logs.getRecentLogs(user, projectId, options, serviceId);
  }

  async getHealth(user: User, projectId: string, serviceId?: string) {
    const summary = await this.getSummary(user, projectId, serviceId);
    return {
      source: summary.source,
      generationId: summary.generationId,
      cloudWatchLogs: summary.logs.enabled ? "available" : "disabled",
      cloudWatchMetrics: getObservabilityConfig(this.config).cloudWatchMetricsEnabled && summary.available ? "available" : "disabled",
      targetHealth: summary.alb.targetHealth,
      prometheus: summary.prometheus.enabled ? "configured" : "not_configured",
      grafanaUrl: summary.grafana.url,
    };
  }
}
