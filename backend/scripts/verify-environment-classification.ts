import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BuildPlan, BuildPlanEnvironmentOwnership, BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { DeploymentContractService } from "../src/projects/deployment-contract.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { unresolvedExactRequiredConfiguration } from "../src/infrastructure/database-service-binding.service";

type Evidence = Record<string, any>;
const scanner = new RepoDeployabilityScannerService();

async function scan(source: string, options: { frontend?: boolean; ecosystem?: "node" | "python"; framework?: string; files?: Record<string, string> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "deployguard-env-classification-"));
  const ecosystem = options.ecosystem || "node";
  try {
    if (ecosystem === "node") {
      await writeFile(join(root, "package.json"), JSON.stringify(options.frontend
        ? { scripts: { build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }
        : { scripts: { start: "node server.js" }, dependencies: { express: "4.21.0" } }));
      await writeFile(join(root, "package-lock.json"), "{}");
      const name = options.frontend ? "src/App.jsx" : "server.js";
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), source);
    } else {
      await writeFile(join(root, "requirements.txt"), `${options.framework || "flask"}==3.0.0\n`);
      await writeFile(join(root, "app.py"), source);
    }
    for (const [name, content] of Object.entries(options.files || {})) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), content);
    }
    const result: any = scanner.scan(root, {
      ecosystem, framework: options.framework || (options.frontend ? "vite-react" : "express"), packageManager: ecosystem === "node" ? "npm" : "pip",
      buildCommand: options.frontend ? "npm run build" : null, startCommand: options.frontend ? null : ecosystem === "node" ? "node server.js" : "gunicorn app:app --bind 0.0.0.0:$PORT",
      expectedPort: options.frontend ? null : 3000, healthCheckPath: "/health", staticOutput: Boolean(options.frontend), hasDockerfile: false,
      requiresDatabase: false, requiresPersistentStorage: false,
    });
    return { result, evidence: new Map<string, Evidence>(result.environmentVariables.map((item: Evidence) => [item.key, item])) };
  } finally { await rm(root, { recursive: true, force: true }); }
}

function plan(environmentOwnership: BuildPlanEnvironmentOwnership[], warnings: string[] = [], blockers: string[] = []): BuildPlan {
  return {
    planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, repositoryFullName: "fixture/app", branch: "main", commitSha: "a".repeat(40), detectorId: "fixture",
    language: "javascript", framework: "vite-react", frameworkMode: "vite-static", confidence: "high", evidence: [], appRoot: ".", repositoryInstallRoot: ".",
    packageManager: "npm", dependencyManifest: "package.json", lockfile: "package-lock.json", runtimeVersion: "22", baseImage: "node:22-alpine3.21",
    runtimeImage: "nginxinc/nginx-unprivileged:1.27-alpine", installCommand: "npm ci", buildCommand: "npm run build", buildCommands: ["npm run build"],
    releaseCommand: null, releaseCommands: [], runCommand: null, runtimeFiles: [], outputDirectory: "dist", buildSystemDependencies: [], runtimeSystemDependencies: [],
    port: 8080, portSource: "template_default", healthPath: "/", bindHost: null, bindsToPortEnv: false, runtimeType: "static", database: { required: false, provider: "none", engine: null },
    environmentOwnership, requiredInputs: environmentOwnership.filter((item) => item.required).map((item) => item.key),
    requiredUserInputs: environmentOwnership.filter((item) => item.owner === "application" && (item.required || item.requirement === "unknown")).map((item) => item.key),
    optionalInputs: environmentOwnership.filter((item) => !item.required).map((item) => item.key), buildTimeEnvVars: environmentOwnership.filter((item) => item.phase === "build").map((item) => item.key),
    runtimeEnvVars: environmentOwnership.filter((item) => item.phase === "runtime").map((item) => item.key), secretEnvVars: environmentOwnership.filter((item) => item.secret).map((item) => item.key),
    dockerStrategy: "generated", dockerTemplate: "vite-static", warnings, blockers,
  };
}

