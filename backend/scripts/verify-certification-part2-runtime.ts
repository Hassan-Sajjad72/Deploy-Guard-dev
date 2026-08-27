import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DETECTION_INPUT_FINGERPRINT_VERSION, detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { BuildPlanComponent } from "../src/projects/build-plan";
import { DeploymentContractService } from "../src/projects/deployment-contract.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { StackDetectionService } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

type Fixture = {
  name: string;
  files: Record<string, string>;
  expectedFramework: string;
  expectedHealth: string;
  configured?: Array<{ key: string; value: string; isSecret: boolean; isActive: boolean }>;
  database?: "postgres" | "mongodb";
  aliases?: { runtime: Record<string, string>; secret: Record<string, "password" | "url"> };
};

const packageJson = (dependencies: Record<string, string>, scripts: Record<string, string>) => JSON.stringify({
  name: "deployguard-certification-part2",
  version: "1.0.0",
  private: true,
  scripts,
  dependencies,
});

const requiredHelper = "function required(name){const value=process.env[name];if(!value)throw new Error(`missing ${name}`);return value;}";
const postgresRuntime = { host: "db.certification.invalid", port: "5432", name: "certification", user: "certifier" };
const mongoRuntime = { host: "db.certification.invalid", port: "27017", name: "certification", user: "certifier" };

