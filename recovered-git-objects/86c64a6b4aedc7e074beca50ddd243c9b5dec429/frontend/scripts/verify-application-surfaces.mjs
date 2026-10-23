import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const routes = read("../src/routes/AppRoutes.jsx");
const environmentRoute = read("../src/routes/ProjectEnvironmentRoute.jsx");
const environment = read("../src/pages/DeploymentRequirements.jsx");
const variables = read("../src/components/projects/EnvironmentVariablesPanel.jsx");
const logs = read("../src/pages/ProjectLogs.jsx");
const metrics = read("../src/pages/ProjectMetrics.jsx");
const settings = read("../src/pages/ProjectSettings.jsx");
const api = read("../src/api/projectApi.js");

assert.match(routes, /ProjectLogs[\s\S]*path="\/projects\/:projectId\/logs"/);
assert.doesNotMatch(routes, /ProjectPipelineLogs|ProjectEnvVars/);
assert.match(environmentRoute, /Navigate replace to={`\/projects\/\$\{projectId\}\/requirements`}/);
assert.doesNotMatch(environmentRoute, /DeveloperMode|children/);

assert.match(environment, /EnvironmentVariablesPanel/);
assert.match(environment, /title=.*Environment/);
assert.doesNotMatch(environment, /useProductMode|Resolved configuration|configurationFingerprint/);
assert.match(variables, /value is now masked|Values are now masked|value remains masked/);
assert.doesNotMatch(variables, /Developer Mode|Effective configuration ownership|configurationFingerprint/);

assert.match(logs, /getApplicationLogs|getProjectCurrentState/);
assert.doesNotMatch(logs, /CloudWatch|ECS|pipelineRun|logGroup|logStream|EventSource|getPipeline/);
assert.match(metrics, /getApplicationRuntimeMetrics|getProjectCurrentState/);
assert.match(metrics, /"1h", "6h", "24h"/);
assert.doesNotMatch(metrics, /Prometheus|CloudWatch|Metric Source|source.*setSource|operator/i);

for (const forbidden of [
  "getProjectDetailedCurrentState", "getDetectionProfile", "getPreflightReport", "getProjectEnvVars",
  "NotificationSettingsPanel", "DestroyInfrastructurePanel", "Terraform", "recoveryIssue", "cloud",
]) assert.equal(settings.includes(forbidden), false, `Settings must not expose ${forbidden}`);
for (const required of ["updateProject", "updateProjectRepository", "updateProjectBranch", "runStackDetection", "generatePreflightReport", "archiveProject", "/requirements"]) {
  assert.equal(settings.includes(required), true, `Settings must retain ${required}`);
}

assert.match(api, /observability\/application-metrics/);
assert.match(api, /observability\/application-logs/);
assert.doesNotMatch(api, /pipeline\/runs|observability\/logs\/stream/);

console.log("Application Environment, Logs, Metrics, and Settings surface verification passed.");
