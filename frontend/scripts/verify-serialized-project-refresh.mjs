import assert from "node:assert/strict";
import { createSerializedRefresh } from "../src/hooks/useSerializedProjectRefresh.js";

function deferred() {
  let resolve;
  return { promise: new Promise((complete) => { resolve = complete; }), resolve };
}

const first = deferred();
const second = deferred();
const executions = [];
const refresh = createSerializedRefresh(async ({ isCurrent }) => {
  const execution = { isCurrent, completion: executions.length === 0 ? first : second };
  executions.push(execution);
  await execution.completion.promise;
});

const initial = refresh();
const duplicate = refresh();
assert.equal(initial, duplicate, "duplicate refresh triggers must share the active request");
assert.equal(executions.length, 1, "only one request may run at a time");
assert.equal(executions[0].isCurrent(), false, "a queued refresh must invalidate the older response immediately");

first.resolve();
await Promise.resolve();
await Promise.resolve();
assert.equal(executions.length, 2, "a trigger during an active request must result in one follow-up read");

second.resolve();
await initial;

const invalidated = deferred();
const invalidatingRefresh = createSerializedRefresh(async ({ isCurrent }) => {
  await invalidated.promise;
  assert.equal(isCurrent(), false, "route changes must invalidate an earlier project response");
});
const invalidatingRequest = invalidatingRefresh();
invalidatingRefresh.invalidate();
invalidated.resolve();
await invalidatingRequest;

console.log("Serialized project refresh regression checks passed.");
