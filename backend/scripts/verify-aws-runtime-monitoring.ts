import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { AWS_RUNTIME_MONITORING_ACTIONS, AWS_RUNTIME_MONITORING_CAPABILITY_VERSION } from "../src/observability/aws-runtime-monitoring-capabilities";
import { AwsPrometheusExportService } from "../src/observability/aws-prometheus-export.service";
import { CloudWatchMetricsService } from "../src/observability/cloudwatch-metrics.service";
import { LiveRuntimeIdentity } from "../src/observability/live-runtime-resolver.service";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";

const root = resolve(__dirname, "../..");
const expected = [
  "cloudwatch:GetMetricData",
  "ecs:DescribeServices",
  "ecs:DescribeTaskDefinition",
  "ecs:ListTasks",
  "elasticloadbalancing:DescribeTargetGroups",
  "elasticloadbalancing:DescribeTargetHealth",
  "logs:FilterLogEvents",
];
assert.equal(AWS_RUNTIME_MONITORING_CAPABILITY_VERSION, "deployguard.monitoring-aws/v1");
assert.deepEqual([...AWS_RUNTIME_MONITORING_ACTIONS].sort(), expected.sort());
assert.equal(AWS_RUNTIME_MONITORING_ACTIONS.some((action) => /Create|Delete|Put|Update|Modify|Register|Deregister|Stop/.test(action)), false, "monitoring is read-only");

const moduleSource = readFileSync(resolve(root, "backend/src/observability/observability.module.ts"), "utf8");
const appSource = readFileSync(resolve(root, "backend/src/app.module.ts"), "utf8");
const resolverSource = readFileSync(resolve(root, "backend/src/observability/live-runtime-resolver.service.ts"), "utf8");
const logsSource = readFileSync(resolve(root, "backend/src/observability/cloudwatch-logs.service.ts"), "utf8");
const metricsSource = readFileSync(resolve(root, "backend/src/observability/cloudwatch-metrics.service.ts"), "utf8");
const frontendSource = readFileSync(resolve(root, "frontend/src/pages/ProjectMetrics.jsx"), "utf8");
// Local product startup is defined by the repository's canonical Compose file.
// The retired docker-compose.yml path must not make monitoring certification
// depend on a file that is no longer part of the product.
const compose = readFileSync(resolve(root, "compose.yaml"), "utf8");
const dashboard = JSON.parse(readFileSync(resolve(root, "monitoring/grafana/dashboards/deployguard-runtime.json"), "utf8"));

assert.match(appSource, /ObservabilityModule/);
assert.match(moduleSource, /LiveRuntimeResolverService/);
assert.match(resolverSource, /DeploymentGenerationStatus\.LIVE/);
assert.match(resolverSource, /StableReleaseStatus\.STABLE/);
assert.match(resolverSource, /id: release\.generationId/);
assert.match(resolverSource, /generationId: generation\.id/);
assert.match(resolverSource, /ListTasksCommand/);
assert.match(logsSource, /FilterLogEventsCommand/);
assert.match(logsSource, /generation_changed/);
assert.match(logsSource, /heartbeat/);
assert.match(logsSource, /liveRuntime\.resolveForUser/);
assert.match(metricsSource, /AWS\/ECS/);
assert.match(metricsSource, /CPUUtilization/);
assert.match(metricsSource, /MemoryUtilization/);
assert.match(metricsSource, /TargetResponseTime/);
assert.match(metricsSource, /HealthyHostCount/);
assert.match(metricsSource, /UnHealthyHostCount/);
assert.match(metricsSource, /awsMetricsCacheSeconds/);
assert.match(frontendSource, /EventSource/);
assert.match(frontendSource, /ECS application logs/);
assert.match(frontendSource, /runtimeAvailability/);
assert.match(compose, /prom\/prometheus/);
assert.match(compose, /grafana\/grafana/);
assert.equal(dashboard.title, "DeployGuard Runtime");
assert.equal(dashboard.panels.length, 5);

