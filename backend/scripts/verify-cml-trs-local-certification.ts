import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DETECTION_INPUT_FINGERPRINT_VERSION, detectionFingerprint } from "../src/projects/analysis-fingerprint";
import { evaluateBuildPlanReadiness } from "../src/projects/build-plan-readiness";
import { DeploymentContractService } from "../src/projects/deployment-contract.service";
import { RepoDeployabilityScannerService } from "../src/projects/detection/repo-deployability-scanner.service";
import { StackDetectionService } from "../src/projects/detection/stack-detection.service";
import { TemplateMatchingService } from "../src/projects/detection/template-matching.service";
import { DockerTemplateEngineService } from "../src/projects/templates/docker-template-engine.service";
import { TemplateRegistryService } from "../src/projects/templates/template-registry.service";

const expectedCommit = "76870c7db79900308e541e031a4803519cf37d57";
const source = process.env.CML_TRS_SOURCE;
assert.ok(source, "CML_TRS_SOURCE must point to the read-only cml_trs checkout");
assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: source }).toString().trim(), expectedCommit);

const project: any = {
  id: "62000000-0000-4000-8000-000000000001",
  repositoryUrl: "https://github.com/Hassan-Sajjad72/cml_trs",
  repositoryFullName: "Hassan-Sajjad72/cml_trs",
  targetBranch: "main",
  appDirectory: null,
  deploymentOverrides: {},
};
const detector = new StackDetectionService(new TemplateMatchingService(), new RepoDeployabilityScannerService());
const draft = detector.detect(source, expectedCommit);
draft.rawProfile.inputFingerprintVersion = DETECTION_INPUT_FINGERPRINT_VERSION;
const profile: any = {
  id: "62000000-0000-4000-8000-000000000002",
  projectId: project.id,
  repositoryUrl: project.repositoryUrl,
  repositoryFullName: project.repositoryFullName,
  targetBranch: project.targetBranch,
  inputFingerprint: detectionFingerprint(project, draft.commitSha),
  ...draft,
};
let persisted: any = null;
const contracts = new DeploymentContractService(
  { findOne: async () => persisted, create: (value: any) => ({ id: "62000000-0000-4000-8000-000000000003", ...value }), save: async (value: any) => (persisted = value) } as any,
  {} as any, {} as any, { find: async () => [] } as any,
  { findOne: async () => null, create: (value: any) => value, save: async (value: any) => value } as any,
  new TemplateRegistryService(), new DockerTemplateEngineService(),
  { get: (_key: string, fallback: unknown) => fallback } as any,
);

function run(command: string, args: string[], options: Record<string, unknown> = {}) {
  return execFileSync(command, args, { stdio: "inherit", timeout: 300_000, ...options });
}

