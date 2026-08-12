import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GithubActionsDeploymentService } from "../src/projects/github-actions-deployment.service";
import { exactZipEntry } from "../src/projects/pipeline/github-actions.service";

const service = readFileSync(resolve(__dirname, "../src/projects/github-actions-deployment.service.ts"), "utf8");

assert.match(service, /implements OnModuleInit, OnModuleDestroy/);
assert.match(service, /GITHUB_ACTIONS_RECONCILIATION_INTERVAL_MS[\s\S]*15000/);
assert.match(service, /setInterval\(\(\) => void this\.reconcileActiveOperations\(\)/);
assert.match(service, /void this\.reconcileActiveOperations\(\)/, "startup performs restart recovery without waiting for UI access");
assert.match(service, /run\.status IN \(:\.\.\.statuses\)[\s\S]*statuses: ACTIVE/);
assert.match(service, /innerJoinAndSelect\("run\.project"[\s\S]*innerJoinAndSelect\("run\.triggeredByUser"/);
assert.match(service, /await this\.reconcile\(operation\.triggeredByUser, operation\.project, operation\)/);
assert.match(service, /reconciliationSweepRunning/, "overlapping scheduler sweeps are bounded");
assert.match(service, /destroyLifecycles\.due/, "the same scheduler resumes due persistent Destroy cleanup");
assert.match(service, /resumeDestroyLifecycle/, "Destroy janitor resumes the immutable cleanup workflow");
assert.match(service, /pg_advisory_lock\(hashtext\(\$1\)\)[\s\S]*github-actions-reconcile:/, "scheduler and GET fallback share operation locking");

async function verify() {
  const name = Buffer.from("deployguard-result.json");
  const payload = Buffer.from('{"status":"verified_destroyed"}');
  const local = Buffer.alloc(30 + name.length + payload.length);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 8);
  local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(name.length, 26);
  name.copy(local, 30); payload.copy(local, 30 + name.length);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 10);
  central.writeUInt32LE(payload.length, 20); central.writeUInt32LE(payload.length, 24); central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12); eocd.writeUInt32LE(local.length, 16);
  assert.equal(exactZipEntry(Buffer.concat([local, central, eocd]), "deployguard-result.json"), payload.toString(), "the durable uploaded result can be extracted without trusting job logs");

  const operation = { id: "11111111-1111-4111-8111-111111111111", project: { id: "project" }, triggeredByUser: { id: 1 } };
  let terminal = false;
  let reconciliations = 0;
  let dispatches = 0;
  const query = {
    innerJoinAndSelect() { return this; }, where() { return this; }, andWhere() { return this; },
    orderBy() { return this; }, take() { return this; },
    async getMany() { return terminal ? [] : [operation]; },
  };
  const instance: any = Object.create(GithubActionsDeploymentService.prototype);
  instance.reconciliationSweepRunning = false;
  instance.config = { get: () => "25" };
  instance.runs = { createQueryBuilder: () => query };
  instance.destroyLifecycles = { due: async () => [] };
  instance.logger = { warn: () => undefined };
  instance.reconcile = async () => { await Promise.resolve(); reconciliations += 1; terminal = true; };
  instance.dispatch = async () => { dispatches += 1; };

  const [first, second] = await Promise.all([instance.reconcileActiveOperations(), instance.reconcileActiveOperations()]);
  assert.equal([first, second].filter((result) => result.skipped).length, 1, "concurrent scheduler sweeps are coalesced");
  assert.equal(reconciliations, 1, "concurrent polling and scheduler execution converge once");
  await instance.reconcileActiveOperations();
  assert.equal(reconciliations, 1, "already-terminal operations are idempotent");
  assert.equal(dispatches, 0, "the observer never dispatches a workflow");
  console.log("Durable GitHub Actions reconciliation checks passed: startup recovery, bounded cadence, active-only scanning, shared locking, idempotency, and no dispatch.");
}

verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
