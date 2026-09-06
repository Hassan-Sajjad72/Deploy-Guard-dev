import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ConfigService } from "@nestjs/config";
import { canonicalDeployguardReusableWorkflow, renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";
import { assertReusableWorkflowCompatibility, generatedCallerWithKeys, parsePinnedReusableWorkflow } from "../src/projects/github-actions-workflow-contract";

const repositoryRoot = join(__dirname, "..", "..");
const localRuntimeEnvironment = join(__dirname, "../.env");
const configured = process.env.DEPLOYGUARD_REUSABLE_WORKFLOW
  || (existsSync(localRuntimeEnvironment) ? readFileSync(localRuntimeEnvironment, "utf8").match(/^DEPLOYGUARD_REUSABLE_WORKFLOW=(.+)$/m)?.[1] : null)
  || "";
const pinned = parsePinnedReusableWorkflow(configured);
const canonicalSha = pinned.sha;
const release = pinned.reference;
const retiredSha = "2a769bd922a2561876d71def13d306360958d8d9";
assert.throws(() => canonicalDeployguardReusableWorkflow(new ConfigService({})), /release revision is not configured/i);
assert.equal(canonicalDeployguardReusableWorkflow(new ConfigService({ DEPLOYGUARD_REUSABLE_WORKFLOW: release })), release);
assert.match(renderDeployguardCallerWorkflow(release), new RegExp(`uses: ${release}`), "caller workflow must use the configured canonical release identity exactly");
assert.equal(configured, release, "active backend runtime configuration must use the exact immutable workflow reference under certification");
const controlPlanePaths = [
  ".github/workflows/deployguard-reusable.yml",
  "infrastructure/railpack-runtime/build-release-result.sh",
  "infrastructure/railpack-runtime/register-release-task-definitions.sh",
  "infrastructure/railpack-runtime/verify-runtime.sh",
  "infrastructure/railpack-runtime/main.tf",
] as const;
const atConfiguredRelease = Object.fromEntries(controlPlanePaths.map((path) => {
  const result = spawnSync("git", ["show", `${canonicalSha}:${path}`], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `configured control-plane release must contain ${path}: ${result.stderr}`);
  assert.equal(result.stdout, readFileSync(join(repositoryRoot, path), "utf8"), `working ${path} bytes must equal the exact configured immutable release`);
  return [path, result.stdout];
}));
const caller = renderDeployguardCallerWorkflow(release);
const certification = assertReusableWorkflowCompatibility(
  atConfiguredRelease[".github/workflows/deployguard-reusable.yml"],
  pinned,
  generatedCallerWithKeys(caller),
  {
    releaseResultProducer: atConfiguredRelease["infrastructure/railpack-runtime/build-release-result.sh"],
    releaseOnlyTaskDefinitions: atConfiguredRelease["infrastructure/railpack-runtime/register-release-task-definitions.sh"],
    runtimeVerifier: atConfiguredRelease["infrastructure/railpack-runtime/verify-runtime.sh"],
    runtimeInfrastructure: atConfiguredRelease["infrastructure/railpack-runtime/main.tf"],
  },
);
assert.equal(certification.sha, canonicalSha);
const staleTracked = spawnSync("git", ["grep", "-n", retiredSha, "--", ":(exclude)backend/scripts/verify-configuration-admission.ts", ":(exclude)backend/scripts/verify-release-identity.ts"], { cwd: repositoryRoot, encoding: "utf8" });
assert.equal(staleTracked.status, 1, `the retired workflow SHA must not remain in tracked active configuration: ${staleTracked.stdout}`);
const staleCertificationSha = "a077458" + "565d27a4c2cf4b039f68908f1b71052e3";
const staleCertification = spawnSync("git", ["grep", "-n", staleCertificationSha], { cwd: repositoryRoot, encoding: "utf8" });
assert.equal(staleCertification.status, 1, `certification must not retain the stale a077458 release assumption: ${staleCertification.stdout}`);
const admin = readFileSync(join(__dirname, "../src/admin/admin.controller.ts"), "utf8");
assert.match(admin, /releaseIdentity: "exact_immutable"/);
assert.match(admin, /remoteWorkflowCompatibility: "not_checked"/);
assert.match(admin, /does not imply that GitHub has remotely[\s\S]*Dispatch performs that live check/);
console.log(`RELEASE_IDENTITY=PASS CANONICAL_SHA=${canonicalSha} EXACT_EXECUTABLE_BYTES=5 ACTIVE_OLD_SHA=0 IMMUTABLE_PIN_REQUIRED=1`);
