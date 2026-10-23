import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const root = process.cwd();
const children = new Set();
const dependencies = ["postgres", "redis"];
let startedDependencies = [];
let stopping = false;

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
  const child = spawn(command, args, { cwd, stdio: "inherit", env: process.env });
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
  for (const child of children) child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 750));
  for (const child of children) child.kill("SIGKILL");
  if (startedDependencies.length) {
    run("docker", ["compose", "stop", ...startedDependencies]);
  }
  process.exit(exitCode);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

try {
  run("docker", ["compose", "config", "--quiet"]);
  const runningBefore = new Set(
    capture("docker", ["compose", "ps", "--status", "running", "--services"])
      .split(/\r?\n/)
      .filter(Boolean),
  );
  startedDependencies = dependencies.filter((service) => !runningBefore.has(service));
  run("docker", ["compose", "up", "-d", ...dependencies]);
  run("npm", ["run", "migration:run"], `${root}/backend`);
  run("npm", ["run", "build"], `${root}/backend`);
  run("npm", ["run", "build"], `${root}/frontend`);

  start("npm", ["start"], `${root}/backend`);
  start("npm", ["run", "preview", "--", "--host", "127.0.0.1", "--port", "5173", "--strictPort"], `${root}/frontend`);

  await waitFor("http://127.0.0.1:5000/api/health/ready", "DeployGuard API");
  await waitFor("http://localhost:5173", "DeployGuard frontend");
  console.log("\nDeployGuard local product is ready:");
  console.log("  Frontend: http://localhost:5173");
  console.log("  API:      http://localhost:5000");
  console.log("  Verify:   npm run product:verify");
  console.log("  Stop:     Ctrl-C\n");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  await stop(1);
}
