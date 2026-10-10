import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { LogSanitizerService } from "../src/observability/log-sanitizer.service";
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
  const phases = readFileSync(join(root, "frontend/src/utils/developerDeploymentPresentation.js"), "utf8");
  assert.match(phases, /Prepare Source[\s\S]*Build Application[\s\S]*Publish Image[\s\S]*Deploy Runtime[\s\S]*Verify Application/, "build stages remain on the canonical deployment surface");
  assert.match(infrastructure, /\["Source commit", state\?\.stableRelease\?\.commit\]/, "source identity comes from the stable release, not the latest attempt");
  for (const node of ["endpoint", "alb", "ecr", "cloudwatch", "terraform"]) assert.match(infrastructure, new RegExp(`id: "${node}"`), `the topology preserves the ${node} evidence inspector`);
  assert.match(infrastructure, /evidence\?\.runtimeIdentity\?\.services/, "topology services are sourced from canonical immutable identity");
  assert.match(infrastructure, /services\.map\(\(service\) => node\(/, "all observed services remain inspectable");
  assert.match(infrastructure, /runningCount === service\.ecs\.desiredCount[\s\S]*service\.targets\.every\(\(target\) => target === "healthy"\)/, "ECS and ALB health jointly control service health");
  for (const supporting of ["Terraform", "CloudWatch", "Infracost"]) assert.match(infrastructure, new RegExp(supporting));
  assert.match(infrastructure, /cost\?\.source === "infracost"/, "Infrastructure pricing remains gated by persisted Infracost evidence");
  assert.match(infrastructure, /summary="AWS resource identifiers"/, "exact infrastructure evidence remains available in the disclosure");
  assert.match(monitoring, /getProjectDetailedCurrentState/, "Monitoring must consume the same bounded AWS observation as Infrastructure");
  assert.doesNotMatch(monitoring, /getProjectCurrentState/);
  for (const [key, title] of [["cpu", "CPU"], ["memory", "Memory"], ["httpLatency", "Response time"], ["healthyHosts", "Healthy instances"], ["unhealthyHosts", "Unhealthy instances"], ["runtimeAvailability", "Availability"]]) assert.match(monitoring, new RegExp(`key: "${key}", title: "${title}"`), `${key} retains its real operator-facing label`);
  for (const evidence of ["Logs", "Grafana"]) assert.match(monitoring, new RegExp(evidence));
  assert.match(monitoring, /runtime\[key\]/, "charts read the canonical runtime metric series");
  for (const state of ["disabled_by_configuration", "temporarily_unavailable", "no_samples_yet"]) assert.match(monitoring, new RegExp(state));
  assert.match(workflow, /terraform -chdir=\.deployguard\/terraform plan -input=false -out=deployguard\.tfplan/);
  assert.match(workflow, /deployguard-cost-plan\.json/);
  assert.match(workflow, /before_sensitive[\s\S]*after_sensitive/, "cost evidence must redact sensitive Terraform values");
  assert.match(workflow, /apply -input=false -auto-approve deployguard\.tfplan/, "runtime must apply the exact priced plan");
  assert.match(deployment, /reconcileCompletedRelease\(operation\)[\s\S]*reconcileCostEvidence\(operation\)/, "existing verified LIVE operations must backfill pricing without deployment");
  assert.match(currentState, /generationId: authoritativeGenerationId,[\s\S]*?pipelineRunId: authoritativeRelease\.deployedByPipelineRunId,[\s\S]*?source: CostEstimateSource\.INFRACOST/, "current Infrastructure pricing must resolve only the canonical LIVE generation and its exact release operation");
  assert.match(currentState, /The current LIVE release has no persisted Infracost evidence\./, "missing current-generation evidence remains explicitly unavailable rather than falling back to a stale estimate");
  assert.match(currentState, /unavailableReason/);
}

function applicationLogSecretSanitization() {
  const sanitizer = new LogSanitizerService();
  const plaintext = "841426246971158";
  const line = sanitizer.sanitize(`Cloudinary API Key: ${plaintext}`);
  assert.doesNotMatch(line, new RegExp(plaintext), "CloudWatch history and stream output must not expose a space-delimited API Key value");
  assert.match(line, /API Key=\[REDACTED\]/i);
  assert.doesNotMatch(sanitizer.sanitize(`{\"api key\":\"${plaintext}\"}`), new RegExp(plaintext), "JSON-form application log keys use the same secret boundary");
}

void metricsProjection().then(() => {
  applicationLogSecretSanitization();
  repositoryContracts();
  console.log("DEVELOPER_RUNTIME_EXPERIENCE=PASS");
}).catch((error) => { console.error(error); process.exitCode = 1; });
