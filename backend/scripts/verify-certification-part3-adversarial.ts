import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DETECTION_INPUT_FINGERPRINT_VERSION, detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { buildPlanWorkflowInputs } from "../src/projects/github-actions-operation-contract";
import { DeploymentContractService } from "../src/projects/deployment-contract.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { StackDetectionService } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

type Case = {
  name: string;
  dockerfilePath: string;
  preferredRoot?: string;
  language: "node" | "python";
  command: "cmd" | "entrypoint" | "entrypoint-cmd" | "shell";
  multistage: boolean;
};

const repository = resolve(__dirname, "../..");
const workflow = join(repository, ".github/workflows/deployguard-reusable.yml");
const suiteRoot = mkdtempSync(join(tmpdir(), "deployguard-certification-part3-"));
const preflightScript = join(suiteRoot, "executable-preflight.sh");
const images: string[] = [];
let runSequence = 0;

const cases: Case[] = [
  { name: "root-dockerfile-node-multistage", dockerfilePath: "Dockerfile", language: "node", command: "cmd", multistage: true },
  { name: "backend-dockerfile-entrypoint", dockerfilePath: "Dockerfile", preferredRoot: "backend", language: "node", command: "entrypoint", multistage: false },
  { name: "frontend-dockerfile-entrypoint-cmd", dockerfilePath: "Dockerfile", preferredRoot: "frontend", language: "node", command: "entrypoint-cmd", multistage: false },
  { name: "docker-directory-dockerfile", dockerfilePath: "docker/Dockerfile", language: "node", command: "entrypoint-cmd", multistage: false },
  { name: "production-dockerfile-shell", dockerfilePath: "Dockerfile.prod", language: "node", command: "shell", multistage: false },
  { name: "docker-backend-python-multistage", dockerfilePath: "docker/backend.Dockerfile", language: "python", command: "entrypoint-cmd", multistage: true },
];

function writeTree(root: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function nodeFiles() {
  return {
    "package.json": JSON.stringify({ name: "part3-custom-node", private: true, version: "1.0.0", scripts: { start: "node server.js" }, dependencies: { express: "5.1.0" }, engines: { node: "22.x" } }),
    "package-lock.json": JSON.stringify({ name: "part3-custom-node", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "part3-custom-node", version: "1.0.0", dependencies: { express: "5.1.0" }, engines: { node: "22.x" } } } }),
    "server.js": "const express=require('express');const app=express();app.get('/health',(_,r)=>r.json({status:'ok'}));app.listen(Number(process.env.PORT||3000),'0.0.0.0');",
  };
}

function pythonFiles() {
  return {
    "requirements.txt": "Flask==3.1.0\n",
    "runtime.txt": "python-3.11.13\n",
    "app.py": "from flask import Flask\napp=Flask(__name__)\n@app.get('/health')\ndef health():return {'status':'ok'}\nif __name__=='__main__':app.run(host='0.0.0.0',port=int(__import__('os').environ.get('PORT','5000')))\n",
  };
}

function commandLines(kind: Case["command"], language: Case["language"]) {
  const executable = language === "node" ? "node" : "python";
  const target = language === "node" ? "server.js" : "app.py";
  if (kind === "cmd") return `CMD ["${executable}","${target}"]`;
  if (kind === "entrypoint") return `ENTRYPOINT ["${executable}","${target}"]`;
  if (kind === "entrypoint-cmd") return `ENTRYPOINT ["${executable}"]\nCMD ["${target}"]`;
  return `CMD ${executable} ${target}`;
}

