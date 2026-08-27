import { strict as assert } from "assert";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { BuildPlan, BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { DETECTION_INPUT_FINGERPRINT_VERSION, detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { DeploymentContractService } from "../src/projects/deployment-contract.service";
import { MainstreamDetectorResolverService } from "../src/projects/detection/mainstream-detector-resolver.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { StackDetectionService } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";
import { buildPlanWorkflowInputs } from "../src/projects/github-actions-operation-contract";

type Fixture = {
  name: string;
  files: Record<string, string>;
  detector: string;
  framework: string;
  mode: string;
  output?: string | null;
  run?: RegExp | null;
  template: string;
  readiness?: "READY" | "READY_WITH_WARNINGS" | "INPUT_REQUIRED" | "BLOCKED";
  install?: RegExp;
  installAbsent?: RegExp;
};

const pkg = (dependencies: Record<string, string>, scripts: Record<string, string> = { build: "tool build", start: "node server.js" }, extra = {}) => JSON.stringify({ packageManager: "npm@10.8.0", engines: { node: ">=20 <21" }, scripts, dependencies, ...extra });
const managerPkg = (manager: string, dependencies: Record<string, string>, scripts: Record<string, string>) => JSON.stringify({ packageManager: manager, engines: { node: ">=22 <23" }, scripts, dependencies });
const python = (dependencies: string, sourceName: string, source: string) => ({ "requirements.txt": dependencies, [sourceName]: source });

const fixtures: Fixture[] = [
  { name: "Next.js SSR", files: { "package.json": pkg({ next: "15", react: "19" }, { build: "next build", start: "next start" }) }, detector: "javascript.nextjs", framework: "nextjs", mode: "nextjs-ssr", run: /npm run start.*0\.0\.0\.0.*PORT/, template: "nextjs-ssr" },
  { name: "Next.js standalone", files: { "package.json": pkg({ next: "15", react: "19", sharp: "0.34" }, { build: "next build", start: "next start" }), "next.config.mjs": "export default { output: 'standalone' }" }, detector: "javascript.nextjs", framework: "nextjs", mode: "nextjs-standalone", run: /\.next\/standalone\/server\.js/, template: "nextjs-standalone" },
  { name: "Next.js static", files: { "package.json": pkg({ next: "15", react: "19" }, { build: "next build" }), "next.config.ts": "export default { output: 'export' }" }, detector: "javascript.nextjs", framework: "nextjs", mode: "nextjs-static", output: "out", run: null, template: "nextjs-static" },
  { name: "React Vite", files: { "package.json": pkg({ react: "19", vite: "6" }, { build: "vite build" }), "vite.config.ts": "export default {}" }, detector: "javascript.vite-react", framework: "vite-react", mode: "vite-static", output: "dist", run: null, template: "vite-static" },
  { name: "Create React App", files: { "package.json": pkg({ react: "18", "react-scripts": "5" }, { build: "react-scripts build" }) }, detector: "javascript.create-react-app", framework: "create-react-app", mode: "cra-static", output: "build", run: null, template: "cra-static" },
  { name: "React Webpack", files: { "package.json": pkg({ react: "15", "react-dom": "15", webpack: "1.12" }, { build: "NODE_ENV='production' ./node_modules/.bin/webpack" }), "webpack.config.js": "var path = require('path'); module.exports = { context: path.join(__dirname, 'app'), output: { path: __dirname + '/app/', filename: 'bundle.js' } };" }, detector: "javascript.react-webpack", framework: "react", mode: "react-webpack-static", output: "app", run: null, template: "react-webpack-static" },
  { name: "React Webpack unknown output", files: { "package.json": pkg({ react: "18", webpack: "5" }, { build: "webpack --mode production" }), "webpack.config.js": "module.exports = { output: { path: getOutputPath() } };" }, detector: "javascript.react-webpack", framework: "react", mode: "react-webpack-static", output: "", run: null, template: "react-webpack-static", readiness: "INPUT_REQUIRED" },
  { name: "React unknown production build", files: { "package.json": pkg({ react: "18" }, {}) }, detector: "javascript.react-static", framework: "react", mode: "react-static", output: "", run: null, template: "react-static", readiness: "INPUT_REQUIRED" },
  { name: "Vue Vite", files: { "package.json": pkg({ vue: "3", vite: "6" }, { build: "vite build" }), "vite.config.ts": "export default {}" }, detector: "javascript.vite-vue", framework: "vite-vue", mode: "vite-vue-static", output: "dist", run: null, template: "vite-vue-static" },
  { name: "Nuxt SSR", files: { "package.json": pkg({ nuxt: "3" }, { build: "nuxt build" }), "nuxt.config.ts": "export default defineNuxtConfig({})" }, detector: "javascript.nuxt", framework: "nuxt", mode: "nuxt-ssr", run: /\.output\/server\/index\.mjs/, template: "nuxt-ssr" },
  { name: "Nuxt static", files: { "package.json": pkg({ nuxt: "3" }, { build: "nuxi generate" }), "nuxt.config.ts": "export default defineNuxtConfig({})" }, detector: "javascript.nuxt", framework: "nuxt", mode: "nuxt-static", output: ".output/public", run: null, template: "nuxt-static" },
  { name: "Angular outputPath", files: { "package.json": pkg({ "@angular/core": "19", "@angular/cli": "19" }, { build: "ng build" }), "angular.json": JSON.stringify({ defaultProject: "portal", projects: { portal: { architect: { build: { options: { outputPath: { base: "dist/portal", browser: "browser" } } } } } } }) }, detector: "javascript.angular", framework: "angular", mode: "angular-static", output: "dist/portal/browser", run: null, template: "angular-static" },
  { name: "SvelteKit node", files: { "package.json": pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-node": "5" }, { build: "vite build" }), "svelte.config.js": "import adapter from '@sveltejs/adapter-node'; export default { kit: { adapter: adapter() } }" }, detector: "javascript.sveltekit", framework: "sveltekit", mode: "sveltekit-node", run: /node build/, template: "sveltekit-node" },
  { name: "SvelteKit static", files: { "package.json": pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-static": "3" }, { build: "vite build" }), "svelte.config.js": "import adapter from '@sveltejs/adapter-static'; export default { kit: { adapter: adapter() } }" }, detector: "javascript.sveltekit", framework: "sveltekit", mode: "sveltekit-static", output: "build", run: null, template: "sveltekit-static" },
  { name: "Astro static", files: { "package.json": pkg({ astro: "5" }, { build: "astro build" }), "astro.config.mjs": "export default defineConfig({ output: 'static' })" }, detector: "javascript.astro", framework: "astro", mode: "astro-static", output: "dist", run: null, template: "astro-static" },
  { name: "Astro Node SSR", files: { "package.json": pkg({ astro: "5", "@astrojs/node": "9" }, { build: "astro build" }), "astro.config.mjs": "import node from '@astrojs/node'; export default defineConfig({ output: 'server', adapter: node({ mode: 'standalone' }) })" }, detector: "javascript.astro", framework: "astro", mode: "astro-node", run: /dist\/server\/entry\.mjs/, template: "astro-node" },
  { name: "Remix Node", files: { "package.json": pkg({ "@remix-run/node": "2", "@remix-run/serve": "2" }, { build: "remix vite:build", start: "remix-serve build/server/index.js" }), "remix.config.js": "module.exports = {}" }, detector: "javascript.remix", framework: "remix", mode: "remix-node", run: /HOST=0\.0\.0\.0.*PORT.*npm run start/, template: "remix-node" },
  { name: "Express", files: { "package.json": pkg({ express: "5" }, { start: "node server.js" }), "server.js": "const app=require('express')(); app.listen(process.env.PORT || 3000, '0.0.0.0')" }, detector: "javascript.express", framework: "express", mode: "express-server", run: /npm run start/, template: "express-server" },
  { name: "Fastify", files: { "package.json": pkg({ fastify: "5" }, { start: "node server.js" }), "server.js": "const app=require('fastify')(); app.listen({port:process.env.PORT||3000,host:'0.0.0.0'})" }, detector: "javascript.fastify", framework: "fastify", mode: "fastify-server", run: /npm run start/, template: "fastify-server" },
  { name: "NestJS", files: { "package.json": pkg({ "@nestjs/core": "11" }, { build: "nest build", "start:prod": "node dist/main.js" }), "nest-cli.json": "{}", "src/main.ts": "app.listen(process.env.PORT || 3000, '0.0.0.0')" }, detector: "javascript.nestjs", framework: "nestjs", mode: "nestjs-server", run: /start:prod/, template: "nestjs-server" },
  { name: "Flask direct", files: python("Flask==3.1.0\ngunicorn==23.0.0\nPillow==11.0.0\n", "app.py", "from flask import Flask\napp = Flask(__name__)\n"), detector: "python.flask", framework: "flask", mode: "flask-wsgi", run: /app:app/, template: "flask-wsgi", installAbsent: /python -m pip install.*gunicorn/ },
  { name: "Flask platform Gunicorn", files: python("Flask==3.1.0\n", "app.py", "from flask import Flask\napp = Flask(__name__)\n"), detector: "python.flask", framework: "flask", mode: "flask-wsgi", run: /app:app/, template: "flask-wsgi", install: /requirements\.txt.*gunicorn==23\.0\.0/ },
  { name: "Flask create_app", files: python("Flask==3.1.0\ngunicorn==23.0.0\n", "app.py", "from flask import Flask\ndef create_app():\n    app = Flask(__name__)\n    return app\n"), detector: "python.flask", framework: "flask", mode: "flask-wsgi", run: /create_app\(\)/, template: "flask-wsgi" },
  { name: "Flask make_app", files: python("Flask==3.1.0\ngunicorn==23.0.0\n", "server.py", "from flask import Flask\ndef make_app():\n    return Flask(__name__)\n"), detector: "python.flask", framework: "flask", mode: "flask-wsgi", run: /make_app\(\)/, template: "flask-wsgi" },
  { name: "FastAPI", files: python("fastapi==0.116.0\nuvicorn==0.35.0\n", "main.py", "from fastapi import FastAPI\napi = FastAPI()\n"), detector: "python.fastapi", framework: "fastapi", mode: "fastapi-asgi", run: /main:api/, template: "fastapi-asgi", installAbsent: /python -m pip install.*uvicorn/ },
  { name: "FastAPI platform Uvicorn", files: python("fastapi==0.116.0\n", "main.py", "from fastapi import FastAPI\napp = FastAPI()\n"), detector: "python.fastapi", framework: "fastapi", mode: "fastapi-asgi", run: /main:app/, template: "fastapi-asgi", install: /requirements\.txt.*uvicorn==0\.35\.0/ },
  { name: "FastAPI factory", files: python("fastapi==0.116.0\n", "main.py", "from fastapi import FastAPI\ndef create_app():\n    return FastAPI()\n"), detector: "python.fastapi", framework: "fastapi", mode: "fastapi-asgi", run: /main:create_app --factory/, template: "fastapi-asgi", install: /uvicorn==0\.35\.0/ },
  { name: "Django WSGI", files: { "requirements.txt": "Django==5.2.0\ngunicorn==23.0.0\n", "manage.py": "", "config/wsgi.py": "application = object()" }, detector: "python.django", framework: "django", mode: "django-wsgi", run: /config\.wsgi:application/, template: "django-wsgi", installAbsent: /python -m pip install.*gunicorn/ },
  { name: "Django WSGI platform Gunicorn", files: { "requirements.txt": "Django==5.2.0\n", "manage.py": "", "config/wsgi.py": "application = object()" }, detector: "python.django", framework: "django", mode: "django-wsgi", run: /config\.wsgi:application/, template: "django-wsgi", install: /gunicorn==23\.0\.0/ },
  { name: "Django ASGI platform Uvicorn", files: { "requirements.txt": "Django==5.2.0\n", "manage.py": "", "config/asgi.py": "application = object()" }, detector: "python.django", framework: "django", mode: "django-asgi", run: /config\.asgi:application/, template: "django-asgi", install: /uvicorn==0\.35\.0/ },
  { name: "Django ASGI repository Uvicorn", files: { "requirements.txt": "Django==5.2.0\nuvicorn[standard]==0.35.0\n", "manage.py": "", "config/asgi.py": "application = object()" }, detector: "python.django", framework: "django", mode: "django-asgi", run: /config\.asgi:application/, template: "django-asgi", installAbsent: /python -m pip install.*uvicorn/ },
  { name: "Flask pyproject pip", files: { "pyproject.toml": "[project]\nname='web'\nrequires-python='>=3.12'\ndependencies=['Flask==3.1.0']\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n" }, detector: "python.flask", framework: "flask", mode: "flask-wsgi", run: /app:app/, template: "flask-wsgi", install: /pip install --no-cache-dir \..*gunicorn==23\.0\.0/ },
  { name: "Flask Poetry", files: { "pyproject.toml": "[tool.poetry]\nname='web'\nversion='1.0.0'\n[tool.poetry.dependencies]\npython='^3.11'\nFlask='3.1.0'\n", "poetry.lock": "", "app.py": "from flask import Flask\napp = Flask(__name__)\n" }, detector: "python.flask", framework: "flask", mode: "flask-wsgi", run: /app:app/, template: "flask-wsgi", install: /poetry install --only main --no-root.*gunicorn==23\.0\.0/ },
  { name: "FastAPI Pipenv", files: { "Pipfile": "[packages]\nfastapi='==0.116.0'\n", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n" }, detector: "python.fastapi", framework: "fastapi", mode: "fastapi-asgi", run: /main:app/, template: "fastapi-asgi", install: /pipenv install --system(?! --deploy).*uvicorn==0\.35\.0/ },
  { name: "Streamlit", files: python("streamlit==1.47.0\n", "app.py", "import streamlit as st\nst.write('ok')\n"), detector: "python.streamlit", framework: "streamlit", mode: "streamlit-server", run: /0\.0\.0\.0.*PORT/, template: "streamlit-server" },
  { name: "Express Yarn", files: { "package.json": managerPkg("yarn@4.5.0", { express: "5" }, { start: "node server.js" }), "yarn.lock": "", "server.js": "const app=require('express')(); app.listen(process.env.PORT || 3000, '0.0.0.0')" }, detector: "javascript.express", framework: "express", mode: "express-server", run: /corepack yarn run start/, template: "express-server", install: /corepack enable && yarn install --frozen-lockfile/ },
  { name: "Express pnpm", files: { "package.json": managerPkg("pnpm@10.0.0", { express: "5" }, { start: "node server.js" }), "pnpm-lock.yaml": "lockfileVersion: '9.0'\n", "server.js": "const app=require('express')(); app.listen(process.env.PORT || 3000, '0.0.0.0')" }, detector: "javascript.express", framework: "express", mode: "express-server", run: /corepack pnpm run start/, template: "express-server", install: /corepack enable && pnpm install --frozen-lockfile/ },
  { name: "Unsupported adapter", files: { "package.json": pkg({ "@sveltejs/kit": "2", "@sveltejs/adapter-cloudflare": "4" }, { build: "vite build" }), "svelte.config.js": "import adapter from '@sveltejs/adapter-cloudflare'; export default { kit: { adapter: adapter() } }" }, detector: "javascript.sveltekit", framework: "sveltekit", mode: "sveltekit-unsupported-adapter", template: "sveltekit-node", readiness: "BLOCKED" },
];

const resolver = new MainstreamDetectorResolverService();
const registry = new TemplateRegistryService();
const docker = new DockerTemplateEngineService();
const scanner = new RepoDeployabilityScannerService();

function writeFixture(files: Record<string, string>, node: boolean) {
  const root = mkdtempSync(join(tmpdir(), "deployguard-mainstream-"));
  const all = { ...files };
  if (node && !["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"].some((name) => Object.prototype.hasOwnProperty.call(all, name))) {
    const manifest = JSON.parse(all["package.json"]);
    all["package-lock.json"] = JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: manifest.dependencies || {}, devDependencies: manifest.devDependencies || {} } } });
  }
  for (const [name, content] of Object.entries(all)) { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
  return root;
}

function asPlan(fixture: Fixture, detected: NonNullable<ReturnType<MainstreamDetectorResolverService["resolve"]>["result"]>): BuildPlan {
  const partial = detected.partialBuildPlan;
  const blockers = [...detected.unsupportedReasons];
  return {
    planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, repositoryFullName: "fixture/repository", branch: "main", commitSha: "a".repeat(40),
    detectorId: detected.detectorId, language: detected.language, framework: detected.framework, frameworkMode: detected.frameworkMode,
    confidence: String(detected.confidence), platformBackendMount: "/__deployguard/backend", evidence: detected.evidence, appRoot: ".", repositoryInstallRoot: ".", packageManager: partial.packageManager,
    dependencyManifest: detected.language === "python" ? "requirements.txt" : "package.json", lockfile: detected.language === "python" ? "requirements.txt" : "package-lock.json",
    runtimeVersion: partial.runtimeVersion, baseImage: partial.baseImage, runtimeImage: partial.runtimeImage,
    installCommand: detected.language === "python" ? "pip install --no-cache-dir -r requirements.txt" : "npm ci",
    buildCommand: partial.buildCommand, buildCommands: partial.buildCommand ? [partial.buildCommand] : [], releaseCommand: partial.releaseCommand,
    releaseCommands: partial.releaseCommand ? [partial.releaseCommand] : [], runCommand: partial.runCommand, runtimeFiles: partial.runtimeFiles,
    outputDirectory: partial.outputDirectory, buildSystemDependencies: partial.buildSystemDependencies, runtimeSystemDependencies: partial.runtimeSystemDependencies,
    port: partial.port, portSource: "detector", healthPath: detected.framework === "streamlit" ? "/_stcore/health" : "/",
    bindHost: partial.bindHost, bindsToPortEnv: partial.bindsToPortEnv, runtimeType: partial.runtimeType, environmentOwnership: [], requiredInputs: [],
    requiredUserInputs: detected.requiredUserInputs, optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: [], secretEnvVars: [],
    dockerStrategy: "generated", dockerTemplate: partial.dockerTemplate, warnings: detected.warnings, blockers, serviceBindings: [],
  };
}

async function persistedContract(profile: any) {
  const project: any = {
    id: "41414141-4141-4414-8414-414141414141", repositoryUrl: "https://github.com/fixture/repository",
    repositoryFullName: "fixture/repository", targetBranch: "main", environmentName: "dev", appDirectory: null, deploymentOverrides: {},
  };
  profile.id = "42424242-4242-4424-8424-424242424242";
  profile.projectId = project.id;
  profile.repositoryUrl = project.repositoryUrl;
  profile.repositoryFullName = project.repositoryFullName;
  profile.targetBranch = project.targetBranch;
  profile.rawProfile.inputFingerprintVersion = DETECTION_INPUT_FINGERPRINT_VERSION;
  profile.inputFingerprint = detectionFingerprint(project, profile.commitSha);
  // This is a generated-image certification, not the missing-user-secret
  // negative case. Supply every repository-evidenced fixture key so an
  // otherwise deployable framework is allowed to compile its Docker contract.
  const required = [...new Set([
    ...((profile.rawProfile.requiredEnvironmentVariables || []) as string[]),
    ...((profile.rawProfile.environmentVariables || []) as Array<{ key?: unknown }>)
      .map((item) => typeof item.key === "string" ? item.key : "")
      .filter(Boolean),
  ])];
  let stored: any = {
    id: "43434343-4343-4434-8434-434343434343",
    projectId: project.id,
    blockers: ["React build tooling is unsupported."],
    buildPlan: { detectorId: "javascript.react-unsupported", frameworkMode: "unsupported-react-build" },
  };
  const service = new DeploymentContractService(
    { findOne: async () => stored, create: (value: any) => ({ id: "43434343-4343-4434-8434-434343434343", ...value }), save: async (value: any) => (stored = value) } as any,
    {} as any, {} as any,
    { find: async () => required.map((key) => ({ key, value: "configured", environment: "dev", isActive: true, isSecret: /SECRET|TOKEN|PASSWORD|API_KEY/.test(key) })) } as any,
    { findOne: async () => null, create: (value: any) => value, save: async (value: any) => value } as any,
    registry, docker, { get: (_key: string, defaultValue: unknown) => defaultValue } as any,
  );
  return service.upsertFromDetection(project, profile);
}

async function main() {
for (const fixture of fixtures) {
  const root = writeFixture(fixture.files, Boolean(fixture.files["package.json"]));
  try {
    const files = new Set(readdirSync(root));
    const resolved = resolver.resolve(root, files);
    assert.ok(resolved.result, `${fixture.name}: detector result`);
    const detected = resolved.result!;
    assert.equal(detected.detectorId, fixture.detector, `${fixture.name}: detector ID`);
    assert.equal(detected.framework, fixture.framework, `${fixture.name}: framework`);
    assert.equal(detected.frameworkMode, fixture.mode, `${fixture.name}: mode`);
    assert.ok(detected.confidence >= 0.7 && detected.evidence.length, `${fixture.name}: confidence/evidence`);
    assert.equal(detected.partialBuildPlan.outputDirectory, fixture.output === undefined ? detected.partialBuildPlan.outputDirectory : fixture.output, `${fixture.name}: output`);
    if (fixture.run === null) assert.equal(detected.partialBuildPlan.runCommand, null, `${fixture.name}: static has no server command`);
    else if (fixture.run) assert.match(detected.partialBuildPlan.runCommand || "", fixture.run, `${fixture.name}: run command`);
    assert.match(detected.partialBuildPlan.baseImage, /:\d/, `${fixture.name}: pinned image`);
    assert.ok(detected.partialBuildPlan.port > 0, `${fixture.name}: port`);
    assert.equal(detected.partialBuildPlan.bindHost, "0.0.0.0", `${fixture.name}: binding`);
    assert.equal(detected.partialBuildPlan.dockerTemplate, fixture.template, `${fixture.name}: strategy`);
    if (fixture.name === "Next.js standalone") assert.ok(detected.partialBuildPlan.runtimeSystemDependencies.includes("vips"), "sharp runtime mapping");
    if (fixture.name === "Flask direct") assert.ok(detected.partialBuildPlan.runtimeSystemDependencies.includes("libjpeg62-turbo"), "Pillow runtime mapping");
    if (fixture.name.startsWith("Django")) {
      assert.equal(detected.partialBuildPlan.buildInitialization?.mode, "runtime_placeholders", "Django collectstatic must declare build-only managed-runtime placeholders");
      assert.match(detected.partialBuildPlan.releaseCommand || "", /manage\.py migrate/, "Django database migrations remain outside image build");
    }
    const plan = asPlan(fixture, detected);
    assert.equal(evaluateBuildPlanReadiness(plan).status, fixture.readiness || "READY", `${fixture.name}: readiness`);
    const integrated = new StackDetectionService(new TemplateMatchingService(), scanner, resolver).detect(root, "c".repeat(40));
    assert.equal(integrated.rawProfile.detectorId, fixture.detector, `${fixture.name}: integrated resolver handoff`);
    assert.equal(integrated.frameworkVariant, fixture.mode, `${fixture.name}: integrated framework mode`);
    assert.equal(integrated.selectedTemplate, detected.unsupportedReasons.length ? "generic-node" : fixture.template, `${fixture.name}: integrated template selection`);
    const requiresInput = detected.requiredUserInputs.length > 0;
    assert.equal(integrated.detectionStatus, detected.unsupportedReasons.length || requiresInput ? "manual_input_required" : "success", `${fixture.name}: integrated readiness gate: ${integrated.errors.join(" | ")}`);
    const contract = await persistedContract(integrated);
    assert.equal(contract.buildPlan.detectorId, fixture.detector, `${fixture.name}: persisted BuildPlan detector`);
    assert.doesNotMatch(JSON.stringify(contract), /javascript\.react-unsupported|unsupported-react-build/, `${fixture.name}: fresh detection replaces stale unsupported contract`);
    assert.equal(contract.buildPlan.frameworkMode, fixture.mode, `${fixture.name}: persisted BuildPlan mode`);
    const publicComponent = contract.buildPlan.components?.find((component: any) => component.role === "frontend") || contract.buildPlan.components?.[0];
    const missingHttpReadiness = publicComponent?.runtimeType === "server" && publicComponent?.healthCheckMode === "tcp";
    if (fixture.install) assert.match(contract.buildPlan.installCommand, fixture.install, `${fixture.name}: completed install command`);
    if (fixture.installAbsent) assert.doesNotMatch(contract.buildPlan.installCommand, fixture.installAbsent, `${fixture.name}: repository runtime respected`);
    if (fixture.install) assert.match(contract.generatedDockerfile || "", fixture.install, `${fixture.name}: generated Docker consumes completed install command`);
    assert.equal(contract.buildPlan.commitSha, "c".repeat(40), `${fixture.name}: exact SHA`);
    assert.equal(contract.ecsPlan.containerPort, contract.buildPlan.port, `${fixture.name}: ECS port parity`);
    assert.equal(contract.ecsPlan.targetGroupPort, contract.buildPlan.port, `${fixture.name}: target-group port parity`);
    assert.equal(contract.ecsPlan.healthCheckPath, contract.buildPlan.healthPath, `${fixture.name}: ECS health parity`);
    if (!detected.unsupportedReasons.length && !requiresInput) {
      assert.equal(contract.deployable, true, `${fixture.name}: deployable contract: ${contract.blockers.join(" | ")}`);
      assert.ok(contract.generatedDockerfile, `${fixture.name}: persisted generated Dockerfile`);
      assert.ok(contract.generatedDockerfile.includes(contract.buildPlan.baseImage), `${fixture.name}: persisted Docker image parity`);
      const workflowInputs = buildPlanWorkflowInputs(contract.buildPlan);
      assert.deepEqual(JSON.parse(Buffer.from(workflowInputs.build_plan_base64, "base64").toString("utf8")), contract.buildPlan, `${fixture.name}: exact workflow BuildPlan`);
      assert.equal(workflowInputs.app_port, String(contract.ecsPlan.containerPort), `${fixture.name}: workflow/ECS port parity`);
      assert.equal(workflowInputs.health_check_path, contract.ecsPlan.healthCheckPath, `${fixture.name}: workflow/ECS health parity`);
      assert.equal(workflowInputs.container_profile, contract.dockerTemplate, `${fixture.name}: workflow strategy parity`);
      assert.equal(evaluateBuildPlanReadiness(contract.buildPlan).status, contract.warnings.length ? "READY_WITH_WARNINGS" : "READY", `${fixture.name}: persisted readiness`);
    } else if (detected.unsupportedReasons.length) {
      assert.equal(contract.deployable, false, `${fixture.name}: unsupported strategy must fail closed`);
      assert.equal(evaluateBuildPlanReadiness(contract.buildPlan).status, "BLOCKED", `${fixture.name}: unsupported readiness`);
    } else {
      assert.equal(contract.deployable, false, `${fixture.name}: incomplete evidence must require input`);
      assert.equal(evaluateBuildPlanReadiness(contract.buildPlan).status, "INPUT_REQUIRED", `${fixture.name}: input readiness`);
    }
    if (!detected.unsupportedReasons.length && !requiresInput) {
      const template = registry.getTemplate(plan.dockerTemplate);
      assert.ok(template, `${fixture.name}: registered template`);
      const rendered = docker.renderDockerfile(template!, plan);
      assert.ok(rendered?.includes(plan.baseImage), `${fixture.name}: Docker consumes pinned BuildPlan image`);
      if (plan.outputDirectory) assert.ok(rendered?.includes(`/app/${plan.outputDirectory}`), `${fixture.name}: Docker consumes BuildPlan output`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

const missingLockRoot = writeFixture({ "package.json": pkg({ express: "5" }, { start: "node server.js" }), "server.js": "app.listen(process.env.PORT || 3000, '0.0.0.0')" }, false);
try {
  const scanned = scanner.scan(missingLockRoot, { ecosystem: "node", framework: "express", packageManager: "npm", buildCommand: null, startCommand: "npm run start", expectedPort: 3000, healthCheckPath: "/", staticOutput: false, hasDockerfile: false, requiresDatabase: false, requiresPersistentStorage: false });
  assert.equal(scanned.installCommand, "npm install"); assert.match(scanned.deployabilityWarnings.join(" "), /No JavaScript lockfile/); assert.doesNotMatch(scanned.installCommand || "", /npm ci/);
  const detected = resolver.resolve(missingLockRoot, new Set(["package.json", "server.js"])).result!;
  const warningPlan = { ...asPlan(fixtures.find((item) => item.name === "Express")!, detected), lockfile: null, installCommand: "npm install", warnings: scanned.deployabilityWarnings };
  assert.equal(evaluateBuildPlanReadiness(warningPlan).status, "READY_WITH_WARNINGS");
} finally { rmSync(missingLockRoot, { recursive: true, force: true }); }

const localhostRoot = writeFixture({ "package.json": pkg({ fastify: "5" }, { start: "node server.js" }), "server.js": "fastify.listen({port:process.env.PORT||3000,host:'127.0.0.1'})" }, true);
try {
  const scanned = scanner.scan(localhostRoot, { ecosystem: "node", framework: "fastify", packageManager: "npm", buildCommand: null, startCommand: "npm run start", expectedPort: 3000, healthCheckPath: "/", staticOutput: false, hasDockerfile: false, requiresDatabase: false, requiresPersistentStorage: false });
  assert.match(scanned.deployabilityBlockers.join(" "), /localhost|0\.0\.0\.0/);
} finally { rmSync(localhostRoot, { recursive: true, force: true }); }

const customRoot = writeFixture({ "package.json": pkg({ express: "5" }, { start: "node server.js" }), "server.js": "app.get('/health', handler); app.listen(process.env.PORT||3000,'0.0.0.0')", Dockerfile: "FROM node:22-alpine3.21\nEXPOSE 3000\nUSER node\nCMD [\"node\",\"server.js\"]\n" }, true);
try {
  const profile = new StackDetectionService(new TemplateMatchingService(), scanner, resolver).detect(customRoot, "b".repeat(40), null, { dockerfileMode: "custom" });
  assert.equal(profile.selectedTemplate, "custom-dockerfile"); assert.equal(profile.hasDockerfile, true); assert.doesNotMatch(profile.errors.join(" "), /Dockerfile.*CMD|secret-like/);
  const contract = await persistedContract(profile);
  assert.equal(contract.deployable, true, `custom Dockerfile contract: ${contract.blockers.join(" | ")}`);
  assert.equal(contract.buildPlan.dockerStrategy, "custom");
  assert.equal(contract.buildPlan.baseImage, "node:22-alpine3.21");
  assert.equal(contract.buildPlan.runtimeImage, "node:22-alpine3.21");
  assert.equal(contract.generatedDockerfile, null);
  assert.deepEqual(JSON.parse(Buffer.from(buildPlanWorkflowInputs(contract.buildPlan).build_plan_base64, "base64").toString("utf8")), contract.buildPlan);
} finally { rmSync(customRoot, { recursive: true, force: true }); }

const unsafeDockerRoot = writeFixture({ "package.json": pkg({ express: "5" }, { start: "node server.js" }), "server.js": "app.listen(process.env.PORT||3000,'0.0.0.0')", Dockerfile: "FROM node:22-alpine3.21\nARG API_TOKEN\nEXPOSE 3000\nCMD [\"node\",\"server.js\"]\n" }, true);
try {
  const profile = new StackDetectionService(new TemplateMatchingService(), scanner, resolver).detect(unsafeDockerRoot, "d".repeat(40), null, { dockerfileMode: "custom" });
  assert.match(profile.errors.join(" "), /secret-like build argument/);
  assert.equal(profile.detectionStatus, "manual_input_required");
} finally { rmSync(unsafeDockerRoot, { recursive: true, force: true }); }

const customPythonRoot = writeFixture({ "requirements.txt": "Flask==3.1.0\n", "app.py": "from flask import Flask\napp = Flask(__name__)\n", Dockerfile: "FROM python:3.11-slim\nRUN useradd --create-home appuser\nWORKDIR /app\nCOPY --chown=appuser:appuser . .\nEXPOSE 5000\nUSER appuser\nCMD [\"python\",\"app.py\"]\n" }, false);
try {
  const profile = new StackDetectionService(new TemplateMatchingService(), scanner, resolver).detect(customPythonRoot, "f".repeat(40), null, { dockerfileMode: "custom" });
  assert.equal(profile.selectedTemplate, "custom-dockerfile");
  assert.doesNotMatch(String(profile.rawProfile.installCommand), /python -m pip install.*gunicorn/, "custom Python Dockerfile gets no platform runtime injection");
  const contract = await persistedContract(profile);
  assert.equal(contract.generatedDockerfile, null);
  assert.doesNotMatch(contract.buildPlan.installCommand, /python -m pip install.*gunicorn/);
} finally { rmSync(customPythonRoot, { recursive: true, force: true }); }

const nestedPythonRoot = mkdtempSync(join(tmpdir(), "deployguard-python-nested-"));
try {
  mkdirSync(join(nestedPythonRoot, "services", "api"), { recursive: true });
  writeFileSync(join(nestedPythonRoot, "services", "api", "requirements.txt"), "Flask==3.1.0\n");
  writeFileSync(join(nestedPythonRoot, "services", "api", "app.py"), "from flask import Flask\napp = Flask(__name__)\n");
  const profile = new StackDetectionService(new TemplateMatchingService(), scanner, resolver).detect(nestedPythonRoot, "1".repeat(40));
  assert.equal(profile.rawProfile.appDirectory, "services/api");
  assert.equal(profile.rawProfile.repositoryInstallRoot, "services/api");
  assert.match(String(profile.rawProfile.installCommand), /gunicorn==23\.0\.0/);
} finally { rmSync(nestedPythonRoot, { recursive: true, force: true }); }

const unresolvedPythonRoot = writeFixture({ "requirements.txt": "fastapi==0.116.0\n", "main.py": "from fastapi import FastAPI\n" }, false);
try {
  const profile = new StackDetectionService(new TemplateMatchingService(), scanner, resolver).detect(unresolvedPythonRoot, "2".repeat(40));
  assert.equal(profile.detectionStatus, "manual_input_required");
  assert.match(profile.errors.join(" "), /application object or factory|start command|No supported deployable application component/i);
} finally { rmSync(unresolvedPythonRoot, { recursive: true, force: true }); }

const unsupportedPythonRoot = writeFixture({ "requirements.txt": "tornado==6.5.0\n", "app.py": "import tornado.web\n" }, false);
try {
  const profile = new StackDetectionService(new TemplateMatchingService(), scanner, resolver).detect(unsupportedPythonRoot, "3".repeat(40));
  assert.equal(profile.detectionStatus, "manual_input_required");
  assert.match(profile.errors.join(" "), /No independent mainstream framework detector|supported.*framework|No supported deployable application component/i);
} finally { rmSync(unsupportedPythonRoot, { recursive: true, force: true }); }

const workspaceRoot = mkdtempSync(join(tmpdir(), "deployguard-workspace-root-"));
try {
  mkdirSync(join(workspaceRoot, "apps", "web"), { recursive: true });
  writeFileSync(join(workspaceRoot, "package.json"), JSON.stringify({ private: true, workspaces: ["apps/*"] }));
  writeFileSync(join(workspaceRoot, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
  writeFileSync(join(workspaceRoot, "apps", "web", "package.json"), pkg({ react: "19", vite: "6" }, { build: "vite build" }));
  writeFileSync(join(workspaceRoot, "apps", "web", "vite.config.ts"), "export default {}");
  const profile = new StackDetectionService(new TemplateMatchingService(), scanner, resolver).detect(workspaceRoot, "e".repeat(40));
  assert.equal(profile.rawProfile.appDirectory, "apps/web");
  assert.equal(profile.rawProfile.repositoryInstallRoot, ".");
} finally { rmSync(workspaceRoot, { recursive: true, force: true }); }

console.log(`Mainstream detector verification passed for ${fixtures.length} framework/mode fixtures plus custom Dockerfile, missing lockfile, unsupported adapter, and localhost binding policies.`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});
