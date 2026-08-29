import { Injectable } from "@nestjs/common";
import { CloudWatchMetricsService, AwsRuntimeTelemetry, RuntimeMetricSeries } from "./cloudwatch-metrics.service";

const METRICS: Array<{ name: string; help: string; field: keyof Pick<AwsRuntimeTelemetry, "cpu" | "memory" | "httpLatency" | "healthyHosts" | "unhealthyHosts" | "runtimeAvailability"> }> = [
  { name: "deployguard_ecs_cpu_utilization_percent", help: "AWS ECS CPUUtilization for the authoritative LIVE service.", field: "cpu" },
  { name: "deployguard_ecs_memory_utilization_percent", help: "AWS ECS MemoryUtilization for the authoritative LIVE service.", field: "memory" },
  { name: "deployguard_http_target_response_time_seconds", help: "AWS ALB TargetResponseTime for the authoritative LIVE target group.", field: "httpLatency" },
  { name: "deployguard_healthy_target_count", help: "AWS ALB HealthyHostCount for the authoritative LIVE target group.", field: "healthyHosts" },
  { name: "deployguard_unhealthy_target_count", help: "AWS ALB UnHealthyHostCount for the authoritative LIVE target group.", field: "unhealthyHosts" },
  { name: "deployguard_runtime_available", help: "Whether the authoritative LIVE runtime has healthy targets.", field: "runtimeAvailability" },
];

@Injectable()
export class AwsPrometheusExportService {
  constructor(private readonly telemetry: CloudWatchMetricsService) {}

  async render() {
    const samples = await this.telemetry.collectAllLatest();
    const lines: string[] = [];
    for (const metric of METRICS) {
      lines.push(`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} gauge`);
      for (const sample of samples) {
        const value = this.latest(sample[metric.field]);
        if (value === null) continue;
        const labels = this.labels({
          project_id: sample.projectId,
          environment: sample.environmentName,
          generation_id: sample.generationId,
          release_id: sample.releaseId,
          cluster: sample.identity.clusterName,
          service: sample.identity.serviceName,
        });
        lines.push(`${metric.name}{${labels}} ${value}`);
      }
    }
    return `${lines.join("\n")}\n`;
  }

  private latest(series: RuntimeMetricSeries) {
    const value = series.points.at(-1)?.value;
    return Number.isFinite(value) ? Number(value) : null;
  }
  private labels(values: Record<string, string>) {
    return Object.entries(values).map(([key, value]) => `${key}="${value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`).join(",");
  }
}