async function main() {
  const contract: any = await contracts.upsertFromDetection(project, profile);
  const plan = contract.buildPlan;
  const readiness = evaluateBuildPlanReadiness(plan);
  assert.ok(["READY", "READY_WITH_WARNINGS"].includes(readiness.status), `${readiness.status}: ${readiness.blockers.join(" | ")}`);
  assert.equal(contract.deployable, true);
  assert.equal(plan.topology.shape, "DECOUPLED_FRONTEND_BACKEND");
  const frontend = plan.components.find((item: any) => item.role === "frontend");
  const backend = plan.components.find((item: any) => item.role === "backend");
  assert.equal(frontend.frameworkMode, "vite-static");
  assert.equal(backend.frameworkMode, "django-wsgi");
  assert.equal(backend.database.engine, "postgres");
  assert.equal(backend.releaseCommand, "python manage.py migrate --noinput");
  assert.deepEqual(plan.relationships, [{
    from: "frontend", to: "backend", kind: "http", mode: "same-origin", pathPrefix: "/api",
    stripPathPrefix: false, buildTimeVariable: "VITE_API_BASE_URL", verificationPath: null,
  }]);

  const temp = mkdtempSync(join(tmpdir(), "deployguard-cml-runtime-"));
  const suffix = String(process.pid);
  const images: Record<string, string> = { frontend: `deployguard-cml-cert:frontend-${suffix}`, backend: `deployguard-cml-cert:backend-${suffix}` };
  const containers = { database: `deployguard-cml-db-${suffix}`, backend: `deployguard-cml-backend-${suffix}`, frontend: `deployguard-cml-frontend-${suffix}` };
  const network = `deployguard-cml-net-${suffix}`;
  const generated = JSON.parse(contract.generatedDockerfile).components;
  const runtimeSecret = "deployguard-local-cert-runtime-secret";
  try {
    for (const component of [frontend, backend]) {
      const directory = join(temp, component.id);
      cpSync(join(source, component.buildContext), directory, { recursive: true });
      writeFileSync(join(directory, "Dockerfile"), generated[component.id]);
      writeFileSync(join(directory, ".dockerignore"), ".git\n.env\n.env.*\nnode_modules\n__pycache__\n");
      if (component.id === "frontend") {
        writeFileSync(join(directory, ".deployguard-nginx.conf"), "server {\n  listen 8080;\n  server_name _;\n  root /usr/share/nginx/html;\n  location / { try_files $uri $uri/ /index.html; }\n  location /api/ { proxy_pass http://127.0.0.1:8000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; }\n}\n");
        run("docker", ["build", "--pull", "--no-cache", "--build-arg", "VITE_API_BASE_URL=", "-t", images.frontend, directory]);
      } else {
        const buildConfig = join(temp, "build-runtime.json");
        writeFileSync(buildConfig, JSON.stringify({ APP_ENV: "dev", SECRET_KEY: "deployguard-local-build-placeholder", DEBUG: "True", DB_HOST: "deployguard-build.invalid", DB_PORT: "5432", DB_NAME: "build_placeholder", DB_USER: "build_placeholder", DB_PASSWORD: "deployguard-build-placeholder" }), { mode: 0o600 });
        run("docker", ["buildx", "build", "--load", "--pull", "--no-cache", "--secret", `id=deployguard_runtime_config,src=${buildConfig}`, "-t", images.backend, directory]);
      }
      const inspect = execFileSync("docker", ["image", "inspect", images[component.id]]).toString();
      const history = execFileSync("docker", ["history", "--no-trunc", images[component.id]]).toString();
      assert.doesNotMatch(inspect + history, new RegExp(runtimeSecret));
      const user = JSON.parse(inspect)[0].Config.User;
      assert.ok(user && user !== "0" && user !== "root", `${component.id} image must be non-root`);
    }
    const frontendBundle = execFileSync("docker", ["run", "--rm", images.frontend, "sh", "-c", "grep -R 'localhost:8000' /usr/share/nginx/html || true"]).toString();
    assert.equal(frontendBundle.trim(), "", "stale local API origins must not enter the immutable frontend image");

    run("docker", ["network", "create", network]);
    run("docker", ["run", "-d", "--name", containers.database, "--network", network, "-e", "POSTGRES_DB=certdb", "-e", "POSTGRES_USER=certuser", "-e", "POSTGRES_PASSWORD=certpassword", "postgres:16-alpine"]);
    let databaseReady = false;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { execFileSync("docker", ["exec", containers.database, "pg_isready", "-U", "certuser", "-d", "certdb"], { stdio: "ignore" }); databaseReady = true; break; }
      catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
    }
    assert.equal(databaseReady, true);
    run("docker", ["run", "-d", "--name", containers.backend, "--network", network, "-p", "127.0.0.1::8000", "-p", "127.0.0.1::8080", "-e", "PORT=8000", "-e", "APP_ENV=dev", "-e", `SECRET_KEY=${runtimeSecret}`, "-e", "DEBUG=True", "-e", `DB_HOST=${containers.database}`, "-e", "DB_PORT=5432", "-e", "DB_NAME=certdb", "-e", "DB_USER=certuser", "-e", "DB_PASSWORD=certpassword", images.backend]);
    run("docker", ["run", "-d", "--name", containers.frontend, "--network", `container:${containers.backend}`, images.frontend]);
    const publicPort = execFileSync("docker", ["port", containers.backend, "8080/tcp"]).toString().trim().split(":").pop();
    assert.ok(publicPort);
    let rootStatus = "000";
    let relationshipStatus = "000";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        rootStatus = execFileSync("curl", ["-L", "-sS", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${publicPort}/`]).toString();
        relationshipStatus = execFileSync("curl", ["-L", "-sS", "-o", "/dev/null", "-w", "%{http_code}", `http://127.0.0.1:${publicPort}/api/get-events`]).toString();
        if (rootStatus === "200" && relationshipStatus === "200") break;
      } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    assert.equal(rootStatus, "200");
    assert.equal(relationshipStatus, "200");
    assert.notEqual(execFileSync("docker", ["exec", containers.backend, "id", "-u"]).toString().trim(), "0");
    assert.match(execFileSync("docker", ["logs", containers.backend]).toString(), /migrations|No migrations to apply/i);
    console.log(`CML_TRS_LOCAL_CERTIFICATION PASS topology=${plan.topology.shape} frontend=200 relationship=200 components=2`);
  } finally {
    for (const name of [containers.frontend, containers.backend, containers.database]) { try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch {} }
    try { execFileSync("docker", ["network", "rm", network], { stdio: "ignore" }); } catch {}
    for (const image of Object.values(images)) { try { execFileSync("docker", ["image", "rm", "-f", image], { stdio: "ignore" }); } catch {} }
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
