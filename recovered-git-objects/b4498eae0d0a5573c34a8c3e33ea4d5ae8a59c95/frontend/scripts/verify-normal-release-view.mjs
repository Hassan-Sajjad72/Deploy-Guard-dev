import { strict as assert } from "node:assert";
import { normalReleaseView } from "../src/utils/normalReleaseView.js";

const operation = {
  latestAttempt: { releaseRevision: 8, status: "completed" },
  terminalResult: "live",
  phases: [
    { key: "analyze", label: "Analyze", status: "passed" },
    { key: "build", label: "Build", status: "passed" },
    { key: "prepare", label: "Prepare", status: "passed" },
    { key: "deploy", label: "Deploy", status: "passed" },
    { key: "verify", label: "Verify", status: "passed" },
  ],
};
const stableRelease = {
  revision: 8,
  status: "stable",
  url: "https://stable.example.test",
};

assert.deepEqual(normalReleaseView(null), null);
assert.deepEqual(normalReleaseView({ releaseLane: { state: "missing" } }), null);
assert.deepEqual(normalReleaseView({
  releaseLane: { state: "completed", intent: { operation }, stableRelease },
}), {
  operation,
  stableRelease,
  status: "live",
  statusLabel: "Live",
  progress: 100,
  phaseLabel: "Verify",
  summary: "Release 8 · Live",
  stableUrl: "https://stable.example.test",
});

const running = normalReleaseView({
  releaseLane: {
    state: "running",
    intent: {
      operation: {
        latestAttempt: { releaseRevision: 9, status: "running" },
        terminalResult: null,
        phases: [
          { key: "analyze", label: "Analyze", status: "passed" },
          { key: "build", label: "Build", status: "running" },
          { key: "prepare", label: "Prepare", status: "not_started" },
        ],
      },
    },
  },
});
assert.equal(running.status, "running");
assert.equal(running.phaseLabel, "Build");
assert.equal(running.progress, 33);
assert.equal(running.stableUrl, null);

const reconciling = normalReleaseView({
  releaseLane: {
    state: "reconciling",
    intent: {
      operation: {
        latestAttempt: { releaseRevision: 9, status: "reconciling" },
        terminalResult: null,
        phases: [
          { key: "analyze", label: "Analyze", status: "passed" },
          { key: "build", label: "Build", status: "passed" },
          { key: "prepare", label: "Prepare", status: "passed" },
          { key: "deploy", label: "Deploy", status: "passed" },
          { key: "verify", label: "Verify", status: "waiting" },
        ],
      },
    },
    stableRelease,
  },
});
assert.equal(reconciling.status, "reconciling");
assert.equal(reconciling.statusLabel, "reconciling");
assert.equal(reconciling.phaseLabel, "Verify");
assert.equal(reconciling.progress, 80);
assert.equal(reconciling.stableUrl, "https://stable.example.test");

const stableOnly = normalReleaseView({
  releaseLane: { state: "completed", stableRelease },
});
assert.equal(stableOnly.summary, "Release 8 · stable");
assert.equal(stableOnly.progress, 100);

console.log("Normal release workspace projection verification passed");
