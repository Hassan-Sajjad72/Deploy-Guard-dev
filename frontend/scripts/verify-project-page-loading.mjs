import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProjectRefreshLifecycle, createSerializedRefresh } from "../src/hooks/useSerializedProjectRefresh.js";

function deferred() {
  let resolve;
  return { promise: new Promise((complete) => { resolve = complete; }), resolve };
}

async function verifyInitialLoad(pageName, page, outcome, expectedError = "") {
  assert.match(page, /useSerializedProjectRefresh\(/, `${pageName} must use the shared refresh lifecycle`);
  assert.match(page, /await Promise\.all\(\[/, `${pageName} must wait for its complete initial read set`);
  assert.match(page, /catch \(caught\)/, `${pageName} must render an initial-load error`);
  assert.match(page, /if \(!projectStatePresentation\(currentState\)\.active\) return undefined;/, `${pageName} must not start polling before current state is loaded`);

  const strictModeProbe = deferred();
  const responses = [strictModeProbe.promise, outcome];
  let loading = true;
  let error = "";
  let acceptedReads = 0;
  const lifecycle = createProjectRefreshLifecycle(() => createSerializedRefresh(async ({ isCurrent }) => {
    try {
      await responses.shift();
      if (!isCurrent()) return;
      acceptedReads += 1;
      loading = false;
      error = "";
    } catch (caught) {
      if (!isCurrent()) return;
      acceptedReads += 1;
      loading = false;
      error = caught.message;
    }
  }));

  lifecycle.mount();
  const abandonedProbe = lifecycle.refresh();
  lifecycle.dispose();
  lifecycle.mount();
  await lifecycle.refresh();

  assert.equal(loading, false, `${pageName} initial loading must resolve after the Strict Mode effect restart`);
  assert.equal(acceptedReads, 1, `${pageName} must accept the real mount result`);
  assert.equal(error, expectedError, `${pageName} must render either its data or its error state`);

  strictModeProbe.resolve();
  await abandonedProbe;

  return { lifecycle, get loading() { return loading; } };
}

const overview = readFileSync(new URL("../src/pages/ProjectDetails.jsx", import.meta.url), "utf8");
const pipeline = readFileSync(new URL("../src/pages/ProjectPipeline.jsx", import.meta.url), "utf8");

await verifyInitialLoad("Overview", overview, Promise.resolve());
await verifyInitialLoad("Pipeline", pipeline, Promise.resolve());
await verifyInitialLoad("Overview error", overview, Promise.resolve().then(() => { throw new Error("Overview read failed"); }), "Overview read failed");
await verifyInitialLoad("Pipeline error", pipeline, Promise.resolve().then(() => { throw new Error("Pipeline read failed"); }), "Pipeline read failed");

for (const [pageName, page] of [["Overview", overview], ["Pipeline", pipeline]]) {
  const refreshes = [Promise.resolve(), Promise.resolve(), Promise.resolve()];
  let loading = true;
  const lifecycle = createProjectRefreshLifecycle(() => createSerializedRefresh(async ({ isCurrent }) => {
    await refreshes.shift();
    if (isCurrent()) loading = false;
  }));
  lifecycle.mount();
  await lifecycle.refresh();
  const firstPoll = lifecycle.refresh();
  const duplicatePoll = lifecycle.refresh();
  assert.equal(firstPoll, duplicatePoll, `${pageName} polling must share an in-flight refresh`);
  await firstPoll;
  assert.equal(loading, false, `${pageName} polling cannot return the page to a permanent loading state`);
  assert.match(page, /window\.setInterval\(load,/, `${pageName} must keep polling through the shared serialized refresh`);
}

console.log("Project Overview/Pipeline initial-loading lifecycle regression checks passed.");
