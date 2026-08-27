import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_PLAN_DETECTOR_VERSION, BUILD_PLAN_REANALYSIS_MESSAGE, BuildPlan, requireBuildPlan } from "../src/projects/build-plan";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { deploymentContractFingerprint } from "../src/projects/analysis-fingerprint";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";
import { buildPlanWorkflowInputs } from "../src/projects/github-actions-operation-contract";

const plan: BuildPlan = {
  planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, repositoryFullName: "example/app", branch: "main",
  commitSha: "a".repeat(40), detectorId: "express:express-server", language: "javascript", framework: "express",
  frameworkMode: "express-server", confidence: "high", platformBackendMount: "/__deployguard/backend", evidence: [{ source: "package.json", description: "Express dependency" }],
  appRoot: ".", repositoryInstallRoot: ".", packageManager: "npm", dependencyManifest: "package.json", lockfile: null, runtimeVersion: "22",
  baseImage: "node:22-alpine3.21", runtimeImage: "node:22-alpine3.21", installCommand: "npm install", buildCommand: null, buildCommands: [],
  releaseCommand: null, releaseCommands: [], runCommand: "npm start", runtimeFiles: ["."], outputDirectory: null, buildSystemDependencies: [], runtimeSystemDependencies: [],
  port: 3000, portSource: "source", healthPath: "/health", bindHost: "0.0.0.0", bindsToPortEnv: true, runtimeType: "server",
  environmentOwnership: [{ key: "PORT", owner: "platform", required: true, phase: "runtime", secret: false }],
  requiredInputs: [], requiredUserInputs: [], optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: [], secretEnvVars: [], dockerStrategy: "generated",
  dockerTemplate: "express-server", warnings: ["No JavaScript lockfile was found; deployment will use a compatible non-frozen install command."], blockers: [], serviceBindings: [],
};

assert.equal(requireBuildPlan({ buildPlan: plan }), plan);
assert.throws(() => requireBuildPlan({ buildPlan: { ...plan, planVersion: 1 as unknown as 2 } }), (error: unknown) => error instanceof Error && error.message === BUILD_PLAN_REANALYSIS_MESSAGE);
assert.equal(evaluateBuildPlanReadiness({ ...plan, warnings: [] }).status, "READY");
assert.equal(evaluateBuildPlanReadiness(plan).status, "READY_WITH_WARNINGS");
assert.deepEqual(evaluateBuildPlanReadiness(plan, { unresolvedRequiredValues: ["JWT_SECRET"] }), { status: "INPUT_REQUIRED", warnings: plan.warnings, blockers: [], requiredInputs: ["JWT_SECRET"] });
assert.equal(evaluateBuildPlanReadiness({ ...plan, blockers: ["Server binds only to localhost instead of 0.0.0.0."] }).status, "BLOCKED");
assert.equal(evaluateBuildPlanReadiness({ ...plan, blockers: ["Secret variables cannot be used during image build: API_TOKEN."] }).status, "BLOCKED");
assert.equal(evaluateBuildPlanReadiness({ ...plan, blockers: ["A safe production start command could not be inferred."] }).status, "INPUT_REQUIRED");

const template = new TemplateRegistryService().getTemplate("express-server")!;
const dockerfile = new DockerTemplateEngineService().renderDockerfile(template, plan)!;
assert.match(dockerfile, /RUN npm install/);
assert.doesNotMatch(dockerfile, /npm ci/);
assert.match(dockerfile, /FROM node:22-alpine3\.21/);
assert.throws(() => new DockerTemplateEngineService().renderDockerfile(template, { ...plan, installCommand: "npm ci" }), /forbidden/);

const changedPlan = { ...plan, port: 4000 };
assert.notEqual(deploymentContractFingerprint({ buildPlan: plan }), deploymentContractFingerprint({ buildPlan: changedPlan }));

const monolithPlan: BuildPlan = {
  ...plan,
  buildCommand: "npm run build",
  buildCommands: ["npm run build"],
  outputDirectory: null,
  components: [{
    id: "backend", role: "backend", root: ".", buildContext: ".", repositoryInstallRoot: ".", detectorId: "javascript.express", language: "javascript",
    framework: "express", frameworkMode: "express-server", runtimeType: "server", packageManager: "npm", dependencyManifest: "package.json",
    lockfile: null, runtimeVersion: "22", baseImage: "node:22-alpine3.21", runtimeImage: "node:22-alpine3.21", installCommand: "npm install",
    buildCommand: "npm run build", runCommand: "npm start", runtimeFiles: ["."], outputDirectory: "dist", port: 3000, healthPath: "/health",
    bindHost: "0.0.0.0", bindsToPortEnv: true, dockerStrategy: "generated", dockerTemplate: "express-server", environmentOwnership: [],
    database: { required: false, provider: "none", engine: null },
  }],
};
const monolithInputs = buildPlanWorkflowInputs(monolithPlan);
assert.deepEqual({
  application_root: monolithInputs.application_root,
  app_port: monolithInputs.app_port,
  health_check_path: monolithInputs.health_check_path,
  container_profile: monolithInputs.container_profile,
  output_directory: monolithInputs.output_directory,
}, {
  application_root: ".", app_port: "3000", health_check_path: "/health", container_profile: "express-server", output_directory: "dist",
}, "all compatibility scalars must project from the same canonical monolith component");
assert.equal(buildPlanWorkflowInputs({ ...monolithPlan, outputDirectory: "legacy-output" }).output_directory, "dist", "legacy top-level output cannot override the canonical component");

