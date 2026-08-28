import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "@nestjs/config";
import { canonicalDeployguardReusableWorkflow, renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";

const release = "Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
assert.throws(() => canonicalDeployguardReusableWorkflow(new ConfigService({})), /release revision is not configured/i);
assert.equal(canonicalDeployguardReusableWorkflow(new ConfigService({ DEPLOYGUARD_REUSABLE_WORKFLOW: release })), release);
assert.match(renderDeployguardCallerWorkflow(release), new RegExp(`uses: ${release}`), "caller workflow must use the configured canonical release identity exactly");
const admin = readFileSync(join(__dirname, "../src/admin/admin.controller.ts"), "utf8");
assert.match(admin, /releaseIdentity: "exact_immutable"/);
assert.match(admin, /remoteWorkflowCompatibility: "not_checked"/);
assert.match(admin, /does not imply that GitHub has remotely[\s\S]*Dispatch performs that live check/);
console.log("Release identity check passed: no stale reusable-workflow fallback exists; callers use the configured revision; admin distinguishes configured immutable SHA from remote workflow verification.");
