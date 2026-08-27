import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import process from "node:process";
import { assertAuthoritativeDatabaseReachable } from "./authoritative-database.mjs";
import { loadCanonicalBackendEnvironment } from "./canonical-backend-env.mjs";

const root = process.cwd();
const canonicalBackendEnv = loadCanonicalBackendEnvironment(root);
const children = new Set();
const supportServices = ["prometheus", "grafana"];
// PostgreSQL is deliberately not a Compose dependency of the AWS product.
// The backend, migrations, and this preflight all consume backend/.env's
// authoritative endpoint (currently localhost:5434).
const dependencyCompose = ["compose", "--env-file", canonicalBackendEnv];
let startedSupportServices = [];
let stopping = false;

function assertControlPlaneRuntime() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== 22) {
    throw new Error(`DeployGuard local startup requires Node 22; current runtime is ${process.version}.`);
  }
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: process.env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env, detached: process.platform !== "win32" });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`Product process exited unexpectedly: ${command} (${signal || code})`);
      void stop(1);
    }
  });
  return child;
}

async function assertPortAvailable(port, description) {
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => reject(new Error(`${description} port ${port} is already in use: ${error.message}`)));
    server.listen(port, "127.0.0.1", () => server.close(resolve));
  });
}

function signalChild(child, signal) {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitFor(url, description, attempts = 60) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${description} did not become ready: ${lastError?.message || "unknown error"}`);
}

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) signalChild(child, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 750));
  for (const child of children) signalChild(child, "SIGKILL");
  if (startedSupportServices.length) {
    run("docker", [...dependencyCompose, "stop", ...startedSupportServices]);
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

try {
  assertControlPlaneRuntime();
  process.env.PROMETHEUS_SCRAPE_TOKEN ||= "deployguard-local-monitoring";
  process.env.PROMETHEUS_SCRAPE_TARGET ||= "host.docker.internal:5000";
  process.env.AWS_RUNTIME_MONITORING_ENABLED ||= "true";
  process.env.CLOUDWATCH_LOGS_ENABLED ||= "true";
  process.env.CLOUDWATCH_METRICS_ENABLED ||= "true";
  process.env.PROMETHEUS_ENABLED ||= "true";
  process.env.GRAFANA_BASE_URL ||= `http://localhost:${process.env.GRAFANA_PORT || 3001}/d/deployguard-runtime/deployguard-runtime`;
  const database = await assertAuthoritativeDatabaseReachable();
  console.log(`Using canonical PostgreSQL endpoint: ${database.host}:${database.port}/${database.database}`);
  run("docker", [...dependencyCompose, "config", "--quiet"]);
  const runningBefore = new Set(
    capture("docker", [...dependencyCompose, "ps", "--status", "running", "--services"])
      .split(/\r?\n/)
      .filter(Boolean),
  );
  await Promise.all([
    assertPortAvailable(Number(process.env.PORT || 5000), "DeployGuard API"),
    assertPortAvailable(5173, "DeployGuard frontend"),
    ...(!runningBefore.has("prometheus") ? [assertPortAvailable(Number(process.env.PROMETHEUS_PORT || 9090), "Prometheus")] : []),
    ...(!runningBefore.has("grafana") ? [assertPortAvailable(Number(process.env.GRAFANA_PORT || 3001), "Grafana")] : []),
  ]);
  startedSupportServices = supportServices.filter((service) => !runningBefore.has(service));
  run("docker", [...dependencyCompose, "up", "-d", "--no-deps", ...supportServices]);
  run("npm", ["run", "migration:run"], `${root}/backend`);
  run("npm", ["run", "build"], `${root}/backend`);
  run("npm", ["run", "build"], `${root}/frontend`);

  start("npm", ["start"], `${root}/backend`);
  start("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], `${root}/frontend`);

  await waitFor("http://127.0.0.1:5000/api/health/ready", "DeployGuard API");
  await waitFor("http://localhost:5173", "DeployGuard frontend");
  await waitFor(`http://127.0.0.1:${process.env.PROMETHEUS_PORT || 9090}/-/ready`, "Prometheus");
  await waitFor(`http://127.0.0.1:${process.env.GRAFANA_PORT || 3001}/api/health`, "Grafana");
  console.log("\nDeployGuard local product is ready:");
  console.log("  Frontend: http://localhost:5173");
  console.log("  API:      http://localhost:5000");
  console.log(`  Prometheus: http://localhost:${process.env.PROMETHEUS_PORT || 9090}`);
  console.log(`  Grafana:    http://localhost:${process.env.GRAFANA_PORT || 3001}/d/deployguard-runtime/deployguard-runtime`);
  console.log("  Verify:   npm run product:verify");
  console.log("  Stop:     Ctrl-C\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stop(1);
}
