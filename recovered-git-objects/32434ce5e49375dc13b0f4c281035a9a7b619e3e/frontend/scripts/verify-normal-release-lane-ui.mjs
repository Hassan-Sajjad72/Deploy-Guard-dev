import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";

const api = readFileSync(new URL("../src/api/projectApi.js", import.meta.url), "utf8");
const details = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("../src/pages/Dashboard.jsx", import.meta.url), "utf8");
const detailsPanel = readFileSync(new URL("../src/components/projects/ReleaseLaneDeveloperDetails.jsx", import.meta.url), "utf8");

assert.match(api, /release-lane\/prepare/);
assert.match(api, /release-lane\/status/);
for (const source of [details, pipeline]) {
  assert.match(source, /prepareNormalReleaseLane/);
  assert.doesNotMatch(source, /getNormalReleaseLaneStatus/);
  assert.match(source, /(?:releaseLane|prepared)\?\.state === "prepared"/);
  assert.match(source, /(?:releaseLane|prepared)\?\.fallbackToLegacy/);
  assert.match(source, /Release prepared; execution is not enabled\./);
  assert.match(source, /startProjectAutomation/);
}
assert.match(details, /releaseLaneMessage\(state\.releaseLane\)/);
assert.match(pipeline, /releaseLaneMessage\(current\.releaseLane\)/);
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
assert.match(detailsPanel, /intent\?\.events/);
assert.match(detailsPanel, /Latest intent events/);
assert.match(detailsPanel, /prepared: "Prepared"/);
assert.match(detailsPanel, /event\.code/);
assert.match(detailsPanel, /slice\(-4\)/);
assert.doesNotMatch(detailsPanel, /intent\?\.id/);
assert.match(dashboard, /currentState\?\.activeRunCount/);
assert.doesNotMatch(dashboard, /releaseLane/);

console.log("Normal release-lane UI fallback verification passed");
