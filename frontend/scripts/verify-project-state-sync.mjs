import { strict as assert } from "node:assert";

const listeners = new Map();
globalThis.window = {
  addEventListener(type, listener) { listeners.set(type, listener); },
  removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
  dispatchEvent() {},
};
globalThis.document = {
  visibilityState: "visible",
  addEventListener(type, listener) { listeners.set(`document:${type}`, listener); },
  removeEventListener(type, listener) { if (listeners.get(`document:${type}`) === listener) listeners.delete(`document:${type}`); },
};

const { subscribeProjectStateChanged } = await import("../src/utils/projectStateSync.js");
const calls = [];
const unsubscribe = subscribeProjectStateChanged("project-1", (...args) => { calls.push(args); });
listeners.get("focus")({ type: "focus" });
listeners.get("pageshow")({ type: "pageshow" });
assert.deepEqual(calls, [[], []], "browser events must never be forwarded as refresh arguments");
unsubscribe();
console.log("PROJECT_STATE_SYNC=PASS");