async function main() {
  const express = await scan("if (!process.env.JWT_SECRET) throw new Error('required'); require('express')().listen(process.env.PORT || 3000, '0.0.0.0')");
  assert.deepEqual({ component: express.evidence.get("JWT_SECRET")?.component, exposure: express.evidence.get("JWT_SECRET")?.exposure, phase: express.evidence.get("JWT_SECRET")?.phase, requirement: express.evidence.get("JWT_SECRET")?.requirement, secret: express.evidence.get("JWT_SECRET")?.secret },
    { component: "backend", exposure: "private", phase: "runtime", requirement: "required", secret: true });

  for (const framework of ["flask", "fastapi", "django"]) {
    const python = await scan("import os\nPRIVATE_SIGNING_KEY = os.environ['PRIVATE_SIGNING_KEY']", { ecosystem: "python", framework });
    assert.equal(python.evidence.get("PRIVATE_SIGNING_KEY")?.component, "backend", framework);
    assert.equal(python.evidence.get("PRIVATE_SIGNING_KEY")?.phase, "runtime", framework);
    assert.equal(python.evidence.get("PRIVATE_SIGNING_KEY")?.secret, true, framework);
  }

  const provenPythonHelper = await scan([
    "import os",
    "def required(name):",
    "    value = os.getenv(name)",
    "    if not value:",
    "        raise RuntimeError(f'Missing value for: {name}')",
    "    return value",
    "POSTGRES_HOST = required('POSTGRES_HOST')",
    "POSTGRES_PORT = required('POSTGRES_PORT')",
    "POSTGRES_DB = required('POSTGRES_DB')",
    "POSTGRES_USER = required('POSTGRES_USER')",
    "POSTGRES_PASSWORD = required('POSTGRES_PASSWORD')",
  ].join("\n"), { ecosystem: "python", framework: "fastapi", files: { "requirements.txt": "fastapi==0.116.1\npsycopg==3.2.9\n" } });
  for (const key of ["POSTGRES_HOST", "POSTGRES_PORT", "POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD"]) {
    const item = provenPythonHelper.evidence.get(key);
    assert.deepEqual({ requirement: item?.requirement, component: item?.component, database: item?.database }, { requirement: "required", component: "backend", database: true }, key);
  }
  assert.equal(provenPythonHelper.evidence.get("POSTGRES_PASSWORD")?.secret, true, "a proven database password alias remains private");

  const arbitraryHelper = await scan([
    "def helper(name):",
    "    return name.lower()",
    "VALUE = helper('POSTGRES_USER')",
  ].join("\n"), { ecosystem: "python", framework: "fastapi", files: { "requirements.txt": "fastapi==0.116.1\n" } });
  assert.equal(arbitraryHelper.evidence.has("POSTGRES_USER"), false, "arbitrary literal-taking helpers are not ENV evidence");

  const repository = await mkdtemp(join(tmpdir(), "deployguard-compose-alias-"));
  try {
    await mkdir(join(repository, ".git"));
    await mkdir(join(repository, "backend"));
    await mkdir(join(repository, "frontend", "src"), { recursive: true });
    await writeFile(join(repository, "backend", "requirements.txt"), "fastapi==0.116.1\npsycopg==3.2.9\n");
    await writeFile(join(repository, "backend", "app.py"), "import os\nPOSTGRES_HOST = os.getenv('POSTGRES_HOST', 'db')\n");
    await writeFile(join(repository, "frontend", "package.json"), JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }));
    await writeFile(join(repository, "frontend", "package-lock.json"), "{}");
    await writeFile(join(repository, "frontend", "src", "App.jsx"), "export default function App(){ return null }");
    await writeFile(join(repository, "base.env"), "ORDERED_VALUE=base\nBASE_ONLY=enabled\n");
    await writeFile(join(repository, "backend.env"), "ORDERED_VALUE=backend\nPOSTGRES_USER=env_file_user\nPOSTGRES_PASSWORD=env_file_secret\nPOSTGRES_DB=env_file_db\nENV_FILE_ONLY=enabled\n");
    await writeFile(join(repository, "frontend.env"), "VITE_FRONTEND_ONLY=public\n");
    await writeFile(join(repository, "docker-compose.yml"), [
      "services:",
      "  backend:",
      "    build:",
      "      context: ./backend",
      "    env_file:",
      "      - ./base.env",
      "      - ./backend.env",
      "    environment:",
      "      POSTGRES_USER: inline_user",
      "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}",
      "      POSTGRES_DB: ${POSTGRES_DB}",
      "      POSTGRES_PORT: ${POSTGRES_PORT}",
      "  frontend:",
      "    build:",
      "      context: ./frontend",
      "    env_file: ./frontend.env",
    ].join("\n"));
    const backend: any = scanner.scan(join(repository, "backend"), {
      ecosystem: "python", framework: "fastapi", packageManager: "pip", buildCommand: null,
      startCommand: "uvicorn app:app --host 0.0.0.0 --port $PORT", expectedPort: 8000, healthCheckPath: "/health",
      staticOutput: false, hasDockerfile: false, requiresDatabase: true, requiresPersistentStorage: false,
    });
    const backendEvidence = new Map<string, Evidence>(backend.environmentVariables.map((item: Evidence) => [item.key, item]));
    for (const key of ["POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB", "POSTGRES_PORT"]) {
      assert.equal(backendEvidence.has(key), true, `root Compose evidence must reach the matching backend component: ${key}`);
    }
    assert.equal(backendEvidence.has("ENV_FILE_ONLY"), true, "Compose env_file evidence must be resolved relative to the Compose file and scoped to its service");
    assert.equal(backendEvidence.get("ORDERED_VALUE")?.detectedDefault, "backend", "later Compose env_file values must override earlier files");
    assert.equal(backendEvidence.has("VITE_FRONTEND_ONLY"), false, "frontend env_file evidence must not leak into backend evidence");
    assert.equal(backendEvidence.get("POSTGRES_USER")?.detectedDefault, "inline_user", "Compose environment must override env_file values");
    const frontend: any = scanner.scan(join(repository, "frontend"), {
      ecosystem: "node", framework: "vite-react", packageManager: "npm", buildCommand: "npm run build",
      startCommand: null, expectedPort: null, healthCheckPath: "/", staticOutput: true, hasDockerfile: false,
      requiresDatabase: false, requiresPersistentStorage: false,
    });
    assert.equal(frontend.environmentVariables.some((item: Evidence) => /^POSTGRES_/.test(item.key)), false, "backend Compose credentials must not leak into frontend evidence");
    assert.equal(frontend.environmentVariables.some((item: Evidence) => item.key === "ENV_FILE_ONLY"), false, "backend env_file values must not leak into frontend evidence");
    assert.equal(frontend.environmentVariables.some((item: Evidence) => item.key === "VITE_FRONTEND_ONLY"), true, "the matching frontend env_file remains frontend-scoped");
    await rm(join(repository, "backend.env"));
    const missingEnvFile: any = scanner.scan(join(repository, "backend"), {
      ecosystem: "python", framework: "fastapi", packageManager: "pip", buildCommand: null,
      startCommand: "uvicorn app:app --host 0.0.0.0 --port $PORT", expectedPort: 8000, healthCheckPath: "/health",
      staticOutput: false, hasDockerfile: false, requiresDatabase: true, requiresPersistentStorage: false,
    });
    assert.match(missingEnvFile.deployabilityBlockers.join(" "), /COMPOSE_ENV_FILE_MISSING/, "a missing application-service env_file must block deterministically");
  } finally { await rm(repository, { recursive: true, force: true }); }

  for (const key of ["VITE_CLIENT_API_KEY", "REACT_APP_PUBLIC_TOKEN", "NEXT_PUBLIC_CLIENT_SECRET"]) {
    const frontend = await scan(`export const value = import.meta.env.${key} || ''`, { frontend: true });
    const item = frontend.evidence.get(key)!;
    assert.deepEqual({ component: item.component, exposure: item.exposure, phase: item.phase, requirement: item.requirement, secret: item.secret, required: item.required },
      { component: "frontend", exposure: "public", phase: "build", requirement: "optional", secret: false, required: false }, key);
  }

  const leaked = await scan("export const secret = process.env.BACKEND_SIGNING_SECRET", { frontend: true });
  assert.match(leaked.result.deployabilityBlockers.join(" "), /Private configuration cannot enter a frontend browser build: BACKEND_SIGNING_SECRET/);

  const optional = await scan("export const weather = import.meta.env.VITE_CLIENT_API_KEY || ''", { frontend: true });
  assert.equal(optional.result.optionalEnvironmentVariables.includes("VITE_CLIENT_API_KEY"), true);
  assert.equal(optional.result.deployabilityBlockers.some((item: string) => /VITE_CLIENT_API_KEY/.test(item)), false);

  const unknown = await scan("export const endpoint = import.meta.env.VITE_PUBLIC_ENDPOINT", { frontend: true });
  assert.equal(unknown.evidence.get("VITE_PUBLIC_ENDPOINT")?.requirement, "required");
  assert.equal(unknown.result.requiredEnvironmentVariables.includes("VITE_PUBLIC_ENDPOINT"), true, "a directly consumed public build value is a required exact contract");
  assert.equal(unknown.result.optionalEnvironmentVariables.includes("VITE_PUBLIC_ENDPOINT"), false, "a directly consumed public build value cannot silently become optional");
  const unknownPublic = plan([{ key: "VITE_PUBLIC_ENDPOINT", owner: "application", component: "frontend", source: "application", exposure: "public", requirement: "unknown", required: false, phase: "build", secret: false }], ["Configuration requiredness remains unproven: VITE_PUBLIC_ENDPOINT."]);
  assert.equal(evaluateBuildPlanReadiness(unknownPublic).status, "INPUT_REQUIRED", "unknown application configuration fails closed until supplied or classified");

  for (const expression of [
    "process.env.FEATURE_FLAG !== 'true'",
    "process.env.FEATURE_FLAG === 'true'",
    "process.env.FEATURE_FLAG === 'production'",
    "Boolean(process.env.FEATURE_FLAG)",
  ]) {
    const comparison = await scan(`const enabled = ${expression}; require('express')().listen(process.env.PORT || 3000, '0.0.0.0')`);
    assert.deepEqual({ requirement: comparison.evidence.get("FEATURE_FLAG")?.requirement, required: comparison.evidence.get("FEATURE_FLAG")?.required }, { requirement: "optional", required: false }, expression);
  }

  const missingGuard = await scan("if (!process.env.REQUIRED_KEY) throw new Error('required'); require('express')().listen(process.env.PORT || 3000, '0.0.0.0')");
  assert.equal(missingGuard.evidence.get("REQUIRED_KEY")?.requirement, "required");
  const undefinedGuard = await scan("if (process.env.REQUIRED_KEY === undefined) throw new Error('required'); require('express')().listen(process.env.PORT || 3000, '0.0.0.0')");
  assert.equal(undefinedGuard.evidence.get("REQUIRED_KEY")?.requirement, "required");
  const terminatingGuard = await scan("if (!process.env.REQUIRED_KEY) process.exit(1); require('express')().listen(process.env.PORT || 3000, '0.0.0.0')");
  assert.equal(terminatingGuard.evidence.get("REQUIRED_KEY")?.requirement, "required");
  const nonFatalGuard = await scan("if (!process.env.UNCERTAIN_KEY) console.warn('feature disabled'); require('express')().listen(process.env.PORT || 3000, '0.0.0.0')");
  assert.deepEqual({ requirement: nonFatalGuard.evidence.get("UNCERTAIN_KEY")?.requirement, required: nonFatalGuard.evidence.get("UNCERTAIN_KEY")?.required }, { requirement: "required", required: true }, "a direct runtime read remains a required exact contract even when the surrounding branch is non-fatal");
  const optionalPassword = await scan("const password = process.env.EMAIL_PASS; require('express')().listen(process.env.PORT || 3000, '0.0.0.0')");
  assert.deepEqual({ requirement: optionalPassword.evidence.get("EMAIL_PASS")?.requirement, required: optionalPassword.evidence.get("EMAIL_PASS")?.required, secret: optionalPassword.evidence.get("EMAIL_PASS")?.secret },
    { requirement: "required", required: true, secret: true }, "password sensitivity remains independent from exact required runtime ownership");
  const optionalPasswordPlan = plan([{ key: "EMAIL_PASS", owner: "application", component: "backend", source: "application", exposure: "private", requirement: "unknown", required: false, phase: "runtime", secret: true }]);
  assert.equal(evaluateBuildPlanReadiness(optionalPasswordPlan).status, "INPUT_REQUIRED", "an absent unknown runtime value remains input-required without fabricating optionality");
  const getOrThrow = await scan("const value = configService.getOrThrow('REQUIRED_KEY'); require('express')().listen(process.env.PORT || 3000, '0.0.0.0')");
  assert.equal(getOrThrow.evidence.get("REQUIRED_KEY")?.requirement, "required");
  const schema = await scan("const schema = z.object({ SCHEMA_SECRET: z.string().min(1) }); schema.parse(process.env); require('express')().listen(process.env.PORT || 3000, '0.0.0.0')");
  assert.equal(schema.evidence.get("SCHEMA_SECRET")?.requirement, "required");
  const mixed = await scan("const enabled = process.env.MIXED_KEY !== 'true'; if (!process.env.MIXED_KEY) throw new Error('required'); require('express')().listen(process.env.PORT || 3000, '0.0.0.0')");
  assert.equal(mixed.evidence.get("MIXED_KEY")?.requirement, "required", "strong requiredness wins across mixed evidence");
  const manifestRequired = await scan("require('express')().listen(process.env.PORT || 3000, '0.0.0.0')", { files: { ".env.example": "MANIFEST_REQUIRED=\n" } });
  assert.equal(manifestRequired.evidence.get("MANIFEST_REQUIRED")?.requirement, "required", "an explicit required repository manifest remains authoritative");

  const environmentSources = await scan("require('express')().listen(process.env.PORT || 3000, '0.0.0.0')", {
    files: {
      ".env": "REPOSITORY_DEFAULT=enabled\nREPOSITORY_SECRET=not-a-real-secret\n",
      ".env.local": "LOCAL_ONLY=development\n",
      ".env.production": "PRODUCTION_DEFAULT=enabled\nPRODUCTION_UNKNOWN=\n",
      "README.md": "## Environment variables\n- README_ONLY: required by hosted deployments\n",
    },
  });
  assert.deepEqual({ requirement: environmentSources.evidence.get("REPOSITORY_DEFAULT")?.requirement, default: environmentSources.evidence.get("REPOSITORY_DEFAULT")?.detectedDefault }, { requirement: "optional", default: undefined }, ".env proves a key/default exists without copying its value into the deployment contract");
  assert.equal(environmentSources.evidence.get("REPOSITORY_SECRET")?.detectedDefault, undefined, "secret-looking .env values must never be copied into detection output");
  assert.equal(environmentSources.evidence.get("LOCAL_ONLY")?.productionRelevant, false, ".env.local remains development-only evidence");
  assert.equal(environmentSources.evidence.get("PRODUCTION_DEFAULT")?.requirement, "optional", ".env.production explicit defaults are repository evidence");
  assert.equal(environmentSources.evidence.get("PRODUCTION_UNKNOWN")?.requirement, "unknown", "blank production values fail closed without claiming requiredness");
  assert.equal(environmentSources.evidence.get("README_ONLY")?.requirement, "unknown", "README-only evidence remains supporting, not fabricated authority");

  const pydantic = await scan([
    "from pydantic_settings import BaseSettings",
    "from typing import Optional",
    "class Settings(BaseSettings):",
    "    REQUIRED_SETTING: str",
    "    DEFAULTED_SETTING: str = 'safe'",
    "    OPTIONAL_SETTING: Optional[str] = None",
  ].join("\n"), { ecosystem: "python", framework: "fastapi" });
  assert.equal(pydantic.evidence.get("REQUIRED_SETTING")?.requirement, "required");
  assert.equal(pydantic.evidence.get("DEFAULTED_SETTING")?.requirement, "optional");
  assert.equal(pydantic.evidence.get("OPTIONAL_SETTING")?.requirement, "optional");

  const viteDevelopment = await scan("require('express')().listen(process.env.PORT || 3000, '0.0.0.0')", {
    files: { "vite.config.ts": "export default { server: { hmr: process.env.DEV_HMR_FLAG !== 'true' } }" },
  });
  assert.deepEqual({ requirement: viteDevelopment.evidence.get("DEV_HMR_FLAG")?.requirement, productionRelevant: viteDevelopment.evidence.get("DEV_HMR_FLAG")?.productionRelevant }, { requirement: "optional", productionRelevant: false });
  assert.equal(viteDevelopment.result.requiredEnvironmentVariables.includes("DEV_HMR_FLAG"), false);
  assert.equal(viteDevelopment.result.optionalEnvironmentVariables.includes("DEV_HMR_FLAG"), false, "development-only configuration is omitted from the production contract");

  const viteProduction = await scan("export default function App(){return null}", {
    frontend: true,
    files: { "vite.config.ts": "if (!process.env.VITE_BUILD_MODE) throw new Error('required'); export default { define: { __MODE__: JSON.stringify(process.env.VITE_BUILD_MODE) }, server: { hmr: process.env.DEV_ONLY !== 'true' } }" },
  });
  assert.equal(viteProduction.evidence.get("VITE_BUILD_MODE")?.requirement, "required", "production Vite build configuration remains required when proven");
  assert.equal(viteProduction.evidence.get("VITE_BUILD_MODE")?.productionRelevant, true);
  assert.equal(viteProduction.evidence.get("DEV_ONLY")?.productionRelevant, false);

  const service: any = Object.create(DeploymentContractService.prototype);
  const topologyPassword = service.topologyEnvironmentEvidence([{ name: "EMAIL_PASS", componentId: "backend", owner: "backend", phase: "runtime", exposure: "private", requirement: "unknown", management: "user-supplied", provenance: ["email.ts"] }])[0];
  assert.deepEqual({ required: topologyPassword.required, requirement: topologyPassword.requirement, secret: topologyPassword.secret },
    { required: false, requirement: "unknown", secret: true }, "Topology-to-BuildPlan projection preserves password sensitivity without fabricating requiredness");
  for (const engine of ["postgres", "mysql", "mongodb"]) {
    const ownership: BuildPlanEnvironmentOwnership[] = service.buildPlanEnvironmentOwnership([
      { key: engine === "mongodb" ? "MONGODB_URI" : "DB_PASSWORD", required: true, phase: "runtime", secret: true, public: false, ownership: "user", component: "backend", exposure: "private", requirement: "required" },
    ], new Set([engine === "mongodb" ? "MONGODB_URI" : "DB_PASSWORD"]), new Set(["PORT"]));
    const database = ownership.find((item) => item.key !== "PORT")!;
    assert.deepEqual({ component: database.component, source: database.source, exposure: database.exposure, phase: database.phase }, { component: "backend", source: "managed_database", exposure: "private", phase: "runtime" }, engine);
    assert.equal(ownership.find((item) => item.key === "PORT")?.source, "platform");
  }

  assert.equal(evaluateBuildPlanReadiness(plan([{ key: "VITE_OPTIONAL", owner: "application", component: "frontend", source: "application", exposure: "public", requirement: "optional", required: false, phase: "build", secret: false }], ["Optional environment variables are not configured: VITE_OPTIONAL."])).status, "READY_WITH_WARNINGS");
  assert.equal(express.evidence.get("PORT")?.component, "platform");
  assert.equal(express.evidence.get("PORT")?.detectedDefault, undefined, "platform-owned values never become repository defaults");

  const frontend = await scan("export const weather = import.meta.env.VITE_WEATHER_API_KEY || ''", { frontend: true });
  assert.equal(frontend.evidence.get("VITE_WEATHER_API_KEY")?.secret, false);
  assert.equal(frontend.evidence.get("VITE_WEATHER_API_KEY")?.requirement, "optional");
  assert.equal(express.evidence.get("JWT_SECRET")?.component, "backend");

  const deployment: any = Object.create(GithubActionsDeploymentService.prototype);
  const configuredRows: Array<{ key: string; value: string; isSecret: boolean }> = [];
  deployment.environmentVariables = {
    createQueryBuilder: () => ({
      addSelect() { return this; },
      where() { return this; },
      async getMany() { return configuredRows; },
    }),
  };
  deployment.environmentCrypto = { decrypt: (value: string) => `resolved:${value}` };
  const optionalPublic = plan([{ key: "VITE_OPTIONAL", owner: "application", component: "frontend", source: "application", exposure: "public", requirement: "optional", required: false, phase: "build", secret: false }]);
  assert.deepEqual(await deployment.buildTimePublicConfig(optionalPublic, "project", "dev"), {}, "an absent optional frontend build value is omitted");
  configuredRows.push({ key: "VITE_OPTIONAL", value: "weather", isSecret: false });
  assert.deepEqual(await deployment.buildTimePublicConfig(optionalPublic, "project", "dev"), { VITE_OPTIONAL: "resolved:weather" }, "a configured optional frontend value is materialized for build only");
  const configuredUnknown = plan([{ key: "VITE_UNKNOWN", owner: "application", component: "frontend", source: "application", exposure: "public", requirement: "unknown", required: false, phase: "build", secret: false }]);
  configuredRows[0] = { key: "VITE_UNKNOWN", value: "preview", isSecret: false };
  assert.deepEqual(await deployment.buildTimePublicConfig(configuredUnknown, "project", "dev"), { VITE_UNKNOWN: "resolved:preview" }, "a supplied unknown value still follows its proven frontend build ownership");
  configuredRows.length = 0;
  const staleSameOriginBase = plan([{ key: "VITE_API_BASE_URL", owner: "application", component: "frontend", source: "application", exposure: "public", requirement: "optional", required: false, phase: "build", secret: false }]);
  staleSameOriginBase.relationships = [{ from: "frontend", to: "backend", kind: "http", mode: "same-origin", pathPrefix: "/api", stripPathPrefix: false, buildTimeVariable: "VITE_API_BASE_URL", verificationPath: "/api/health" }];
  staleSameOriginBase.serviceBindings = [{ sourceComponent: "frontend", envAlias: "VITE_API_BASE_URL", targetComponent: "backend", bindingMode: "platform-proxy", preservedPathname: "/api", platformPathPrefix: "/__deployguard/backend" }];
  configuredRows.push({ key: "VITE_API_BASE_URL", value: "http://localhost:8000", isSecret: false });
  assert.deepEqual(await deployment.buildTimePublicConfig(staleSameOriginBase, "project", "dev"), { VITE_API_BASE_URL: "/__deployguard/backend/api" }, "the BuildPlan service binding owns build-time public routing; legacy route evidence cannot alter its pathname");
  configuredRows.length = 0;
  const requiredPublic = plan([{ key: "VITE_REQUIRED", owner: "application", component: "frontend", source: "application", exposure: "public", requirement: "required", required: true, phase: "build", secret: false }]);
  await assert.rejects(() => deployment.buildTimePublicConfig(requiredPublic, "project", "dev"), /Required public build configuration is missing: VITE_REQUIRED/);

  const optionalBackend = plan([{ key: "OPTIONAL_BACKEND_VALUE", owner: "application", component: "backend", source: "application", exposure: "private", requirement: "optional", required: false, phase: "runtime", secret: false }]);
  assert.deepEqual(await deployment.buildTimePublicConfig(optionalBackend, "project", "dev"), {}, "an absent optional backend runtime value never enters build materialization");
  const requiredBackend = plan([{ key: "JWT_SECRET", owner: "application", component: "backend", source: "application", exposure: "private", requirement: "required", required: true, phase: "runtime", secret: true }]);
  assert.equal(evaluateBuildPlanReadiness(requiredBackend, { unresolvedRequiredValues: ["JWT_SECRET"] }).status, "INPUT_REQUIRED", "a missing required backend secret remains blocked before dispatch");
  assert.deepEqual(await deployment.buildTimePublicConfig(requiredBackend, "project", "dev"), {}, "private backend configuration never enters a frontend build");
  assert.deepEqual(unresolvedExactRequiredConfiguration(["POSTGRES_USER"], ["DB_USER"]), ["POSTGRES_USER"], "a sibling semantic alias cannot satisfy an exact required PostgreSQL alias");
  assert.deepEqual(unresolvedExactRequiredConfiguration(["DB_USER"], ["POSTGRES_USER"]), ["DB_USER"], "a PostgreSQL alias cannot satisfy an exact required generic alias");
  assert.deepEqual(unresolvedExactRequiredConfiguration(["POSTGRES_USER", "DB_USER"], ["POSTGRES_USER", "DB_USER"]), [], "both evidenced aliases are resolved only when both are materialized");

  console.log("Environment classification regression matrix passed: backend secrets, frontend public values, evidence requirements, platform/database ownership, single and bounded component assignment.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
