import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ProjectDeployment } from "../orchestration/project-deployment.entity";
import { LogSanitizerService } from "./log-sanitizer.service";
import { getObservabilityConfig, rangeToDates } from "./observability.config";

@Injectable()
export class PrometheusService {
  constructor(
    private readonly config: ConfigService,
    private readonly auditLogService: AuditLogService,
    private readonly sanitizer: LogSanitizerService
  ) {}

  isEnabled() {
    return getObservabilityConfig(this.config).prometheusEnabled;
  }

  async queryInstant(query: string) {
    return this.query("/api/v1/query", { query });
  }

  async queryRange(query: string, start: Date, end: Date, step: string) {
    return this.query("/api/v1/query_range", {
      query,
      start: String(Math.floor(start.getTime() / 1000)),
      end: String(Math.floor(end.getTime() / 1000)),
      step,
    });
  }

  async getCpuUsage(projectId: string, deployment: ProjectDeployment | null, range = "1h") {
    return this.runtimeQuery(projectId, "cpu", getObservabilityConfig(this.config).prometheusQueries.cpu, deployment, range);
  }

  async getMemoryUsage(projectId: string, deployment: ProjectDeployment | null, range = "1h") {
    return this.runtimeQuery(projectId, "memory", getObservabilityConfig(this.config).prometheusQueries.memory, deployment, range);
  }

  async getHttpLatency(projectId: string, deployment: ProjectDeployment | null, range = "1h") {
    return this.runtimeQuery(projectId, "http_latency", getObservabilityConfig(this.config).prometheusQueries.latency, deployment, range);
  }

  async getRequestRate(projectId: string, deployment: ProjectDeployment | null, range = "1h") {
    return this.runtimeQuery(projectId, "request_rate", getObservabilityConfig(this.config).prometheusQueries.requestRate, deployment, range);
  }

  async getRuntimeMetrics(projectId: string, deployment: ProjectDeployment | null, range = "1h") {
    if (!this.isEnabled()) {
      return { enabled: false, message: "Prometheus is not configured." };
    }

    return {
      enabled: true,
      source: "prometheus",
      cpu: await this.getCpuUsage(projectId, deployment, range),
      memory: await this.getMemoryUsage(projectId, deployment, range),
      httpLatency: await this.getHttpLatency(projectId, deployment, range),
      requestRate: await this.getRequestRate(projectId, deployment, range),
    };
  }

  private async runtimeQuery(projectId: string, metricName: string, query: string, deployment: ProjectDeployment | null, range: string) {
    const { start, end } = rangeToDates(range);

    await this.auditLogService.record({
      actorUser: null,
      action: "PROMETHEUS_QUERY_STARTED",
      resourceType: "observability",
      resourceId: projectId,
      status: "success",
      metadata: this.sanitizer.sanitizeMetadata({ projectId, metricName, range }),
    });

    try {
      const result = await this.queryRange(this.scopedQuery(query, deployment), start, end, "60s");
      await this.auditLogService.record({
        actorUser: null,
        action: "PROMETHEUS_QUERY_SUCCEEDED",
        resourceType: "observability",
        resourceId: projectId,
        status: "success",
        metadata: this.sanitizer.sanitizeMetadata({ projectId, metricName, range }),
      });
      return this.normalize(metricName, result);
    } catch (error) {
      const message = this.failureMessage(error, "Prometheus query failed.");
      await this.auditLogService.record({
        actorUser: null,
        action: "PROMETHEUS_QUERY_FAILED",
        resourceType: "observability",
        resourceId: projectId,
        status: "failed",
        metadata: this.sanitizer.sanitizeMetadata({ projectId, metricName, range, reason: message }),
      });
      return { metricName, points: [], error: message };
    }
  }

  private async query(path: string, params: Record<string, string>) {
    const config = getObservabilityConfig(this.config);
    const url = new URL(path, config.prometheusBaseUrl);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.prometheusQueryTimeoutSeconds * 1000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`prometheus_${response.status}`);
      }
      return response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  private scopedQuery(query: string, deployment: ProjectDeployment | null) {
    if (!deployment?.ecsServiceName) {
      return query;
    }

    return query.replace(/\$service/g, deployment.ecsServiceName).replace(/\$cluster/g, deployment.ecsClusterName || "");
  }

  private normalize(metricName: string, response: any) {
    const series = response?.data?.result || [];
    return {
      metricName,
      points: series.flatMap((item: any) =>
        (item.values || []).map(([timestamp, value]: [number, string]) => ({
          timestamp: new Date(timestamp * 1000).toISOString(),
          value: Number(value),
          labels: this.sanitizer.sanitizeMetadata(item.metric || {}),
        }))
      ),
    };
  }

  private failureMessage(error: unknown, fallback: string) {
    if (!error || typeof error !== "object") {
      return fallback;
    }

    const typed = error as { name?: string; message?: string };
    return typed.name || typed.message ? `${fallback} ${typed.name || typed.message}` : fallback;
  }
}
