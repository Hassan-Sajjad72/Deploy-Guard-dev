import { strict as assert } from "assert";
import { readFileSync } from "fs";
import { join } from "path";
import { DeploymentContractDockerInput, DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

const registry = new TemplateRegistryService();
const engine = new DockerTemplateEngineService();
const sha = "0123456789abcdef0123456789abcdef01234567";

const base: DeploymentContractDockerInput = {
  planVersion: 1, detectorVersion: "mainstream-detectors-v3", repositoryFullName: "example/app", branch: "main", detectorId: "express:express-server", confidence: "high", evidence: [],
  language: "javascript", framework: "express", frameworkMode: "express-server", appRoot: ".", repositoryInstallRoot: ".",
  packageManager: "npm", dependencyManifest: "package.json", lockfile: "package-lock.json", runtimeVersion: "20", baseImage: "node:20-alpine3.21", runtimeImage: "node:20-alpine3.21",
  installCommand: "npm ci", buildCommand: null, buildCommands: [], releaseCommand: null, releaseCommands: [], runCommand: "npm run start", runtimeFiles: ["."], outputDirectory: null,
  port: 3000, healthPath: "/health", runtimeType: "server", buildTimeEnvVars: [], runtimeEnvVars: ["PORT"],
  secretEnvVars: ["DATABASE_URL"], commitSha: sha, portSource: "source", bindHost: "0.0.0.0", bindsToPortEnv: true,
  buildSystemDependencies: [], runtimeSystemDependencies: [], environmentOwnership: [], requiredInputs: [], requiredUserInputs: [], optionalInputs: [], dockerStrategy: "generated", dockerTemplate: "express-server", warnings: [], blockers: [],
};

function render(templateKey: string, input: Partial<DeploymentContractDockerInput>) {
  const template = registry.getTemplate(templateKey);
  assert.ok(template, `${templateKey} must exist`);
  const dockerfile = engine.renderDockerfile(template, { ...base, ...input });
  assert.ok(dockerfile);
  assert.doesNotMatch(dockerfile, /\{\{[A-Z_]+\}\}/);
  assert.match(dockerfile, /USER (app|appuser|nginx)/);
  assert.match(dockerfile, new RegExp(sha));
  assert.doesNotMatch(dockerfile, /DATABASE_URL=/);
  return dockerfile;
}

for (const [templateKey, framework, mode, build] of [
  ["express-server", "express", "express-server", false],
  ["fastify-server", "fastify", "fastify-server", false],
  ["nestjs-server", "nestjs", "nestjs-server", true],
  ["nextjs-ssr", "nextjs", "nextjs-ssr", true],
] as const) {
  const dockerfile = render(templateKey, { framework, frameworkMode: mode, buildCommand: build ? "npm run build" : null });
  assert.match(dockerfile, /FROM node:20-alpine3\.21/);
  assert.match(dockerfile, /CMD \["sh","-c","npm run start"\]/);
  assert.doesNotMatch(dockerfile, /CMD .*next start/);
}

for (const [templateKey, framework, mode, output] of [
  ["vite-static", "vite-react", "vite-static", "dist"],
  ["react-static", "react", "react-static", "build"],
  ["nextjs-static", "nextjs", "nextjs-static", "out"],
] as const) {
  const dockerfile = render(templateKey, { framework, frameworkMode: mode, runtimeType: "static", port: 8080, buildCommand: "npm run build", runCommand: null, outputDirectory: output, buildTimeEnvVars: ["VITE_API_URL"], runtimeImage: "nginxinc/nginx-unprivileged:1.27-alpine" });
  assert.match(dockerfile, /FROM nginxinc\/nginx-unprivileged:1\.27-alpine AS runner/);
  assert.match(dockerfile, /ARG VITE_API_URL/);
  assert.match(dockerfile, new RegExp(`/app/${output}`));
}

for (const [templateKey, framework, mode, command, port] of [
  ["flask-wsgi", "flask", "flask-wsgi", "gunicorn app:app --bind 0.0.0.0:${PORT:-5000}", 5000],
  ["fastapi-asgi", "fastapi", "fastapi-asgi", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}", 8000],
  ["django-wsgi", "django", "django-wsgi", "gunicorn app.wsgi:application --bind 0.0.0.0:${PORT:-8000}", 8000],
  ["streamlit-server", "streamlit", "streamlit-server", "streamlit run app.py --server.address=0.0.0.0 --server.port=${PORT:-8000}", 8000],
] as const) {
  const dockerfile = render(templateKey, { language: "python", framework, frameworkMode: mode, packageManager: "pip", dependencyManifest: "requirements.txt", lockfile: "requirements.txt", runtimeVersion: "3.12", baseImage: "python:3.12-slim", runtimeImage: "python:3.12-slim", installCommand: "pip install --no-cache-dir -r requirements.txt", runCommand: command, port });
  assert.match(dockerfile, /FROM python:3\.12-slim/);
}

const template = registry.getTemplate("vite-static")!;
assert.throws(() => engine.renderDockerfile(template, { ...base, framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080, outputDirectory: "dist", buildCommand: "npm run build", buildTimeEnvVars: ["API_TOKEN"], secretEnvVars: ["API_TOKEN"] }), /Secret variables/);
assert.throws(() => engine.renderDockerfile(template, { ...base, framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080, outputDirectory: "dist", buildCommand: "npm run build", baseImage: "" }), /pinned BuildPlan images/);
assert.throws(() => engine.renderDockerfile(template, { ...base, framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080, outputDirectory: "dist", buildCommand: "npm run build", appRoot: "../app" }), /safe repository-relative/);

const workflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
assert.match(workflow, /ref: \$\{\{ inputs\.commit_sha \}\}/);
assert.match(workflow, /GENERATED_DOCKERFILE_BASE64/);
assert.match(workflow, /BUILD_TIME_PUBLIC_CONFIG_BASE64/);
assert.match(workflow, /cd "\$APPLICATION_DIRECTORY"/);
assert.doesNotMatch(workflow, /Generate Dockerfile when absent|FROM node:20-alpine AS build|streamlit run app\.py --server\.address/);
assert.doesNotMatch(workflow, /--build-arg APP_PORT|--build-arg STATIC_OUTPUT_DIR/);
assert.match(workflow, /SHORT_SHA="\$\{\{ inputs\.commit_sha \}\}"/);
assert.match(workflow, /HOST\s*=\s*"0\.0\.0\.0",\s*PORT\s*=\s*tostring\(var\.app_port\)/);
assert.match(workflow, /app_environment\s*=\s*\[for key in sort\(keys\(local\.app_environment_map\)\)\s*:\s*\{ name = key, value = tostring\(local\.app_environment_map\[key\]\) \}\]/);

const dispatch = readFileSync(join(__dirname, "../src/projects/github-actions-deployment.service.ts"), "utf8");
for (const field of ["commit_sha", "generated_dockerfile_base64", "build_time_public_config_base64"]) assert.match(dispatch, new RegExp(`${field}:`));
assert.match(dispatch, /buildPlanWorkflowInputs\(plan\)/, "application root and container inputs must come from the authoritative BuildPlan handoff");
const operationContract = readFileSync(join(__dirname, "../src/projects/github-actions-operation-contract.ts"), "utf8");
assert.match(operationContract, /application_root: plan\.appRoot/);
assert.match(operationContract, /build_plan_base64: Buffer\.from\(JSON\.stringify\(plan\)/);
assert.match(dispatch, /contract\.generatedDockerfile/);
assert.match(dispatch, /plan\.buildTimeEnvVars/);
assert.match(dispatch, /row\.isSecret/);
assert.doesNotMatch(dispatch, /app_port: String\(profile\.expectedPort/);

console.log("PASS contract-driven Docker generation for all supported JavaScript/Python framework templates and immutable workflow handoff");
