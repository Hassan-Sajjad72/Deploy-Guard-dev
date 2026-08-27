import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BuildPlan, BUILD_PLAN_DETECTOR_VERSION } from "../src/projects/build-plan";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

const cases = [
  {
    name: "vite-static", framework: "vite-react", mode: "vite-static", template: "vite-static", port: 8080, output: "dist", run: null,
    packageJson: { scripts: { build: "vite build" }, dependencies: { vite: "6.1.0", react: "19.0.0", "react-dom": "19.0.0" }, devDependencies: {} },
    files: { "index.html": "<div id='root'></div><script type='module' src='/src.jsx'></script>", "src.jsx": "import React from 'react';import{createRoot}from'react-dom/client';createRoot(document.getElementById('root')).render(<h1>deployguard-static-ok</h1>)" },
  },
  {
    name: "next-ssr", framework: "nextjs", mode: "nextjs-ssr", template: "nextjs-ssr", port: 3000, output: null, run: "npm run start -- -H 0.0.0.0 -p ${PORT:-3000}",
    packageJson: { scripts: { build: "next build", start: "next start" }, dependencies: { next: "15.1.0", react: "19.0.0", "react-dom": "19.0.0" } },
    files: { "app/layout.js": "export default function Layout({children}){return <html><body>{children}</body></html>}", "app/page.js": "export default function Page(){return <h1>deployguard-next-ok</h1>}" },
  },
] as const;

for (const item of cases) {
  const directory = mkdtempSync(join(tmpdir(), `deployguard-js-${item.name}-`));
  const suffix = `${process.pid}-${item.name}`;
  const image = `deployguard-js-runtime-smoke:${suffix}`;
  const container = `deployguard-js-runtime-smoke-${suffix}`;
  try {
    const plan: BuildPlan = {
      planVersion: 2, detectorVersion: BUILD_PLAN_DETECTOR_VERSION, repositoryFullName: "example/javascript-runtime", branch: "main", commitSha: "b".repeat(40),
      detectorId: `javascript.${item.framework}`, language: "javascript", framework: item.framework, frameworkMode: item.mode, confidence: "high", evidence: [],
      appRoot: ".", repositoryInstallRoot: ".", packageManager: "npm", dependencyManifest: "package.json", lockfile: null,
      runtimeVersion: "22", baseImage: "node:22-alpine3.21", runtimeImage: item.output ? "nginxinc/nginx-unprivileged:1.27-alpine" : "node:22-alpine3.21",
      installCommand: "npm install", buildCommand: "npm run build", buildCommands: ["npm run build"], releaseCommand: null, releaseCommands: [], runCommand: item.run,
      runtimeFiles: item.output ? [item.output] : [".next", "public", "package.json"], outputDirectory: item.output,
      buildSystemDependencies: [], runtimeSystemDependencies: [], port: item.port, portSource: "detector", healthPath: "/", bindHost: "0.0.0.0", bindsToPortEnv: true,
      runtimeType: item.output ? "static" : "server", environmentOwnership: [], requiredInputs: [], requiredUserInputs: [], optionalInputs: [], buildTimeEnvVars: [], runtimeEnvVars: ["PORT"], secretEnvVars: [],
      dockerStrategy: "generated", dockerTemplate: item.template, warnings: ["No JavaScript lockfile was found; deployment will use a compatible non-frozen install command."], blockers: [],
    };
    const template = new TemplateRegistryService().getTemplate(item.template)!;
    writeFileSync(join(directory, "Dockerfile"), new DockerTemplateEngineService().renderDockerfile(template, plan)!);
    writeFileSync(join(directory, ".dockerignore"), ".git\n.env\nnode_modules\n");
    writeFileSync(join(directory, "package.json"), JSON.stringify({ name: item.name, version: "1.0.0", ...item.packageJson }));
    for (const [name, content] of Object.entries(item.files)) {
      mkdirSync(join(directory, name, ".."), { recursive: true });
      writeFileSync(join(directory, name), content);
    }
    execFileSync("docker", ["build", "--pull", "-t", image, directory], { stdio: "inherit", timeout: 300_000 });
    execFileSync("docker", ["run", "-d", "--name", container, "-e", `PORT=${item.port}`, "-p", `127.0.0.1::${item.port}`, image], { stdio: "pipe", timeout: 15_000 });
    const published = execFileSync("docker", ["port", container, `${item.port}/tcp`], { timeout: 5_000 }).toString().trim().match(/:(\d+)$/)?.[1];
    assert.ok(published);
    let body = "";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        body = execFileSync(process.execPath, ["-e", `fetch('http://127.0.0.1:${published}').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())})`], { timeout: 5_000 }).toString();
        break;
      } catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
    }
    assert.match(body, item.output ? /id='root'/ : /deployguard-next-ok/);
    assert.notEqual(execFileSync("docker", ["exec", container, "id", "-u"], { timeout: 5_000 }).toString().trim(), "0");
    console.log(`PASS generated ${item.name} runtime builds and serves as non-root`);
  } finally {
    try { execFileSync("docker", ["rm", "-f", container], { stdio: "ignore", timeout: 10_000 }); } catch {}
    try { execFileSync("docker", ["image", "rm", "-f", image], { stdio: "ignore", timeout: 10_000 }); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
}
