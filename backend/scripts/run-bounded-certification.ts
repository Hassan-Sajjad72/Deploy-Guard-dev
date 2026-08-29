import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [suite, seconds, command, ...args] = process.argv.slice(2);
if (!suite || !command || !/^\d+$/.test(seconds || "")) throw new Error("usage: <suite> <timeout-seconds> <command> [...args]");
const timeoutMs = Number(seconds) * 1_000;
const root = resolve(process.cwd(), "../.deployguard-test-results");
mkdirSync(root, { recursive: true });
const base = resolve(root, suite);
const startedAt = new Date().toISOString();
const log = openSync(`${base}.log`, "w");
writeFileSync(`${base}.command`, JSON.stringify({ command, args, startedAt, timeoutMs }, null, 2));

function cleanup() {
  for (const prefix of ["deployguard-template-runtime", "deployguard-real-db-certification", "deployguard-web-binding"]) {
    const ids = spawnSync("docker", ["ps", "-aq", "--filter", `name=${prefix}`], { encoding: "utf8" }).stdout.trim();
    if (ids) spawnSync("docker", ["rm", "-f", ...ids.split(/\s+/)], { stdio: "ignore" });
  }
  for (const prefix of ["dg-preflight-", "dg-web-binding-", "deployguard-real-db-"]) {
    const ids = spawnSync("docker", ["network", "ls", "-q", "--filter", `name=${prefix}`], { encoding: "utf8" }).stdout.trim();
    if (ids) spawnSync("docker", ["network", "rm", ...ids.split(/\s+/)], { stdio: "ignore" });
  }
  for (const prefix of ["dg-preflight-", "dg-web-binding-", "deployguard-real-db-"]) {
    const ids = spawnSync("docker", ["volume", "ls", "-q", "--filter", `name=${prefix}`], { encoding: "utf8" }).stdout.trim();
    if (ids) spawnSync("docker", ["volume", "rm", ...ids.split(/\s+/)], { stdio: "ignore" });
  }
}

const child = spawn(command, args, { cwd: process.cwd(), detached: true, stdio: ["ignore", log, log] });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  try { process.kill(-child.pid!, "SIGTERM"); } catch { /* child exited */ }
  setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* child exited */ } }, 5_000).unref();
}, timeoutMs);
child.on("close", (code, signal) => {
  clearTimeout(timer); closeSync(log); cleanup();
  const status = timedOut ? "TIMEOUT" : code === 0 ? "PASS" : "FAIL";
  const exit = timedOut ? 124 : code ?? 1;
  writeFileSync(`${base}.exit`, `${exit}\n`);
  writeFileSync(`${base}.status`, `${status}\nstart=${startedAt}\nend=${new Date().toISOString()}\nexit=${exit}\nsignal=${signal || "none"}\n`);
  process.exitCode = status === "PASS" ? 0 : exit;
});
child.on("error", (error) => {
  clearTimeout(timer); closeSync(log); cleanup();
  writeFileSync(`${base}.exit`, "1\n");
  writeFileSync(`${base}.status`, `FAIL\nstart=${startedAt}\nend=${new Date().toISOString()}\nexit=1\nsignal=none\n`);
  writeFileSync(`${base}.error`, String(error));
  process.exitCode = 1;
});
