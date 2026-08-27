import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(__dirname, "../..");
const workflow = join(repository, ".github/workflows/deployguard-reusable.yml");
const root = mkdtempSync(join(tmpdir(), "deployguard-executable-preflight-"));
const script = join(root, "preflight.sh");
const image = `deployguard-preflight-fixture:${process.pid}`;

function extractWorkflowScript() {
  execFileSync("python3", ["-c", [
    "import sys,yaml",
    "doc=yaml.safe_load(open(sys.argv[1]))",
    "step=next(x for x in doc['jobs']['deploy']['steps'] if x.get('name')=='Execute immutable application contract before AWS mutation')",
    "open(sys.argv[2],'w').write(step['run'])",
  ].join(";"), workflow, script]);
  execFileSync("bash", ["-n", script]);
}

function fixture(user: string, options: { listenPort?: number; contractPort?: number; command?: string[]; ownership?: Array<Record<string, unknown>>; runtime?: Record<string, string> } = {}) {
  const listenPort = options.listenPort || 8080;
  const contractPort = options.contractPort || 8080;
  mkdirSync(join(root, ".deployguard"), { recursive: true });
  writeFileSync(join(root, "Dockerfile"), [
    "FROM python:3.11-alpine",
    "RUN adduser -D app",
    `USER ${user}`,
    "WORKDIR /app",
    `CMD ${JSON.stringify(options.command || ["python", "-m", "http.server", String(listenPort)])}`,
  ].join("\n"));
  execFileSync("docker", ["build", "-q", "-t", image, root], { stdio: "inherit" });
  const component = { id: "frontend", role: "frontend", imageUri: image, port: contractPort, healthPath: "/", healthCheckMode: "http", environmentOwnership: options.ownership || [] };
  writeFileSync(join(root, ".deployguard/component-images.json"), JSON.stringify([component]));
  writeFileSync(join(root, ".deployguard/build-plan.json"), JSON.stringify({ components: [component], relationships: [] }));
  writeFileSync(join(root, ".deployguard/runtime-config.json"), JSON.stringify({
    environment: options.runtime || {}, secretReferences: {}, managedDatabase: null,
    componentRuntime: { frontend: { environment: options.runtime || {}, secretReferences: {} } },
  }));
}

function execute() {
  return spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, OPERATION_ID: "11111111-1111-4111-8111-111111111111", GITHUB_RUN_ID: String(process.pid), RUNNER_TEMP: root, DEPLOYGUARD_PREFLIGHT_ATTEMPTS: "2" },
  });
}

try {
  extractWorkflowScript();
  fixture("app");
  const passed = execute();
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
  assert.match(passed.stdout, /Executable immutable application contract passed before persistence and Terraform/);
  fixture("app", {
    ownership: [{ key: "POSTGRES_USER", componentId: "frontend", phase: "runtime", source: "application", required: true }],
    runtime: { DB_USER: "sibling-alias-only" },
  });
  const missingAlias = execute();
  assert.notEqual(missingAlias.status, 0, "a sibling alias must not satisfy the exact required runtime key");
  assert.match(missingAlias.stderr, /missing required runtime configuration for frontend: POSTGRES_USER/);
  fixture("app", { command: ["sh", "-c", "exit 17"] });
  const crashing = execute();
  assert.notEqual(crashing.status, 0, "a crashing immutable image must fail executable preflight");
  assert.match(crashing.stderr, /component frontend exited during startup|component did not expose its immutable port contract|component failed startup\/readiness/);
  fixture("app", { listenPort: 8080, contractPort: 8099 });
  const wrongPort = execute();
  assert.notEqual(wrongPort.status, 0, "a wrong immutable port contract must fail executable preflight");
  assert.match(wrongPort.stderr, /component failed startup\/readiness/);
  fixture("root");
  const rejected = execute();
  assert.notEqual(rejected.status, 0, "a root final image must fail executable preflight");
  assert.match(rejected.stderr, /configured to run as root/);
  const source = readFileSync(workflow, "utf8");
  const gate = source.indexOf("- name: Execute immutable application contract before AWS mutation");
  assert.ok(gate > source.indexOf("- name: Build and push immutable image"));
  assert.ok(gate < source.indexOf("- name: Prepare project-scoped persistence"));
  assert.ok(gate < source.indexOf("- name: Terraform plan and apply"));
  assert.match(source, /trap cleanup_executable_preflight EXIT/);
  assert.equal(spawnSync("docker", ["network", "inspect", `dg-preflight-11111111-${process.pid}`], { stdio: "ignore" }).status, 1, "temporary preflight network is always removed");
  console.log("Executable pre-AWS contract gate passed with the real workflow shell: success, missing exact alias, crash, wrong port, non-root enforcement, cleanup and order are verified.");
} finally {
  spawnSync("docker", ["image", "rm", "-f", image], { stdio: "ignore" });
  rmSync(root, { recursive: true, force: true });
}