const fixtures: Fixture[] = [
  {
    name: "vue-vite",
    expectedFramework: "vite-vue",
    expectedHealth: "/",
    files: {
      "package.json": packageJson({ "@vitejs/plugin-vue": "6.0.1", vite: "7.1.3", vue: "3.5.20" }, { build: "vite build" }),
      "vite.config.js": "import{defineConfig}from'vite';import vue from'@vitejs/plugin-vue';export default defineConfig({plugins:[vue()]})",
      "index.html": "<div id=\"app\"></div><script type=\"module\" src=\"/src/main.js\"></script>",
      "src/main.js": "import{createApp}from'vue';import App from'./App.vue';createApp(App).mount('#app')",
      "src/App.vue": "<template><main>deployguard-vue-certified</main></template><script setup>const api=import.meta.env.VITE_API_BASE_URL??'/api'</script>",
    },
  },
  {
    name: "fastapi-health",
    expectedFramework: "fastapi",
    expectedHealth: "/health",
    files: {
      "requirements.txt": "fastapi==0.116.0\nuvicorn==0.35.0\n",
      "Procfile": "web: uvicorn main:app --host 0.0.0.0 --port 8000\n",
      "main.py": "from fastapi import FastAPI,APIRouter\nfrom fastapi.responses import JSONResponse\napp=FastAPI()\nrouter=APIRouter(prefix='/api/v1')\n@router.get('/items')\ndef items():return []\napp.include_router(router)\n@app.get('/health')\ndef health():return {'status':'ok'}\n@app.get('/fail')\ndef fail():return JSONResponse(status_code=500,content={'status':'failed'})\n",
    },
  },
  {
    name: "flask-health",
    expectedFramework: "flask",
    expectedHealth: "/health",
    files: {
      "requirements.txt": "Flask==3.1.0\ngunicorn==23.0.0\n",
      "Procfile": "web: gunicorn app:app --bind 0.0.0.0:5000\n",
      "app.py": "from flask import Flask\napp=Flask(__name__)\n@app.get('/health')\ndef health():return {'status':'ok'},200\n@app.get('/fail')\ndef fail():return {'status':'failed'},500\n",
    },
  },
  {
    name: "django-health",
    expectedFramework: "django",
    expectedHealth: "/health",
    configured: [
      { key: "APP_ENV", value: "test", isSecret: false, isActive: true },
      { key: "SECRET_KEY", value: "encrypted", isSecret: true, isActive: true },
    ],
    files: {
      "requirements.txt": "Django==5.2.0\ngunicorn==23.0.0\n",
      "Procfile": "web: gunicorn config.wsgi:application --bind 0.0.0.0:8000\n",
      "manage.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')\nfrom django.core.management import execute_from_command_line\nexecute_from_command_line()\n",
      "config/__init__.py": "",
      "config/settings.py": "import os\nSECRET_KEY=os.environ['SECRET_KEY']\nAPP_ENV=os.environ['APP_ENV']\nDEBUG=False\nALLOWED_HOSTS=['*']\nROOT_URLCONF='config.urls'\nMIDDLEWARE=[]\nINSTALLED_APPS=['django.contrib.staticfiles']\nDATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}\nSTATIC_URL='/static/'\nSTATIC_ROOT='/app/staticfiles'\n",
      "config/urls.py": "from django.urls import path\nfrom django.http import JsonResponse\ndef health(request):return JsonResponse({'status':'ok'})\ndef fail(request):return JsonResponse({'status':'failed'},status=500)\nurlpatterns=[path('health',health,name='health'),path('fail',fail,name='fail')]\n",
      "config/wsgi.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')\nfrom django.core.wsgi import get_wsgi_application\napplication=get_wsgi_application()\n",
    },
  },
  {
    name: "node-postgres-aliases",
    expectedFramework: "express",
    expectedHealth: "/health",
    database: "postgres",
    aliases: {
      runtime: { POSTGRES_HOST: postgresRuntime.host, POSTGRES_PORT: postgresRuntime.port, POSTGRES_DB: postgresRuntime.name, POSTGRES_USER: postgresRuntime.user },
      secret: { POSTGRES_PASSWORD: "password" },
    },
    files: {
      "package.json": packageJson({ express: "5.1.0", pg: "8.16.3" }, { start: "node server.js" }),
      "server.js": `${requiredHelper}\nconst{Client}=require('pg');const express=require('express');async function main(){const client=new Client({host:required('POSTGRES_HOST'),port:Number(required('POSTGRES_PORT')),database:required('POSTGRES_DB'),user:required('POSTGRES_USER'),password:required('POSTGRES_PASSWORD'),connectionTimeoutMillis:1500});await client.connect();await client.query('select 1');const app=express();app.get('/health',(_,r)=>r.json({status:'ok'}));app.get('/fail',(_,r)=>r.status(500).json({status:'failed'}));app.listen(Number(process.env.PORT),'0.0.0.0')}main().catch(e=>{console.error(e.message);process.exit(1)})`,
    },
  },
  {
    name: "node-mongo-uri",
    expectedFramework: "express",
    expectedHealth: "/health",
    database: "mongodb",
    aliases: { runtime: {}, secret: { MONGO_URI: "url" } },
    files: {
      "package.json": packageJson({ express: "5.1.0", mongodb: "6.19.0" }, { start: "node server.js" }),
      "server.js": `${requiredHelper}\nconst{MongoClient}=require('mongodb');const express=require('express');async function main(){const client=new MongoClient(required('MONGO_URI'),{serverSelectionTimeoutMS:1500});await client.connect();await client.db().command({ping:1});const app=express();app.get('/health',(_,r)=>r.json({status:'ok'}));app.get('/fail',(_,r)=>r.status(500).json({status:'failed'}));app.listen(Number(process.env.PORT),'0.0.0.0')}main().catch(e=>{console.error(e.message);process.exit(1)})`,
    },
  },
  {
    name: "express-ready",
    expectedFramework: "express",
    expectedHealth: "/ready",
    files: {
      "package.json": packageJson({ express: "5.1.0" }, { start: "node server.js" }),
      "server.js": "const express=require('express');const app=express();app.get('/ready',(_,r)=>r.json({ready:true}));app.get('/fail',(_,r)=>r.status(500).json({ready:false}));app.listen(Number(process.env.PORT),'0.0.0.0')",
    },
  },
  {
    name: "express-typescript-ready",
    expectedFramework: "express",
    expectedHealth: "/health",
    files: {
      "package.json": packageJson({ express: "5.1.0", typescript: "5.8.3", "@types/node": "22.15.30", "@types/express": "5.0.3" }, { build: "tsc -p tsconfig.json", start: "node dist/server.js" }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", outDir: "dist", esModuleInterop: true, strict: true, skipLibCheck: true }, include: ["server.ts"] }),
      "server.ts": "import express from 'express';const app=express();app.get('/health',(_,r)=>r.json({status:'ok'}));app.get('/fail',(_,r)=>r.status(500).json({status:'failed'}));app.listen(Number(process.env.PORT),'0.0.0.0')",
    },
  },
  {
    name: "fastify-javascript-ready",
    expectedFramework: "fastify",
    expectedHealth: "/health",
    files: {
      "package.json": packageJson({ fastify: "5.4.0" }, { start: "node server.js" }),
      "server.js": "const app=require('fastify')();app.get('/health',async()=>({status:'ok'}));app.get('/fail',async(_,r)=>r.code(500).send({status:'failed'}));app.listen({port:Number(process.env.PORT),host:'0.0.0.0'})",
    },
  },
  {
    name: "fastify-typescript-ready",
    expectedFramework: "fastify",
    expectedHealth: "/health",
    files: {
      "package.json": packageJson({ fastify: "5.4.0", typescript: "5.8.3", "@types/node": "22.15.30" }, { build: "tsc -p tsconfig.json", start: "node dist/server.js" }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "commonjs", outDir: "dist", esModuleInterop: true, strict: true, skipLibCheck: true }, include: ["server.ts"] }),
      "server.ts": "import Fastify from 'fastify';const app=Fastify();app.get('/health',async()=>({status:'ok'}));app.get('/fail',async(_,r)=>r.code(500).send({status:'failed'}));app.listen({port:Number(process.env.PORT),host:'0.0.0.0'})",
    },
  },
  {
    name: "flask-factory-ready",
    expectedFramework: "flask",
    expectedHealth: "/health",
    files: {
      "requirements.txt": "Flask==3.1.0\ngunicorn==23.0.0\n",
      "app.py": "from flask import Flask\ndef create_app():\n app=Flask(__name__)\n @app.get('/health')\n def health():return {'status':'ok'}\n @app.get('/fail')\n def fail():return {'status':'failed'},500\n return app\n",
    },
  },
  {
    name: "fastapi-nested-module-ready",
    expectedFramework: "fastapi",
    expectedHealth: "/health",
    files: {
      "requirements.txt": "fastapi==0.116.0\nuvicorn==0.35.0\n",
      "service/main.py": "from fastapi import FastAPI\napp=FastAPI()\n@app.get('/health')\ndef health():return {'status':'ok'}\n@app.get('/fail')\ndef fail():return FastAPI().response_class(status_code=500)\n",
    },
  },
  {
    name: "django-asgi-ready",
    expectedFramework: "django",
    expectedHealth: "/health",
    configured: [
      { key: "APP_ENV", value: "test", isSecret: false, isActive: true },
      { key: "SECRET_KEY", value: "encrypted", isSecret: true, isActive: true },
    ],
    files: {
      "requirements.txt": "Django==5.2.0\nuvicorn==0.35.0\n",
      "manage.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')\nfrom django.core.management import execute_from_command_line\nexecute_from_command_line()\n",
      "config/__init__.py": "",
      "config/settings.py": "import os\nSECRET_KEY=os.environ['SECRET_KEY']\nAPP_ENV=os.environ['APP_ENV']\nDEBUG=False\nALLOWED_HOSTS=['*']\nROOT_URLCONF='config.urls'\nMIDDLEWARE=[]\nINSTALLED_APPS=['django.contrib.staticfiles']\nSTATIC_URL='/static/'\nDATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':':memory:'}}\n",
      "config/urls.py": "from django.urls import path\nfrom django.http import JsonResponse\ndef health(request):return JsonResponse({'status':'ok'})\ndef fail(request):return JsonResponse({'status':'failed'},status=500)\nurlpatterns=[path('health',health),path('fail',fail)]\n",
      "config/asgi.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')\nfrom django.core.asgi import get_asgi_application\napplication=get_asgi_application()\n",
    },
  },
  {
    name: "streamlit-ready",
    expectedFramework: "streamlit",
    expectedHealth: "/_stcore/health",
    files: {
      "requirements.txt": "streamlit==1.47.0\n",
      "app.py": "import streamlit as st\nst.write('deployguard-certified')\n",
    },
  },
  {
    name: "node-pg-native-aliases",
    expectedFramework: "express",
    expectedHealth: "/health",
    database: "postgres",
    aliases: {
      runtime: { PGHOST: postgresRuntime.host, PGPORT: postgresRuntime.port, PGDATABASE: postgresRuntime.name, PGUSER: postgresRuntime.user },
      secret: { PGPASSWORD: "password" },
    },
    files: {
      "package.json": packageJson({ express: "5.1.0", pg: "8.16.3" }, { start: "node server.js" }),
      "server.js": `${requiredHelper}\nrequired('PGHOST');required('PGPORT');required('PGDATABASE');required('PGUSER');required('PGPASSWORD');const{Client}=require('pg');const express=require('express');async function main(){const client=new Client({connectionTimeoutMillis:1500});await client.connect();await client.query('select 1');const app=express();app.get('/health',(_,r)=>r.json({status:'ok'}));app.get('/fail',(_,r)=>r.status(500).json({status:'failed'}));app.listen(Number(process.env.PORT),'0.0.0.0')}main().catch(e=>{console.error(e.message);process.exit(1)})`,
    },
  },
];

