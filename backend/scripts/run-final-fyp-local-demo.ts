import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { resolveBackendEnvFile } from "../src/config/backend-env-file";

// Compose interpolation needs the same repository-owned backend environment as
// the application. Values remain process-local and are never written to the
// generated evidence or command output.
loadEnv({ path: resolveBackendEnvFile(), override: false });

const repositoryRoot = resolve(__dirname, "../..");
const backendRoot = resolve(__dirname, "..");
const evidenceRoot = resolve(
  repositoryRoot,
  "docs/architecture/two-lane-migration/evidence/fyp-local-demo",
);
const jsonPath = resolve(evidenceRoot, "latest.json");
const markdownPath = resolve(evidenceRoot, "latest.md");
const checksumPath = resolve(evidenceRoot, "latest.sha256");
const demoStateFile = "/tmp/deployguard-normal-v1-local-demo.json";
const demoLogFile = "/tmp/deployguard-normal-v1-local-demo.log";

type DemoCommand = "start" | "status" | "stop";
type DemoResult = Record<string, unknown> & {
  state: string;
  ready: boolean;
};

function composeServices() {
  return execFileSync(
    "docker",
    ["compose", "ps", "--status", "running", "--services"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).split(/\r?\n/).filter(Boolean).sort();
}

function composeContainers() {
  return execFileSync(
    "docker",
    ["compose", "ps", "-a", "--services"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).split(/\r?\n/).filter(Boolean).sort();
}

function composeNetworkExists() {
  const config = JSON.parse(execFileSync(
    "docker",
    ["compose", "config", "--format", "json"],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )) as { networks?: { default?: { name?: string } } };
  const name = config.networks?.default?.name;
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("FYP_DEMO_NETWORK_IDENTITY_INVALID");
  }
  try {
    execFileSync("docker", ["network", "inspect", name], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runDemo(command: DemoCommand): DemoResult {
  const output = execFileSync(
    process.execPath,
    [
      "-r",
      "ts-node/register",
      "-r",
      "tsconfig-paths/register",
      "scripts/normal-v1-local-demo.ts",
      command,
    ],
    {
      cwd: backendRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        NORMAL_V1_LOCAL_FAILURE_RECOVERY_SOAK: "false",
      },
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: command === "start" ? 180_000 : 120_000,
    },
  );
  const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error("FYP_DEMO_COMMAND_OUTPUT_MISSING");
  const value = JSON.parse(line) as DemoResult;
  if (!value || typeof value !== "object") {
    throw new Error("FYP_DEMO_COMMAND_OUTPUT_INVALID");
  }
  return value;
}

function requirementChecks(status: DemoResult) {
  return Object.freeze({
    authenticatedUiHandoff:
      status.networkEvidence ===
        "deploy-command=1; legacy-mutations=0",
    workerReady:
      status.workerReadyObserved === true
      && status.workerReadyCode === "NORMAL_V1_RELEASE_CONSUMER_READY",
    deterministicQueueDelivery:
      status.queueConsumption === "exactly_once"
      && typeof status.jobId === "string"
      && /^dg:v1:release:[0-9a-f-]{36}:execute:1$/.test(status.jobId),
    durableCompletion:
      status.currentState === "completed"
      && status.durableEvidence ===
        "outbox-publications=1; provenance=1; effects=3; leases=0; owners=0; claims=0",
    canonicalFivePhaseUi:
      status.renderedOverview ===
        "Analyze/Build/Prepare/Deploy/Verify=passed; result=Live",
    refreshConsistency:
      status.crossPageState ===
        "overview=pipeline=dashboard=plan-usage:release-completed/stable",
    sanitizedObservability:
      status.operationSignals ===
        "phases=5/5; developer-internals=absent",
    cloudExecutionExcluded: status.cloudExecution === "not_reachable",
  });
}

function atomicWrite(path: string, value: string) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function markdown(evidence: any) {
  return `# DeployGuard local FYP demonstration evidence

- Result: **${evidence.result}**
- Evidence classification: **local runtime** with an **isolated non-cloud external executor**
- Live AWS: **not used**
- Disposable scope: \`${evidence.runtime.projectScope}\`
- Operation: \`${evidence.runtime.operationId}\`
- BullMQ job: \`${evidence.runtime.jobId}\`
- Worker: \`${evidence.runtime.workerReadyCode}\`
- Canonical state: \`${evidence.runtime.currentState}\`
- Overview: ${evidence.runtime.renderedOverview}
- Cross-page refresh: ${evidence.runtime.crossPageState}
- Durable evidence: ${evidence.runtime.durableEvidence}
- Cleanup: **${evidence.cleanup.complete ? "complete" : "failed"}**
- Deferred providers: **Stripe off; SNS off**

## Walkthrough

1. Start disposable PostgreSQL and Redis only when absent.
2. Start the authenticated backend, Vite frontend and independently supervised normal-v1 worker.
3. Use the Overview Deploy action; observe one canonical deployment command whose backend performs exact preparation and dispatch.
4. Observe Analyze, Build, Prepare, Deploy and Verify through canonical current-state.
5. Refresh Overview, Pipeline, Dashboard and Plan & Usage and confirm one completed/stable release.
6. Stop through SIGTERM and verify the disposable database, isolated Redis keys, processes and temporary files are removed.

This is local/non-cloud evidence. It does not claim Docker build, ECR, ECS, Terraform or live AWS execution.
`;
}

async function main() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("FYP_LOCAL_DEMO_PRODUCTION_FORBIDDEN");
  }
  const startedAt = new Date().toISOString();
  const baselineServices = composeServices();
  const baselineContainers = composeContainers();
  const baselineNetwork = composeNetworkExists();
  let start: DemoResult | null = null;
  let statusOne: DemoResult | null = null;
  let statusTwo: DemoResult | null = null;
  let stop: DemoResult | null = null;
  let startAttempted = false;
  try {
    startAttempted = true;
    start = runDemo("start");
    assert.equal(start.state, "ready");
    assert.equal(start.ready, true);
    statusOne = runDemo("status");
    statusTwo = runDemo("status");
    for (const status of [statusOne, statusTwo]) {
      assert.equal(status.state, "ready");
      assert.equal(status.ready, true);
      assert.equal(status.operationId, start.operationId);
      assert.equal(status.jobId, start.jobId);
    }
    assert.deepEqual(requirementChecks(statusOne), requirementChecks(statusTwo));
    assert.equal(
      Object.values(requirementChecks(statusTwo)).every(Boolean),
      true,
    );
  } finally {
    if (startAttempted) {
      try {
        stop = runDemo("stop");
      } catch {
        stop = null;
      }
    }
  }

  assert.ok(start && statusOne && statusTwo && stop);
  assert.equal(stop.state, "stopped");
  assert.equal(stop.ready, false);
  assert.equal(stop.cleanupComplete, true);
  assert.equal(stop.processAlive, false);
  assert.equal(stop.defaultsRestoredOff, true);
  const finalServices = composeServices();
  const finalContainers = composeContainers();
  const finalNetwork = composeNetworkExists();
  assert.deepEqual(finalServices, baselineServices);
  assert.deepEqual(finalContainers, baselineContainers);
  assert.equal(finalNetwork, baselineNetwork);
  assert.equal(existsSync(demoStateFile), false);
  assert.equal(existsSync(demoLogFile), false);

  const checks = requirementChecks(statusTwo);
  const evidence = {
    schemaVersion: 1,
    evidenceType: "deployguard.fyp-local-demo/v1",
    result: "passed",
    startedAt,
    completedAt: new Date().toISOString(),
    classification: {
      frontend: "local_runtime",
      backend: "local_runtime",
      postgresql: "local_runtime_disposable",
      redisBullMq: "local_runtime_isolated_prefix",
      worker: "local_runtime_supervised_process",
      externalReleaseExecutor: "isolated_non_cloud",
      liveAws: "not_used",
    },
    commands: {
      run: "npm run demo:fyp-local",
      inspect: "cat docs/architecture/two-lane-migration/evidence/fyp-local-demo/latest.json",
    },
    runtimeConfiguration: {
      billingProviderEnabled: false,
      notificationDeliveryEnabled: false,
      cloudReleaseExecutionEnabled: false,
    },
    runtime: {
      projectScope: statusTwo.projectScope,
      operationId: statusTwo.operationId,
      jobId: statusTwo.jobId,
      workerReadyCode: statusTwo.workerReadyCode,
      workerState: statusTwo.workerState,
      queueConsumption: statusTwo.queueConsumption,
      currentState: statusTwo.currentState,
      renderedOverview: statusTwo.renderedOverview,
      operationSignals: statusTwo.operationSignals,
      crossPageState: statusTwo.crossPageState,
      recoveryState: statusTwo.recoveryState,
      networkEvidence: statusTwo.networkEvidence,
      durableEvidence: statusTwo.durableEvidence,
      cloudExecution: statusTwo.cloudExecution,
    },
    requirements: checks,
    cleanup: {
      complete: true,
      processAlive: false,
      temporaryStateRemoved: true,
      temporaryLogRemoved: true,
      composeBaselineBefore: baselineServices,
      composeBaselineAfter: finalServices,
      composeContainersBefore: baselineContainers,
      composeContainersAfter: finalContainers,
      composeNetworkBefore: baselineNetwork,
      composeNetworkAfter: finalNetwork,
      defaultsRestoredOff: true,
    },
    limitations: [
      "External release execution is deterministic and non-cloud.",
      "Live AWS deployment is not claimed by this evidence.",
      "Normal-v1 deletion execution is intentionally unavailable.",
    ],
  };
  mkdirSync(evidenceRoot, { recursive: true });
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const checksum = createHash("sha256").update(json).digest("hex");
  atomicWrite(jsonPath, json);
  atomicWrite(markdownPath, markdown(evidence));
  atomicWrite(checksumPath, `${checksum}  latest.json\n`);
  for (const temporary of [
    `${jsonPath}.tmp`,
    `${markdownPath}.tmp`,
    `${checksumPath}.tmp`,
  ]) rmSync(temporary, { force: true });
  process.stdout.write(`${JSON.stringify({
    result: "passed",
    operationId: statusTwo.operationId,
    jobId: statusTwo.jobId,
    evidence: jsonPath,
    summary: markdownPath,
    checksum,
    cleanupComplete: true,
    liveAws: "not_used",
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    result: "failed",
    safeCode: error instanceof Error
      && /^[A-Z0-9_]{3,128}$/.test(error.message)
      ? error.message
      : "FYP_LOCAL_DEMO_FAILED",
  })}\n`);
  process.exitCode = 1;
});
