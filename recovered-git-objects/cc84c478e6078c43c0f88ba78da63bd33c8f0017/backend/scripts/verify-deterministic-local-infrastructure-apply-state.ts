import * as assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicLocalInfrastructureApplyStateAdapter } from "../src/orchestration-contracts/infrastructure/deterministic-local-infrastructure-apply-state.adapter";
void (async () => { const workspace = await mkdtemp(join(tmpdir(), "deployguard-local-apply-")); try { const adapter = new DeterministicLocalInfrastructureApplyStateAdapter(); const input = { planHash: "a".repeat(64), inputIdentity: "b".repeat(64) }; const first = await adapter.apply(workspace, input); const replay = await adapter.apply(workspace, input); assert.deepEqual(replay, first); assert.deepEqual(await adapter.inspect(workspace), first); await assert.rejects(() => adapter.apply(workspace, { ...input, planHash: "c".repeat(64) }), /LOCAL_INFRASTRUCTURE_APPLY_STATE_CONFLICT/); process.stdout.write("Deterministic local infrastructure apply state verification passed\n"); } finally { await rm(workspace, { recursive: true, force: true }); } })().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
