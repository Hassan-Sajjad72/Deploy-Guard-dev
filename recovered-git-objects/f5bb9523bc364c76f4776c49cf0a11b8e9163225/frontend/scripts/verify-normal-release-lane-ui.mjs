import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const api = readFileSync(new URL("../src/api/projectApi.js", import.meta.url), "utf8");
const details = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/pages/Dashboard.jsx", import.meta.url), "utf8");
const billing = readFileSync(new URL("../src/pages/Billing.jsx", import.meta.url), "utf8");
const detailsPanel = readFileSync(new URL("../src/components/projects/ReleaseLaneDeveloperDetails.jsx", import.meta.url), "utf8");
const stablePanel = readFileSync(new URL("../src/components/projects/ReleaseLaneStableSummary.jsx", import.meta.url), "utf8");
const releaseLaneStart = await import("../src/utils/releaseLaneStart.js");

assert.match(api, /release-lane\/prepare/);
assert.match(api, /release-lane\/dispatch/);
assert.match(api, /release-lane\/status/);
for (const source of [details, pipeline]) {
  assert.match(source, /prepareNormalReleaseLane/);
  assert.match(source, /dispatchNormalReleaseLane/);
  assert.doesNotMatch(source, /getNormalReleaseLaneStatus/);
  assert.match(source, /releaseLaneStartInFlight/);
  assert.match(source, /(?:releaseLane|prepared)\?\.state === "prepared"/);
  assert.doesNotMatch(source, /(?:releaseLane|prepared)\?\.fallbackToLegacy/);
  assert.match(source, /releaseLaneBlocksStart/);
  assert.match(source, /Release prepared and queued for controlled execution\./);
  assert.match(source, /(?:prepared|releaseLane)\?\.firstRelease/);
  assert.match(source, /First release foundation prepared; infrastructure execution is not enabled\./);
  assert.match(source, /Release outcome is being reconciled safely\./);
  assert.doesNotMatch(source, /startProjectAutomation|automation\/start|infrastructure\/deploy|orchestration\/deploy/);
}
assert.match(details, /releaseLaneMessage\(state\.releaseLane\)/);
assert.match(pipeline, /releaseLaneMessage\(current\.releaseLane\)/);
assert.match(details, /Release preparation is blocked\./);
assert.match(pipeline, /Release preparation is unavailable for this project\./);
for (const source of [details, pipeline]) {
  assert.match(source, /ReleaseLaneDeveloperDetails/);
  assert.match(source, /\["admin", "developer"\]\.includes\(role\)/);
}
assert.match(detailsPanel, /intent\?\.safeId/);
assert.match(detailsPanel, /intent\?\.releaseManifestRevision/);
assert.match(detailsPanel, /intent\?\.outboxStatus/);
assert.match(detailsPanel, /intent\?\.lifecycleCode/);
assert.match(detailsPanel, /intent\?\.sourceCommitShortSha/);
assert.match(detailsPanel, /intent\?\.lastMeaningfulAt/);
assert.match(detailsPanel, /intent\?\.history/);
assert.match(detailsPanel, /Release history/);
assert.match(detailsPanel, /prepared: "Prepared"/);
assert.match(detailsPanel, /event\.code/);
assert.match(detailsPanel, /slice\(-4\)/);
assert.doesNotMatch(detailsPanel, /intent\?\.id/);
assert.match(stablePanel, /stable\.revision/);
assert.match(stablePanel, /stable\.sourceCommitShortSha/);
assert.match(stablePanel, /stable\.rollbackLineage/);
assert.doesNotMatch(stablePanel, /intent|fenc|journal|arn/i);
for (const source of [details, pipeline]) assert.match(source, /ReleaseLaneStableSummary/);
assert.match(dashboard, /currentState\?\.activeRunCount/);
assert.doesNotMatch(dashboard, /releaseLane/);
assert.match(dashboard, /response\.releaseSummary/);
assert.match(dashboard, /V1 stable releases/);
assert.match(dashboard, /V1 releases needing review/);
assert.match(dashboard, /usage\?\.activeRuns/);
assert.doesNotMatch(dashboard, /getNormalReleaseLaneStatus/);
assert.match(billing, /getWorkspaceSummary/);
assert.match(billing, /Promise\.all\(\[/);
assert.match(billing, /getBillingSummary\(\),\s*getWorkspaceSummary\(\{/);
assert.match(billing, /Workspace v1 releases/);
assert.match(billing, /Recent v1 terminal outcomes/);
assert.match(billing, /Filter release history by project/);
assert.match(billing, /Filter release history by terminal state/);
assert.match(billing, /historyCursor/);
assert.match(billing, /historyPage\.nextCursor/);
assert.match(billing, /getWorkspaceSummary\(\{/);
assert.doesNotMatch(billing, /getNormalReleaseLaneStatus|release-lane\/status/);
assert.equal(releaseLaneStart.releaseLaneBlocksStart({ releaseLane: { state: "queued" } }), true);
assert.equal(releaseLaneStart.releaseLaneBlocksStart({ releaseLane: { state: "blocked" } }), true);
assert.equal(releaseLaneStart.releaseLaneBlocksStart({ releaseLane: { state: "reconciling" } }), true);
assert.equal(releaseLaneStart.releaseLaneBlocksStart({
  releaseLane: { state: "completed", intent: { sourceCommitShortSha: "a".repeat(12) } },
  deploymentContract: { commitSha: "a".repeat(40) },
}), true);
assert.equal(releaseLaneStart.releaseLaneBlocksStart({
  releaseLane: { state: "completed", intent: { sourceCommitShortSha: "a".repeat(12) } },
  deploymentContract: { commitSha: "b".repeat(40) },
}), false);

console.log("Normal release-lane UI handoff verification passed");
