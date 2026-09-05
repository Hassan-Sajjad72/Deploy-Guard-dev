import "reflect-metadata";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeServiceDirectory } from "../src/projects/deployable-service-path";
import { assertRailpackRuntimeConfiguration, RailpackRuntimeConfiguration } from "../src/projects/railpack-workflow-contract";

const root = join(__dirname, "..", "..");
const workflow = readFileSync(join(root, ".github/workflows/deployguard-reusable.yml"), "utf8");
const executableWorkflow = workflow.split("\n").filter((line) => !line.trimStart().startsWith("#")).join("\n");
const migration = readFileSync(join(root, "backend/src/migrations/1787356813000-ProjectDeployableServices.ts"), "utf8");
const portMigration = readFileSync(join(root, "backend/src/migrations/1787356819000-DeployableServicePort.ts"), "utf8");
const automaticPortMigration = readFileSync(join(root, "backend/src/migrations/1787356822000-AutomaticServicePortAuthority.ts"), "utf8");
const serviceDto = readFileSync(join(root, "backend/src/projects/dto/deployable-service.dto.ts"), "utf8");
const projectEntity = readFileSync(join(root, "backend/src/projects/project.entity.ts"), "utf8");
const entrypointMigration = readFileSync(join(root, "backend/src/migrations/1787356818000-ProjectApplicationEntrypoint.ts"), "utf8");
const newProject = readFileSync(join(root, "frontend/src/pages/NewProject.jsx"), "utf8");
const newProjectStyles = readFileSync(join(root, "frontend/src/styles.css"), "utf8");
const source = readFileSync(join(root, "backend/src/projects/repository-source.service.ts"), "utf8");
const workspacePackage = JSON.parse(readFileSync(join(root, "backend/fixtures/railpack-native-workspace/package.json"), "utf8")) as { workspaces: string[]; scripts: { start: string } };

assert.equal(normalizeServiceDirectory(undefined), ".");
assert.equal(normalizeServiceDirectory("./apps//web/"), "apps/web");
for (const invalid of ["../api", "apps/../api", "/api", "C:\\api", "api\0escape", "./apps/./web"]) {
  assert.throws(() => normalizeServiceDirectory(invalid), /Service directory/);
}

const base: RailpackRuntimeConfiguration = {
  schemaVersion: 3,
  projectId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  environmentName: "dev",
  sourceSha: "a".repeat(40),
  services: [{ serviceId: "33333333-3333-4333-8333-333333333333", runtimeConfigRevisionId: "55555555-5555-4555-8555-555555555555", serviceName: "Web", serviceDirectory: ".", servicePort: 8080, buildEnvironment: {}, buildSecretReferences: {}, environment: { PORT: "8080", HOST: "0.0.0.0" }, secretReferences: {}, databaseAttached: false, managedDatabase: { engine: null, aliases: [] } }],
};
assert.doesNotThrow(() => assertRailpackRuntimeConfiguration(base));
assert.throws(() => assertRailpackRuntimeConfiguration({ ...base, services: [{ ...base.services[0], servicePort: 0, environment: { PORT: "0", HOST: "0.0.0.0" } }] }), /service port/);
assert.throws(() => assertRailpackRuntimeConfiguration({ ...base, services: [{ ...base.services[0], servicePort: 65536, environment: { PORT: "65536", HOST: "0.0.0.0" } }] }), /service port/);
assert.throws(() => assertRailpackRuntimeConfiguration({ ...base, services: [{ ...base.services[0], servicePort: 3000 }] }), /platform runtime values/);
assert.throws(() => assertRailpackRuntimeConfiguration({ ...base, services: [...base.services, { ...base.services[0], serviceId: "44444444-4444-4444-8444-444444444444", serviceName: "web" }] }), /service identity/);
assert.throws(() => assertRailpackRuntimeConfiguration({ ...base, services: [{ ...base.services[0], serviceDirectory: "../web" }] }), /Service directory|canonical/);