function dockerfile(test: Case) {
  const port = test.language === "node" ? 3000 : 5000;
  const command = commandLines(test.command, test.language);
  if (test.language === "node") {
    const builder = test.multistage
      ? "FROM node:22-alpine3.21 AS build\nWORKDIR /app\nCOPY package*.json ./\nRUN npm install --omit=dev\n"
      : "";
    const install = test.multistage
      ? "COPY --from=build /app/node_modules ./node_modules"
      : "COPY package*.json ./\nRUN npm install --omit=dev";
    return `${builder}FROM node:22-alpine3.21 AS runtime\nWORKDIR /app\n${install}\nCOPY --chown=node:node server.js ./server.js\nEXPOSE ${port}\nUSER node\n${command}\n`;
  }
  const builder = test.multistage
    ? "FROM python:3.11.13-slim AS builder\nRUN python -m venv /opt/venv\nENV PATH=/opt/venv/bin:$PATH\nCOPY requirements.txt /tmp/requirements.txt\nRUN pip install --no-cache-dir -r /tmp/requirements.txt\n"
    : "";
  return `${builder}FROM python:3.11.13-slim AS runtime\nRUN useradd --create-home --shell /usr/sbin/nologin appuser\nWORKDIR /app\n${test.multistage ? "COPY --from=builder /opt/venv /opt/venv\nENV PATH=/opt/venv/bin:$PATH" : "COPY requirements.txt .\nRUN pip install --no-cache-dir -r requirements.txt"}\nCOPY --chown=appuser:appuser app.py ./app.py\nEXPOSE ${port}\nUSER appuser\n${command}\n`;
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

async function contractFor(root: string, preferredRoot: string | null = null) {
  const project: any = {
    id: "61616161-6161-4161-8161-616161616161",
    repositoryUrl: "https://github.com/fixture/part3-custom",
    repositoryFullName: "fixture/part3-custom",
    targetBranch: "main",
    appDirectory: preferredRoot,
    deploymentOverrides: { dockerfileMode: "custom" },
  };
  const detector = new StackDetectionService(new TemplateMatchingService(), new RepoDeployabilityScannerService());
  const draft = detector.detect(root, "d".repeat(40), preferredRoot, project.deploymentOverrides);
  draft.rawProfile.inputFingerprintVersion = DETECTION_INPUT_FINGERPRINT_VERSION;
  const profile: any = {
    id: "62626262-6262-4262-8262-626262626262",
    projectId: project.id,
    repositoryUrl: project.repositoryUrl,
    repositoryFullName: project.repositoryFullName,
    targetBranch: project.targetBranch,
    inputFingerprint: detectionFingerprint(project, draft.commitSha),
    ...draft,
  };
  let persisted: any = null;
  const service = new DeploymentContractService(
    { findOne: async () => persisted, create: (value: any) => ({ id: "63636363-6363-4363-8363-636363636363", ...value }), save: async (value: any) => { persisted = value; return value; } } as any,
    {} as any, {} as any, { find: async () => [] } as any,
    { findOne: async () => null, create: (value: any) => value, save: async (value: any) => value } as any,
    new TemplateRegistryService(), new DockerTemplateEngineService(), { get: (_key: string, fallback: unknown) => fallback } as any,
  );
  return { draft, contract: await service.upsertFromDetection(project, profile) };
}

function preflight(root: string, plan: any, image: string, expectedPass: boolean, label: string) {
  mkdirSync(join(root, ".deployguard"), { recursive: true });
  writeFileSync(join(root, ".deployguard/build-plan.json"), JSON.stringify(plan));
  writeFileSync(join(root, ".deployguard/component-images.json"), JSON.stringify((plan.components || []).map((component: any) => ({ ...component, imageUri: image }))));
  const runtimeEnvironment = { HOST: "0.0.0.0", NODE_ENV: "production", AWS_REGION: "us-east-1", AWS_DEFAULT_REGION: "us-east-1", DEPLOYGUARD_PROJECT_ID: "61616161-6161-4161-8161-616161616161", DEPLOYGUARD_OPERATION_ID: "64646464-6464-4464-8464-646464646464", DEPLOYGUARD_ENVIRONMENT: "dev", DEPLOYGUARD_APP_LOG_GROUP: "/deployguard/part3/app", DEPLOYGUARD_DATABASE_LOG_GROUP: "/deployguard/part3/database", DEPLOYGUARD_DEPLOYMENT_LOG_GROUP: "/deployguard/part3/deployment" };
  writeFileSync(join(root, ".deployguard/runtime-config.json"), JSON.stringify({
    environment: { PORT: String(plan.port), ...runtimeEnvironment },
    secretReferences: {},
    componentRuntime: Object.fromEntries((plan.components || []).map((component: any) => [component.id, {
      environment: { PORT: String(component.port), ...runtimeEnvironment }, secretReferences: {},
    }])),
    managedDatabase: null,
  }));
  runSequence += 1;
  const result = spawnSync("bash", [preflightScript], { cwd: root, encoding: "utf8", timeout: 120_000, env: { ...process.env, OPERATION_ID: `64646464-6464-4464-8464-${String(runSequence).padStart(12, "0")}`, GITHUB_RUN_ID: `${process.pid}${runSequence}`, RUNNER_TEMP: root, DEPLOYGUARD_PREFLIGHT_ATTEMPTS: expectedPass ? "20" : "3" } });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (expectedPass) {
    assert.equal(result.status, 0, `${label}\n${output}`);
    assert.match(output, /Executable immutable application contract passed before persistence and Terraform/);
  } else {
    assert.notEqual(result.status, 0, `${label}: mutation unexpectedly passed`);
    assert.match(output, /EXECUTABLE_PREFLIGHT_FAILED|failed|not found|executable|readiness/i);
  }
}

function build(root: string, dockerfilePath: string, image: string) {
  execFileSync("docker", ["buildx", "build", "--load", "-f", dockerfilePath, "-t", image, "."], { cwd: root, stdio: "inherit", timeout: 360_000 });
  images.push(image);
  const user = execFileSync("docker", ["image", "inspect", image, "--format", "{{.Config.User}}"], { encoding: "utf8" }).trim();
  assert.ok(user && !["0", "root", "0:0", "root:root"].includes(user), "custom runtime must be non-root");
  const inspect = execFileSync("docker", ["image", "inspect", image], { encoding: "utf8" });
  const history = execFileSync("docker", ["history", "--no-trunc", image], { encoding: "utf8" });
  assert.doesNotMatch(`${inspect}\n${history}`, /PART3_PRIVATE_SECRET_VALUE/);
}

async function positiveMatrix() {
  for (const test of cases) {
    const root = mkdtempSync(join(suiteRoot, `${test.name}-`));
    const appRoot = test.preferredRoot ? join(root, test.preferredRoot) : root;
    writeTree(appRoot, test.language === "node" ? nodeFiles() : pythonFiles());
    writeTree(appRoot, { [test.dockerfilePath]: dockerfile(test) });
    const { draft, contract } = await contractFor(root, test.preferredRoot || null);
    assert.equal(draft.detectionStatus, "success", `${test.name}: ${draft.errors.join(" | ")}`);
    assert.equal(contract.deployable, true, `${test.name}: ${contract.blockers.join(" | ")}`);
    assert.ok(["READY", "READY_WITH_WARNINGS"].includes(evaluateBuildPlanReadiness(contract.buildPlan).status));
    const component = contract.buildPlan.components![0];
    assert.equal(component.dockerStrategy, "custom");
    assert.equal(component.dockerfilePath, test.dockerfilePath);
    assert.equal(component.runCommand, test.language === "node" ? "node server.js" : "python app.py");
    assert.deepEqual(JSON.parse(Buffer.from(buildPlanWorkflowInputs(contract.buildPlan).build_plan_base64, "base64").toString("utf8")), contract.buildPlan);
    const image = `deployguard-certification-part3:${process.pid}-${test.name}`;
    build(appRoot, test.dockerfilePath, image);
    preflight(appRoot, contract.buildPlan, image, true, test.name);
    console.log(`PASS ${test.name}: ${test.preferredRoot ? `${test.preferredRoot}/` : ""}${test.dockerfilePath} -> immutable BuildPlan -> non-root image -> executable preflight`);
  }
}

async function staticMutation(name: string, files: Record<string, string>, expected: RegExp) {
  const root = mkdtempSync(join(suiteRoot, `${name}-`));
  writeTree(root, { ...nodeFiles(), ...files });
  const { draft, contract } = await contractFor(root);
  assert.match(`${draft.errors.join(" ")} ${contract.blockers.join(" ")}`, expected, name);
  assert.equal(contract.deployable, false, name);
  assert.equal(evaluateBuildPlanReadiness(contract.buildPlan).status, "BLOCKED", name);
  console.log(`PASS ${name}: blocked before Terraform`);
}

async function negativeMatrix() {
  const base = dockerfile(cases[0]);
  await staticMutation("missing-final-command", { Dockerfile: base.replace(/CMD \["node","server\.js"\]\n/, "") }, /final runtime stage has no CMD or ENTRYPOINT/);
  await staticMutation("root-final-runtime", { Dockerfile: base.replace("USER node", "USER root") }, /non-root USER/);
  await staticMutation("secret-build-argument", { Dockerfile: base.replace("FROM node:22-alpine3.21 AS build", "FROM node:22-alpine3.21 AS build\nARG API_SECRET") }, /secret-like build argument/);
  await staticMutation("conflicting-port", { "server.js": "const express=require('express');const app=express();app.get('/health',(_,r)=>r.send('ok'));app.listen(5000,'0.0.0.0');", Dockerfile: base.replace(/EXPOSE 3000/, "EXPOSE 8000") }, /PORT_IDENTITY_AMBIGUOUS|Conflicting proven server ports/);
  await staticMutation("ambiguous-dockerfile-path", { Dockerfile: base, "Dockerfile.prod": base }, /multiple Dockerfile paths are plausible/);

  const root = mkdtempSync(join(suiteRoot, "invalid-runtime-command-"));
  writeTree(root, { ...nodeFiles(), Dockerfile: base.replace("server.js\"]", "missing.js\"]") });
  const { contract } = await contractFor(root);
  assert.equal(contract.deployable, true, "the command exists structurally and must be disproved by execution");
  const image = `deployguard-certification-part3:${process.pid}-invalid-command`;
  build(root, "Dockerfile", image);
  preflight(root, contract.buildPlan, image, false, "invalid runtime command");
  console.log("PASS invalid-runtime-command: exact executable preflight failed before Terraform");
}

async function main() {
  extractPreflight();
  await positiveMatrix();
  await negativeMatrix();
  const source = readFileSync(workflow, "utf8");
  assert.ok(source.indexOf("Execute immutable application contract before AWS mutation") < source.indexOf("Terraform plan and apply"));
  assert.match(source, /docker buildx build --check -f "\$DOCKERFILE_PATH"/);
  assert.match(source, /immutable runtime image must declare a non-root user/i);
  console.log("Part 3 custom Dockerfile and adversarial command/port/security matrix passed; Terraform was not executed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const image of images) spawnSync("docker", ["image", "rm", "-f", image], { stdio: "ignore" });
  rmSync(suiteRoot, { recursive: true, force: true });
});
