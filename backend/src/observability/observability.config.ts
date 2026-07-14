import { ConfigService } from "@nestjs/config";

export type ObservabilityRange = "1h" | "6h" | "24h";

export function getObservabilityConfig(config: ConfigService) {
  return {
    prometheusEnabled: config.get<string>("PROMETHEUS_ENABLED", "false") === "true",
    prometheusBaseUrl: config.get<string>("PROMETHEUS_BASE_URL", "http://localhost:9090"),
    prometheusQueryTimeoutSeconds: Number(config.get<string>("PROMETHEUS_QUERY_TIMEOUT_SECONDS", "10")),
    cloudWatchLogsEnabled: config.get<string>("CLOUDWATCH_LOGS_ENABLED", "true") !== "false",
    cloudWatchMetricsEnabled: config.get<string>("CLOUDWATCH_METRICS_ENABLED", "true") !== "false",
    logStreamPollIntervalSeconds: Number(config.get<string>("OBSERVABILITY_LOG_STREAM_POLL_INTERVAL_SECONDS", "5")),
    logStreamMaxEvents: Number(config.get<string>("OBSERVABILITY_LOG_STREAM_MAX_EVENTS", "100")),
    logStreamHeartbeatSeconds: Number(config.get<string>("OBSERVABILITY_LOG_STREAM_HEARTBEAT_SECONDS", "15")),
    maskSecrets: config.get<string>("OBSERVABILITY_MASK_SECRETS", "true") !== "false",
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