const fixture = mkdtempSync(join(tmpdir(), "deployguard-build-plan-"));
try {
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ packageManager: "npm@10", scripts: { start: "node server.js" }, dependencies: { express: "^4.21.0" } }));
  writeFileSync(join(fixture, "server.js"), "require('express')().listen(process.env.PORT || 3000, '0.0.0.0')");
  const scanner = new RepoDeployabilityScannerService();
  const profile = { ecosystem: "node", framework: "express", packageManager: "npm", buildCommand: null, startCommand: "npm start", expectedPort: 3000, healthCheckPath: "/health", staticOutput: false, hasDockerfile: false, requiresDatabase: false, requiresPersistentStorage: false };
  const missing = scanner.scan(fixture, profile);
  assert.equal(missing.installCommand, "npm install");
  assert.match(missing.deployabilityWarnings.join(" "), /No JavaScript lockfile/);
  assert.doesNotMatch(missing.deployabilityBlockers.join(" "), /No JavaScript lockfile/);
  writeFileSync(join(fixture, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: { express: "^5.0.0" } } } }));
  const stale = scanner.scan(fixture, profile);
  assert.match(stale.deployabilityBlockers.join(" "), /out of sync with package\.json/);
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

const root = join(__dirname, "../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const workflow = read(".github/workflows/deployguard-reusable.yml");
const buildPlanPredicate = workflow.match(/--arg output "\$OUTPUT_DIRECTORY" '\n([\s\S]*?)\n\s+' \.deployguard\/build-plan\.json/)?.[1];
assert.ok(buildPlanPredicate, "the immutable workflow validator must remain extractable");
const validateMonolith = (outputDirectory: string) => execFileSync("jq", [
  "-e", "--arg", "repository", monolithPlan.repositoryFullName, "--arg", "branch", monolithPlan.branch, "--arg", "commit", monolithPlan.commitSha,
  "--arg", "appRoot", monolithInputs.application_root, "--argjson", "port", monolithInputs.app_port, "--arg", "health", monolithInputs.health_check_path,
  "--arg", "template", monolithInputs.container_profile, "--arg", "output", outputDirectory, buildPlanPredicate!,
], { input: JSON.stringify(monolithPlan), stdio: ["pipe", "ignore", "pipe"] });
assert.doesNotThrow(() => validateMonolith("dist"), "the immutable validator must accept the canonical monolith artifact");
assert.throws(() => validateMonolith(""), "the immutable validator must still reject a genuinely mismatched output directory");
assert.match(read("backend/src/projects/project-deployment-contract.entity.ts"), /name: "build_plan"/);
assert.match(read("backend/src/projects/templates/preflight.service.ts"), /evaluateBuildPlanReadiness\(plan, effective\)/);
assert.match(read("backend/src/projects/templates/docker-template-engine.service.ts"), /contract: DeploymentContractDockerInput/);
assert.doesNotMatch(read("backend/src/projects/templates/docker-template-engine.service.ts"), /profile\.|selectedTemplate|expectedPort/);
const dispatch = read("backend/src/projects/github-actions-deployment.service.ts");
assert.match(dispatch, /buildPlanWorkflowInputs\(plan\)/, "dispatch must derive workflow build inputs from the authoritative BuildPlan helper");
const workflowContract = read("backend/src/projects/github-actions-operation-contract.ts");
assert.match(workflowContract, /plan\.appRoot/);
for (const field of ["root", "port", "healthPath", "dockerTemplate", "outputDirectory"]) assert.match(workflowContract, new RegExp(`primary\\.${field}`));
assert.match(workflowContract, /buildPlanComponents\(plan\)/);
assert.match(workflowContract, /JSON\.stringify\(plan\)/, "the complete immutable BuildPlan must cross the workflow boundary");
assert.match(dispatch, /plan\.buildTimeEnvVars/);
assert.match(dispatch, /evaluateBuildPlanReadiness\(plan, preDispatchConfiguration\)/);
assert.match(read("backend/src/infrastructure/database-service-binding.service.ts"), /buildPlan\.environmentOwnership/);

console.log("Iteration 2 BuildPlan checks passed: versioned persistence, exact readiness states, lockfile policy, pinned Docker inputs, environment ownership, and dispatch handoff.");
