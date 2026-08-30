import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const routes = read("../src/routes/AppRoutes.jsx");
const sidebar = read("../src/components/layout/Sidebar.jsx");
const newProject = read("../src/pages/NewProject.jsx");
const api = read("../src/api/projectApi.js");
const infrastructure = read("../src/pages/ProjectInfrastructure.jsx");
const monitoring = read("../src/pages/ProjectMetrics.jsx");
const admin = read("../src/pages/AdminUsers.jsx");
const deployment = read("../src/components/projects/PipelineExecution.jsx");

for (const route of [
  'path="/projects/:projectId"',
  'path="/projects/:projectId/pipeline"',
  'path="/projects/:projectId/infrastructure"',
  'path="/projects/:projectId/monitoring"',
  'path="/projects/:projectId/settings"',
]) assert.match(routes, new RegExp(route), `canonical route ${route} is reachable`);

for (const retired of ["environment", "env", "requirements/*"]) {
  assert.match(routes, new RegExp(`LegacyProjectRedirect section="/settings" \\/>} path="/projects/:projectId/${retired.replace("*", "\\*")}"`), `${retired} redirects to Settings`);
}
assert.doesNotMatch(routes, /ProjectLogs|ProjectEnvVars|ProjectDetection|ProjectPreflight|\/detection|\/preflight/);
assert.match(sidebar, /Overview/, "canonical project navigation has Overview");
assert.match(sidebar, /Pipeline/, "canonical project navigation has Pipeline");
assert.match(sidebar, /Infrastructure/, "canonical project navigation has Infrastructure");
assert.match(sidebar, /Monitoring/, "canonical project navigation has Monitoring");
assert.doesNotMatch(sidebar, /Environment|Detection|Pre-flight/);

assert.match(newProject, /getGithubRepositories/);
assert.match(newProject, /bulkUpsertProjectEnvVars/);
assert.match(newProject, /deployGithubActionsDeployment/);
assert.doesNotMatch(newProject, /Repository URL|\/requirements/);
assert.match(api, /github\/repositories/);
assert.match(api, /deploy/);

assert.match(infrastructure, /infrastructureEvidence/);
assert.doesNotMatch(infrastructure, /ProjectDeployPanel|deployment-readiness|service-discovery/);
assert.match(infrastructure, /TechnicalDetails/);
assert.match(infrastructure, /Terraform state/);
assert.match(monitoring, /const authority = state\?\.stateAuthority/);
assert.match(monitoring, /authority\?\.monitoring\?\.available/);
assert.match(monitoring, /Source:/);
assert.match(admin, /data-admin-section="overview"/);
assert.match(admin, /data-admin-section="users"/);
assert.match(admin, /data-admin-section="projects"/);
assert.match(admin, /data-admin-section="audit"/);
assert.match(deployment, /canManage \|\| !currentState\.canRetry \|\| !latestFailed/);
assert.doesNotMatch(deployment, /Redeploy|destroyGithubActionsDeployment|deployGithubActionsDeployment/);

console.log("Canonical application surface and consolidated deployment journey verification passed.");
