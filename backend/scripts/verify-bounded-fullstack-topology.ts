import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { StackDetectionService, DetectedApplicationTopology } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { BuildPlan, BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { buildPlanWorkflowInputs } from "../src/projects/github-actions-operation-contract";

const detector = () => new StackDetectionService(new TemplateMatchingService(), new RepoDeployabilityScannerService());

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "deployguard-fullstack-"));
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

const frontend = {
  "Frontend/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
  "Frontend/package-lock.json": "{}",
  "Frontend/src/App.jsx": "export async function health(){ return fetch('/api/health'); }",
};
const express = (root = "Backend", dependencies: Record<string, string> = {}) => ({
  [`${root}/package.json`]: JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "4.21.0", ...dependencies } }),
  [`${root}/package-lock.json`]: "{}",
  [`${root}/server.js`]: "const express=require('express'); const app=express(); app.get('/health',(_,r)=>r.send('ok')); app.listen(process.env.PORT||3000,'0.0.0.0');",
});
const nextSsr = (root = "Frontend") => ({
  [`${root}/package.json`]: JSON.stringify({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "15.0.0", react: "19.0.0" } }),
  [`${root}/package-lock.json`]: "{}",
  [`${root}/app/page.jsx`]: "export default function Page(){ return <main>DeployGuard</main>; }",
});

