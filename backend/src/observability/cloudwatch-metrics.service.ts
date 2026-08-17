import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CloudWatchClient, GetMetricDataCommand, MetricDataQuery, StandardUnit } from "@aws-sdk/client-cloudwatch";
import { LiveRuntimeIdentity, LiveRuntimeResolverService } from "./live-runtime-resolver.service";
import { getObservabilityConfig, rangeToDates } from "./observability.config";
import { NotificationDispatcherService } from "../notifications/notification-dispatcher.service";

export type RuntimeMetricPoint = { timestamp: string; value: number };
export type RuntimeMetricSeries = { metricName: string; unit: string; points: RuntimeMetricPoint[] };
export type AwsRuntimeTelemetry = {
  available: boolean;
  source: "aws_cloudwatch";
  projectId: string;
  environmentName: string;
  generationId: string;
  releaseId: string;
  collectedAt: string;
  cacheStatus: "fresh" | "cached" | "stale";
  warning: string | null;
  identity: Pick<LiveRuntimeIdentity, "clusterName" | "serviceName" | "targetGroupArn" | "loadBalancerArn" | "taskArns" | "targetHealth">;
  cpu: RuntimeMetricSeries;
  memory: RuntimeMetricSeries;
  httpLatency: RuntimeMetricSeries;
  healthyHosts: RuntimeMetricSeries;
  unhealthyHosts: RuntimeMetricSeries;
  runtimeAvailability: RuntimeMetricSeries;
};

type CacheEntry = { expiresAt: number; staleUntil: number; telemetry: AwsRuntimeTelemetry };

