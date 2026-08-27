import { strict as assert } from "node:assert";
import {
  projectApplicationLogs,
  projectApplicationMetrics,
} from "../src/observability/developer-observability-projection";

const metrics = projectApplicationMetrics({
  enabled: true,
  source: "provider-a",
  cpu: { metricName: "internal_cpu", points: [{ timestamp: "2026-08-01T10:00:00Z", value: 42, labels: { service: "secret-id" } }] },
  memory: { points: [{ timestamp: "2026-08-01T10:00:00Z", value: "64" }] },
  httpLatency: { points: [], error: "raw provider error" },
  requestRate: { points: [] },
  healthyHosts: { points: [{ timestamp: "2026-08-01T10:00:00Z", value: 1 }] },
});
assert.equal(metrics.available, true);
assert.equal(metrics.cpu.points[0].value, 42);
assert.equal(metrics.memory.points[0].value, 64);
const serializedMetrics = JSON.stringify(metrics);
for (const hidden of ["source", "metricName", "labels", "error", "healthyHosts", "provider-a", "secret-id"]) {
  assert.equal(serializedMetrics.includes(hidden), false);
}

const unavailable = projectApplicationMetrics({ enabled: false, message: "provider credentials missing" });
assert.deepEqual(unavailable.cpu.points, []);
assert.equal(JSON.stringify(unavailable).includes("credentials"), false);

const logs = projectApplicationLogs({
  enabled: true,
  logGroupName: "/internal/project-id",
  logStreamName: "task/cloud-id",
  nextToken: "opaque-token",
  events: [{
    timestamp: "2026-08-01T10:00:00Z",
    message: "password=hunter2",
    logStreamName: "task/cloud-id",
  }],
}, (value) => value.replace(/hunter2/g, "[redacted]"));
assert.equal(logs.available, true);
assert.equal(logs.events[0].message, "password=[redacted]");
const serializedLogs = JSON.stringify(logs);
for (const hidden of ["logGroupName", "logStreamName", "nextToken", "cloud-id", "opaque-token", "hunter2"]) {
  assert.equal(serializedLogs.includes(hidden), false);
}

console.log("Closed application logs and metrics projection verification passed.");
