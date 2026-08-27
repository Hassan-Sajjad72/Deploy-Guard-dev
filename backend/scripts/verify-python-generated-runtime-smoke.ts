import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildPlan, BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

const cases = [
  {
    name: "wsgi",
    template: "flask-wsgi",
    framework: "flask",
    mode: "flask-wsgi",
    dependency: "Flask==3.1.0\n",
    runtime: "gunicorn==23.0.0",
    runCommand: "gunicorn app:app --bind 0.0.0.0:${PORT:-5000}",
    port: 5000,
    files: { "app.py": "from flask import Flask\napp=Flask(__name__)\n@app.get('/health')\ndef health(): return 'ok'\n" },
  },
  {
    name: "asgi",
    template: "fastapi-asgi",
    framework: "fastapi",
    mode: "fastapi-asgi",
    dependency: "fastapi==0.116.0\n",
    runtime: "uvicorn==0.35.0",
    runCommand: "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}",
    port: 8000,
    files: { "main.py": "from fastapi import FastAPI\napp=FastAPI()\n@app.get('/health')\ndef health(): return {'ok': True}\n" },
  },
  {
    name: "django-postgresql",
    template: "django-wsgi",
    framework: "django",
    mode: "django-wsgi",
    dependency: "Django==5.2.0\npsycopg2==2.9.10\n",
    runtime: "gunicorn==23.0.0",
    buildCommand: "python manage.py collectstatic --noinput",
    releaseCommand: "python manage.py migrate --noinput",
    runCommand: "gunicorn config.wsgi:application --bind 0.0.0.0:${PORT:-8000}",
    port: 8000,
    buildSystemDependencies: ["gcc", "libc6-dev", "libpq-dev"],
    runtimeSystemDependencies: ["libpq5"],
    files: {
      "config/__init__.py": "",
      "manage.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')\nfrom django.core.management import execute_from_command_line\nexecute_from_command_line()\n",
      "config/settings.py": "import os\nSECRET_KEY=os.environ['SECRET_KEY']\nAPP_ENV=os.environ['APP_ENV']\nDB_HOST=os.environ['DB_HOST']\nDB_PORT=os.environ['DB_PORT']\nDB_NAME=os.environ['DB_NAME']\nDB_USER=os.environ['DB_USER']\nDB_PASSWORD=os.environ['DB_PASSWORD']\nDATABASES={'default':{'ENGINE':'django.db.backends.postgresql','HOST':DB_HOST,'PORT':DB_PORT,'NAME':DB_NAME,'USER':DB_USER,'PASSWORD':DB_PASSWORD}}\nDEBUG=False\nALLOWED_HOSTS=['*']\nROOT_URLCONF='config.urls'\nMIDDLEWARE=[]\nINSTALLED_APPS=['django.contrib.staticfiles']\nSTATIC_ROOT='/app/staticfiles'\nSTATIC_URL='/static/'\n",
      "config/urls.py": "from django.urls import path\nfrom django.http import JsonResponse\nurlpatterns=[path('health',lambda request: JsonResponse({'ok':True}))]\n",
      "config/wsgi.py": "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','config.settings')\nfrom django.core.wsgi import get_wsgi_application\napplication=get_wsgi_application()\n",
    },
  },
] as const;

