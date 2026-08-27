import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const script = resolve(__dirname, "run-operational-production-canary-preflight.ts");
const result = spawnSync("ts-node", [script], {
  cwd: resolve(__dirname, ".."),
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_PATH: process.env.NODE_PATH,
  },
  encoding: "utf8",
});

assert.equal(result.status, 2);
assert.deepEqual(JSON.parse(result.stdout), {
  state: "blocked",
  safeCodes: ["CANARY_CONFIGURATION_INVALID"],
});
assert.equal(result.stderr, "");

const source = readFileSync(script, "utf8");
for (const forbidden of [
  "RegisterTaskDefinitionCommand",
  "UpdateServiceCommand",
  "new Worker(",
  ".dispatchOne(",
  ".start(",
  "terraform",
]) {
  assert.equal(source.includes(forbidden), false, `runner contains ${forbidden}`);
}
console.log("Operational production canary runner verification passed.");
