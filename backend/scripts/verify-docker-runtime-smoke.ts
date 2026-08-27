import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";
import { BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";

const directory = mkdtempSync(join(tmpdir(), "deployguard-docker-smoke-"));
const suffix = process.pid.toString();
const image = `deployguard-contract-smoke:${suffix}`;
const container = `deployguard-contract-smoke-${suffix}`;

try {
  const template = new TemplateRegistryService().getTemplate("express-server")!;
  const dockerfile = new DockerTemplateEngineService().renderDockerfile(template, {
    planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, repositoryFullName: "example/app", branch: "main", detectorId: "express:express-server", confidence: "high", evidence: [],
    language: "javascript", framework: "express", frameworkMode: "express-server", appRoot: ".", repositoryInstallRoot: ".",
    packageManager: "npm", dependencyManifest: "package.json", lockfile: "package-lock.json", runtimeVersion: "20", baseImage: "node:20-alpine3.21", runtimeImage: "node:20-alpine3.21",
    installCommand: "npm ci", buildCommand: null, buildCommands: [], releaseCommand: null, releaseCommands: [], runCommand: "npm run start", runtimeFiles: ["."], outputDirectory: null,
    port: 3000, healthPath: "/health", runtimeType: "server", buildTimeEnvVars: [], runtimeEnvVars: ["PORT"],
    secretEnvVars: [], commitSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", portSource: "source", bindHost: "0.0.0.0", bindsToPortEnv: true,
    buildSystemDependencies: [], runtimeSystemDependencies: [], environmentOwnership: [], requiredInputs: [], requiredUserInputs: [], optionalInputs: [], dockerStrategy: "generated", dockerTemplate: "express-server", warnings: [], blockers: [],
  })!;
  writeFileSync(join(directory, "Dockerfile"), dockerfile);
  writeFileSync(join(directory, ".dockerignore"), ".git\n.env\nnode_modules\n");
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "deployguard-smoke", version: "1.0.0", scripts: { start: "node server.js" } }));
  writeFileSync(join(directory, "package-lock.json"), JSON.stringify({ name: "deployguard-smoke", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "deployguard-smoke", version: "1.0.0" } } }));
  writeFileSync(join(directory, "server.js"), "const fs=require('fs');fs.mkdirSync('/app/runtime-data',{recursive:true});fs.writeFileSync('/app/runtime-data/started.txt','ok');require('http').createServer((req,res)=>{res.statusCode=200;res.end('ok')}).listen(Number(process.env.PORT||3000),'0.0.0.0')");
  execFileSync("docker", ["build", "--pull", "-t", image, directory], { stdio: "inherit", timeout: 180_000 });
  execFileSync("docker", ["run", "-d", "--name", container, "-e", "PORT=3000", image], { stdio: "pipe", timeout: 15_000 });
  let healthy = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = execFileSync("docker", ["exec", container, "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)})"], { timeout: 5_000 }).toString();
      void response;
      healthy = true;
      break;
    } catch { execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { timeout: 5_000 }); }
  }
  assert.equal(healthy, true, "rendered container must answer on the contract port");
  assert.notEqual(execFileSync("docker", ["exec", container, "id", "-u"], { timeout: 5_000 }).toString().trim(), "0");
  assert.equal(execFileSync("docker", ["exec", container, "cat", "/app/runtime-data/started.txt"], { timeout: 5_000 }).toString().trim(), "ok");
  assert.equal(execFileSync("docker", ["exec", container, "sh", "-c", "test -w /app && mkdir /app/runtime-child && printf ok > /app/runtime-child/value && cat /app/runtime-child/value"], { timeout: 5_000 }).toString().trim(), "ok");
  assert.doesNotMatch(execFileSync("docker", ["logs", container], { timeout: 5_000 }).toString(), /not found|permission denied/i);
  assert.doesNotMatch(execFileSync("docker", ["history", "--no-trunc", image], { timeout: 10_000 }).toString(), /DATABASE_URL|secret/i);
  console.log("PASS exact generated Node Dockerfile builds and remains healthy as a non-root process on the contract port");
} finally {
  try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 10_000 }); } catch {}
  try { execFileSync("docker", ["image", "rm", "-f", image], { stdio: "ignore", timeout: 10_000 }); } catch {}
  rmSync(directory, { recursive: true, force: true });
}
