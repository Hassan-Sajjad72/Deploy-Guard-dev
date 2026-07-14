import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  MetricDataQuery,
  StandardUnit,
} from "@aws-sdk/client-cloudwatch";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { LogSanitizerService } from "./log-sanitizer.service";
import { getObservabilityConfig, rangeToDates } from "./observability.config";

@Injectable()
export class CloudWatchMetricsService {
  constructor(
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly sanitizer: LogSanitizerService
  ) {}

  isEnabled() {
    return getObservabilityConfig(this.config).cloudWatchMetricsEnabled;
  }

  async getEcsCpuMemory(projectId: string, deployment: ProjectDeployment | null, range = "1h") {
    if (!deployment?.ecsClusterName || !deployment.ecsServiceName) {
      return { cpu: this.empty("ecs_cpu"), memory: this.empty("ecs_memory") };
    }

    const { start, end } = rangeToDates(range);
    const queries: MetricDataQuery[] = [
      this.metricQuery("ecs_cpu", "AWS/ECS", "CPUUtilization", "Percent", [
        { Name: "ClusterName", Value: deployment.ecsClusterName },
        { Name: "ServiceName", Value: deployment.ecsServiceName },
      ]),
      this.metricQuery("ecs_memory", "AWS/ECS", "MemoryUtilization", "Percent", [
        { Name: "ClusterName", Value: deployment.ecsClusterName },
        { Name: "ServiceName", Value: deployment.ecsServiceName },
      ]),
    ];
    const data = await this.fetch(projectId, queries, start, end, range);
    return { cpu: data.ecs_cpu || this.empty("ecs_cpu"), memory: data.ecs_memory || this.empty("ecs_memory") };
  }

  async getAlbLatency(projectId: string, deployment: ProjectDeployment | null, range = "1h") {
    const loadBalancer = this.albDimension(deployment?.albArn);
    const targetGroup = this.targetGroupDimension(deployment?.targetGroupArn);

    if (!loadBalancer || !targetGroup) {
      return this.empty("alb_latency");
    }

    const { start, end } = rangeToDates(range);
    const data = await this.fetch(projectId, [
      this.metricQuery("alb_latency", "AWS/ApplicationELB", "TargetResponseTime", "Seconds", [
        { Name: "LoadBalancer", Value: loadBalancer },
        { Name: "TargetGroup", Value: targetGroup },
      ]),
    ], start, end, range);
    return data.alb_latency || this.empty("alb_latency");
  }

  async getAlbRequestStats(projectId: string, deployment: ProjectDeployment | null, range = "1h") {
    const loadBalancer = this.albDimension(deployment?.albArn);
    const targetGroup = this.targetGroupDimension(deployment?.targetGroupArn);

    if (!loadBalancer || !targetGroup) {
      return {
        requestRate: this.empty("alb_request_count"),
        target5xx: this.empty("alb_target_5xx"),
        healthyHosts: this.empty("alb_healthy_hosts"),
        unhealthyHosts: this.empty("alb_unhealthy_hosts"),
      };
    }

    const { start, end } = rangeToDates(range);
    const dimensions = [
      { Name: "LoadBalancer", Value: loadBalancer },
      { Name: "TargetGroup", Value: targetGroup },
    ];
    const data = await this.fetch(projectId, [
      this.metricQuery("alb_request_count", "AWS/ApplicationELB", "RequestCount", "Count", dimensions, "Sum"),
      this.metricQuery("alb_target_5xx", "AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "Count", dimensions, "Sum"),
      this.metricQuery("alb_healthy_hosts", "AWS/ApplicationELB", "HealthyHostCount", "Count", dimensions),
      this.metricQuery("alb_unhealthy_hosts", "AWS/ApplicationELB", "UnHealthyHostCount", "Count", dimensions),
    ], start, end, range);

    return {
      requestRate: data.alb_request_count || this.empty("alb_request_count"),
      target5xx: data.alb_target_5xx || this.empty("alb_target_5xx"),
      healthyHosts: data.alb_healthy_hosts || this.empty("alb_healthy_hosts"),
      unhealthyHosts: data.alb_unhealthy_hosts || this.empty("alb_unhealthy_hosts"),
    };
  }

  async getRuntimeMetricFallback(projectId: string, deployment: ProjectDeployment | null, range = "1h") {
    if (!this.isEnabled()) {
      return { enabled: false, message: "CloudWatch metrics are disabled." };
    }

    try {
      const ecs = await this.getEcsCpuMemory(projectId, deployment, range);
      const albLatency = await this.getAlbLatency(projectId, deployment, range);
      const albStats = await this.getAlbRequestStats(projectId, deployment, range);

      return {
        enabled: true,
        source: "cloudwatch",
        cpu: ecs.cpu,
        memory: ecs.memory,
        httpLatency: albLatency,
        requestRate: albStats.requestRate,
        target5xx: albStats.target5xx,
        healthyHosts: albStats.healthyHosts,
        unhealthyHosts: albStats.unhealthyHosts,
      };
    } catch (error) {
      return {
        enabled: false,
        source: "cloudwatch",
        message: this.failureMessage(error, "CloudWatch metrics are unavailable."),
      };
    }
  }

  private async fetch(projectId: string, queries: MetricDataQuery[], start: Date, end: Date, range: string) {
    await this.auditLogService.record({
      actorUser: null,
      action: "CLOUDWATCH_METRICS_QUERIED",
      resourceType: "observability",
      resourceId: projectId,
      status: "success",
      metadata: this.sanitizer.sanitizeMetadata({ projectId, range }),
    });
    const response = await this.client().send(
      new GetMetricDataCommand({
        StartTime: start,
        EndTime: end,
        MetricDataQueries: queries,
      })
    );

    return (response.MetricDataResults || []).reduce((output, item) => {
      output[item.Id || "metric"] = {
        metricName: item.Id,
        points: (item.Timestamps || []).map((timestamp, index) => ({
          timestamp: timestamp.toISOString(),
          value: Number(item.Values?.[index] || 0),
        })).reverse(),
      };
      return output;
    }, {} as Record<string, { metricName?: string; points: { timestamp: string; value: number }[] }>);
  }

  private metricQuery(id: string, namespace: string, metricName: string, unit: StandardUnit, dimensions: { Name: string; Value: string }[], stat = "Average"): MetricDataQuery {
    return {
      Id: id,
      MetricStat: {
        Period: 60,
        Stat: stat,
        Metric: {
          Namespace: namespace,
          MetricName: metricName,
          Dimensions: dimensions,
        },
        Unit: unit,
      },
      ReturnData: true,
    };
  }

  private empty(metricName: string) {
    return { metricName, points: [] };
  }

  private albDimension(arn?: string | null) {
    if (!arn) return null;
    return arn.split(":loadbalancer/")[1] || null;
  }

  private targetGroupDimension(arn?: string | null) {
    if (!arn) return null;
    return arn.split(":targetgroup/")[1] ? `targetgroup/${arn.split(":targetgroup/")[1]}` : null;
  }

  private client() {
    return new CloudWatchClient({ region: this.config.get<string>("AWS_REGION", "us-east-1") });
  }

  private failureMessage(error: unknown, fallback: string) {
    if (!error || typeof error !== "object") {
      return fallback;
    }

    const typed = error as { name?: string };
    return typed.name ? `${fallback} ${typed.name}` : fallback;
  }
}
