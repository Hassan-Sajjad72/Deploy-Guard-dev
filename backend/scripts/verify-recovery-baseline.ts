import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const root = resolve(__dirname, "../..");
const pathFromRoot = (path: string) => resolve(root, path);
const read = (path: string) => readFileSync(pathFromRoot(path), "utf8");

const requiredAreas = [
  "frontend/src/routes/AppRoutes.jsx",
  "backend/src/app.module.ts",
  "backend/src/projects/pipeline/pipeline-worker.service.ts",
  "backend/terraform/modules/ecs-service/main.tf",
  ".github/workflows/deployguard-reusable.yml",
  "backend/src/migrations/1759999999000-CreateLegacyCoreBootstrap.ts",
  "backend/scripts/verify-legacy-retirement.ts",
  "frontend/scripts/verify-application-surfaces.mjs",
  "docs/DEPLOYGUARD_PRODUCT_UI_AUDIT.md",
] as const;

for (const path of requiredAreas) {
  assert.equal(existsSync(pathFromRoot(path)), true, `recovery area is missing: ${path}`);
}

const routes = read("frontend/src/routes/AppRoutes.jsx");
const projectDetails = read("frontend/src/pages/ProjectDetails.jsx");
const projectPipeline = read("frontend/src/pages/ProjectPipeline.jsx");
const deploymentRequirements = read("frontend/src/pages/DeploymentRequirements.jsx");
const projectsController = read("backend/src/projects/projects.controller.ts");
const orchestrationController = read("backend/src/orchestration/orchestration.controller.ts");
const orchestrationService = read("backend/src/orchestration/orchestration.service.ts");
const appModule = read("backend/src/app.module.ts");
const worker = read("backend/src/projects/pipeline/pipeline-worker.service.ts");

for (const activeRoute of [
  'path="/projects/:projectId"',
  'path="/projects/:projectId/pipeline"',
]) {
  assert.match(routes, new RegExp(activeRoute), `active route is missing: ${activeRoute}`);
}
assert.match(projectDetails, /ProjectOverviewLifecycle/);
assert.match(projectPipeline, /PipelineExecution/);
assert.match(deploymentRequirements, /EnvironmentVariablesPanel/);

const environmentAndRequirementsAreDormant = ["environment", "env", "requirements/*"]
  .every((segment) => routes.includes(`LegacyProjectRedirect />} path="/projects/:projectId/${segment}"`));
assert.equal(
  environmentAndRequirementsAreDormant,
  true,
  "update the recovery inventory when environment or requirements routes become active",
);
assert.match(routes, /<Route element=\{<ProjectSettings \/>\} path="\/projects\/:projectId\/settings" \/>/);

for (const endpoint of [
  /@Post\(\)/,
  /@Post\(":projectId\/detect-stack"\)/,
  /@Post\(":projectId\/deploy"\)/,
  /@Post\(":projectId\/deploy\/destroy"\)/,
  /@Get\(":projectId\/deploy\/status"\)/,
  /@Get\(":projectId\/deploy\/history"\)/,
]) {
  assert.match(projectsController, endpoint, `core project endpoint is missing: ${endpoint}`);
}

assert.match(orchestrationController, /@Get\("releases"\)/);
assert.match(orchestrationService, /async getReleases\(/);
assert.match(orchestrationService, /async rollback\(/);
assert.doesNotMatch(
  appModule,
  /OrchestrationModule/,
  "update the recovery inventory when the dormant orchestration controller becomes active",
);

assert.match(worker, /export class PipelineWorkerService/);
assert.match(worker, /\n  start\(\) \{/);
assert.match(worker, /new Worker(?:<[^>]+>)?\(/);

const migrationDirectory = pathFromRoot("backend/src/migrations");
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => /^\d{13}-.+\.ts$/.test(file))
  .sort();
assert.ok(migrationFiles.length > 0, "no database migrations were found");

const timestamps = migrationFiles.map((file) => Number.parseInt(file.slice(0, 13), 10));
assert.equal(new Set(timestamps).size, timestamps.length, "migration timestamps must be unique");
for (let index = 1; index < timestamps.length; index += 1) {
  assert.ok(timestamps[index] > timestamps[index - 1], "migration timestamps must be strictly ordered");
}
assert.equal(
  basename(migrationFiles[0]),
  "1759999999000-CreateLegacyCoreBootstrap.ts",
  "the clean bootstrap migration must remain first",
);

const duplicateLifecycleComponents = [
  "frontend/src/components/projects/CanonicalDeploymentView.jsx",
  "frontend/src/components/projects/ProjectOverviewLifecycle.jsx",
].filter((path) => existsSync(pathFromRoot(path)));
assert.equal(duplicateLifecycleComponents.length, 2, "update the dormant-component inventory when consolidation changes");

console.log(
  JSON.stringify({
    requiredAreas: "present",
    migrations: { count: migrationFiles.length, ordered: true },
    activeSurfaces: ["ProjectDetails", "ProjectOverviewLifecycle", "pipeline history"],
    reportedGaps: [
      "environment-variable management and project settings redirect to Project Overview",
      "rollback service and release listing source exist but OrchestrationModule is not active",
      "BullMQ worker source exists but is intentionally outside the active GitHub Actions-only product graph",
    ],
    duplicatedActiveAndDormantComponents: duplicateLifecycleComponents,
  }, null, 2),
);
