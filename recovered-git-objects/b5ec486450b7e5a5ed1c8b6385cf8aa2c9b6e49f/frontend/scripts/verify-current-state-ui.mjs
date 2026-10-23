import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

const projects = readFileSync(new URL("../src/pages/Projects.jsx", import.meta.url), "utf8");
const overview = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const admin = readFileSync(new URL("../src/pages/AdminCloudCleanup.jsx", import.meta.url), "utf8");

assert.match(projects, /deploymentStatus/);
assert.match(projects, /healthStatus/);
assert.match(projects, /resourceStatus/);
assert.doesNotMatch(projects, /liveDeployment\?\.available\) return "Live"/);
assert.match(overview, /Deployment URL stale/);
assert.match(overview, /historicalHostname/);
assert.match(overview, /state\.isDeploymentJobActive && state\.runControls\?\.canCancel/);
assert.match(overview, /Infrastructure provisioned, but app live verification failed\./);
assert.match(overview, /Infra ready/);
assert.doesNotMatch(overview, /\["queued", "running"\]\.includes\(state\.latestPipeline\?\.status\)/);
assert.match(admin, /Inventory unavailable/);
assert.match(admin, /No zero counts or clean-state conclusions/);
assert.match(admin, /!authUnavailable/);

console.log("Authoritative current-state UI verification passed.\n");
