import { strict as assert } from "node:assert";
import { normalReleaseView } from "../src/utils/normalReleaseView.js";

const latestAttempt = {
  status: "live",
  outcome: "completed",
  releaseRevision: "8",
  commit: "abcdef123456",
  occurredAt: "2026-07-30T12:00:00.000Z",
};
const stableRelease = {
  revision: "8",
  commit: "abcdef123456",
  promotedAt: "2026-07-30T12:00:00.000Z",
  rollbackAvailable: true,
};

assert.deepEqual(normalReleaseView(null), null);
assert.deepEqual(normalReleaseView({ latestAttempt: null, stableRelease: null }), null);
assert.deepEqual(normalReleaseView({
  developerState: "live",
  progress: { percentage: 100, phase: "verify", label: "Live" },
  latestAttempt,
  stableRelease,
  stableUrl: "https://stable.example.test",
}), {
  operation: latestAttempt,
  stableRelease,
  status: "live",
  statusLabel: "Live",
  progress: 100,
  phaseLabel: "Live",
  summary: "Release 8 · Live",
  stableUrl: "https://stable.example.test",
});

const running = normalReleaseView({
  developerState: "building",
  progress: { percentage: 20, phase: "build", label: "Build" },
  latestAttempt: { ...latestAttempt, status: "building", outcome: null, releaseRevision: "9" },
  stableRelease,
  stableUrl: "https://stable.example.test",
});
assert.equal(running.status, "building");
assert.equal(running.phaseLabel, "Build");
assert.equal(running.progress, 20);
assert.equal(running.stableUrl, "https://stable.example.test");
assert.equal(running.operation.releaseRevision, "9");
assert.equal(running.stableRelease.revision, "8");

const stableOnly = normalReleaseView({
  developerState: "live",
  progress: { percentage: 100, phase: "verify", label: "Live" },
  latestAttempt: null,
  stableRelease,
  stableUrl: "https://stable.example.test",
});
assert.equal(stableOnly.summary, "Release 8 · stable");
assert.equal(stableOnly.progress, 100);

const unverifiedUrl = normalReleaseView({
  developerState: "ready",
  progress: { percentage: 0, phase: null, label: "Ready" },
  latestAttempt,
  stableRelease: null,
  stableUrl: "https://must-not-be-used.example.test",
});
assert.equal(unverifiedUrl.stableUrl, null);

console.log("Sanitized normal release workspace projection verification passed");
