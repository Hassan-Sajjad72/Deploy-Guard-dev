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
    const outputs = Object.freeze({
      local_foundation: "verified",
      local_plan_identity: input.inputIdentity.slice(0, 16),
      ...(await this.managedDatabaseOutputs(workspace)),
    });
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
  private async managedDatabaseOutputs(workspace: string): Promise<Record<string, unknown>> {
    try {
      const variables = JSON.parse(await readFile(join(workspace, "terraform.tfvars.json"), "utf8")) as {
        database_service?: { enabled?: boolean; database_name?: string; database_user?: string; port?: number };
        cloud_map_namespace?: string;
      };
      const database = variables.database_service;
      if (!database?.enabled) return {};
      const namespace = variables.cloud_map_namespace;
      if (typeof namespace !== "string" || !namespace || typeof database.port !== "number") {
        throw new Error("LOCAL_MANAGED_DATABASE_VARIABLES_INVALID");
      }
      // These are deterministic identifiers, never secret values. They model
      // the Terraform output contract used by the fenced apply service.
      return {
        database_enabled: true,
        database_internal_host: `db.${namespace}`,
        database_port: database.port,
        database_password_secret_arn: `local-secret-ref:${inputHash(namespace, "password")}`,
        database_url_secret_arn: `local-secret-ref:${inputHash(namespace, "url")}`,
        database_cloud_map_service_arn: `local-discovery-ref:${inputHash(namespace, "db")}`,
        database_security_group_id: `local-security-group:${inputHash(namespace, "database")}`,
        database_name_reference: database.database_name || null,
        database_user_reference: database.database_user || null,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "LOCAL_MANAGED_DATABASE_VARIABLES_INVALID") throw error;
      return {};
    }
  }
  private async readMarker(path: string) { try { await readFile(path, "utf8"); return true; } catch { return false; } }
}

function inputHash(value: string, kind: string) {
  return createHash("sha256").update(`${kind}:${value}`).digest("hex").slice(0, 24);
}
