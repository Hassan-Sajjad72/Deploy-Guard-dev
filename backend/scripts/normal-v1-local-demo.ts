import { strict as assert } from "node:assert";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(__dirname, "../..");
const backendRoot = resolve(__dirname, "..");
const stateFile = "/tmp/deployguard-normal-v1-local-demo.json";
const logFile = "/tmp/deployguard-normal-v1-local-demo.log";
const dependencies = ["postgres", "redis"] as const;

type DemoState = {
  schemaVersion: number;
  state: "starting" | "ready" | "stopping" | "stopped" | "failed";
  ready: boolean;
  pid?: number;
  backendUrl?: string;
  frontendUrl?: string;
  projectScope?: string;
  operationId?: string;
  jobId?: string;
  workerReadyObserved?: boolean;
  workerReadyCode?: string;
  workerState?: string;
  workerHealthFile?: string;
  currentState?: string;
  renderedOverview?: string;
  operationSignals?: string;
  crossPageState?: string;
  recoveryState?: string;
  networkEvidence?: string;
  durableEvidence?: string;
  queueConsumption?: string;
  cloudExecution?: string;
  cleanupComplete?: boolean;
  safeCode?: string;
  dependenciesStartedByDemo?: string[];
  dependenciesCreatedByDemo?: string[];
  networkCreatedByDemo?: boolean;
  networkName?: string;
  observedAt: string;
};