@Injectable()
export class CloudWatchMetricsService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<AwsRuntimeTelemetry>>();

  constructor(
    private readonly config: ConfigService,
    private readonly liveRuntime: LiveRuntimeResolverService,
    private readonly notifications: NotificationDispatcherService,
  ) {}

  isEnabled() { return getObservabilityConfig(this.config).awsRuntimeMonitoringEnabled; }

  async getForUser(projectId: string, identity: LiveRuntimeIdentity, range = "1h") {
    return this.collect(identity, range);
  }

  async getForProject(projectId: string, range = "1h") {
    return this.collect(await this.liveRuntime.resolveProjectId(projectId), range);
  }

  async collect(identity: LiveRuntimeIdentity, range = "1h"): Promise<AwsRuntimeTelemetry> {
    if (!this.isEnabled()) throw new Error("AWS runtime monitoring is disabled.");
    if (!["1h", "6h", "24h"].includes(range)) throw new Error("Unsupported metrics time range.");
    const key = `${identity.projectId}:${identity.generationId}:${range}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached?.expiresAt && cached.expiresAt > now) return { ...cached.telemetry, cacheStatus: "cached" };
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const request = this.fetch(identity, range).catch((error) => {
      if (cached && cached.staleUntil > Date.now()) {
        return { ...cached.telemetry, cacheStatus: "stale" as const, warning: this.errorMessage(error) };
      }
      throw error;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  async collectAllLatest() {
    const output: AwsRuntimeTelemetry[] = [];
    for (const projectId of await this.liveRuntime.liveProjectIds()) {
      try { output.push(await this.getForProject(projectId, "1h")); } catch { /* one project cannot break all Prometheus output */ }
    }
    return output;
  }

  private async fetch(identity: LiveRuntimeIdentity, range: string) {
    const { start, end } = rangeToDates(range);
    const ecsDimensions = [
      { Name: "ClusterName", Value: identity.clusterName },
      { Name: "ServiceName", Value: identity.serviceName },
    ];
    const albDimensions = [
      { Name: "LoadBalancer", Value: this.loadBalancerDimension(identity.loadBalancerArn) },
      { Name: "TargetGroup", Value: this.targetGroupDimension(identity.targetGroupArn) },
    ];
    const response = await this.client(identity.region).send(new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      MetricDataQueries: [
        this.query("ecs_cpu", "AWS/ECS", "CPUUtilization", "Percent", ecsDimensions),
        this.query("ecs_memory", "AWS/ECS", "MemoryUtilization", "Percent", ecsDimensions),
        this.query("alb_latency", "AWS/ApplicationELB", "TargetResponseTime", "Seconds", albDimensions),
        this.query("healthy_hosts", "AWS/ApplicationELB", "HealthyHostCount", "Count", albDimensions),
        this.query("unhealthy_hosts", "AWS/ApplicationELB", "UnHealthyHostCount", "Count", albDimensions),
      ],
    }));
    const values = Object.fromEntries((response.MetricDataResults || []).map((item) => [item.Id, this.points(item.Timestamps, item.Values)]));
    const observedAt = new Date().toISOString();
    const healthy = values.healthy_hosts || [];
    const unhealthy = values.unhealthy_hosts || [];
    const healthByTimestamp = new Map<string, { healthy: number; unhealthy: number }>();
    for (const point of healthy) healthByTimestamp.set(point.timestamp, { healthy: point.value, unhealthy: 0 });
    for (const point of unhealthy) {
      const value = healthByTimestamp.get(point.timestamp) || { healthy: 0, unhealthy: 0 };
      value.unhealthy = point.value;
      healthByTimestamp.set(point.timestamp, value);
    }
    let availability = [...healthByTimestamp].map(([timestamp, value]) => ({
      timestamp,
      value: value.healthy > 0 && value.unhealthy === 0 ? 1 : 0,
    })).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (!availability.length) {
      availability = [{
        timestamp: observedAt,
        value: identity.targetHealth.length > 0 && identity.targetHealth.every((state) => state === "healthy") ? 1 : 0,
      }];
    }
    const telemetry: AwsRuntimeTelemetry = {
      available: true,
      source: "aws_cloudwatch",
      projectId: identity.projectId,
      environmentName: identity.environmentName,
      generationId: identity.generationId,
      releaseId: identity.releaseId,
      collectedAt: observedAt,
      cacheStatus: "fresh",
      warning: null,
      identity: {
        clusterName: identity.clusterName,
        serviceName: identity.serviceName,
        targetGroupArn: identity.targetGroupArn,
        loadBalancerArn: identity.loadBalancerArn,
        taskArns: identity.taskArns,
        targetHealth: identity.targetHealth,
      },
      cpu: this.series("ecs_cpu_utilization", "percent", values.ecs_cpu),
      memory: this.series("ecs_memory_utilization", "percent", values.ecs_memory),
      httpLatency: this.series("alb_target_response_time", "seconds", values.alb_latency),
      healthyHosts: this.series("alb_healthy_host_count", "count", healthy),
      unhealthyHosts: this.series("alb_unhealthy_host_count", "count", unhealthy),
      runtimeAvailability: this.series("runtime_availability", "ratio", availability),
    };
    const latestHealthy = healthy.at(-1)?.value ?? 0;
    const latestUnhealthy = unhealthy.at(-1)?.value ?? 0;
    if (latestUnhealthy > 0 || (latestHealthy === 0 && identity.targetHealth.includes("unhealthy"))) {
      await this.notifications.dispatch({
        projectId: identity.projectId,
        pipelineRunId: identity.operationId,
        eventId: `${identity.generationId}:runtime_unhealthy`,
        stage: "runtime_unhealthy",
        status: "failed",
        message: `The authoritative LIVE runtime reports ${latestHealthy} healthy and ${latestUnhealthy} unhealthy target(s).`,
        action: "runtime_health",
        environmentName: identity.environmentName,
        generationId: identity.generationId,
        projectUrl: `${this.config.get<string>("FRONTEND_URL", "http://localhost:5173").replace(/\/$/, "")}/projects/${identity.projectId}/monitoring`,
      }).catch(() => undefined);
    }
    const ttl = getObservabilityConfig(this.config).awsMetricsCacheSeconds * 1_000;
    this.cache.set(`${identity.projectId}:${identity.generationId}:${range}`, {
      telemetry,
      expiresAt: Date.now() + ttl,
      staleUntil: Date.now() + Math.max(ttl * 5, 300_000),
    });
    return telemetry;
  }

  private query(id: string, namespace: string, metricName: string, unit: StandardUnit, dimensions: { Name: string; Value: string }[]): MetricDataQuery {
    return { Id: id, ReturnData: true, MetricStat: { Period: 60, Stat: "Average", Unit: unit, Metric: { Namespace: namespace, MetricName: metricName, Dimensions: dimensions } } };
  }

  private points(timestamps: Date[] | undefined, values: number[] | undefined) {
    return (timestamps || []).flatMap((timestamp, index) => Number.isFinite(values?.[index])
      ? [{ timestamp: timestamp.toISOString(), value: Number(values![index]) }]
      : []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  private series(metricName: string, unit: string, points: RuntimeMetricPoint[] = []): RuntimeMetricSeries { return { metricName, unit, points }; }
  private loadBalancerDimension(arn: string) { return arn.split(":loadbalancer/")[1] || ""; }
  private targetGroupDimension(arn: string) { return arn.split(":targetgroup/")[1] ? `targetgroup/${arn.split(":targetgroup/")[1]}` : ""; }
  private client(region: string) { return new CloudWatchClient({ region }); }
  private errorMessage(error: unknown) { return error instanceof Error ? error.message : "CloudWatch metrics are temporarily unavailable."; }
}
