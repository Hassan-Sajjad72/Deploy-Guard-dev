import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSerializedRefresh } from "../src/hooks/useSerializedProjectRefresh.js";

function deferred() {
  let resolve;
  return { promise: new Promise((complete) => { resolve = complete; }), resolve };
}

const overview = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");
for (const page of [overview, pipeline]) {
  assert.match(page, /if \(!isCurrent\(\)\) return;/, "a superseded response must not update page state");
}

const stalePrepare = deferred();
const freshLive = deferred();
const responses = [
  { completion: stalePrepare, snapshot: { phase: "prepare", authority: "DEPLOYING" } },
  { completion: freshLive, snapshot: { phase: "verify", authority: "LIVE" } },
];
let responseIndex = 0;
let rendered = { phase: "deploy", authority: "DEPLOYING" };
const renderedPhases = [rendered.phase];
const poll = createSerializedRefresh(async ({ isCurrent }) => {
  const response = responses[responseIndex++];
  await response.completion.promise;
  if (!isCurrent()) return;
  rendered = response.snapshot;
  renderedPhases.push(rendered.phase);
});

const firstPoll = poll();
const queuedPoll = poll();
assert.equal(firstPoll, queuedPoll, "polling must not overlap requests for one operation");

stalePrepare.resolve();
await Promise.resolve();
await Promise.resolve();
assert.deepEqual(rendered, { phase: "deploy", authority: "DEPLOYING" }, "a superseded Prepare response cannot regress an already-rendered Deploy phase");

freshLive.resolve();
await firstPoll;
assert.deepEqual(rendered, { phase: "verify", authority: "LIVE" });
assert.deepEqual(renderedPhases, ["deploy", "verify"], "the rendered lifecycle cannot move backward when an older response arrives out of order");

console.log("Rollback polling stage-monotonicity regression checks passed.");