function compose(args: string[]) {
  return execFileSync("docker", ["compose", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readState(): DemoState | null {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8")) as DemoState;
  } catch {
    return null;
  }
}

function writeStartingState(
  pid: number,
  started: string[],
  created: string[],
  networkName: string,
  networkCreated: boolean,
) {
  writeFileSync(stateFile, `${JSON.stringify({
    schemaVersion: 1,
    state: "starting",
    ready: false,
    pid,
    dependenciesStartedByDemo: started,
    dependenciesCreatedByDemo: created,
    networkCreatedByDemo: networkCreated,
    networkName,
    observedAt: new Date().toISOString(),
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

function processAlive(pid?: number) {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningServices() {
  return new Set(compose(["ps", "--status", "running", "--services"])
    .split(/\r?\n/)
    .filter(Boolean));
}

function existingServices() {
  return new Set(compose(["ps", "-a", "--services"])
    .split(/\r?\n/)
    .filter(Boolean));
}

function defaultNetworkName() {
  const config = JSON.parse(compose(["config", "--format", "json"])) as {
    networks?: { default?: { name?: string } };
  };
  const name = config.networks?.default?.name;
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("NORMAL_V1_LOCAL_DEMO_NETWORK_IDENTITY_INVALID");
  }
  return name;
}

function networkExists(name: string) {
  try {
    execFileSync("docker", ["network", "inspect", name], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 90_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new Error(`NORMAL_V1_LOCAL_DEMO_${label.toUpperCase()}_TIMEOUT`);
}

async function waitForDependencies() {
  await waitFor(() => {
    try {
      compose([
        "exec", "-T", "postgres", "pg_isready",
        "-U", "mini_paas_user", "-d", "mini_paas",
      ]);
      return compose(["exec", "-T", "redis", "redis-cli", "ping"])
        .trim() === "PONG";
    } catch {
      return false;
    }
  }, "DEPENDENCIES_READY", 45_000);
}

function stopDependencies(started: readonly string[]) {
  if (started.length === 0) return;
  compose(["stop", ...started]);
}


function removeCreatedDependencies(created: readonly string[]) {
  if (created.length === 0) return;
  compose(["rm", "-f", ...created]);
}

function removeCreatedNetwork(name: string, created: boolean) {
  if (!created) return;
  execFileSync("docker", ["network", "rm", name], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function reachable(url?: string) {
  if (!url) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    await fetch(url, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function status(print = true) {
  const state = readState();
  if (!state) {
    const result = {
      state: "stopped",
      ready: false,
      processAlive: false,
      dependenciesManaged: [],
    };
    if (print) process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const alive = processAlive(state.pid);
  const [backendReachable, frontendReachable] = await Promise.all([
    reachable(state.backendUrl ? `${state.backendUrl}/api/auth/me` : undefined),
    reachable(state.frontendUrl),
  ]);
  const result = {
    state: alive ? state.state : state.state === "stopped" ? "stopped" : "failed",
    ready: Boolean(
      alive
      && state.state === "ready"
      && state.workerReadyObserved
      && backendReachable
      && frontendReachable
    ),
    processAlive: alive,
    backendReachable,
    frontendReachable,
    workerReadyObserved: Boolean(state.workerReadyObserved),
    workerReadyCode: state.workerReadyCode || null,
    workerState: state.workerState || null,
    projectScope: state.projectScope || null,
    operationId: state.operationId || null,
    jobId: state.jobId || null,
    currentState: state.currentState || null,
    renderedOverview: state.renderedOverview || null,
    operationSignals: state.operationSignals || null,
    crossPageState: state.crossPageState || null,
    recoveryState: state.recoveryState || null,
    networkEvidence: state.networkEvidence || null,
    durableEvidence: state.durableEvidence || null,
    queueConsumption: state.queueConsumption || null,
    cloudExecution: state.cloudExecution || "not_reachable",
    cleanupComplete: Boolean(state.cleanupComplete),
    dependenciesManaged: state.dependenciesStartedByDemo || [],
    dependenciesCreated: state.dependenciesCreatedByDemo || [],
    networkCreated: Boolean(state.networkCreatedByDemo),
  };
  if (print) process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

async function start() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("NORMAL_V1_LOCAL_DEMO_PRODUCTION_FORBIDDEN");
  }
  const prior = readState();
  if (prior && processAlive(prior.pid)) {
    throw new Error("NORMAL_V1_LOCAL_DEMO_ALREADY_RUNNING");
  }
  rmSync(stateFile, { force: true });
  rmSync(logFile, { force: true });

  const before = runningServices();
  const existingBefore = existingServices();
  const networkName = defaultNetworkName();
  const networkCreated = !networkExists(networkName);
  const started = dependencies.filter((service) => !before.has(service));
  const created = dependencies.filter((service) => !existingBefore.has(service));
  compose(["up", "-d", ...dependencies]);
  await waitForDependencies();

  const logDescriptor = openSync(logFile, "a", 0o600);
  const child = spawn(
    process.execPath,
    [
      "-r", "ts-node/register",
      "-r", "tsconfig-paths/register",
      "scripts/verify-normal-v1-local-fixture-worker-postgres-redis.ts",
    ],
    {
      cwd: backendRoot,
      detached: true,
      env: {
        ...process.env,
        NODE_ENV: "test",
        NORMAL_V1_LOCAL_DEMO_HOLD: "true",
        NORMAL_V1_LOCAL_DEMO_STATE_FILE: stateFile,
        NORMAL_V1_LOCAL_DEMO_STARTED_DEPENDENCIES: started.join(","),
        NORMAL_V1_LOCAL_DEMO_CREATED_DEPENDENCIES: created.join(","),
        NORMAL_V1_LOCAL_DEMO_CREATED_NETWORK:
          networkCreated ? networkName : "",
      },
      stdio: ["ignore", logDescriptor, logDescriptor],
    },
  );
  closeSync(logDescriptor);
  assert.ok(child.pid);
  writeStartingState(
    child.pid,
    [...started],
    [...created],
    networkName,
    networkCreated,
  );
  child.unref();

  try {
    await waitFor(() => {
      const current = readState();
      return current?.state === "ready"
        || current?.state === "failed"
        || !processAlive(child.pid);
    }, "READY");
    const current = readState();
    if (!current || current.state !== "ready") {
      throw new Error(current?.safeCode || "NORMAL_V1_LOCAL_DEMO_START_FAILED");
    }
    const observed = await status(false);
    assert.equal(observed.ready, true);
    process.stdout.write(`${JSON.stringify({
      ...observed,
      command: "npm run demo:normal-v1-local -- status",
      stopCommand: "npm run demo:normal-v1-local -- stop",
    })}\n`);
  } catch (error) {
    if (processAlive(child.pid)) process.kill(child.pid!, "SIGTERM");
    stopDependencies(started);
    removeCreatedDependencies(created);
    removeCreatedNetwork(networkName, networkCreated);
    throw error;
  }
}

async function stop() {
  const current = readState();
  if (!current) {
    process.stdout.write('{"state":"stopped","ready":false,"cleanupComplete":true}\n');
    return;
  }
  const started = current.dependenciesStartedByDemo || [];
  const created = current.dependenciesCreatedByDemo || [];
  const networkName = current.networkName || defaultNetworkName();
  const networkCreated = Boolean(current.networkCreatedByDemo);
  if (processAlive(current.pid)) {
    process.kill(current.pid!, "SIGTERM");
    await waitFor(() => {
      const latest = readState();
      return !processAlive(current.pid)
        && Boolean(latest && ["stopped", "failed"].includes(latest.state));
    }, "STOPPED");
  }
  const terminal = readState();
  stopDependencies(started);
  removeCreatedDependencies(created);
  removeCreatedNetwork(networkName, networkCreated);
  const result = {
    state: terminal?.state === "failed" ? "failed" : "stopped",
    ready: false,
    cleanupComplete: Boolean(terminal?.cleanupComplete),
    processAlive: processAlive(current.pid),
    dependenciesStopped: started,
    dependenciesRemoved: created,
    networkRemoved: networkCreated,
    defaultsRestoredOff: true,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  rmSync(stateFile, { force: true });
  rmSync(logFile, { force: true });
}

async function main() {
  const command = process.argv[2];
  if (command === "start") return start();
  if (command === "status") return status();
  if (command === "stop") return stop();
  throw new Error("NORMAL_V1_LOCAL_DEMO_COMMAND_INVALID");
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    state: "failed",
    ready: false,
    safeCode: error instanceof Error
      && /^[A-Z0-9_]{3,128}$/.test(error.message)
      ? error.message
      : "NORMAL_V1_LOCAL_DEMO_COMMAND_FAILED",
  })}\n`);
  process.exitCode = 1;
});
