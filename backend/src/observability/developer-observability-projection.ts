type MetricPoint = { timestamp: string; value: number };

const METRICS = ["cpu", "memory", "httpLatency", "requestRate"] as const;

function metricPoints(value: unknown): MetricPoint[] {
  const points = Array.isArray((value as { points?: unknown[] } | null)?.points)
    ? (value as { points: unknown[] }).points
    : [];
  return points.flatMap((point) => {
    const source = point as { timestamp?: unknown; value?: unknown };
    const timestamp = typeof source.timestamp === "string" ? source.timestamp : "";
    const numeric = Number(source.value);
    if (!timestamp || Number.isNaN(Date.parse(timestamp)) || !Number.isFinite(numeric)) return [];
    return [{ timestamp: new Date(timestamp).toISOString(), value: numeric }];
  }).slice(-120);
}

export function projectApplicationMetrics(runtime: unknown) {
  const source = (runtime && typeof runtime === "object" ? runtime : {}) as Record<string, unknown>;
  if (source.enabled === false) {
    return {
      available: false,
      message: "Application metrics are not available yet.",
      cpu: { points: [] },
      memory: { points: [] },
      httpLatency: { points: [] },
      requestRate: { points: [] },
    };
  }
  return {
    available: true,
    message: null,
    ...Object.fromEntries(METRICS.map((metric) => [metric, { points: metricPoints(source[metric]) }])),
  };
}

export function projectApplicationLogs(
  result: unknown,
  sanitize: (value: string) => string,
) {
  const source = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const events = Array.isArray(source.events) ? source.events : [];
  if (source.enabled === false) {
    return { available: false, message: "Application logs are not available yet.", events: [] };
  }
  return {
    available: true,
    message: null,
    events: events.flatMap((event) => {
      const value = event as { timestamp?: unknown; message?: unknown };
      const timestamp = typeof value.timestamp === "string" ? value.timestamp : "";
      if (!timestamp || Number.isNaN(Date.parse(timestamp))) return [];
      return [{
        timestamp: new Date(timestamp).toISOString(),
        message: sanitize(String(value.message || "")).slice(0, 10_000),
      }];
    }).slice(-200),
  };
}
