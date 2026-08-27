import { ConfigService } from "@nestjs/config";
import { envBoolean } from "../config/env-parsing";

export type ObservabilityRange = "1h" | "6h" | "24h";

export function getObservabilityConfig(config: ConfigService) {
  const production = config.get<string>("NODE_ENV", process.env.NODE_ENV || "development") === "production";
  return {
    awsRuntimeMonitoringEnabled: envBoolean(config, "AWS_RUNTIME_MONITORING_ENABLED", true),
    prometheusEnabled: envBoolean(config, "PROMETHEUS_ENABLED", false),
    prometheusBaseUrl: config.get<string>("PROMETHEUS_BASE_URL", "http://localhost:9090"),
    prometheusScrapeToken: config.get<string>("PROMETHEUS_SCRAPE_TOKEN", production ? "" : "deployguard-local-monitoring"),
    grafanaBaseUrl: config.get<string>("GRAFANA_BASE_URL", "http://localhost:3001/d/deployguard-runtime/deployguard-runtime"),
    prometheusQueryTimeoutSeconds: Number(config.get<string>("PROMETHEUS_QUERY_TIMEOUT_SECONDS", "10")),
    cloudWatchLogsEnabled: envBoolean(config, "CLOUDWATCH_LOGS_ENABLED", true),
    cloudWatchMetricsEnabled: envBoolean(config, "CLOUDWATCH_METRICS_ENABLED", true),
    awsMetricsCacheSeconds: Math.min(300, Math.max(30, Number(config.get<string>("OBSERVABILITY_AWS_METRICS_CACHE_SECONDS", "60")))),
    logStreamPollIntervalSeconds: Number(config.get<string>("OBSERVABILITY_LOG_STREAM_POLL_INTERVAL_SECONDS", "5")),
    logStreamMaxEvents: Number(config.get<string>("OBSERVABILITY_LOG_STREAM_MAX_EVENTS", "100")),
    logStreamHeartbeatSeconds: Number(config.get<string>("OBSERVABILITY_LOG_STREAM_HEARTBEAT_SECONDS", "15")),
    logReconnectMilliseconds: Math.min(30_000, Math.max(1_000, Number(config.get<string>("OBSERVABILITY_LOG_RECONNECT_MILLISECONDS", "5000")))),
    logHistoryMinutes: Math.min(60, Math.max(1, Number(config.get<string>("OBSERVABILITY_LOG_HISTORY_MINUTES", "15")))),
    logHistoryMaxEvents: Math.min(500, Math.max(20, Number(config.get<string>("OBSERVABILITY_LOG_HISTORY_MAX_EVENTS", "200")))),
    maskSecrets: envBoolean(config, "OBSERVABILITY_MASK_SECRETS", true),
    defaultRange: config.get<ObservabilityRange>("OBSERVABILITY_DEFAULT_RANGE", "1h"),
    awsRegion: config.get<string>("AWS_REGION", "us-east-1"),
    prometheusQueries: {
      cpu: config.get<string>("PROMETHEUS_CPU_QUERY", "rate(container_cpu_usage_seconds_total[5m])"),
      memory: config.get<string>("PROMETHEUS_MEMORY_QUERY", "container_memory_working_set_bytes"),
      latency: config.get<string>("PROMETHEUS_HTTP_LATENCY_QUERY", "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))"),
      requestRate: config.get<string>("PROMETHEUS_REQUEST_RATE_QUERY", "rate(http_requests_total[5m])"),
    },
  };
}

export function rangeToDates(range: string) {
  const now = new Date();
  const hours = range === "24h" ? 24 : range === "6h" ? 6 : 1;
  return {
    start: new Date(now.getTime() - hours * 60 * 60 * 1000),
    end: now,
    seconds: hours * 60 * 60,
  };
}
