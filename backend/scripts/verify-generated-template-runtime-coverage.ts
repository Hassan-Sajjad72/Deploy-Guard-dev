import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildPlan, BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { DEVOPS_TEMPLATES } from "../src/projects/templates/devops-templates";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

const registry = new TemplateRegistryService();
const engine = new DockerTemplateEngineService();
const root = mkdtempSync(join(tmpdir(), "deployguard-template-runtime-"));
const images: string[] = [];
const containers: string[] = [];

function run(command: string, args: string[], options: { encoding?: "utf8"; timeout?: number; stdio?: "pipe" | "inherit" } = {}) {
  return execFileSync(command, args, { encoding: options.encoding, timeout: options.timeout || 240_000, stdio: options.stdio || (options.encoding ? "pipe" : "inherit") });
}

function waitFor(url: string) {
  let response = "";
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      response = execFileSync("curl", ["--fail", "--silent", "--show-error", "--max-time", "3", url], { encoding: "utf8", timeout: 5_000 });
      return response;
    } catch (error) {
      last = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  throw last;
}

function planFor(template: (typeof DEVOPS_TEMPLATES)[number]): BuildPlan {
  const isStatic = template.outputMode === "static";
  const isNode = template.ecosystem === "node";
  const staticWeb = template.templateKey === "static-web";
  const outputDirectory = isStatic && !staticWeb ? "dist" : staticWeb ? "." : null;
  const port = template.defaultPort;
  return {
    planVersion: 2,
    detectorVersion: BUILD_PLAN_DETECTOR_VERSION,
    repositoryFullName: "deployguard/template-runtime-coverage",
    branch: "main",
    commitSha: "e".repeat(40),
    detectorId: `coverage.${template.templateKey}`,
    language: isNode || staticWeb ? "javascript" : "python",
    framework: template.framework,
    frameworkMode: template.frameworkVariant,
    confidence: "high",
    evidence: [{ source: "coverage", description: "Generated-template runtime coverage." }],
    appRoot: ".",
    repositoryInstallRoot: ".",
    packageManager: staticWeb ? "none" : isNode ? "npm" : "pip",
    dependencyManifest: staticWeb ? "index.html" : isNode ? "package.json" : "requirements.txt",
    lockfile: null,
    runtimeVersion: isNode ? "22" : "3.11",
    baseImage: template.baseImage,
    runtimeImage: template.runtimeImage,
    installCommand: staticWeb ? "" : isNode ? "npm install" : "pip install --no-cache-dir -r requirements.txt",
    buildCommand: staticWeb || !isNode ? null : "npm run build",
    buildCommands: staticWeb || !isNode ? [] : ["npm run build"],
    releaseCommand: null,
    releaseCommands: [],
    runCommand: isStatic ? null : isNode ? "node server.js" : "python server.py",
    runtimeFiles: isStatic ? [outputDirectory || "."] : ["."],
    outputDirectory,
    buildSystemDependencies: [],
    runtimeSystemDependencies: [],
    port,
    portSource: "coverage",
    healthPath: "/health",
    bindHost: "0.0.0.0",
    bindsToPortEnv: true,
    runtimeType: isStatic ? "static" : "server",
    environmentOwnership: [],
    database: { required: false, provider: "none", engine: null },
    requiredInputs: [],
    requiredUserInputs: [],
    optionalInputs: [],
    buildTimeEnvVars: [],
    runtimeEnvVars: ["PORT"],
    secretEnvVars: [],
    dockerStrategy: "generated",
    dockerTemplate: template.templateKey,
    warnings: [],
    blockers: [],
  };
}