for (const item of cases) {
  const directory = mkdtempSync(join(tmpdir(), `deployguard-python-${item.name}-`));
  const suffix = `${process.pid}-${item.name}`;
  const image = `deployguard-python-runtime-smoke:${suffix}`;
  const container = `deployguard-python-runtime-smoke-${suffix}`;
  const network = `deployguard-python-runtime-smoke-net-${suffix}`;
  const database = `deployguard-python-runtime-smoke-db-${suffix}`;
  try {
    const plan: BuildPlan = {
      planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, repositoryFullName: "example/python-runtime", branch: "main", commitSha: "a".repeat(40),
      detectorId: `python.${item.framework}`, language: "python", framework: item.framework, frameworkMode: item.mode, confidence: "high", evidence: [],
      appRoot: ".", repositoryInstallRoot: ".", packageManager: "pip", dependencyManifest: "requirements.txt", lockfile: "requirements.txt",
      runtimeVersion: "3.11", baseImage: "python:3.11-slim", runtimeImage: "python:3.11-slim",
      installCommand: `pip install --no-cache-dir -r requirements.txt && python -m pip install --no-cache-dir ${item.runtime}`,
      buildCommand: "buildCommand" in item ? item.buildCommand : null, buildCommands: "buildCommand" in item ? [item.buildCommand] : [],
      buildInitialization: "buildCommand" in item ? { contractVersion: "deployguard.build-initialization/v1", mode: "runtime_placeholders", reason: "Django collectstatic imports settings without requiring the managed database service." } : undefined,
      releaseCommand: "releaseCommand" in item ? item.releaseCommand : null,
      releaseCommands: "releaseCommand" in item ? [item.releaseCommand] : [], runCommand: item.runCommand, runtimeFiles: ["."], outputDirectory: null,
      buildSystemDependencies: "buildSystemDependencies" in item ? [...item.buildSystemDependencies] : [],
      runtimeSystemDependencies: "runtimeSystemDependencies" in item ? [...item.runtimeSystemDependencies] : [],
      systemDependencyEvidence: {
        build: "buildSystemDependencies" in item ? [...item.buildSystemDependencies] : [],
        runtime: "runtimeSystemDependencies" in item ? [...item.runtimeSystemDependencies] : [],
      },
      port: item.port, portSource: "detector", healthPath: "/health", bindHost: "0.0.0.0", bindsToPortEnv: true,
      runtimeType: "server", environmentOwnership: "buildCommand" in item ? [
        { key: "APP_ENV", owner: "application", component: "application", source: "application", exposure: "private", requirement: "required", required: true, phase: "runtime", secret: false },
        { key: "SECRET_KEY", owner: "application", component: "application", source: "application", exposure: "private", requirement: "required", required: true, phase: "runtime", secret: true },
        ...["DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD"].map((key) => ({ key, owner: "infrastructure" as const, component: "application" as const, source: "managed_database" as const, exposure: "private" as const, requirement: "required" as const, required: true, phase: "runtime" as const, secret: key === "DB_PASSWORD" })),
      ] : [], database: "buildCommand" in item ? { required: true, provider: "managed", engine: "postgres" } : { required: false, provider: "none", engine: null }, requiredInputs: [], requiredUserInputs: [], optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: ["PORT"], secretEnvVars: [],
      dockerStrategy: "generated", dockerTemplate: item.template, warnings: [], blockers: [],
    };
    const template = new TemplateRegistryService().getTemplate(item.template)!;
    const dockerfile = new DockerTemplateEngineService().renderDockerfile(template, plan)!;
    assert.match(dockerfile, new RegExp(item.runtime.replaceAll(".", "\\.")));
    assert.match(dockerfile, /USER appuser/);
    writeFileSync(join(directory, "Dockerfile"), dockerfile);
    writeFileSync(join(directory, ".dockerignore"), ".git\n.env\n__pycache__\n");
    writeFileSync(join(directory, "requirements.txt"), item.dependency);
    for (const [name, content] of Object.entries(item.files)) {
      mkdirSync(join(directory, name, ".."), { recursive: true });
      writeFileSync(join(directory, name), content);
    }
    if ("buildCommand" in item) {
      const runtimeConfiguration = join(directory, "deployguard-runtime-build.json");
      writeFileSync(runtimeConfiguration, JSON.stringify({
        APP_ENV: "test",
        SECRET_KEY: "fixture-build-secret",
        DB_HOST: "deployguard-build-init.invalid",
        DB_PORT: "5432",
        DB_NAME: "deployguard_build_init",
        DB_USER: "deployguard_build_init",
        DB_PASSWORD: "deployguard-build-init-placeholder",
      }), { mode: 0o600 });
      assert.match(dockerfile, /--mount=type=secret,id=deployguard_runtime_config,required=true/);
      assert.doesNotMatch(dockerfile, /fixture-build-secret/);
      assert.doesNotMatch(dockerfile, /fixture-runtime-db-password/);
      execFileSync("docker", ["buildx", "build", "--load", "--pull", "--no-cache", "--secret", `id=deployguard_runtime_config,src=${runtimeConfiguration}`, "-t", image, directory], { stdio: "inherit", timeout: 240_000 });
    } else {
      execFileSync("docker", ["build", "--pull", "-t", image, directory], { stdio: "inherit", timeout: 240_000 });
    }
    const runtimeArguments = ["run", "-d", "--name", container, "-e", `PORT=${item.port}`];
    if ("buildCommand" in item) {
      execFileSync("docker", ["network", "create", network], { stdio: "pipe", timeout: 10_000 });
      execFileSync("docker", ["run", "-d", "--name", database, "--network", network,
        "-e", "POSTGRES_DB=runtime_database", "-e", "POSTGRES_USER=runtime_user",
        "-e", "POSTGRES_PASSWORD=fixture-runtime-db-password", "postgres:16-alpine"], { stdio: "pipe", timeout: 30_000 });
      let databaseReady = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          execFileSync("docker", ["exec", database, "pg_isready", "-U", "runtime_user", "-d", "runtime_database"], { stdio: "ignore", timeout: 5_000 });
          databaseReady = true;
          break;
        } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
      }
      assert.equal(databaseReady, true, "managed PostgreSQL fixture must be ready before post-provision release initialization");
      runtimeArguments.push("--network", network);
      runtimeArguments.push(
        "-e", "APP_ENV=test", "-e", "SECRET_KEY=fixture-runtime-secret",
        "-e", `DB_HOST=${database}`, "-e", "DB_PORT=5432",
        "-e", "DB_NAME=runtime_database", "-e", "DB_USER=runtime_user", "-e", "DB_PASSWORD=fixture-runtime-db-password",
      );
    }
    runtimeArguments.push(image);
    execFileSync("docker", runtimeArguments, { stdio: "pipe", timeout: 15_000 });
    let healthy = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        execFileSync("docker", ["exec", container, "python", "-c", `import urllib.request; assert urllib.request.urlopen('http://127.0.0.1:${item.port}/health', timeout=2).status == 200`], { timeout: 5_000 });
        healthy = true;
        break;
      } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
    }
    assert.equal(healthy, true, `${item.name} generated runtime must answer on platform PORT`);
    assert.notEqual(execFileSync("docker", ["exec", container, "id", "-u"], { timeout: 5_000 }).toString().trim(), "0");
    const logs = execFileSync("docker", ["logs", container], { timeout: 5_000 }).toString();
    assert.doesNotMatch(logs, /not found|permission denied/i);
    if ("releaseCommand" in item) {
      assert.match(logs, /migrations|No migrations to apply/i, "post-provision release initialization must complete before Django starts");
    }
    console.log(`PASS generated Python ${item.name.toUpperCase()} runtime supplies ${item.runtime} and serves as non-root`);
  } finally {
    try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 10_000 }); } catch {}
    try { execFileSync("docker", ["rm", "-f", database], { stdio: "ignore", timeout: 10_000 }); } catch {}
    try { execFileSync("docker", ["network", "rm", network], { stdio: "ignore", timeout: 10_000 }); } catch {}
    try { execFileSync("docker", ["image", "rm", "-f", image], { stdio: "ignore", timeout: 10_000 }); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
}
