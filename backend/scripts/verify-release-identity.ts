import { strict as assert } from "node:assert";
import { ConfigService } from "@nestjs/config";
import { canonicalDeployguardReusableWorkflow, renderDeployguardCallerWorkflow } from "../src/projects/github-app.service";

const release = "Hassan-Sajjad72/Deploy-Guard-dev/.github/workflows/deployguard-reusable.yml@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
assert.throws(() => canonicalDeployguardReusableWorkflow(new ConfigService({})), /release revision is not configured/i);
assert.equal(canonicalDeployguardReusableWorkflow(new ConfigService({ DEPLOYGUARD_REUSABLE_WORKFLOW: release })), release);
assert.match(renderDeployguardCallerWorkflow(release), new RegExp(`uses: ${release}`), "caller workflow must use the configured canonical release identity exactly");
console.log("Release identity check passed: no stale reusable-workflow fallback exists and the generated caller uses the configured revision.");