async function detect(files: Record<string, string>) {
  const root = await fixture(files);
  try {
    const profile = detector().detect(root, "a".repeat(40));
    return profile.rawProfile.componentTopology as DetectedApplicationTopology;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const nextExpressMongo = await detect({
    ...nextSsr(),
    ...express("Backend", { mongoose: "8.6.0" }),
    "Backend/server.js": "const mongoose=require('mongoose'); const express=require('express'); const app=express(); mongoose.connect(process.env.MONGODB_URI); app.get('/health',(_,r)=>r.send('ok')); app.listen(process.env.PORT||5000,'0.0.0.0');",
  });
  assert.equal(nextExpressMongo.status, "supported", nextExpressMongo.blockers.join(" | "));
  assert.equal(nextExpressMongo.analysisState, "SUPPORTED");
  assert.deepEqual(nextExpressMongo.components.map((item) => [item.role, item.framework, item.runtimeType]), [
    ["frontend", "nextjs", "server"], ["backend", "express", "server"],
  ], "a proven SSR web service may be the bounded frontend beside one backend");
  assert.deepEqual(nextExpressMongo.managedDatabase, { engine: "mongodb", ownerComponentId: "backend" });

  const nextSsrPostgres = await detect({
    ...nextSsr("."),
    ".env.example": "DB_HOST=localhost\nDB_PORT=5432\nDB_NAME=Smart\nDB_USER=postgres\nDB_PASSWORD=local-only\nJWT_SECRET=replace-me\n",
    "src/lib/db.js": "const { Client }=require('pg'); module.exports=()=>new Client({host:process.env.DB_HOST,database:process.env.DB_NAME,user:process.env.DB_USER,password:process.env.DB_PASSWORD});",
    "middleware.js": "if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET required');",
    "package.json": JSON.stringify({ scripts: { build: "next build", start: "next start" }, dependencies: { next: "15.0.0", react: "19.0.0", pg: "8.12.0" } }),
  });
  assert.equal(nextSsrPostgres.status, "supported", nextSsrPostgres.blockers.join(" | "));
  assert.equal(nextSsrPostgres.shape, "SSR_APPLICATION", "a database-backed SSR frontend is an application runtime, not a static frontend");
  assert.deepEqual(nextSsrPostgres.managedDatabase, { engine: "postgres", ownerComponentId: "frontend" });

  const nextExpressMissingSecrets = await detect({
    ...nextSsr(),
    ...express("Backend", { mongoose: "8.6.0" }),
    "Backend/server.js": "const mongoose=require('mongoose'); const express=require('express'); if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET required'); if (!process.env.CLOUDINARY_API_KEY) throw new Error('CLOUDINARY_API_KEY required'); if (!process.env.CLOUDINARY_API_SECRET) throw new Error('CLOUDINARY_API_SECRET required'); if (!process.env.CLOUDINARY_CLOUD_NAME) throw new Error('CLOUDINARY_CLOUD_NAME required'); const app=express(); mongoose.connect(process.env.MONGODB_URI); app.get('/health',(_,r)=>r.send('ok')); app.listen(process.env.PORT||5000,'0.0.0.0');",
  });
  assert.equal(nextExpressMissingSecrets.status, "supported", "missing application configuration is not a topology blocker");
  const missingSecretKeys = (nextExpressMissingSecrets.components.find((item) => item.role === "backend")?.profile.rawProfile.requiredEnvironmentVariables || []) as string[];
  assert.deepEqual(missingSecretKeys.filter((key) => key === "JWT_SECRET" || key.startsWith("CLOUDINARY_")).sort(), [
    "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET", "CLOUDINARY_CLOUD_NAME", "JWT_SECRET",
  ]);
  assert.equal(evaluateBuildPlanReadiness({ blockers: [], warnings: [], requiredUserInputs: missingSecretKeys } as BuildPlan).status, "INPUT_REQUIRED");

  const reactExpress = await detect({ ...frontend, ...express() });
  assert.equal(reactExpress.status, "supported");
  assert.deepEqual(reactExpress.components.map((item) => [item.role, item.root]), [["frontend", "Frontend"], ["backend", "Backend"]]);
  assert.equal(reactExpress.components.find((item) => item.role === "frontend")?.healthCheckPath, "/");
  const reactExpressCall = reactExpress.relationships.find((item) => item.kind === "CALLS");
  assert.deepEqual(reactExpressCall && { ...reactExpressCall, evidence: undefined }, {
    from: "frontend", to: "backend", kind: "CALLS", evidence: undefined, mode: "same-origin", pathPrefix: "/api",
    stripPathPrefix: true, buildTimeVariable: null, verificationPath: "/api/health",
  });

  const preservedPrefix = await detect({
    ...frontend,
    "Backend/package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "4.21.0" } }),
    "Backend/package-lock.json": "{}",
    "Backend/server.js": "const express=require('express'); const app=express(); app.get('/api/health',(_,r)=>r.send('ok')); app.get('/api/tasks',(_,r)=>r.json([])); app.listen(process.env.PORT||3000,'0.0.0.0');",
  });
  const preservedCall = preservedPrefix.relationships.find((item) => item.kind === "CALLS");
  assert.equal(preservedCall?.stripPathPrefix, false);
  assert.equal(preservedCall?.verificationPath, "/api/health");

  const djangoIncludedRoutes = await detect({
    "client/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { axios: "1.7.0", react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
    "client/package-lock.json": "{}",
    "client/src/api.js": "const api=axios.create({baseURL:import.meta.env.VITE_API_BASE_URL}); export const events=()=>api.get('api/get-events/');",
    "server/requirements.txt": "Django==5.1.1\ndjango-environ==0.11.2\npsycopg2-binary==2.9.9\n",
    "server/manage.py": "",
    "server/server/wsgi.py": "application = object()",
    "server/server/settings.py": "ROOT_URLCONF = 'server.urls'\n",
    "server/server/urls.py": "from django.urls import include,path\nurlpatterns=[path('api/',include('crud.urls'))]\n",
    "server/crud/urls.py": "from django.urls import path\nfrom .views import get_events\nurlpatterns=[path('get-events/',get_events)]\n",
    "server/crud/views.py": "from rest_framework.decorators import api_view\n@api_view(['GET'])\ndef get_events(request): return None\n",
  });
  assert.equal(djangoIncludedRoutes.status, "supported", djangoIncludedRoutes.blockers.join(" | "));
  const djangoCall = djangoIncludedRoutes.relationships.find((item) => item.kind === "CALLS");
  assert.equal(djangoCall?.verificationPath, null, "a proven router path is not automatically a safe unauthenticated GET probe");
  assert.equal(djangoCall?.stripPathPrefix, false, "the backend owns the /api prefix");
  assert.equal(djangoCall?.mode, "same-origin", "a relative api/... request already owns the public prefix");
  assert.equal(djangoCall?.buildTimeVariable, "VITE_API_BASE_URL", "the relationship still owns the repository's public API base variable");
  const djangoBackend = djangoIncludedRoutes.components.find((item) => item.role === "backend");
  assert.equal(djangoBackend?.healthCheckMode, "tcp", "routing evidence must not become HTTP health evidence");
  assert.equal(djangoBackend?.healthCheckPath, null, "TCP-only readiness must not fabricate a root health path");

  const versionedApi = await detect({
    "frontend/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
    "frontend/package-lock.json": "{}",
    "frontend/src/api.js": "const api=axios.create({baseURL:import.meta.env.VITE_API_BASE_URL}); export const list=()=>api.get('/api/v1');",
    "backend/requirements.txt": "fastapi==0.115.0\nuvicorn==0.30.0\n",
    "backend/app/main.py": "from fastapi import FastAPI,APIRouter\napp=FastAPI()\nr=APIRouter(prefix='/api/v1')\napp.include_router(r)\n@app.get('/health')\ndef health(): return {'ok':True}\n",
  });
  const versionedCall = versionedApi.relationships.find((item) => item.kind === "CALLS");
  assert.equal(versionedCall?.pathPrefix, "/api/v1", "the complete evidenced API pathname must be preserved");
  assert.equal(versionedCall?.stripPathPrefix, false);
  assert.equal(versionedCall?.verificationPath, null, "an API router prefix is not a health endpoint");
  assert.equal(versionedApi.components.find((item) => item.role === "backend")?.healthCheckPath, "/health");

  const configuredVersionedApi = await detect({
    "frontend/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { axios: "1.7.0", react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
    "frontend/package-lock.json": "{}",
    "frontend/.env.example": "VITE_API_BASE_URL=http://localhost:8000/api/v1\n",
    "frontend/src/api.js": "const api=axios.create({baseURL:import.meta.env.VITE_API_BASE_URL}); export const list=()=>api.get('/expenses');",
    "backend/requirements.txt": "fastapi==0.115.0\nuvicorn==0.30.0\n",
    "backend/app/main.py": "from fastapi import FastAPI\napp=FastAPI()\n@app.get('/api/v1/expenses')\ndef expenses(): return []\n@app.get('/health')\ndef health(): return {'ok':True}\n",
  });
  const configuredCall = configuredVersionedApi.relationships.find((item) => item.kind === "CALLS");
  assert.equal(configuredCall?.pathPrefix, "/api/v1", "a local developer origin is replaced while its complete pathname is preserved");
  assert.equal(configuredCall?.stripPathPrefix, false);
  assert.equal(configuredCall?.verificationPath, "/api/v1/expenses", "only a proven concrete GET route may become relationship verification evidence");
  assert.deepEqual(configuredVersionedApi.serviceBindings, [{
    sourceComponent: "frontend", envAlias: "VITE_API_BASE_URL", targetComponent: "backend", bindingMode: "platform-proxy",
    preservedPathname: "/api/v1", platformPathPrefix: "/__deployguard/backend",
  }], "a matching localhost development URL becomes a deterministic platform binding without application rewrite inference");

  const reactFastApiPostgres = await detect({
    "frontend/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { axios: "1.7.0", react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
    "frontend/package-lock.json": "{}",
    "frontend/.env.example": "VITE_API_BASE_URL=http://localhost:8000/api/v1\n",
    "frontend/src/api.js": "const api=axios.create({baseURL:import.meta.env.VITE_API_BASE_URL}); export const list=()=>api.get('/expenses');",
    "backend/requirements.txt": "fastapi==0.115.0\nuvicorn==0.30.0\npsycopg[binary]==3.2.1\n",
    "backend/app/main.py": "import os\nfrom fastapi import FastAPI\nDATABASE_URL=os.environ.get('DATABASE_URL')\napp=FastAPI()\n@app.get('/api/v1/expenses')\ndef expenses(): return []\n@app.get('/health')\ndef health(): return {'ok':True}\n",
  });
  assert.equal(reactFastApiPostgres.status, "supported", reactFastApiPostgres.blockers.join(" | "));
  assert.deepEqual(reactFastApiPostgres.managedDatabase, { engine: "postgres", ownerComponentId: "backend" }, "React + FastAPI + PostgreSQL retains backend database ownership");
  assert.deepEqual(reactFastApiPostgres.serviceBindings, [{
    sourceComponent: "frontend", envAlias: "VITE_API_BASE_URL", targetComponent: "backend", bindingMode: "platform-proxy",
    preservedPathname: "/api/v1", platformPathPrefix: "/__deployguard/backend",
  }], "React + FastAPI + PostgreSQL keeps the exact application API path");

  const reactExpressMongo = await detect({
    "frontend/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
    "frontend/package-lock.json": "{}",
    "frontend/.env.example": "VITE_API_BASE_URL=http://localhost:4000/v1\n",
    "frontend/src/api.js": "export const api=import.meta.env.VITE_API_BASE_URL;",
    "backend/package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "4.21.0", mongoose: "8.6.0" } }),
    "backend/package-lock.json": "{}",
    "backend/server.js": "const mongoose=require('mongoose'); const express=require('express'); const app=express(); mongoose.connect(process.env.MONGODB_URI); app.get('/v1/health',(_,r)=>r.send('ok')); app.listen(process.env.PORT||4000,'0.0.0.0');",
  });
  assert.equal(reactExpressMongo.status, "supported", reactExpressMongo.blockers.join(" | "));
  assert.deepEqual(reactExpressMongo.managedDatabase, { engine: "mongodb", ownerComponentId: "backend" }, "React + Express + MongoDB retains backend database ownership");
  assert.deepEqual(reactExpressMongo.serviceBindings, [{
    sourceComponent: "frontend", envAlias: "VITE_API_BASE_URL", targetComponent: "backend", bindingMode: "platform-proxy",
    preservedPathname: "/v1", platformPathPrefix: "/__deployguard/backend",
  }], "React + Express + MongoDB preserves /v1 exactly");

  for (const [developmentUrl, preservedPathname] of [
    ["http://localhost:8000/api/v1", "/api/v1"],
    ["http://localhost:8000/v1", "/v1"],
    ["http://localhost:8000/graphql", "/graphql"],
    ["http://localhost:8000", null],
  ] as const) {
    const bound = await detect({
      "frontend/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
      "frontend/package-lock.json": "{}",
      "frontend/.env.example": `VITE_API_BASE_URL=${developmentUrl}\n`,
      "frontend/src/api.js": "export const api=import.meta.env.VITE_API_BASE_URL;",
      "backend/requirements.txt": "fastapi==0.115.0\nuvicorn==0.30.0\n",
      "backend/main.py": "from fastapi import FastAPI\napp=FastAPI()\n",
    });
    assert.deepEqual(bound.serviceBindings, [{
      sourceComponent: "frontend", envAlias: "VITE_API_BASE_URL", targetComponent: "backend", bindingMode: "platform-proxy",
      preservedPathname, platformPathPrefix: "/__deployguard/backend",
    }], `${developmentUrl}: only the platform mount is stripped and the application pathname is exact`);
  }

  const externalPublicUrl = await detect({
    "frontend/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
    "frontend/package-lock.json": "{}",
    "frontend/.env.example": "VITE_API_BASE_URL=https://api.external-example.com/v1\n",
    "frontend/src/api.js": "export const api=import.meta.env.VITE_API_BASE_URL;",
    "backend/requirements.txt": "fastapi==0.115.0\nuvicorn==0.30.0\n",
    "backend/main.py": "from fastapi import FastAPI\napp=FastAPI()\n",
  });
  assert.equal(externalPublicUrl.status, "supported");
  assert.deepEqual(externalPublicUrl.serviceBindings, [], "an external public URL is never rebound to a repository backend");

  const unselectedBackend = await detect({
    "frontend/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
    "frontend/package-lock.json": "{}",
    "frontend/.env.example": "VITE_API_BASE_URL=http://localhost:4000/api/v1\n",
    "frontend/src/api.js": "export const api=import.meta.env.VITE_API_BASE_URL;",
    "backend/requirements.txt": "fastapi==0.115.0\nuvicorn==0.30.0\n",
    "backend/main.py": "from fastapi import FastAPI\napp=FastAPI()\n",
  });
  assert.equal(unselectedBackend.analysisState, "INPUT_REQUIRED");
  assert.deepEqual(unselectedBackend.requiredUserInputs, ["Choose the backend service for VITE_API_BASE_URL."]);

  for (const pathPrefix of ["/v1", "/graphql"]) {
    const routed = await detect({
      "Frontend/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
      "Frontend/package-lock.json": "{}",
      "Frontend/src/App.jsx": `export const load=()=>fetch('${pathPrefix}')`,
      ...express("Backend"),
      "Backend/server.js": `const express=require('express'); const app=express(); app.get('${pathPrefix}',(_,r)=>r.send('ok')); app.listen(process.env.PORT||3000,'0.0.0.0');`,
    });
    const call = routed.relationships.find((item) => item.kind === "CALLS");
    assert.equal(call?.pathPrefix, pathPrefix, `${pathPrefix} must not be rewritten to a universal /api prefix`);
    assert.equal(call?.stripPathPrefix, false);
  }

  const ambiguousRewrite = await detect({
    "Frontend/package.json": JSON.stringify({ scripts: { build: "vite build" }, dependencies: { react: "18.3.1" }, devDependencies: { vite: "5.4.0" } }),
    "Frontend/package-lock.json": "{}",
    "Frontend/src/App.jsx": "export const load=()=>fetch('/api/v1/users')",
    "Backend/package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "4.21.0" } }),
    "Backend/package-lock.json": "{}",
    "Backend/server.js": "const express=require('express'); const app=express(); app.use('/api/v1',()=>{}); app.get('/v1/users',(_,r)=>r.send('ok')); app.listen(process.env.PORT||3000,'0.0.0.0');",
  });
  assert.equal(ambiguousRewrite.status, "supported", "ambiguous application rewrite semantics are optional evidence, not a deployment blocker");

  const publicApiKey = await detect({
    ...frontend,
    "Frontend/src/Weather.jsx": "const key=import.meta.env.VITE_WEATHER_API_KEY; export const load=()=>fetch('/api/weather?key='+key);",
    ...express(),
  });
  const publicApiCall = publicApiKey.relationships.find((item) => item.kind === "CALLS");
  assert.equal(publicApiCall?.mode, "same-origin");
  assert.equal(publicApiCall?.buildTimeVariable, null, "a public API credential must not be repurposed as the backend URL");

  const python = await detect({
    ...frontend,
    "Backend/requirements.txt": "flask==3.0.0\ngunicorn==22.0.0\n",
    "Backend/app.py": "from flask import Flask\napp=Flask(__name__)\n@app.get('/health')\ndef health(): return 'ok'\n",
  });
  assert.equal(python.components.find((item) => item.role === "backend")?.framework, "flask");

  const mongo = await detect({ ...frontend, ...express("Backend", { mongoose: "8.6.0" }) });
  assert.deepEqual(mongo.managedDatabase, { engine: "mongodb", ownerComponentId: "backend" });
  assert.equal(mongo.components.find((item) => item.role === "frontend")?.databaseType, null);

  const library = await detect({
    "Frontend/index.html": "<link rel=\"stylesheet\" href=\"css/app.css\"><script src=\"Js/app.js\"></script>",
    "Frontend/css/app.css": "body{}",
    "Frontend/Js/app.js": "fetch('/api/health')",
    ...express("Backend", { mongoose: "8.6.0" }),
  });
  assert.equal(library.status, "supported");
  assert.equal(library.components.find((item) => item.role === "frontend")?.framework, "static-web");
  assert.equal(library.managedDatabase?.engine, "mongodb");

  const single = await detect(express("."));
  assert.equal(single.status, "supported");
  assert.equal(single.components.length, 1);

  const sameRootMonolith = await detect({
    "package.json": JSON.stringify({ scripts: { build: "vite build", start: "node server.js" }, dependencies: { react: "18.3.1", express: "4.21.0" }, devDependencies: { vite: "5.4.0" } }),
    "package-lock.json": "{}",
    "src/App.jsx": "export const App=()=>null",
    "server.js": "const path=require('path'); const express=require('express'); const app=express(); const web=path.join(__dirname, 'dist'); app.use(express.static(web)); app.get('/api/health',(_,r)=>r.send('ok')); app.listen(process.env.PORT||3000,'0.0.0.0');",
  });
  assert.equal(sameRootMonolith.status, "supported", sameRootMonolith.blockers.join(" | "));
  assert.equal(sameRootMonolith.shape, "MONOLITH_SERVES_FRONTEND");
  assert.equal(sameRootMonolith.components.length, 1);
  assert.equal(sameRootMonolith.components[0].framework, "express");
  assert.ok(sameRootMonolith.relationships.some((item) => item.kind === "SERVES"));
  assert.ok(sameRootMonolith.artifacts.some((item) => item.path === "dist"));

  const complex = await detect({ ...frontend, ...express("BackendA"), ...express("BackendB") });
  assert.equal(complex.status, "supported");
  assert.equal(complex.analysisState, "INPUT_REQUIRED");
  assert.deepEqual(complex.requiredUserInputs, ["Choose which of these backend service roots should be deployed."]);

  const unsupportedWorker = await detect({
    ...nextSsr(),
    ...express(),
    "worker.js": "require('bullmq').Worker;",
  });
  assert.equal(unsupportedWorker.status, "blocked");
  assert.equal(unsupportedWorker.analysisState, "UNSUPPORTED");
  assert.match(unsupportedWorker.blockers.join(" "), /required worker process/i);

  const external = await detect({
    "Frontend/index.html": "<script src=\"Js/app.js\"></script>",
    "Frontend/Js/app.js": "fetch('https://example.up.railway.app/books')",
    ...express(),
  });
  assert.equal(external.status, "supported", "external backends must remain external rather than being rebound or blocked");

  const component = reactExpress.components[0];
  const plan = {
    planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, repositoryFullName: "fixture/fullstack", branch: "main", commitSha: "a".repeat(40),
    detectorId: "fixture", language: "javascript", framework: "express", frameworkMode: "express-server", confidence: "high", platformBackendMount: "/__deployguard/backend", evidence: [], appRoot: "Backend", repositoryInstallRoot: "Backend",
    packageManager: "npm", dependencyManifest: "package.json", lockfile: "package-lock.json", runtimeVersion: "22", baseImage: "node:22-alpine3.21", runtimeImage: "node:22-alpine3.21",
    installCommand: "npm ci", buildCommand: null, buildCommands: [], releaseCommand: null, releaseCommands: [], runCommand: "npm start", runtimeFiles: [], outputDirectory: null,
    buildSystemDependencies: [], runtimeSystemDependencies: [], port: 3000, portSource: "detected", healthPath: "/health", bindHost: "0.0.0.0", bindsToPortEnv: true, runtimeType: "server",
    database: { required: false, provider: "none", engine: null }, environmentOwnership: [], requiredInputs: [], requiredUserInputs: [], optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: [], secretEnvVars: [],
    dockerStrategy: "generated", dockerTemplate: "express-server", warnings: [], blockers: [],
    components: reactExpress.components.map((item) => ({
      id: item.id, role: item.role, root: item.root, buildContext: item.buildContext, repositoryInstallRoot: item.profile.rawProfile.repositoryInstallRoot as string || item.root, detectorId: item.profile.rawProfile.detectorId as string || item.framework,
      language: item.profile.language as "javascript" | "python", framework: item.framework, frameworkMode: item.frameworkVariant, runtimeType: item.runtimeType,
      packageManager: item.profile.packageManager || "npm", dependencyManifest: "package.json", lockfile: "package-lock.json", runtimeVersion: item.profile.runtimeVersion || "22",
      baseImage: "node:22-alpine3.21", runtimeImage: item.runtimeType === "static" ? "nginxinc/nginx-unprivileged:1.27-alpine" : "node:22-alpine3.21", installCommand: "npm ci",
      buildCommand: item.profile.buildCommand, runCommand: item.profile.startCommand, runtimeFiles: [], outputDirectory: item.runtimeType === "static" ? "dist" : null,
      port: item.port, healthPath: item.healthCheckPath, bindHost: item.profile.rawProfile.bindHost as string || null, bindsToPortEnv: item.profile.rawProfile.bindsToPortEnv === true,
      dockerStrategy: "generated" as const, dockerTemplate: item.profile.selectedTemplate || "", environmentOwnership: [], database: { required: false, provider: "none" as const, engine: null },
    })),
    relationships: reactExpress.relationships.filter((item) => item.kind === "CALLS").map((item) => ({ from: "frontend" as const, to: "backend" as const, kind: "http" as const, mode: item.mode, pathPrefix: item.pathPrefix, stripPathPrefix: item.stripPathPrefix, buildTimeVariable: item.buildTimeVariable, verificationPath: item.verificationPath })),
    serviceBindings: [],
  } satisfies BuildPlan;
  const inputs = buildPlanWorkflowInputs(plan);
  assert.equal(inputs.application_root, component.root);
  assert.equal(inputs.app_port, String(component.port));
  assert.equal((JSON.parse(Buffer.from(inputs.build_plan_base64, "base64").toString()) as BuildPlan).components?.length, 2);

  const workflow = readFileSync(resolve(__dirname, "../../.github/workflows/deployguard-reusable.yml"), "utf8");
  assert.match(workflow, /component\.runtimeType == "static" \? \["CMD-SHELL", "wget/, "static frontend health must use the nginx runtime rather than its source language");
  assert.doesNotMatch(workflow, /component\.language == "static"/);
  const topologySource = readFileSync(resolve(__dirname, "../src/projects/detection/stack-detection.service.ts"), "utf8");
  assert.doesNotMatch(topologySource, /full-stack release supports a static frontend|server-rendered frontend plus backend is outside the current contract/i);
  const contractSource = readFileSync(resolve(__dirname, "../src/projects/deployment-contract.service.ts"), "utf8");
  assert.match(contractSource, /component\.role === "frontend" && component\.runtimeType === "static"/, "only static frontend images receive the existing nginx proxy configuration");
  assert.match(workflow, /\["DEPLOYGUARD_OPERATION_ID", "DEPLOYGUARD_PROJECT_ID", "DEPLOYGUARD_ENVIRONMENT"\]/, "static public components must retain immutable operation identity");
  assert.match(workflow, /PLATFORM_PREFIX="\$\(jq -er '\.platformBackendMount'/, "nginx must consume the BuildPlan-owned platform mount");
  assert.match(workflow, /location \$\{PLATFORM_PREFIX%\/\}\//, "nginx must route the platform-owned backend mount");
  assert.match(workflow, /\.relationships\[0\]\.verificationPath/, "relationship verification must use persisted route evidence");
  assert.match(workflow, /backendComponentHealthVerified:true/, "backend component health must remain independently represented");
  const bindingSource = readFileSync(resolve(__dirname, "../src/infrastructure/database-service-binding.service.ts"), "utf8");
  assert.match(bindingSource, /const runtimeIdentityContainer = containers\.find/, "promotion validation must resolve runtime identity independently from the public image container");
  assert.match(bindingSource, /containers\.find\(\(item\) => item\.image === expectedRelease\.imageUri\) \|\| bindingContainer/, "promotion validation must verify the exact public image container");
  const buildPlanPredicate = workflow.match(/--arg output "\$OUTPUT_DIRECTORY" '\n([\s\S]*?)\n\s+' \.deployguard\/build-plan\.json/)?.[1];
  assert.ok(buildPlanPredicate, "the exact reusable-workflow BuildPlan predicate must remain extractable");
  assert.doesNotThrow(() => execFileSync("jq", [
    "-e",
    "--arg", "repository", plan.repositoryFullName,
    "--arg", "branch", plan.branch,
    "--arg", "commit", plan.commitSha,
    "--arg", "appRoot", inputs.application_root,
    "--argjson", "port", inputs.app_port,
    "--arg", "health", inputs.health_check_path,
    "--arg", "template", inputs.container_profile,
    "--arg", "output", inputs.output_directory,
    buildPlanPredicate,
  ], { input: JSON.stringify(plan), stdio: ["pipe", "ignore", "pipe"] }), "the live workflow predicate must accept a valid two-component BuildPlan");

  console.log("Bounded full-stack topology verification passed: service discovery, optional route evidence, platform bindings, and componentized workflow inputs.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