const repository = resolve(__dirname, "../..");
const workflow = join(repository, ".github/workflows/deployguard-reusable.yml");
const suiteRoot = mkdtempSync(join(tmpdir(), "deployguard-certification-part2-"));
const preflightScript = join(suiteRoot, "executable-preflight.sh");
const images: string[] = [];
let runSequence = 0;

function writeTree(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function extractPreflight() {
  execFileSync("python3", ["-c", [
    "import sys,yaml",
    "doc=yaml.safe_load(open(sys.argv[1]))",
    "step=next(x for x in doc['jobs']['deploy']['steps'] if x.get('name')=='Execute immutable application contract before AWS mutation')",
    "open(sys.argv[2],'w').write(step['run'])",
  ].join(";"), workflow, preflightScript]);
  execFileSync("bash", ["-n", preflightScript]);
}

async function analyze(fixture: Fixture, files = fixture.files, configured = fixture.configured || []) {
  const root = mkdtempSync(join(suiteRoot, `${fixture.name}-`));
  writeTree(root, files);
  const project: any = {
    id: "51515151-5151-4151-8151-515151515151",
    repositoryUrl: `https://github.com/fixture/${fixture.name}`,
    repositoryFullName: `fixture/${fixture.name}`,
    targetBranch: "main",
    appDirectory: null,
    deploymentOverrides: {},
  };
  const detector = new StackDetectionService(new TemplateMatchingService(), new RepoDeployabilityScannerService());
  const draft = detector.detect(root, "c".repeat(40));
  draft.rawProfile.inputFingerprintVersion = DETECTION_INPUT_FINGERPRINT_VERSION;
  const profile: any = {
    id: "52525252-5252-4252-8252-525252525252",
    projectId: project.id,
    repositoryUrl: project.repositoryUrl,
    repositoryFullName: project.repositoryFullName,
    targetBranch: project.targetBranch,
    inputFingerprint: detectionFingerprint(project, draft.commitSha),
    ...draft,
  };
  let persisted: any = null;
  const docker = new DockerTemplateEngineService();
  const contracts = new DeploymentContractService(
    {
      findOne: async () => persisted,
      create: (value: any) => ({ id: "53535353-5353-4353-8353-535353535353", ...value }),
      save: async (value: any) => { persisted = value; return value; },
    } as any,
    {} as any,
    {} as any,
    { find: async () => configured } as any,
    { findOne: async () => null, create: (value: any) => value, save: async (value: any) => value } as any,
    new TemplateRegistryService(),
    docker,
    { get: (_key: string, fallback: unknown) => fallback } as any,
  );
  const contract = await contracts.upsertFromDetection(project, profile);
  return { root, draft, contract, docker };
}

function managedDatabase(fixture: Fixture) {
  if (!fixture.database || !fixture.aliases) return null;
  const profile = fixture.database === "postgres" ? postgresRuntime : mongoRuntime;
  return {
    bindingId: "54545454-5454-4454-8454-545454545454",
    engine: fixture.database,
    host: profile.host,
    port: Number(profile.port),
    databaseName: profile.name,
    databaseUser: profile.user,
    runtimeAliases: fixture.aliases.runtime,
    secretAliases: fixture.aliases.secret,
    urlScheme: fixture.database === "postgres" ? "postgresql" : "mongodb",
    urlQuery: fixture.database === "mongodb" ? "?authSource=admin" : "",
  };
}

function runtimeConfiguration(fixture: Fixture) {
  const environment = Object.fromEntries((fixture.configured || [])
    .filter((item) => !item.isSecret)
    .map((item) => [item.key, item.value]));
  const secretReferences = Object.fromEntries((fixture.configured || [])
    .filter((item) => item.isSecret)
    .map((item) => [item.key, `arn:aws:secretsmanager:us-east-1:123456789012:secret:part2:${item.key}::`]));
  return { environment, secretReferences, managedDatabase: managedDatabase(fixture) };
}

function componentImages(components: BuildPlanComponent[], image: string) {
  return components.map((component) => ({
    id: component.id,
    role: component.role,
    imageUri: image,
    port: component.port,
    healthPath: component.healthPath,
    healthCheckMode: component.healthCheckMode || "http",
    environmentOwnership: component.environmentOwnership,
  }));
}

function buildImage(root: string, dockerfile: string, image: string, fixture: Fixture) {
  writeFileSync(join(root, "Dockerfile"), dockerfile);
  writeFileSync(join(root, ".dockerignore"), ".git\n.env\n.env.*\nnode_modules\n__pycache__\n");
  const argumentsList = ["buildx", "build", "--load", "-t", image];
  if (dockerfile.includes("deployguard_runtime_config")) {
    const buildConfiguration = join(root, "deployguard-build-runtime.json");
    writeFileSync(buildConfiguration, JSON.stringify({
      APP_ENV: "certification",
      SECRET_KEY: "ephemeral-build-only-secret",
      DB_HOST: "deployguard-build-init.invalid",
      DB_PORT: "5432",
      DB_NAME: "deployguard_build_init",
      DB_USER: "deployguard_build_init",
      DB_PASSWORD: "deployguard-build-init-placeholder",
    }), { mode: 0o600 });
    argumentsList.push("--secret", `id=deployguard_runtime_config,src=${buildConfiguration}`);
  }
  argumentsList.push(root);
  execFileSync("docker", argumentsList, { stdio: "inherit", timeout: 360_000 });
  images.push(image);
  const history = execFileSync("docker", ["history", "--no-trunc", image], { encoding: "utf8", timeout: 30_000 });
  assert.doesNotMatch(history, /ephemeral-build-only-secret|deployguard_preflight_password/);
  const user = execFileSync("docker", ["image", "inspect", image, "--format", "{{.Config.User}}"], { encoding: "utf8" }).trim();
  assert.ok(user && user !== "0" && user !== "root", `${fixture.name}: final image must be non-root`);
}

function executePreflight(root: string, expectedPass: boolean, label: string) {
  runSequence += 1;
  const result = spawnSync("bash", [preflightScript], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    env: {
      ...process.env,
      OPERATION_ID: `11111111-1111-4111-8111-${String(runSequence).padStart(12, "0")}`,
      GITHUB_RUN_ID: `${process.pid}${runSequence}`,
      RUNNER_TEMP: root,
      DEPLOYGUARD_PREFLIGHT_ATTEMPTS: expectedPass ? "20" : "3",
    },
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (expectedPass) {
    assert.equal(result.status, 0, `${label}\n${output}`);
    assert.match(output, /Executable immutable application contract passed before persistence and Terraform/);
  } else {
    assert.notEqual(result.status, 0, `${label}: mutation unexpectedly passed`);
    assert.match(output, /EXECUTABLE_PREFLIGHT_FAILED|missing|required|failed|resolve|connect|ENOTFOUND|ECONN/i);
  }
  return output;
}

function writePreflightArtifacts(root: string, fixture: Fixture, plan: any, image: string, runtime = runtimeConfiguration(fixture), imagesOverride?: unknown) {
  mkdirSync(join(root, ".deployguard"), { recursive: true });
  const materialized = JSON.parse(JSON.stringify(runtime));
  materialized.environment = {
    AWS_DEFAULT_REGION: "us-east-1",
    AWS_REGION: "us-east-1",
    DEPLOYGUARD_APP_LOG_GROUP: "/deployguard/part2/application",
    DEPLOYGUARD_DATABASE_LOG_GROUP: "/deployguard/part2/database",
    DEPLOYGUARD_DEPLOYMENT_LOG_GROUP: "/deployguard/part2/deployment",
    DEPLOYGUARD_ENVIRONMENT: "dev",
    DEPLOYGUARD_OPERATION_ID: "11111111-1111-4111-8111-111111111111",
    DEPLOYGUARD_PROJECT_ID: "51515151-5151-4151-8151-515151515151",
    HOST: "0.0.0.0",
    NODE_ENV: "production",
    PORT: String(plan.components[0].port),
    ...(materialized.environment || {}),
  };
  writeFileSync(join(root, ".deployguard/build-plan.json"), JSON.stringify(plan));
  writeFileSync(join(root, ".deployguard/component-images.json"), JSON.stringify(imagesOverride || componentImages(plan.components, image)));
  writeFileSync(join(root, ".deployguard/runtime-config.json"), JSON.stringify(materialized));
}

async function staticNegativeCases() {
  const fastapi = fixtures.find((item) => item.name === "fastapi-health")!;
  const fastapiFiles = {
    ...fastapi.files,
    "main.py": "from fastapi import FastAPI\napp=FastAPI()\nDOCUMENTED_PATH='/health'\n",
  };
  const missingFastapi = await analyze(fastapi, fastapiFiles);
  assert.ok(["READY", "READY_WITH_WARNINGS"].includes(evaluateBuildPlanReadiness(missingFastapi.contract.buildPlan).status));
  const fastapiRuntime = missingFastapi.contract.buildPlan.components?.find((component: any) => component.role === "backend" || component.role === "application") || missingFastapi.contract.buildPlan;
  assert.deepEqual({ mode: fastapiRuntime.healthCheckMode, path: fastapiRuntime.healthPath }, { mode: "tcp", path: null });
  console.log("PASS FastAPI missing-health mutation uses TCP readiness without fabricating an HTTP endpoint");

  const django = fixtures.find((item) => item.name === "django-health")!;
  const missingDjango = await analyze(django, django.files, [{ key: "APP_ENV", value: "test", isSecret: false, isActive: true }]);
  assert.equal(evaluateBuildPlanReadiness(missingDjango.contract.buildPlan, { unresolvedRequiredValues: ["SECRET_KEY"] }).status, "INPUT_REQUIRED");
  console.log("PASS Django missing-required-ENV mutation requires input before executable preflight");

  const ready = fixtures.find((item) => item.name === "express-ready")!;
  const missingReady = await analyze(ready, { ...ready.files, "server.js": "const express=require('express');const app=express();app.listen(Number(process.env.PORT),'0.0.0.0')" });
  assert.ok(["READY", "READY_WITH_WARNINGS"].includes(evaluateBuildPlanReadiness(missingReady.contract.buildPlan).status));
  const expressRuntime = missingReady.contract.buildPlan.components?.find((component: any) => component.role === "backend" || component.role === "application") || missingReady.contract.buildPlan;
  assert.deepEqual({ mode: expressRuntime.healthCheckMode, path: expressRuntime.healthPath }, { mode: "tcp", path: null });
  console.log("PASS removed-/ready mutation uses TCP readiness without fabricating an HTTP endpoint");
}

async function main() {
  extractPreflight();
  await staticNegativeCases();
  for (const fixture of fixtures) {
    const analyzed = await analyze(fixture);
    const { contract, root, docker } = analyzed;
    const readiness = evaluateBuildPlanReadiness(contract.buildPlan);
    assert.ok(["READY", "READY_WITH_WARNINGS"].includes(readiness.status), `${fixture.name}: ${readiness.blockers.join(" | ")} / ${readiness.requiredInputs.join(",")}`);
    assert.equal(contract.deployable, true, `${fixture.name}: deployment contract`);
    assert.equal(contract.buildPlan.components?.length, 1, `${fixture.name}: bounded single component`);
    const component = contract.buildPlan.components![0];
    assert.equal(component.framework, fixture.expectedFramework, `${fixture.name}: detected framework`);
    assert.equal(component.healthPath, fixture.expectedHealth, `${fixture.name}: explicit readiness identity`);
    assert.equal(component.healthCheckMode, "http", `${fixture.name}: HTTP readiness mode`);
    if (fixture.database) assert.equal(component.database.engine, fixture.database, `${fixture.name}: managed database engine`);
    if (fixture.database && fixture.aliases) {
      const owned = new Map<string, (typeof component.environmentOwnership)[number]>(component.environmentOwnership.map((item) => [item.key, item]));
      for (const key of [...Object.keys(fixture.aliases.runtime), ...Object.keys(fixture.aliases.secret)]) {
        assert.equal(owned.get(key)?.source, "managed_database", `${fixture.name}: ${key} must remain an exact managed alias`);
      }
    }
    if (fixture.name === "vue-vite") {
      assert.equal(component.role, "frontend");
      assert.equal(component.outputDirectory, "dist");
      assert.equal(component.environmentOwnership.some((item) => item.secret), false);
    }
    if (fixture.name === "fastapi-health") {
      assert.equal(contract.buildPlan.relationships?.length, 0, "API prefix is not a frontend relationship");
      assert.equal(component.healthPath, "/health", "router prefix cannot replace health");
    }
    if (fixture.name === "node-pg-native-aliases") {
      const owned = new Map<string, (typeof component.environmentOwnership)[number]>(component.environmentOwnership.map((item) => [item.key, item]));
      for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) assert.ok(owned.has(key), `${key} exact alias`);
      assert.equal(owned.get("PGPASSWORD")?.secret, true);
      assert.notEqual(owned.get("PGPASSWORD")?.component, "frontend");
    }
    const generated = contract.generatedDockerfile;
    assert.equal(typeof generated, "string", `${fixture.name}: generated Dockerfile`);
    docker.validateGeneratedDockerfile(generated as string);
    const image = `deployguard-certification-part2:${process.pid}-${fixture.name}`;
    buildImage(root, generated as string, image, fixture);
    writePreflightArtifacts(root, fixture, contract.buildPlan, image);
    executePreflight(root, true, fixture.name);

    const imagesForMutation = componentImages(contract.buildPlan.components!, image);
    if (component.runtimeType === "server" && fixture.name !== "streamlit-ready") {
      const missingHealth = JSON.parse(JSON.stringify(imagesForMutation));
      missingHealth[0].healthPath = "/__missing_certification_health";
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, runtimeConfiguration(fixture), missingHealth);
      executePreflight(root, false, `${fixture.name} HTTP 404 readiness mutation`);
      const failingHealth = JSON.parse(JSON.stringify(imagesForMutation));
      failingHealth[0].healthPath = "/fail";
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, runtimeConfiguration(fixture), failingHealth);
      executePreflight(root, false, `${fixture.name} HTTP 500 readiness mutation`);
      const wrongPort = JSON.parse(JSON.stringify(imagesForMutation));
      wrongPort[0].port = component.port + 1;
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, runtimeConfiguration(fixture), wrongPort);
      executePreflight(root, false, `${fixture.name} wrong runtime port mutation`);
      console.log(`PASS ${fixture.name}: HTTP 404, HTTP 500, and wrong-port mutations fail executable preflight before Terraform`);
    }
    if (fixture.name === "streamlit-ready") {
      const wrongPort = JSON.parse(JSON.stringify(imagesForMutation));
      wrongPort[0].port = component.port + 1;
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, runtimeConfiguration(fixture), wrongPort);
      executePreflight(root, false, "Streamlit wrong runtime port mutation");
      console.log("PASS Streamlit wrong-port mutation fails executable preflight before Terraform");
    }
    if (fixture.name === "vue-vite") {
      const broken = JSON.parse(JSON.stringify(imagesForMutation));
      broken[0].healthPath = "/missing-output";
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, runtimeConfiguration(fixture), broken);
      executePreflight(root, false, "Vue bad output/runtime route mutation");
      console.log("PASS Vue bad-output mutation fails executable preflight before Terraform");
    }
    if (fixture.name === "flask-health") {
      const wrongPort = JSON.parse(JSON.stringify(imagesForMutation));
      wrongPort[0].port = component.port + 1;
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, runtimeConfiguration(fixture), wrongPort);
      executePreflight(root, false, "Flask wrong port mutation");
      console.log("PASS Flask wrong-port mutation fails executable preflight before Terraform");
    }
    if (fixture.name === "node-postgres-aliases") {
      const wrongHost = runtimeConfiguration(fixture) as any;
      wrongHost.managedDatabase.runtimeAliases.POSTGRES_HOST = "wrong-host.invalid";
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, wrongHost);
      executePreflight(root, false, "PostgreSQL wrong host mutation");
      console.log("PASS PostgreSQL wrong-host mutation fails executable preflight before Terraform");
      const wrongPort = runtimeConfiguration(fixture) as any;
      wrongPort.managedDatabase.runtimeAliases.POSTGRES_PORT = "6543";
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, wrongPort);
      executePreflight(root, false, "PostgreSQL wrong port mutation");
      console.log("PASS PostgreSQL wrong-port mutation fails executable preflight before Terraform");
      const wrongUser = runtimeConfiguration(fixture) as any;
      wrongUser.managedDatabase.runtimeAliases.POSTGRES_USER = "wrong_user";
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, wrongUser);
      executePreflight(root, false, "PostgreSQL wrong username alias mutation");
      const missingPassword = runtimeConfiguration(fixture) as any;
      delete missingPassword.managedDatabase.secretAliases.POSTGRES_PASSWORD;
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, missingPassword);
      executePreflight(root, false, "PostgreSQL missing password alias mutation");
      const missingDatabase = runtimeConfiguration(fixture) as any;
      missingDatabase.managedDatabase.runtimeAliases.POSTGRES_DB = "missing_database";
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, missingDatabase);
      executePreflight(root, false, "PostgreSQL missing database mutation");
      console.log("PASS PostgreSQL wrong-user, missing-password, and missing-database mutations fail before Terraform");
    }
    if (fixture.name === "node-mongo-uri") {
      const wrongUri = runtimeConfiguration(fixture) as any;
      wrongUri.managedDatabase.secretAliases = {};
      wrongUri.environment = { MONGO_URI: "mongodb://wrong-host.invalid:27017/certification" };
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, wrongUri);
      executePreflight(root, false, "MongoDB wrong URI mutation");
      console.log("PASS MongoDB wrong-URI mutation fails executable preflight before Terraform");
    }
    if (fixture.name === "express-ready") {
      const missingRoute = JSON.parse(JSON.stringify(imagesForMutation));
      missingRoute[0].healthPath = "/removed-ready";
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, runtimeConfiguration(fixture), missingRoute);
      executePreflight(root, false, "removed /ready runtime mutation");
      console.log("PASS removed-/ready runtime mutation fails executable preflight before Terraform");
    }
    if (fixture.name === "node-pg-native-aliases") {
      const missingAlias = runtimeConfiguration(fixture) as any;
      delete missingAlias.managedDatabase.runtimeAliases.PGUSER;
      writePreflightArtifacts(root, fixture, contract.buildPlan, image, missingAlias);
      executePreflight(root, false, "missing PGUSER mutation");
      console.log("PASS missing-PGUSER mutation fails executable preflight before Terraform");
    }
    writePreflightArtifacts(root, fixture, contract.buildPlan, image);
    console.log(`PASS ${fixture.name}: detection -> BuildPlan -> generated image -> non-root runtime -> executable preflight`);
  }
  const workflowSource = readFileSync(workflow, "utf8");
  assert.ok(workflowSource.indexOf("Execute immutable application contract before AWS mutation") < workflowSource.indexOf("Terraform plan and apply"));
  console.log(`Part 2 runtime certification passed with ${fixtures.length} real generated images and ${fixtures.length} positive executable container runs; Terraform was not executed.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  for (const image of images) spawnSync("docker", ["image", "rm", "-f", image], { stdio: "ignore" });
  rmSync(suiteRoot, { recursive: true, force: true });
});
