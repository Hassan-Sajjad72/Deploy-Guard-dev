import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(__dirname, "../..");
const evidenceRoot = resolve(
  repositoryRoot,
  "docs/architecture/two-lane-migration/evidence/fyp-local-demo",
);
const jsonPath = resolve(evidenceRoot, "latest.json");
const markdownPath = resolve(evidenceRoot, "latest.md");
const checksumPath = resolve(evidenceRoot, "latest.sha256");

const runner = readFileSync(
  resolve(__dirname, "run-final-fyp-local-demo.ts"),
  "utf8",
);
const guide = readFileSync(resolve(repositoryRoot, "docs/FYP_LOCAL_DEMO.md"), "utf8");
const json = readFileSync(jsonPath, "utf8");
const summary = readFileSync(markdownPath, "utf8");
const checksum = readFileSync(checksumPath, "utf8").trim();
const evidence = JSON.parse(json) as any;

assert.equal(evidence.schemaVersion, 1);
assert.equal(evidence.evidenceType, "deployguard.fyp-local-demo/v1");
assert.equal(evidence.result, "passed");
assert.equal(Object.values(evidence.requirements).every(Boolean), true);
assert.equal(evidence.classification.externalReleaseExecutor, "isolated_non_cloud");
assert.equal(evidence.classification.liveAws, "not_used");
assert.equal(evidence.runtime.workerReadyCode, "NORMAL_V1_RELEASE_CONSUMER_READY");
assert.equal(evidence.runtime.queueConsumption, "exactly_once");
assert.match(
  evidence.runtime.jobId,
  /^dg:v1:release:[0-9a-f-]{36}:execute:1$/,
);
assert.equal(evidence.runtime.currentState, "completed");
assert.equal(
  evidence.runtime.renderedOverview,
  "Analyze/Build/Prepare/Deploy/Verify=passed; result=Live",
);
assert.equal(evidence.runtime.cloudExecution, "not_reachable");
assert.equal(evidence.cleanup.complete, true);
assert.equal(evidence.cleanup.processAlive, false);
assert.equal(evidence.cleanup.temporaryStateRemoved, true);
assert.equal(evidence.cleanup.temporaryLogRemoved, true);
assert.equal(evidence.cleanup.defaultsRestoredOff, true);
assert.deepEqual(
  evidence.cleanup.composeBaselineAfter,
  evidence.cleanup.composeBaselineBefore,
);
assert.ok(
  evidence.limitations.includes(
    "Normal-v1 deletion execution is intentionally unavailable.",
  ),
);

const expectedChecksum = createHash("sha256").update(json).digest("hex");
assert.equal(checksum, `${expectedChecksum}  latest.json`);
assert.match(summary, /Result: \*\*passed\*\*/);
assert.match(summary, /Live AWS: \*\*not used\*\*/);
assert.match(guide, /npm run demo:fyp-local/);
assert.match(guide, /fyp-local-demo\/latest\.json/);
assert.match(runner, /normal-v1-local-demo\.ts/);
assert.doesNotMatch(runner, /execFileSync\(\s*["'](?:terraform|aws)["']/i);
assert.doesNotMatch(runner, /["']docker["']\s*,\s*\[(?:[\s\S]{0,80})["'](?:build|push)["']/i);
assert.doesNotMatch(
  json,
  /accessKey|secretAccessKey|sessionToken|credential|fencingToken|leaseId|arn:aws/i,
);

process.stdout.write(
  "Final FYP local demo evidence and checksum verification passed.\n",
);
