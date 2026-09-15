import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(__dirname, "..", "..");
const fallbackRoot = join(root, "infrastructure", "docker-fallback");
const cli = join(fallbackRoot, "fallback-contract.mjs");
const manifestPath = join(fallbackRoot, "templates.json");
const workflow = readFileSync(join(root, ".github", "workflows", "deployguard-reusable.yml"), "utf8");
const template = readFileSync(join(fallbackRoot, "node22-npm-workspace.Dockerfile"), "utf8");
const builder = readFileSync(join(fallbackRoot, "build-images.sh"), "utf8");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const temp = mkdtempSync(join(tmpdir(), "deployguard-fallback-"));

const classify = (exitCode: number, evidence: string, complete = true) => {
  const evidencePath = join(temp, `evidence-${Math.random()}.log`); writeFileSync(evidencePath, evidence);
  const result = spawnSync("node", [cli, "classify", "--exit-code", String(exitCode), "--evidence", evidencePath, "--complete", String(complete), "--railpack-version", "0.38.0", "--railpack-sha256", "7c3f0e70ca8bf80bde87e8c30cb0171414c2b6bbd794d6f60a19cc3b71772950"], { encoding: "utf8" });
  return { status: result.status, value: JSON.parse(result.stdout) };
};

try {
  const ordinaryFailures = [
    "npm ERR! code ERESOLVE dependency tree", "error TS2322: source compilation failed", "failed to solve: BuildKit unavailable",
    "GET https://registry.npmjs.org/example failed: ETIMEDOUT", "application failed to start", "bind 127.0.0.1 instead of PORT",
    "database authentication failed", "DG_FAILURE code=DG_RAILPACK_BUILD_FAILED stage=railpack_build", "unknown failure",
  ];
  for (const evidence of ordinaryFailures) assert.equal(classify(1, evidence).value.decision, "NOT_ELIGIBLE", evidence);
  assert.equal(classify(2, "panic: internal\ngoroutine 1 [running]:\ngithub.com/railwayapp/railpack/core.Generate()\ncontext canceled").value.decision, "NOT_ELIGIBLE", "cancel evidence never falls back");
  assert.equal(classify(2, "panic: internal\ngoroutine 1 [running]:\ngithub.com/customer/application.main()").value.decision, "NOT_ELIGIBLE", "application panic never impersonates Railpack");
  assert.equal(classify(2, "panic: internal\ngoroutine 1 [running]:\ngithub.com/railwayapp/railpack/core.Generate()").value.decision, "ELIGIBLE", "pinned Railpack-owned panic is deterministic internal evidence");
  assert.equal(classify(2, "panic: internal\ngoroutine 1 [running]:\ngithub.com/railwayapp/railpack/core.Generate()", false).value.decision, "NOT_ELIGIBLE", "incomplete evidence fails closed");

  const service = {
    serviceId: "11111111-1111-4111-8111-111111111111", runtimeConfigRevisionId: "22222222-2222-4222-8222-222222222222", runtimeConfigFingerprint: "a".repeat(64),
    buildTargetRevisionId: "33333333-3333-4333-8333-333333333333", buildEnvironment: { RAILPACK_NODE_VERSION: "22.14.0", PUBLIC_API_ORIGIN: "https://example.test" }, buildSecretReferences: { TOKEN: "sealed-reference" },
    buildTarget: { resolverVersion: "deployguard.build-target/v2", status: "resolved", contract: "JS_WORKSPACE_MEMBER", packageIdentity: "api", workspaceRoot: ".", buildRoot: ".", installRoot: ".", fingerprint: "b".repeat(64), execution: { packageManager: "npm", packageTarget: "api", buildCommand: "npm --workspace api run build", startCommand: "npm --workspace api run start" } },
  };
  const servicePath = join(temp, "service.json"); writeFileSync(servicePath, JSON.stringify(service));
  const select = (manifestFile: string, ledger: string) => spawnSync("node", [cli, "select", "--service", servicePath, "--manifest", manifestFile, "--root", fallbackRoot, "--ledger", ledger], { encoding: "utf8" });
  const selected = select(manifestPath, join(temp, "attempt")); assert.equal(selected.status, 0); assert.equal(JSON.parse(selected.stdout).templateId, "node22-npm-workspace");
  const repeated = select(manifestPath, join(temp, "attempt")); assert.equal(JSON.parse(repeated.stdout).code, "DG_DOCKER_FALLBACK_ALREADY_ATTEMPTED");
  const unsupported = structuredClone(service); unsupported.buildEnvironment.RAILPACK_NODE_VERSION = "20.0.0"; writeFileSync(servicePath, JSON.stringify(unsupported));
  assert.equal(JSON.parse(select(manifestPath, join(temp, "unsupported")).stdout).code, "DG_DOCKER_FALLBACK_UNSUPPORTED");
  writeFileSync(servicePath, JSON.stringify(service));
  const ambiguousPath = join(temp, "ambiguous.json"); writeFileSync(ambiguousPath, JSON.stringify({ ...manifest, templates: [...manifest.templates, { ...manifest.templates[0], id: "duplicate" }] }));
  assert.equal(JSON.parse(select(ambiguousPath, join(temp, "ambiguous")).stdout).code, "DG_DOCKER_FALLBACK_CONTRACT_INVALID");
  const corruptPath = join(temp, "corrupt.json"); writeFileSync(corruptPath, JSON.stringify({ ...manifest, templates: [{ ...manifest.templates[0], sha256: "c".repeat(64) }] }));
  assert.equal(JSON.parse(select(corruptPath, join(temp, "corrupt")).stdout).code, "DG_DOCKER_FALLBACK_TEMPLATE_INTEGRITY_FAILED");

  assert.equal(manifest.templates[0].sha256, createHash("sha256").update(template).digest("hex"), "certified template digest is immutable");
  assert.match(template, /^FROM node:[^\n]+@sha256:[0-9a-f]{64} AS build/m); assert.match(template, /^FROM node:[^\n]+@sha256:[0-9a-f]{64} AS runtime/m);
  assert.match(template, /--mount=type=secret,id=deployguard_build_environment/); assert.match(template, /--mount=type=secret,id=deployguard_build_secrets/); assert.match(template, /USER node/);
  assert.doesNotMatch(template, /ARG\s+(?:TOKEN|SECRET|PASSWORD|API_KEY)|ENV\s+(?:TOKEN|SECRET|PASSWORD|API_KEY)/i);
  assert.match(workflow, /Build immutable Railpack images[\s\S]*build-images\.sh/); assert.match(workflow, /Build immutable Railpack images[\s\S]*Validate Application Runtime[\s\S]*Publish immutable images to ECR/);
  assert.doesNotMatch(workflow, /(?:docker build|build-images\.sh)[^\n]*(?:rollback|destroy)/i, "rollback/destroy do not invoke fallback");
  assert.match(workflow, /Preserve authoritative deployment failure evidence/); assert.match(workflow, /deployguard\.failure-event\/v1/);
  assert.match(builder, /docker image inspect[^\n]+\|\| true/, "a missing image must reach the authoritative failure classifier");
  assert.match(builder, /if \[ "\$builder" = railpack \][\s\S]*DG_RAILPACK_BUILD_FAILED[\s\S]*DG_DOCKER_FALLBACK_BUILD_FAILED/, "missing images retain primary-versus-fallback failure ownership");
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8" });
  assert.equal(docker.status, 0, "Docker is required for executable fallback-template certification");
  const fixture = join(temp, "fixture"); const workspace = join(fixture, "packages", "api"); mkdirSync(workspace, { recursive: true });
  writeFileSync(join(fixture, "package.json"), JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/api"] }));
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "api", version: "1.0.0", scripts: { build: "node -e \"require('fs').writeFileSync('built.txt', process.env.BUILD_LABEL)\"", start: "node server.js" } }));
  writeFileSync(join(workspace, "server.js"), "require('http').createServer((_,res)=>res.end('ok')).listen(Number(process.env.PORT||8080),'0.0.0.0');\n");
  const locked = spawnSync("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: fixture, encoding: "utf8" }); assert.equal(locked.status, 0, locked.stderr);
  const publicEnv = join(temp, "public.json"); const secretEnv = join(temp, "secrets.json"); const secretValue = "fallback-secret-must-not-persist-93841";
  writeFileSync(publicEnv, JSON.stringify({ BUILD_LABEL: "certified" })); writeFileSync(secretEnv, JSON.stringify({ BUILD_TOKEN: secretValue }));
  const tag = `deployguard-fallback-cert-${process.pid}`;
  const built = spawnSync("docker", ["build", "--file", join(fallbackRoot, "node22-npm-workspace.Dockerfile"), "--build-arg", "DG_PACKAGE_TARGET=api", "--secret", `id=deployguard_build_environment,src=${publicEnv}`, "--secret", `id=deployguard_build_secrets,src=${secretEnv}`, "--tag", tag, fixture], { encoding: "utf8", timeout: 180_000 });
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  const user = spawnSync("docker", ["image", "inspect", "--format", "{{.Config.User}}", tag], { encoding: "utf8" }); assert.equal(user.stdout.trim(), "node");
  const history = spawnSync("docker", ["history", "--no-trunc", tag], { encoding: "utf8" }); assert.doesNotMatch(history.stdout, new RegExp(secretValue));
  spawnSync("docker", ["image", "rm", "--force", tag], { encoding: "utf8" });
  console.log("DOCKER_FALLBACK_ELIGIBILITY=PASS");
  console.log("DOCKER_FALLBACK_EXACT_SELECTION=PASS");
  console.log("DOCKER_FALLBACK_SINGLE_ATTEMPT=PASS");
  console.log("DOCKER_FALLBACK_SECURITY=PASS");
  console.log("DOCKER_FALLBACK_EXECUTABLE_BUILD=PASS NON_ROOT=1 SECRET_HISTORY=0");
  console.log("DOCKER_FALLBACK_LIFECYCLE_BOUNDARY=PASS");
} finally { rmSync(temp, { recursive: true, force: true }); }
