import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    source: "from flask import Flask\napp=Flask(__name__)\n@app.get('/health')\ndef health(): return 'ok'\n",
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
    source: "from fastapi import FastAPI\napp=FastAPI()\n@app.get('/health')\ndef health(): return {'ok': True}\n",
  },
] as const;

for (const item of cases) {
  const directory = mkdtempSync(join(tmpdir(), `deployguard-python-${item.name}-`));
  const suffix = `${process.pid}-${item.name}`;
  const image = `deployguard-python-runtime-smoke:${suffix}`;
  const container = `deployguard-python-runtime-smoke-${suffix}`;
  try {
    const plan: BuildPlan = {
      planVersion: 1, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, repositoryFullName: "example/python-runtime", branch: "main", commitSha: "a".repeat(40),
      detectorId: `python.${item.framework}`, language: "python", framework: item.framework, frameworkMode: item.mode, confidence: "high", evidence: [],
      appRoot: ".", repositoryInstallRoot: ".", packageManager: "pip", dependencyManifest: "requirements.txt", lockfile: "requirements.txt",
      runtimeVersion: "3.11", baseImage: "python:3.11-slim", runtimeImage: "python:3.11-slim",
      installCommand: `pip install --no-cache-dir -r requirements.txt && python -m pip install --no-cache-dir ${item.runtime}`,
      buildCommand: null, buildCommands: [], releaseCommand: null, releaseCommands: [], runCommand: item.runCommand, runtimeFiles: ["."], outputDirectory: null,
      buildSystemDependencies: [], runtimeSystemDependencies: [], port: item.port, portSource: "detector", healthPath: "/health", bindHost: "0.0.0.0", bindsToPortEnv: true,
      runtimeType: "server", environmentOwnership: [], requiredInputs: [], requiredUserInputs: [], optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: ["PORT"], secretEnvVars: [],
      dockerStrategy: "generated", dockerTemplate: item.template, warnings: [], blockers: [],
    };
    const template = new TemplateRegistryService().getTemplate(item.template)!;
    const dockerfile = new DockerTemplateEngineService().renderDockerfile(template, plan)!;
    assert.match(dockerfile, new RegExp(item.runtime.replaceAll(".", "\\.")));
    assert.match(dockerfile, /USER appuser/);
    writeFileSync(join(directory, "Dockerfile"), dockerfile);
    writeFileSync(join(directory, ".dockerignore"), ".git\n.env\n__pycache__\n");
    writeFileSync(join(directory, "requirements.txt"), item.dependency);
    writeFileSync(join(directory, item.name === "wsgi" ? "app.py" : "main.py"), item.source);
    execFileSync("docker", ["build", "--pull", "-t", image, directory], { stdio: "inherit", timeout: 240_000 });
    execFileSync("docker", ["run", "-d", "--name", container, "-e", `PORT=${item.port}`, image], { stdio: "pipe", timeout: 15_000 });
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
    assert.doesNotMatch(execFileSync("docker", ["logs", container], { timeout: 5_000 }).toString(), /not found|permission denied/i);
    console.log(`PASS generated Python ${item.name.toUpperCase()} runtime supplies ${item.runtime} and serves as non-root`);
  } finally {
    try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 10_000 }); } catch {}
    try { execFileSync("docker", ["image", "rm", "-f", image], { stdio: "ignore", timeout: 10_000 }); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
}
