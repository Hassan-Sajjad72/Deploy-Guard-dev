import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { ObservabilityService } from "../src/observability/observability.service";

const root = join(__dirname, "..", "..");
const identity = { generationId: "7fcf0947-d66e-4d79-9cfc-9879d0022548", environmentName: "dev", releaseId: "release", clusterName: "cluster", serviceName: "service", taskArns: ["task"], targetGroupArn: "target", targetHealth: ["healthy"], logGroupName: "logs" };
const liveRuntime = { resolveForUser: async () => identity };
const logs = {};

async function metricsProjection() {
  const disabled = new ObservabilityService(
    new ConfigService({ AWS_RUNTIME_MONITORING_ENABLED: "true", CLOUDWATCH_METRICS_ENABLED: "false", GRAFANA_BASE_URL: "https://grafana.example/d/runtime" }),
    liveRuntime as never,
    { collect: async () => { throw new Error("must not collect"); } } as never,
    logs as never,
  );
  const disabledResult = await disabled.getApplicationMetrics({} as never, "project");
  assert.equal(disabledResult.availabilityState, "disabled_by_configuration");
  assert.deepEqual(disabledResult.grafana, { configured: true, url: "https://grafana.example/d/runtime" }, "Grafana remains configured when CloudWatch metrics are disabled");

  const temporary = new ObservabilityService(
    new ConfigService({ AWS_RUNTIME_MONITORING_ENABLED: "true", CLOUDWATCH_METRICS_ENABLED: "true", GRAFANA_BASE_URL: "https://grafana.example/d/runtime" }),
    liveRuntime as never,
    { collect: async () => { throw new Error("provider timeout"); } } as never,
    logs as never,
  );
  const temporaryResult = await temporary.getApplicationMetrics({} as never, "project");
  assert.equal(temporaryResult.availabilityState, "temporarily_unavailable");
  assert.equal(temporaryResult.grafana.configured, true);

  const noSamples = new ObservabilityService(
    new ConfigService({ AWS_RUNTIME_MONITORING_ENABLED: "true", CLOUDWATCH_METRICS_ENABLED: "true" }),
    liveRuntime as never,
    { collect: async () => ({ available: true, source: "aws_cloudwatch", generationId: identity.generationId, cpu: { points: [] }, memory: { points: [] }, httpLatency: { points: [] }, healthyHosts: { points: [] }, unhealthyHosts: { points: [] }, runtimeAvailability: { points: [{ timestamp: new Date().toISOString(), value: 1 }] } }) } as never,
    logs as never,
  );
  const noSamplesResult = await noSamples.getApplicationMetrics({} as never, "project");
  assert.equal(noSamplesResult.availabilityState, "no_samples_yet");
  assert.deepEqual(noSamplesResult.grafana, { configured: false, url: null });
}

function repositoryContracts() {
  const infrastructure = readFileSync(join(root, "frontend/src/pages/ProjectInfrastructure.jsx"), "utf8");
  const monitoring = readFileSync(join(root, "frontend/src/pages/ProjectMetrics.jsx"), "utf8");
  const workflow = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
  const deployment = readFileSync(join(root, "backend/src/projects/railpack-deployment.service.ts"), "utf8");
  const currentState = readFileSync(join(root, "backend/src/projects/current-state/project-current-state.service.ts"), "utf8");
  assert.match(infrastructure, /Source[\s\S]*Railpack[\s\S]*ECR[\s\S]*ECS[\s\S]*ALB[\s\S]*Application/);
  for (const supporting of ["Terraform", "CloudWatch", "Infracost"]) assert.match(infrastructure, new RegExp(supporting));
  assert.match(infrastructure, /persisted Infracost evidence only/i);
  assert.match(infrastructure, /Technical details/);
  assert.match(monitoring, /getProjectDetailedCurrentState/, "Monitoring must consume the same bounded AWS observation as Infrastructure");
  assert.doesNotMatch(monitoring, /getProjectCurrentState/);
  for (const service of ["Application", "ECS", "Load Balancer", "Logs", "Metrics", "Grafana"]) assert.match(monitoring, new RegExp(`label="${service}"`));
  for (const state of ["disabled_by_configuration", "temporarily_unavailable", "no_samples_yet"]) assert.match(monitoring, new RegExp(state));
  assert.match(workflow, /terraform -chdir=\.deployguard\/terraform plan -input=false -out=deployguard\.tfplan/);
  assert.match(workflow, /deployguard-cost-plan\.json/);
  assert.match(workflow, /before_sensitive[\s\S]*after_sensitive/, "cost evidence must redact sensitive Terraform values");
  assert.match(workflow, /apply -input=false -auto-approve deployguard\.tfplan/, "runtime must apply the exact priced plan");
  assert.match(deployment, /reconcileCompletedRelease\(operation\)[\s\S]*reconcileCostEvidence\(operation\)/, "existing verified LIVE operations must backfill pricing without deployment");
  assert.match(currentState, /source: CostEstimateSource\.INFRACOST/);
  assert.match(currentState, /unavailableReason/);
}

void metricsProjection().then(() => {
  repositoryContracts();
  console.log("DEVELOPER_RUNTIME_EXPERIENCE=PASS");
}).catch((error) => { console.error(error); process.exitCode = 1; });
