import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type DeterministicLocalApplyEvidence = Readonly<{
  planHash: string;
  inputIdentity: string;
  stateVersionId: string;
  resourceCount: number;
  outputs: Record<string, unknown>;
}>;

/** Test-only durable stand-in for Terraform state/output inspection. */
@Injectable()
export class DeterministicLocalInfrastructureApplyStateAdapter {
  async apply(workspace: string, input: { planHash: string; inputIdentity: string }): Promise<DeterministicLocalApplyEvidence> {
    const existing = await this.inspect(workspace);
    if (existing) {
      if (existing.planHash !== input.planHash || existing.inputIdentity !== input.inputIdentity) throw new Error("LOCAL_INFRASTRUCTURE_APPLY_STATE_CONFLICT");
      return existing;
    }
    const outputs = Object.freeze({ local_foundation: "verified", local_plan_identity: input.inputIdentity.slice(0, 16) });
    const evidence: DeterministicLocalApplyEvidence = Object.freeze({
      planHash: input.planHash, inputIdentity: input.inputIdentity,
      stateVersionId: `local-${createHash("sha256").update(`${input.planHash}:${input.inputIdentity}`).digest("hex").slice(0, 20)}`,
      resourceCount: 1, outputs,
    });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, ".deployguard-local-apply-state.json"), JSON.stringify(evidence), { encoding: "utf8", mode: 0o600 });
    if (process.env.NORMAL_FIRST_INFRASTRUCTURE_APPLY_SOAK_UNCERTAIN === "true") {
      const marker = join(workspace, ".deployguard-local-apply-uncertain-once");
      if (!(await this.readMarker(marker))) {
        await writeFile(marker, "1", { encoding: "utf8", mode: 0o600 });
        throw new Error("LOCAL_INFRASTRUCTURE_APPLY_RESPONSE_UNCERTAIN");
      }
    }
    return evidence;
  }
  async inspect(workspace: string): Promise<DeterministicLocalApplyEvidence | null> {
    try {
      const value = JSON.parse(await readFile(join(workspace, ".deployguard-local-apply-state.json"), "utf8")) as DeterministicLocalApplyEvidence;
      return /^[0-9a-f]{64}$/.test(value.planHash || "") && /^[0-9a-f]{64}$/.test(value.inputIdentity || "")
        && typeof value.stateVersionId === "string" && value.resourceCount > 0 && value.outputs && typeof value.outputs === "object" ? value : null;
    } catch { return null; }
  }
  private async readMarker(path: string) { try { await readFile(path, "utf8"); return true; } catch { return false; } }
}
