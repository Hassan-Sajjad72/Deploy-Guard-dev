import { strict as assert } from "assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { DeploymentContractDockerInput, DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";
import { BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";
import { DeploymentContractService } from "../src/projects/deployment-contract.service";

const registry = new TemplateRegistryService();
const engine = new DockerTemplateEngineService();
const sha = "0123456789abcdef0123456789abcdef01234567";

const base: DeploymentContractDockerInput = {
  planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, repositoryFullName: "example/app", branch: "main", detectorId: "express:express-server", confidence: "high", evidence: [],
  language: "javascript", framework: "express", frameworkMode: "express-server", appRoot: ".", repositoryInstallRoot: ".",
  packageManager: "npm", dependencyManifest: "package.json", lockfile: "package-lock.json", runtimeVersion: "20", baseImage: "node:20-alpine3.21", runtimeImage: "node:20-alpine3.21",
  installCommand: "npm ci", buildCommand: null, buildCommands: [], releaseCommand: null, releaseCommands: [], runCommand: "npm run start", runtimeFiles: ["."], outputDirectory: null,
  port: 3000, healthPath: "/health", runtimeType: "server", buildTimeEnvVars: [], runtimeEnvVars: ["PORT"],
  secretEnvVars: ["DATABASE_URL"], commitSha: sha, portSource: "source", bindHost: "0.0.0.0", bindsToPortEnv: true,
  buildSystemDependencies: [], runtimeSystemDependencies: [], environmentOwnership: [], requiredInputs: [], requiredUserInputs: [], optionalInputs: [], dockerStrategy: "generated", dockerTemplate: "express-server", warnings: [], blockers: [],
};

const componentContractService: any = new DeploymentContractService(
  {} as any, {} as any, {} as any, {} as any, {} as any,
  registry, engine, { get: (_key: string, fallback: unknown) => fallback } as any,
);
const frontendComponent = componentContractService.componentBuildPlan({
  id: "frontend", role: "frontend", root: "frontend", buildContext: "frontend", repositoryInstallRoot: "frontend", framework: "vite-react",
  frameworkVariant: "vite-static", runtimeType: "static", port: 8080, healthCheckPath: "/", databaseType: null,
  environment: [], profile: {
    language: "javascript", ecosystem: "node", packageManager: "npm", selectedTemplate: "vite-static", runtimeVersion: "22",
    buildCommand: "npm run build", startCommand: null,
    rawProfile: { detectorId: "javascript.vite-react", dependencyFiles: ["package.json"], lockfiles: ["package-lock.json"], installCommand: "npm ci", outputDirectory: "dist", resolvedBaseImage: "node:22-alpine3.21", resolvedRuntimeImage: "nginxinc/nginx-unprivileged:1.27-alpine", buildSystemDependencies: [], runtimeSystemDependencies: [] },
  },
}, base, "postgres");
const isolatedFrontendPlan = componentContractService.componentAsBuildPlan({
  ...base,
  buildSystemDependencies: ["libpq-dev", "gcc", "libc6-dev"],
  runtimeSystemDependencies: ["libpq5"],
  releaseCommand: "python manage.py migrate",
  releaseCommands: ["python manage.py migrate"],
  port: 8000,
  healthPath: "/backend-health",
  environmentOwnership: [{ key: "DB_PASSWORD", owner: "infrastructure", component: "backend", source: "managed_database", exposure: "private", requirement: "required", required: true, phase: "runtime", secret: true }],
  requiredInputs: ["DB_PASSWORD"],
  requiredUserInputs: ["BACKEND_ONLY"],
  optionalInputs: ["BACKEND_OPTIONAL"],
  sentinelFromParent: "must-not-survive",
}, frontendComponent);
assert.deepEqual(isolatedFrontendPlan.buildSystemDependencies, [], "backend PostgreSQL build packages cannot leak into a frontend component");
assert.deepEqual(isolatedFrontendPlan.runtimeSystemDependencies, [], "backend PostgreSQL runtime packages cannot leak into a frontend component");
assert.equal(isolatedFrontendPlan.releaseCommand, null, "backend migrations cannot leak into a frontend component");
assert.equal(isolatedFrontendPlan.port, 8080, "backend ports cannot leak into a frontend component");
assert.equal(isolatedFrontendPlan.healthPath, "/", "backend health values cannot leak into a frontend component");
assert.equal(isolatedFrontendPlan.requiredInputs.includes("DB_PASSWORD"), false, "backend database ENV cannot leak into a frontend component");
assert.deepEqual(isolatedFrontendPlan.requiredUserInputs, [], "global required inputs cannot leak into a frontend component");
assert.deepEqual(isolatedFrontendPlan.optionalInputs, [], "global optional inputs cannot leak into a frontend component");
assert.equal((isolatedFrontendPlan as any).sentinelFromParent, undefined, "component plans must be constructed from an explicit allowlist");
assert.doesNotMatch(engine.renderDockerfile(registry.getTemplate("vite-static")!, isolatedFrontendPlan)!, /libpq|gcc/);

const djangoComponent = componentContractService.componentBuildPlan({
  id: "backend", role: "backend", root: "backend", buildContext: "backend", repositoryInstallRoot: "backend", framework: "django",
  frameworkVariant: "django-wsgi", runtimeType: "server", port: 8000, healthCheckPath: "/health", databaseType: "postgres",
  environment: [], profile: {
    language: "python", ecosystem: "python", packageManager: "pip", selectedTemplate: "django-wsgi", runtimeVersion: "3.11",
    buildCommand: "python manage.py collectstatic --noinput", startCommand: "gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000}",
    rawProfile: { detectorId: "python.django", dependencyFiles: ["requirements.txt"], lockfiles: [], installCommand: "pip install --no-cache-dir -r requirements.txt", releaseCommand: "python manage.py migrate --noinput", runtimeFiles: ["config", "manage.py", "staticfiles"], resolvedBaseImage: "python:3.11-slim", resolvedRuntimeImage: "python:3.11-slim", buildSystemDependencies: ["libpq-dev", "gcc", "libc6-dev"], runtimeSystemDependencies: ["libpq5"] },
  },
}, base, "postgres");
const isolatedDjangoPlan = componentContractService.componentAsBuildPlan(base, djangoComponent);
assert.deepEqual(isolatedDjangoPlan.buildSystemDependencies, ["gcc", "libc6-dev", "libpq-dev"]);
assert.deepEqual(isolatedDjangoPlan.runtimeSystemDependencies, ["libpq5"]);
assert.equal(isolatedDjangoPlan.buildInitialization?.mode, "runtime_placeholders", "Django settings initialization carries an explicit build-only placeholder contract");
assert.equal(isolatedDjangoPlan.releaseCommand, "python manage.py migrate --noinput", "Django's detector-owned post-provision initialization remains in the component BuildPlan");

const publicFrontend = {
  ...frontendComponent,
  environmentOwnership: [{ key: "VITE_API_URL", owner: "platform", component: "frontend", source: "platform", exposure: "public", requirement: "optional", required: false, phase: "build", secret: false }],
};
const databaseBackend = {
  ...djangoComponent,
  environmentOwnership: [{ key: "DB_PASSWORD", owner: "infrastructure", component: "backend", source: "managed_database", exposure: "private", requirement: "required", required: true, phase: "runtime", secret: true }],
};
const relationship = { from: "frontend", to: "backend", kind: "http", mode: "same-origin", pathPrefix: "/api", stripPathPrefix: false, buildTimeVariable: "VITE_API_URL", verificationPath: "/api/health" };
const frontendRelationshipPlan = componentContractService.componentAsBuildPlan({ ...base, relationships: [relationship] }, publicFrontend);
const backendDatabasePlan = componentContractService.componentAsBuildPlan(base, databaseBackend);
assert.deepEqual(frontendRelationshipPlan.buildTimeEnvVars, ["VITE_API_URL"], "explicit relationship-derived public routing ENV remains frontend-scoped");
assert.deepEqual(frontendRelationshipPlan.relationships, [relationship], "proven frontend/backend relationships remain explicit");
assert.deepEqual(frontendRelationshipPlan.secretEnvVars, [], "database credentials cannot reach the frontend");
assert.deepEqual(backendDatabasePlan.secretEnvVars, ["DB_PASSWORD"], "database credentials reach only the database-owning backend");
assert.deepEqual(backendDatabasePlan.buildTimeEnvVars, [], "frontend values cannot overwrite backend build configuration");

assert.equal(frontendComponent.environmentOwnership.every((item) => item.componentId === "frontend" || item.component === "platform"), true, "component ownership must remain exact rather than resolve a global runtime owner");

function render(templateKey: string, input: Partial<DeploymentContractDockerInput>) {
  const template = registry.getTemplate(templateKey);
  assert.ok(template, `${templateKey} must exist`);
  const dockerfile = engine.renderDockerfile(template, { ...base, ...input });
  assert.ok(dockerfile);
  assert.doesNotMatch(dockerfile, /\{\{[A-Z_]+\}\}/);
  assert.match(dockerfile, /USER (app|appuser|nginx|101)/);
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
  assert.match(dockerfile, /adduser -S app -G app && chown app:app \/app[\s\S]*USER app/);
  assert.doesNotMatch(dockerfile, /chmod\s+(?:-R\s+)?777|USER root/);
  assert.doesNotMatch(dockerfile, /CMD .*next start/);
}

for (const [templateKey, framework, mode, output] of [
  ["vite-static", "vite-react", "vite-static", "dist"],
  ["react-static", "react", "react-static", "build"],
  ["nextjs-static", "nextjs", "nextjs-static", "out"],
] as const) {
  const dockerfile = render(templateKey, { framework, frameworkMode: mode, runtimeType: "static", port: 8080, buildCommand: "npm run build", runCommand: null, outputDirectory: output, buildTimeEnvVars: ["VITE_API_URL"], runtimeImage: "nginxinc/nginx-unprivileged:1.27-alpine" });
  assert.match(dockerfile, /FROM nginxinc\/nginx-unprivileged:1\.27-alpine AS runner/);
  assert.doesNotMatch(dockerfile, /ARG VITE_API_URL|ENV VITE_API_URL=/, "generated public build configuration must not be persisted through Docker ARG or ENV");
  assert.match(dockerfile, /--mount=type=secret,id=deployguard_public_build_config,required=false/, "generated public build configuration must use an optional ephemeral BuildKit file mount");
  assert.match(dockerfile, new RegExp(`/app/${output}`));
  assert.match(dockerfile, /FROM nginxinc\/nginx-unprivileged:1\.27-alpine AS runner\s+USER root[\s\S]*USER nginx/, "static runtimes temporarily acquire package-install privileges and permanently return to nginx");
}

const buildxCheckDirectory = mkdtempSync(join(tmpdir(), "deployguard-buildx-check-"));
const buildxImage = `deployguard-public-build-config:${process.pid}`;
try {
  const dockerfile = render("vite-static", {
    framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080,
    buildCommand: "npm run build", runCommand: null, outputDirectory: "dist",
    buildTimeEnvVars: ["VITE_WEATHER_API_KEY"], runtimeImage: "nginxinc/nginx-unprivileged:1.27-alpine",
  });
  writeFileSync(join(buildxCheckDirectory, "Dockerfile"), dockerfile);
  writeFileSync(join(buildxCheckDirectory, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { postinstall: "mkdir -p node_modules", build: "node build.js" } }));
  writeFileSync(join(buildxCheckDirectory, "package-lock.json"), JSON.stringify({ name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0" } } }));
  writeFileSync(join(buildxCheckDirectory, "build.js"), "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/index.html',process.env.VITE_WEATHER_API_KEY||'absent');");
  execFileSync("docker", ["buildx", "build", "--check", "-f", "Dockerfile", "."], { cwd: buildxCheckDirectory, stdio: "pipe" });
  execFileSync("docker", ["buildx", "build", "--load", "-t", `${buildxImage}-absent`, "-f", "Dockerfile", "."], { cwd: buildxCheckDirectory, stdio: "pipe" });
  assert.equal(execFileSync("docker", ["run", "--rm", "--entrypoint", "cat", `${buildxImage}-absent`, "/usr/share/nginx/html/index.html"], { encoding: "utf8" }), "absent", "an absent optional public build value must be omitted without blocking the build");
  const configPath = join(buildxCheckDirectory, "public-config.json");
  writeFileSync(configPath, JSON.stringify({ VITE_WEATHER_API_KEY: "fixture-public-value" }), { mode: 0o600 });
  execFileSync("docker", ["buildx", "build", "--load", "--secret", `id=deployguard_public_build_config,src=${configPath}`, "-t", `${buildxImage}-supplied`, "-f", "Dockerfile", "."], { cwd: buildxCheckDirectory, stdio: "pipe" });
  assert.equal(execFileSync("docker", ["run", "--rm", "--entrypoint", "cat", `${buildxImage}-supplied`, "/usr/share/nginx/html/index.html"], { encoding: "utf8" }), "fixture-public-value", "a supplied public value must reach only the generated build process");
  const imageMetadata = execFileSync("docker", ["image", "inspect", `${buildxImage}-supplied`], { encoding: "utf8" })
    + execFileSync("docker", ["history", "--no-trunc", `${buildxImage}-supplied`], { encoding: "utf8" });
  assert.doesNotMatch(imageMetadata, /fixture-public-value|VITE_WEATHER_API_KEY/, "public build configuration must not be persisted in runtime image metadata or history");
} finally {
  try { execFileSync("docker", ["image", "rm", "-f", `${buildxImage}-absent`, `${buildxImage}-supplied`], { stdio: "ignore" }); } catch {}
  rmSync(buildxCheckDirectory, { recursive: true, force: true });
}

const staticRuntimeDependency = render("vite-static", {
  framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080,
  buildCommand: "npm run build", runCommand: null, outputDirectory: "dist",
  runtimeImage: "nginxinc/nginx-unprivileged:1.27-alpine", runtimeSystemDependencies: ["libpq"],
  systemDependencyEvidence: { build: [], runtime: ["libpq"] },
});
assert.match(staticRuntimeDependency, /USER root\s+RUN apk add --no-cache libpq[\s\S]*USER nginx/);
assert.ok(staticRuntimeDependency.indexOf("RUN apk add --no-cache libpq") < staticRuntimeDependency.lastIndexOf("USER nginx"));

const staticWebDockerfile = render("static-web", {
  language: "javascript",
  framework: "static-web",
  frameworkMode: "static-web",
  runtimeType: "static",
  packageManager: "none",
  dependencyManifest: "index.html",
  lockfile: "index.html",
  runtimeVersion: "static",
  baseImage: "nginxinc/nginx-unprivileged:1.27-alpine",
  runtimeImage: "nginxinc/nginx-unprivileged:1.27-alpine",
  installCommand: "true",
  buildCommand: null,
  runCommand: null,
  outputDirectory: ".",
  port: 8080,
  healthPath: "/index.html",
  secretEnvVars: [],
});
assert.match(staticWebDockerfile, /COPY --chown=101:101 \. \/usr\/share\/nginx\/html/);

const workspaceDirectory = mkdtempSync(join(tmpdir(), "deployguard-workspace-build-"));
const workspaceImage = `deployguard-workspace-build:${process.pid}`;
try {
  mkdirSync(join(workspaceDirectory, "apps", "web"), { recursive: true });
  mkdirSync(join(workspaceDirectory, "packages", "shared"), { recursive: true });
  writeFileSync(join(workspaceDirectory, "package.json"), JSON.stringify({ name: "workspace-root", private: true, workspaces: ["apps/*", "packages/*"] }));
  writeFileSync(join(workspaceDirectory, "apps", "web", "package.json"), JSON.stringify({ name: "web", private: true, scripts: { build: "node build.js" }, dependencies: { "@fixture/shared": "*" } }));
  writeFileSync(join(workspaceDirectory, "apps", "web", "build.js"), "const fs=require('fs');const shared=require('@fixture/shared');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html',shared);\n");
  writeFileSync(join(workspaceDirectory, "packages", "shared", "package.json"), JSON.stringify({ name: "@fixture/shared", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(workspaceDirectory, "packages", "shared", "index.js"), "module.exports='workspace-install-root-certified';\n");
  const dockerfile = render("vite-static", {
    framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080,
    appRoot: "apps/web", repositoryInstallRoot: ".", dependencyManifest: "apps/web/package.json",
    lockfile: null, installCommand: "npm install", buildCommand: "npm run build", runCommand: null,
    outputDirectory: "dist", runtimeImage: "nginxinc/nginx-unprivileged:1.27-alpine",
  });
  assert.match(dockerfile, /WORKDIR \/app\/apps\/web[\s\S]*RUN npm run build/);
  assert.match(dockerfile, /COPY --from=builder \/app\/apps\/web\/dist \/usr\/share\/nginx\/html/);
  writeFileSync(join(workspaceDirectory, "Dockerfile"), dockerfile);
  execFileSync("docker", ["build", "-t", workspaceImage, "-f", "Dockerfile", "."], { cwd: workspaceDirectory, stdio: "pipe", timeout: 360_000 });
  assert.equal(execFileSync("docker", ["run", "--rm", "--entrypoint", "cat", workspaceImage, "/usr/share/nginx/html/index.html"], { encoding: "utf8" }), "workspace-install-root-certified");
} finally {
  try { execFileSync("docker", ["image", "rm", "-f", workspaceImage], { stdio: "ignore" }); } catch {}
  rmSync(workspaceDirectory, { recursive: true, force: true });
}

const reusableWorkflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
assert.match(reusableWorkflow, /DOCKER_BUILD_CONTEXT="\$GITHUB_WORKSPACE\/\$REPOSITORY_INSTALL_ROOT"/);
assert.match(reusableWorkflow, /docker build --pull -f "\$DOCKERFILE_PATH"[\s\S]*"\$DOCKER_BUILD_CONTEXT"/);
assert.match(reusableWorkflow, /while jq -e --argjson port "\$INTERNAL_PORT" 'any\(\.\[\]; \.port == \$port\)'/);
assert.match(reusableWorkflow, /\[ \$components\[\]\.port \] \| unique \| length/, "immutable workflow rejects duplicate awsvpc application ports");

for (const [templateKey, framework, mode, command, port] of [
  ["flask-wsgi", "flask", "flask-wsgi", "gunicorn app:app --bind 0.0.0.0:${PORT:-5000}", 5000],
  ["fastapi-asgi", "fastapi", "fastapi-asgi", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}", 8000],
  ["django-wsgi", "django", "django-wsgi", "gunicorn app.wsgi:application --bind 0.0.0.0:${PORT:-8000}", 8000],
  ["streamlit-server", "streamlit", "streamlit-server", "streamlit run app.py --server.address=0.0.0.0 --server.port=${PORT:-8000}", 8000],
] as const) {
  const dockerfile = render(templateKey, { language: "python", framework, frameworkMode: mode, packageManager: "pip", dependencyManifest: "requirements.txt", lockfile: "requirements.txt", runtimeVersion: "3.12", baseImage: "python:3.12-slim", runtimeImage: "python:3.12-slim", installCommand: "pip install --no-cache-dir -r requirements.txt", runCommand: command, port });
  assert.match(dockerfile, /FROM python:3\.12-slim/);
}

const djangoPostgres = render("django-wsgi", {
  language: "python", framework: "django", frameworkMode: "django-wsgi", packageManager: "pip",
  dependencyManifest: "requirements.txt", lockfile: "requirements.txt", runtimeVersion: "3.11",
  baseImage: "python:3.11-slim", runtimeImage: "python:3.11-slim",
  installCommand: "pip install --no-cache-dir -r requirements.txt", buildCommand: "python manage.py collectstatic --noinput",
  releaseCommand: "python manage.py migrate --noinput", releaseCommands: ["python manage.py migrate --noinput"],
  runCommand: "gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000}", port: 8000,
  buildSystemDependencies: ["libpq-dev", "gcc", "libc6-dev"], runtimeSystemDependencies: ["libpq5"],
});
assert.match(djangoPostgres, /RUN apt-get update && apt-get install -y --no-install-recommends libpq-dev gcc libc6-dev/);
assert.match(djangoPostgres, /RUN apt-get update && apt-get install -y --no-install-recommends libpq5[\s\S]*USER appuser/);
assert.ok(djangoPostgres.indexOf("libpq5") < djangoPostgres.lastIndexOf("USER appuser"), "PostgreSQL runtime packages install before the final non-root Django user");
assert.match(djangoPostgres, /--mount=type=secret,id=deployguard_runtime_config,required=true/, "Django application initialization must receive runtime configuration through an ephemeral BuildKit secret");
assert.match(djangoPostgres, /DEPLOYGUARD_BUILD_COMMAND_BASE64/, "Django build initialization command must remain safely encoded outside shell interpolation");
assert.doesNotMatch(djangoPostgres, /SECRET_KEY=/, "Django build initialization must never bake a secret into the image");
assert.match(djangoPostgres, /CMD \["sh","-c","python manage\.py migrate --noinput && exec gunicorn config\.wsgi:application/, "Django release initialization must run after provisioning and before the application server");
assert.ok(djangoPostgres.indexOf("USER appuser") < djangoPostgres.indexOf('CMD ["sh","-c","python manage.py migrate'), "release initialization must run as the final non-root user");

const djangoAsgi = render("django-asgi", {
  language: "python", framework: "django", frameworkMode: "django-asgi", packageManager: "pip",
  dependencyManifest: "requirements.txt", lockfile: "requirements.txt", runtimeVersion: "3.11",
  baseImage: "python:3.11-slim", runtimeImage: "python:3.11-slim",
  installCommand: "pip install --no-cache-dir -r requirements.txt", buildCommand: "python manage.py collectstatic --noinput",
  runCommand: "uvicorn config.asgi:application --host 0.0.0.0 --port ${PORT:-8000}", port: 8000,
});
assert.match(djangoAsgi, /--mount=type=secret,id=deployguard_runtime_config,required=true/, "Django ASGI shares the same runtime-initialization protection");
assert.throws(() => engine.renderDockerfile(registry.getTemplate("django-wsgi")!, {
  ...base, language: "python", framework: "django", frameworkMode: "django-wsgi", packageManager: "pip",
  dependencyManifest: "requirements.txt", lockfile: "requirements.txt", runtimeVersion: "3.11",
  baseImage: "python:3.11-slim", runtimeImage: "python:3.11-slim", installCommand: "pip install -r requirements.txt",
  buildCommand: "python manage.py migrate --noinput", buildInitialization: {
    contractVersion: "deployguard.build-initialization/v1", mode: "external_service_required", reason: "Database migrations require the provisioned database.",
  }, runCommand: "gunicorn app.wsgi:application --bind 0.0.0.0:8000", port: 8000,
}), /live external service.*post-provision\/release/i, "a command that really needs a live database must never run during image construction");

const template = registry.getTemplate("vite-static")!;
assert.throws(() => engine.renderDockerfile(template, { ...base, framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080, outputDirectory: "dist", buildCommand: "npm run build", buildTimeEnvVars: ["API_TOKEN"], secretEnvVars: ["API_TOKEN"] }), /Secret variables/);
assert.throws(() => engine.renderDockerfile(template, { ...base, framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080, outputDirectory: "dist", buildCommand: "npm run build", baseImage: "" }), /pinned BuildPlan images/);
assert.throws(() => engine.renderDockerfile(template, { ...base, framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080, outputDirectory: "dist", buildCommand: "npm run build", appRoot: "../app" }), /safe repository-relative/);
assert.throws(() => engine.renderDockerfile(template, { ...base, framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080, outputDirectory: "dist", buildCommand: "npm run build", buildImageFamily: { distro: "debian", packageManager: "apt" } }), /image-family contract/);
assert.throws(() => engine.renderDockerfile(registry.getTemplate("django-wsgi")!, {
  ...base, language: "python", framework: "django", frameworkMode: "django-wsgi", packageManager: "pip",
  dependencyManifest: "requirements.txt", lockfile: "requirements.txt", runtimeVersion: "3.11",
  baseImage: "python:3.11-slim", runtimeImage: "python:3.11-slim", installCommand: "pip install -r requirements.txt",
  runCommand: "gunicorn app.wsgi:application --bind 0.0.0.0:8000", port: 8000,
  buildImageFamily: { distro: "alpine", packageManager: "apk" },
}), /image-family contract/);
assert.throws(() => engine.renderDockerfile(template, {
  ...base, framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080,
  outputDirectory: "dist", buildCommand: "npm run build", runtimeSystemDependencies: ["libpq5"],
  systemDependencyEvidence: { build: [], runtime: [] },
}), /lacks component-owned detector evidence/);
assert.throws(() => engine.renderDockerfile(template, {
  ...base, framework: "vite-react", frameworkMode: "vite-static", runtimeType: "static", port: 8080,
  outputDirectory: "dist", buildCommand: "npm run build",
  environmentOwnership: [{ key: "DB_PASSWORD", owner: "infrastructure", component: "frontend", source: "managed_database", required: true, phase: "runtime", secret: true }],
  database: { required: false, provider: "none", engine: null },
}), /only reach the component that owns USES_DATABASE/);
assert.throws(() => engine.validateGeneratedDockerfile("FROM node:22-alpine\nUSER root\n"), /final runtime user must be non-root/);
assert.throws(() => engine.validateGeneratedDockerfile("FROM node:22-alpine\nUSER app\nRUN apk add --no-cache libc6-compat\n"), /after the final non-root USER/);

const workflow = readFileSync(join(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
assert.match(workflow, /ref: \$\{\{ inputs\.commit_sha \}\}/);
assert.match(workflow, /GENERATED_DOCKERFILE_BASE64/);
assert.match(workflow, /BUILD_TIME_PUBLIC_CONFIG_BASE64/);
assert.match(workflow, /deployguard_runtime_config/, "generated application initialization must use an ephemeral BuildKit secret only when the generated Dockerfile asks for it");
assert.match(workflow, /deployguard_public_build_config/, "generated public build configuration must use an ephemeral BuildKit file rather than Docker ARG or ENV");
assert.match(workflow, /BUILD_SECRET_ARGS\+=\(--secret "id=deployguard_public_build_config,src=\$CONFIG_FILE"\)/);
assert.match(workflow, /docker buildx build --check -f "\$DOCKERFILE_PATH" "\$\{BUILD_ARGS\[@\]\}" "\$\{BUILD_SECRET_ARGS\[@\]\}" "\$DOCKER_BUILD_CONTEXT"/, "supported runners must validate each materialized component and its canonical install-root context before its real build");
const buildxCheckIndex = workflow.indexOf('docker buildx build --check -f "$DOCKERFILE_PATH" "${BUILD_ARGS[@]}" "${BUILD_SECRET_ARGS[@]}" "$DOCKER_BUILD_CONTEXT"');
const realBuildIndex = workflow.indexOf('docker build --pull -f "$DOCKERFILE_PATH" "${BUILD_ARGS[@]}" -t "$TAGGED_URI" "$DOCKER_BUILD_CONTEXT"');
const terraformIndex = workflow.indexOf("- name: Install Terraform");
assert.ok(buildxCheckIndex >= 0 && buildxCheckIndex < realBuildIndex && realBuildIndex < terraformIndex, "validate/check → build/push every required image → Terraform ordering must remain intact");
assert.match(workflow, /cd "\$APPLICATION_DIRECTORY"/);
assert.doesNotMatch(workflow, /Generate Dockerfile when absent|FROM node:20-alpine AS build|streamlit run app\.py --server\.address/);
assert.doesNotMatch(workflow, /--build-arg APP_PORT|--build-arg STATIC_OUTPUT_DIR/);
assert.match(workflow, /SHORT_SHA="\$\{\{ inputs\.commit_sha \}\}"/);
assert.match(workflow, /component_runtime\s+=\s+try\(local\.runtime_config\.componentRuntime, \{\}\)/);
assert.match(workflow, /local\.component_runtime\[component\.id\]\.environment/);

const dispatch = readFileSync(join(__dirname, "../src/projects/github-actions-deployment.service.ts"), "utf8");
for (const field of ["commit_sha", "generated_dockerfile_base64", "build_time_public_config_base64"]) assert.match(dispatch, new RegExp(`${field}:`));
assert.match(dispatch, /buildPlanWorkflowInputs\(plan\)/, "application root and container inputs must come from the authoritative BuildPlan handoff");
const operationContract = readFileSync(join(__dirname, "../src/projects/github-actions-operation-contract.ts"), "utf8");
assert.match(operationContract, /application_root: primary\.root/);
assert.match(operationContract, /build_plan_base64: Buffer\.from\(JSON\.stringify\(plan\)/);
assert.match(dispatch, /contract\.generatedDockerfile/);
assert.match(dispatch, /plan\.buildTimeEnvVars/);
assert.match(dispatch, /row\.isSecret/);
assert.doesNotMatch(dispatch, /app_port: String\(profile\.expectedPort/);

console.log("PASS contract-driven Docker generation for all supported JavaScript/Python framework templates and immutable workflow handoff");
