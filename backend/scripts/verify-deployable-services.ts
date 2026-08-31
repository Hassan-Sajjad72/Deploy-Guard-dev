import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeServiceDirectory } from "../src/projects/deployable-service-path";
import { assertRailpackRuntimeConfiguration, RailpackRuntimeConfiguration } from "../src/projects/railpack-workflow-contract";

const root = join(__dirname, "..", "..");
const workflow = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const migration = readFileSync(join(root, "backend/src/migrations/1787356813000-ProjectDeployableServices.ts"), "utf8");
const projectEntity = readFileSync(join(root, "backend/src/projects/project.entity.ts"), "utf8");
const newProject = readFileSync(join(root, "frontend/src/pages/NewProject.jsx"), "utf8");
const source = readFileSync(join(root, "backend/src/projects/repository-source.service.ts"), "utf8");
const workspacePackage = JSON.parse(readFileSync(join(root, "backend/fixtures/railpack-native-workspace/package.json"), "utf8")) as { workspaces: string[]; scripts: { start: string } };

assert.equal(normalizeServiceDirectory(undefined), ".");
assert.equal(normalizeServiceDirectory("./apps//web/"), "apps/web");
for (const invalid of ["../api", "apps/../api", "/api", "C:\\api", "api\0escape", "./apps/./web"]) {
  assert.throws(() => normalizeServiceDirectory(invalid), /Service directory/);
}

const base: RailpackRuntimeConfiguration = {
  schemaVersion: 2,
  projectId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  environmentName: "dev",
  sourceSha: "a".repeat(40),
  services: [{ serviceId: "33333333-3333-4333-8333-333333333333", runtimeConfigRevisionId: "55555555-5555-4555-8555-555555555555", serviceName: "Web", serviceDirectory: ".", environment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: {}, databaseAttached: false, managedDatabase: { engine: null, aliases: [] } }],
};
assert.doesNotThrow(() => assertRailpackRuntimeConfiguration(base));
assert.throws(() => assertRailpackRuntimeConfiguration({ ...base, services: [...base.services, { ...base.services[0], serviceId: "44444444-4444-4444-8444-444444444444", serviceName: "web" }] }), /service identity/);
assert.throws(() => assertRailpackRuntimeConfiguration({ ...base, services: [{ ...base.services[0], serviceDirectory: "../web" }] }), /Service directory|canonical/);

assert.doesNotMatch(projectEntity, /@Column[^\n]*app_directory|appDirectory\s*:/);
assert.doesNotMatch(projectEntity, /deploymentOverrides\s*:/);
assert.match(migration, /INSERT INTO "project_deployable_services"/);
assert.match(migration, /UPDATE "project_environment_variables"[\s\S]*SET "service_id"/);
assert.match(migration, /UPDATE "project_database_tiers"[\s\S]*"attached_service_id"/);
assert.match(migration, /DROP COLUMN IF EXISTS "app_directory"/);
assert.match(migration, /UQ_project_deployable_service_name_ci/);
assert.match(newProject, /name: "Web", serviceDirectory: ""/);
assert.match(newProject, /name: `Service \$\{current\.length \+ 1\}`, serviceDirectory: ""/);
assert.match(newProject, /function compareDirectoryPresentation/);
assert.match(newProject, /directorySuggestions\(rankedDirectories, directoryQueries\[service\.key\] \|\| "", service\.serviceDirectory\)/);
assert.doesNotMatch(newProject, /matchingDirectories\(rankedDirectories, service\.serviceDirectory\)/);
assert.match(newProject, /\+ Add Service/);
assert.doesNotMatch(newProject, /Install Command|Build Command|Start Command|Framework|Language|Package Manager/);
assert.match(source, /assertDirectoriesAtExactSha/);
assert.match(source, /checkout\.sourceSha\.toLowerCase\(\) !== input\.sourceSha\.toLowerCase\(\)/);
assert.match(workflow, /fetch-depth: 1/);
assert.match(workflow, /railpack build --name "\$image" "\$directory"/);
assert.doesNotMatch(workflow, /sparse-checkout|framework|package-manager|install-command|start-command/i);
assert.deepEqual(workspacePackage.workspaces, ["apps/*", "packages/*"]);
assert.equal(workspacePackage.scripts.start, "npm --workspace @deployguard-fixture/web run start", "the shared-workspace fixture uses repository-owned targeting rather than DeployGuard-generated commands");
console.log("DEPLOYABLE_SERVICES=PASS DEFAULT_ROOT=1 PATH_AUTHORITY=SERVICE_ONLY EXACT_SHA_DIRECTORY_GATE=1");
