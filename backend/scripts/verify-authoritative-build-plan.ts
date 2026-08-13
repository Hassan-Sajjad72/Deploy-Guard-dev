import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILD_PLAN_REANALYSIS_MESSAGE, BuildPlan, requireBuildPlan } from "../src/projects/build-plan";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { deploymentContractFingerprint } from "../src/projects/analysis-fingerprint";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

const plan: BuildPlan = {
  planVersion: 1, detectorVersion: "mainstream-detectors-v3", repositoryFullName: "example/app", branch: "main",
  commitSha: "a".repeat(40), detectorId: "express:express-server", language: "javascript", framework: "express",
  frameworkMode: "express-server", confidence: "high", evidence: [{ source: "package.json", description: "Express dependency" }],
  appRoot: ".", repositoryInstallRoot: ".", packageManager: "npm", dependencyManifest: "package.json", lockfile: null, runtimeVersion: "22",
  baseImage: "node:22-alpine3.21", runtimeImage: "node:22-alpine3.21", installCommand: "npm install", buildCommand: null, buildCommands: [],
  releaseCommand: null, releaseCommands: [], runCommand: "npm start", runtimeFiles: ["."], outputDirectory: null, buildSystemDependencies: [], runtimeSystemDependencies: [],
  port: 3000, portSource: "source", healthPath: "/health", bindHost: "0.0.0.0", bindsToPortEnv: true, runtimeType: "server",
  environmentOwnership: [{ key: "PORT", owner: "platform", required: true, phase: "runtime", secret: false }],
  requiredInputs: [], requiredUserInputs: [], optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: [], secretEnvVars: [], dockerStrategy: "generated",
  dockerTemplate: "express-server", warnings: ["No JavaScript lockfile was found; deployment will use a compatible non-frozen install command."], blockers: [],
};

assert.equal(requireBuildPlan({ buildPlan: plan }), plan);
assert.throws(() => requireBuildPlan({ buildPlan: { ...plan, planVersion: 2 as 1 } }), (error: unknown) => error instanceof Error && error.message === BUILD_PLAN_REANALYSIS_MESSAGE);
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
assert.match(read("backend/src/projects/project-deployment-contract.entity.ts"), /name: "build_plan"/);
assert.match(read("backend/src/projects/templates/preflight.service.ts"), /evaluateBuildPlanReadiness\(plan, effective\)/);
assert.match(read("backend/src/projects/templates/docker-template-engine.service.ts"), /contract: DeploymentContractDockerInput/);
assert.doesNotMatch(read("backend/src/projects/templates/docker-template-engine.service.ts"), /profile\.|selectedTemplate|expectedPort/);
const dispatch = read("backend/src/projects/github-actions-deployment.service.ts");
assert.match(dispatch, /buildPlanWorkflowInputs\(plan\)/, "dispatch must derive workflow build inputs from the authoritative BuildPlan helper");
const workflowContract = read("backend/src/projects/github-actions-operation-contract.ts");
for (const field of ["appRoot", "port", "healthPath", "dockerTemplate", "outputDirectory"]) assert.match(workflowContract, new RegExp(`plan\\.${field}`));
assert.match(workflowContract, /JSON\.stringify\(plan\)/, "the complete immutable BuildPlan must cross the workflow boundary");
assert.match(dispatch, /plan\.buildTimeEnvVars/);
assert.match(dispatch, /evaluateBuildPlanReadiness\(plan, preDispatchConfiguration\)/);
assert.match(read("backend/src/infrastructure/database-service-binding.service.ts"), /buildPlan\.environmentOwnership/);

console.log("Iteration 2 BuildPlan checks passed: versioned persistence, exact readiness states, lockfile policy, pinned Docker inputs, environment ownership, and dispatch handoff.");