async function verifyBehavior() {
  const identity: LiveRuntimeIdentity = {
    projectId: "project-a",
    environmentName: "dev",
    generationId: "generation-a",
    releaseId: "release-a",
    operationId: "operation-a",
    region: "us-east-1",
    cluster: "arn:aws:ecs:us-east-1:123456789012:cluster/shared",
    clusterName: "shared",
    serviceArn: "arn:aws:ecs:us-east-1:123456789012:service/shared/service-a",
    serviceName: "service-a",
    taskDefinitionArn: "arn:aws:ecs:us-east-1:123456789012:task-definition/app:1",
    taskArns: ["arn:aws:ecs:us-east-1:123456789012:task/task-a"],
    targetGroupArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/app/abc",
    loadBalancerArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/shared/def",
    logGroupName: "/deployguard/project-a/dev/generation-a/app",
    logStreamPrefix: "ecs",
    containerName: "app",
    resolvedAt: new Date().toISOString(),
    targetHealth: ["healthy"],
  };
  const config = {
    get(key: string, fallback?: unknown) {
      if (key === "AWS_RUNTIME_MONITORING_ENABLED") return "true";
      if (key === "OBSERVABILITY_AWS_METRICS_CACHE_SECONDS") return "60";
      return fallback;
    },
  };
  let requests = 0;
  const metrics = new CloudWatchMetricsService(config as never, {} as never, { dispatch: async () => null } as never);
  (metrics as unknown as { client: () => { send: (command: { input: { MetricDataQueries: unknown[] } }) => Promise<unknown> } }).client = () => ({
    send: async (command) => {
      requests += 1;
      assert.equal(command.input.MetricDataQueries.length, 5);
      const timestamp = new Date("2026-08-14T00:00:00.000Z");
      return {
        MetricDataResults: [
          { Id: "ecs_cpu", Timestamps: [timestamp], Values: [12.5] },
          { Id: "ecs_memory", Timestamps: [timestamp], Values: [37.5] },
          { Id: "alb_latency", Timestamps: [timestamp], Values: [0.125] },
          { Id: "healthy_hosts", Timestamps: [timestamp], Values: [1] },
          { Id: "unhealthy_hosts", Timestamps: [timestamp], Values: [0] },
        ],
      };
    },
  });
  const first = await metrics.collect(identity, "1h");
  const cached = await metrics.collect(identity, "1h");
  assert.equal(requests, 1, "a Prometheus/UI refresh must reuse the short-lived CloudWatch cache");
  assert.equal(first.cpu.points[0].value, 12.5);
  assert.equal(first.runtimeAvailability.points[0].value, 1);
  assert.equal(cached.cacheStatus, "cached");
  const nextGeneration = { ...identity, generationId: "generation-b", releaseId: "release-b" };
  const switched = await metrics.collect(nextGeneration, "1h");
  assert.equal(requests, 2, "a new LIVE generation must receive an independent metric query/cache key");
  assert.equal(switched.generationId, "generation-b");

  const exporter = new AwsPrometheusExportService({ collectAllLatest: async () => [first] } as never);
  const exposition = await exporter.render();
  for (const family of [
    "deployguard_ecs_cpu_utilization_percent",
    "deployguard_ecs_memory_utilization_percent",
    "deployguard_http_target_response_time_seconds",
    "deployguard_healthy_target_count",
    "deployguard_unhealthy_target_count",
    "deployguard_runtime_available",
  ]) assert.match(exposition, new RegExp(`${family}\\{[^}]*generation_id="generation-a"`));

  const sanitized = new LogSanitizerService().sanitize("password=hunter2 Authorization: Bearer eyJabcdefghijklmnopqrstuv");
  assert.doesNotMatch(sanitized, /hunter2|eyJabcdefghijklmnopqrstuv/);
}

verifyBehavior().then(() => {
  console.log("AWS runtime monitoring verification passed.");
  console.log("  authoritative LIVE identity: enforced");
  console.log("  CloudWatch metrics cache and generation switch: verified");
  console.log("  sanitized SSE generation following: configured");
  console.log("  Prometheus/Grafana provisioning: configured");
  console.log("  IAM capability set: read-only and exact");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
