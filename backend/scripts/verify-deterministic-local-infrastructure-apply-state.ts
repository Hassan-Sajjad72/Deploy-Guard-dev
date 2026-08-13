import * as assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicLocalInfrastructureApplyStateAdapter } from "../src/orchestration-contracts/infrastructure/deterministic-local-infrastructure-apply-state.adapter";
void (async () => {
  const workspace = await mkdtemp(join(tmpdir(), "deployguard-local-apply-"));
  const managedWorkspace = await mkdtemp(join(tmpdir(), "deployguard-local-managed-apply-"));
  try {
    const adapter = new DeterministicLocalInfrastructureApplyStateAdapter();
    const input = { planHash: "a".repeat(64), inputIdentity: "b".repeat(64) };
    const first = await adapter.apply(workspace, input);
    const replay = await adapter.apply(workspace, input);
    assert.deepEqual(replay, first); assert.deepEqual(await adapter.inspect(workspace), first);
    await assert.rejects(() => adapter.apply(workspace, { ...input, planHash: "c".repeat(64) }), /LOCAL_INFRASTRUCTURE_APPLY_STATE_CONFLICT/);

    await writeFile(join(managedWorkspace, "terraform.tfvars.json"), JSON.stringify({
      cloud_map_namespace: "project-fixture.deployguard.local",
      database_service: { enabled: true, database_name: "smart_retail", database_user: "dg_smart", port: 5432 },
    }), { encoding: "utf8", mode: 0o600 });
    const managed = await adapter.apply(managedWorkspace, { planHash: "d".repeat(64), inputIdentity: "e".repeat(64) });
    assert.equal(managed.outputs.database_internal_host, "db.project-fixture.deployguard.local");
    assert.equal(managed.outputs.database_port, 5432);
    assert.match(String(managed.outputs.database_password_secret_arn), /^local-secret-ref:/);
    assert.doesNotMatch(JSON.stringify(managed.outputs), /(?:password|jwt)[=:][^:/\s]{8,}/i);
    process.stdout.write("Deterministic local infrastructure apply state verification passed\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(managedWorkspace, { recursive: true, force: true });
  }
})().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