assert.doesNotMatch(projectEntity, /@Column[^\n]*app_directory|appDirectory\s*:/);
assert.doesNotMatch(projectEntity, /deploymentOverrides\s*:/);
assert.match(migration, /INSERT INTO "project_deployable_services"/);
assert.match(migration, /UPDATE "project_environment_variables"[\s\S]*SET "service_id"/);
assert.match(migration, /UPDATE "project_database_tiers"[\s\S]*"attached_service_id"/);
assert.match(migration, /DROP COLUMN IF EXISTS "app_directory"/);
assert.match(migration, /UQ_project_deployable_service_name_ci/);
assert.match(portMigration, /ADD COLUMN "service_port" integer NOT NULL DEFAULT 8080/);
assert.match(portMigration, /"service_port" BETWEEN 1 AND 65535/);
assert.match(automaticPortMigration, /ALTER COLUMN "service_port" DROP DEFAULT/);
assert.match(automaticPortMigration, /ALTER COLUMN "service_port" DROP NOT NULL/);
assert.doesNotMatch(newProject, /<span>Application port<\/span>|servicePort: Number\(servicePort\)/);
assert.doesNotMatch(serviceDto, /servicePort/);
assert.match(newProject, /function buildDirectoryTree/);
assert.match(newProject, /function filterDirectoryTree/);
assert.match(newProject, /function DirectoryTreeNodes/);
assert.match(newProject, /function directoryLeaf/);
assert.match(newProject, /role="combobox"/);
assert.match(newProject, /role="tree"/);
assert.match(newProject, /role="treeitem"/);
assert.match(newProject, /function selectDirectory/);
assert.match(newProject, /onValueChange\(directory\)/);
assert.match(newProject, /Expand/);
assert.match(newProject, /Repository root/);
assert.match(newProject, /services\.map\(\(\{ key, name, serviceDirectory \}\)/);
assert.match(newProjectStyles, /max-height:280px;overflow-y:auto/);
assert.doesNotMatch(newProject, /DIRECTORY_SUGGESTION_LIMIT|matchingDirectories|\.slice\(0,\s*\d+\)/);
assert.doesNotMatch(newProject, /manualEntry|Exact directory path|Selected path|Enter path manually|Use this directory|Selected directory:|service-directory-breadcrumbs|immediateChildDirectories/);
assert.doesNotMatch(newProject, /<span>Search directory suggestions<\/span>|<span>Directory suggestions<\/span>/);
assert.match(newProject, /\+ Add Service/);
assert.match(newProject, /Application service/);
assert.match(newProject, /applicationEntryPointServiceId/);
assert.match(projectEntity, /applicationEntryPointServiceId: string \| null/);
assert.match(entrypointMigration, /HAVING COUNT\(\*\) = 1/);
assert.doesNotMatch(newProject, /Install Command|Build Command|Start Command|Framework|Language|Package Manager/);
assert.match(source, /assertDirectoriesAtExactSha/);
assert.match(source, /resolveServicePortsAtExactSha/);
assert.match(source, /checkout\.sourceSha\.toLowerCase\(\) !== input\.sourceSha\.toLowerCase\(\)/);
assert.match(workflow, /fetch-depth: 1/);
assert.match(workflow, /buildTargetRevisionId/);
assert.match(workflow, /railpack build "\$\{build_env_args\[@\]\}" --name "\$image" "\$build_root"/);
assert.match(workflow, /DG_BUILD_TARGET_INVALID/);
assert.doesNotMatch(executableWorkflow, /sparse-checkout|framework|package-manager|install-command|start-command/i);
assert.deepEqual(workspacePackage.workspaces, ["apps/*", "packages/*"]);
assert.equal(workspacePackage.scripts.start, "npm --workspace @deployguard-fixture/web run start", "the shared-workspace fixture uses repository-owned targeting rather than DeployGuard-generated commands");
console.log("DEPLOYABLE_SERVICES=PASS SERVICE_AUTHORITY=USER_SELECTED BUILD_SCOPE_AUTHORITY=EXACT_SHA_CANONICAL PORT_AUTHORITY=AUTOMATIC");