function writeApplication(directory: string, template: (typeof DEVOPS_TEMPLATES)[number], plan: BuildPlan) {
  const isNode = template.ecosystem === "node";
  if (template.templateKey === "static-web") {
    writeFileSync(join(directory, "index.html"), `<main>deployguard-${template.templateKey}</main>`);
    return;
  }
  if (plan.runtimeType === "static") {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: template.templateKey, private: true, version: "1.0.0", dependencies: { "is-number": "7.0.0" }, scripts: { build: "node build.js" } }));
    writeFileSync(join(directory, "build.js"), "const fs=require('fs');fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/index.html','<main>deployguard-static-template-ok</main>')");
    return;
  }
  if (isNode) {
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: template.templateKey, private: true, version: "1.0.0", dependencies: { "is-number": "7.0.0" }, scripts: { build: "node build.js", start: "node server.js" } }));
    writeFileSync(join(directory, "build.js"), "process.stdout.write('deployguard build ok\\n')");
    writeFileSync(join(directory, "server.js"), "const http=require('http');http.createServer((q,r)=>{r.writeHead(q.url==='/health'?200:200,{'content-type':'text/plain'});r.end('deployguard-server-template-ok')}).listen(Number(process.env.PORT),'0.0.0.0')");
    return;
  }
  writeFileSync(join(directory, "requirements.txt"), "");
  writeFileSync(join(directory, "server.py"), "import os\nfrom http.server import BaseHTTPRequestHandler,HTTPServer\nclass H(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(b'deployguard-python-template-ok')\nHTTPServer(('0.0.0.0',int(os.environ['PORT'])),H).serve_forever()\n");
}

for (const template of DEVOPS_TEMPLATES.filter((item) => item.dockerfileTemplatePath)) {
  const plan = planFor(template);
  const directory = join(root, template.templateKey);
  const image = `deployguard-template-runtime:${process.pid}-${template.templateKey}`;
  const container = `deployguard-template-runtime-${process.pid}-${template.templateKey}`;
  mkdirSync(directory, { recursive: true });
  try {
    const selected = registry.getTemplate(template.templateKey);
    assert.ok(selected, `${template.templateKey}: registry entry`);
    const dockerfile = engine.renderDockerfile(selected!, plan);
    assert.ok(dockerfile, `${template.templateKey}: generated Dockerfile`);
    assert.doesNotMatch(dockerfile!, /\{\{[A-Z_]+\}\}/, `${template.templateKey}: no unresolved Docker token`);
    writeFileSync(join(directory, "Dockerfile"), dockerfile!);
    writeFileSync(join(directory, ".dockerignore"), ".git\n.env\n.env.*\nnode_modules\n__pycache__\n");
    writeApplication(directory, template, plan);
    run("docker", ["buildx", "build", "--load", "-t", image, directory], { timeout: 360_000 });
    images.push(image);
    const configuredUser = run("docker", ["image", "inspect", image, "--format", "{{.Config.User}}"], { encoding: "utf8" }).trim();
    assert.ok(configuredUser && configuredUser !== "0" && configuredUser !== "root", `${template.templateKey}: configured non-root user`);
    run("docker", ["run", "-d", "--name", container, "-e", `PORT=${plan.port}`, "-p", `127.0.0.1::${plan.port}`, image]);
    containers.push(container);
    const hostPort = run("docker", ["inspect", container, "--format", `{{(index (index .NetworkSettings.Ports \"${plan.port}/tcp\") 0).HostPort}}`], { encoding: "utf8" }).trim();
    const body = waitFor(`http://127.0.0.1:${hostPort}${plan.runtimeType === "static" ? "/" : plan.healthPath}`);
    assert.match(body, /deployguard-(?:static|server|python)-template-ok|deployguard-static-web/);
    assert.notEqual(run("docker", ["exec", container, "id", "-u"], { encoding: "utf8" }).trim(), "0", `${template.templateKey}: runtime non-root`);
    console.log(`PASS ${template.templateKey}: generated Docker build, startup, health, non-root runtime, cleanup`);
  } finally {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
    spawnSync("docker", ["image", "rm", "-f", image], { stdio: "ignore" });
  }
}

console.log(`Generated-template runtime coverage passed for ${DEVOPS_TEMPLATES.filter((item) => item.dockerfileTemplatePath).length} registry entries.`);
rmSync(root, { recursive: true, force: true });
