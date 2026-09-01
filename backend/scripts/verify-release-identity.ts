import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ConfigService } from "@nestjs/config";
import { canonicalDeployguardReusableWorkflow, renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";

const canonicalSha = "a9bcc72df2047de64cb4034960d4df72da3e9c1f";
const release = `Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@${canonicalSha}`;
const retiredSha = "2a769bd922a2561876d71def13d306360958d8d9";
assert.throws(() => canonicalDeployguardReusableWorkflow(new ConfigService({})), /release revision is not configured/i);
assert.equal(canonicalDeployguardReusableWorkflow(new ConfigService({ DEPLOYGUARD_REUSABLE_WORKFLOW: release })), release);
assert.match(renderDeployguardCallerWorkflow(release), new RegExp(`uses: ${release}`), "caller workflow must use the configured canonical release identity exactly");
const localRuntimeEnvironment = join(__dirname, "../.env");
if (existsSync(localRuntimeEnvironment)) {
  const configured = readFileSync(localRuntimeEnvironment, "utf8").match(/^DEPLOYGUARD_REUSABLE_WORKFLOW=(.+)$/m)?.[1];
  assert.equal(configured, release, "active local backend runtime configuration must use the canonical immutable workflow SHA");
}
const staleTracked = spawnSync("git", ["grep", "-n", retiredSha, "--", ":(exclude)backend/scripts/verify-configuration-admission.ts", ":(exclude)backend/scripts/verify-release-identity.ts"], { cwd: join(__dirname, "..", ".."), encoding: "utf8" });
assert.equal(staleTracked.status, 1, `the retired workflow SHA must not remain in tracked active configuration: ${staleTracked.stdout}`);
const admin = readFileSync(join(__dirname, "../src/admin/admin.controller.ts"), "utf8");
assert.match(admin, /releaseIdentity: "exact_immutable"/);
assert.match(admin, /remoteWorkflowCompatibility: "not_checked"/);
assert.match(admin, /does not imply that GitHub has remotely[\s\S]*Dispatch performs that live check/);
console.log(`RELEASE_IDENTITY=PASS CANONICAL_SHA=${canonicalSha} ACTIVE_OLD_SHA=0 IMMUTABLE_PIN_REQUIRED=1`);
