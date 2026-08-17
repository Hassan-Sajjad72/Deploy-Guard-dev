import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { canonicalSha256 } from "../contracts/canonical-json";
import { InactiveReleaseLaneOwnershipService } from "./inactive-release-lane-ownership.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_CODE = "FIRST_RELEASE_RECOVERY_INVALID";
const RETRYABLE = new Set(["40001", "40P01"]);

export type NormalFirstReleaseRecoveryRemediationInput = {
  projectId: string;
  environmentName: "dev";
  failedIntentId: string;
  malformedIntentId: string;
  infrastructureManifestId: string;
  initialReleaseDraftId: string;
  commitSha: string;
};

@Injectable()
export class NormalFirstReleaseRecoveryRemediationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: InactiveReleaseLaneOwnershipService,
  ) {}

  async remediate(input: NormalFirstReleaseRecoveryRemediationInput) {
    if (![input.projectId, input.failedIntentId, input.malformedIntentId,
      input.infrastructureManifestId, input.initialReleaseDraftId].every((value) => UUID.test(value))
      || input.environmentName !== "dev" || !/^[0-9a-f]{40}$/.test(input.commitSha)
      || input.failedIntentId === input.malformedIntentId) {
      throw new Error("FIRST_RELEASE_RECOVERY_REMEDIATION_SCOPE_INVALID");
    }
    const fingerprint = canonicalSha256({ schemaVersion: 1, policy: "first-release-recovery-remediation-v1", ...input });
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    const scopeLock = `deployguard:first-release-recovery-remediation:${input.projectId}:${input.environmentName}`;
    await runner.query("SELECT pg_advisory_lock(hashtext($1))", [scopeLock]);
    try {
      return await this.remediateOwned(input, fingerprint);
    } finally {
      await runner.query("SELECT pg_advisory_unlock(hashtext($1))", [scopeLock]).catch(() => undefined);
      await runner.release();
    }
  }

  private async remediateOwned(
    input: NormalFirstReleaseRecoveryRemediationInput,
    fingerprint: string,
  ) {
    const leaseId = this.uuidFromHash(fingerprint);
    const actorId = "normal-first-release-recovery-remediation";
    const acquired = await this.ownership.acquire({
      projectId: input.projectId, environmentName: input.environmentName,
      lane: "v1", leaseId, actorId, idempotencyKey: fingerprint,
      requestFingerprint: fingerprint, leaseTtlMs: 60_000,
      ownV1IntentId: input.malformedIntentId,
    });
    if (!["acquired", "already_owned"].includes(acquired.disposition)) {
      throw new Error("FIRST_RELEASE_RECOVERY_REMEDIATION_OWNERSHIP_BLOCKED");
    }
    const ownership = (acquired as Extract<typeof acquired, { ownership: unknown }>).ownership;
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await this.dataSource.transaction("SERIALIZABLE", (manager) =>
            this.inTransaction(manager, input, leaseId, actorId, ownership.fencingToken));
        } catch (error) {
          const code = typeof error === "object" && error ? String((error as { code?: unknown }).code || "") : "";
          if (!RETRYABLE.has(code) || attempt >= 2) throw error;
        }
      }
    } finally {
      await this.ownership.release({
        projectId: input.projectId, environmentName: input.environmentName,
        lane: "v1", leaseId, actorId, fencingToken: ownership.fencingToken,
      }).catch(() => undefined);
    }
  }

  private async inTransaction(
    manager: EntityManager,
    input: NormalFirstReleaseRecoveryRemediationInput,
    leaseId: string,
    actorId: string,
    fencingToken: string,
  ) {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `deployguard:planner:${input.projectId}:${input.environmentName}`,
    ]);
    const rows = await manager.query(
      `SELECT malformed.status, malformed.failure_code AS "failureCode",
              malformed.release_manifest_id AS "releaseManifestId",
              malformed.infrastructure_manifest_id AS "infrastructureManifestId",
              malformed.request_payload AS "requestPayload"
       FROM deployment_intents malformed
       JOIN deployment_intents failed ON failed.id=$2
       JOIN infrastructure_manifests infrastructure ON infrastructure.id=$3
       JOIN initial_release_drafts draft ON draft.id=$4
       WHERE malformed.id=$1 AND malformed.project_id=$5 AND malformed.environment_name='dev'
         AND malformed.kind='deploy' AND malformed.classification='release_only'
         AND failed.project_id=malformed.project_id AND failed.environment_name=malformed.environment_name
         AND failed.status='failed' AND failed.failure_code='INVOCATION_PREPARATION_FAILED'
         AND infrastructure.project_id=malformed.project_id AND infrastructure.environment_name='dev'
         AND infrastructure.status='applied'
         AND draft.project_id=malformed.project_id AND draft.environment_name='dev'
         AND draft.infrastructure_manifest_id=infrastructure.id
         AND draft.release_draft->>'commitSha'=$6
       FOR UPDATE OF malformed, failed, infrastructure, draft`,
      [input.malformedIntentId, input.failedIntentId, input.infrastructureManifestId,
        input.initialReleaseDraftId, input.projectId, input.commitSha],
    ) as Array<{ status: string; failureCode: string | null; releaseManifestId: string | null;
      infrastructureManifestId: string; requestPayload: Record<string, unknown> }>;
    if (rows.length !== 1) throw new Error("FIRST_RELEASE_RECOVERY_REMEDIATION_EVIDENCE_INVALID");
    const row = rows[0];
    if (row.status === "failed" && row.failureCode === SAFE_CODE) {
      return { state: "terminal", safeCode: SAFE_CODE, replayed: true };
    }
    const fence = await manager.query(
      `SELECT 1 FROM project_release_lane_ownerships
       WHERE project_id=$1 AND environment_name=$2 AND owner_lane='v1'
         AND lease_id=$3 AND actor_id=$4 AND fencing_token=$5::bigint
         AND status IN ('acquired','heartbeat_active') AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [input.projectId, input.environmentName, leaseId, actorId, fencingToken],
    );
    if (fence.length !== 1) throw new Error("FIRST_RELEASE_RECOVERY_REMEDIATION_FENCE_LOST");
    if (row.status !== "planned" || row.releaseManifestId !== null
      || row.infrastructureManifestId !== input.infrastructureManifestId
      || row.requestPayload?.recoveryOfIntentId !== input.failedIntentId
      || row.requestPayload?.recoveryCode !== "PRE_MUTATION_IMAGE_ABSENT"
      || row.requestPayload?.requestedCommitSha !== input.commitSha) {
      throw new Error("FIRST_RELEASE_RECOVERY_REMEDIATION_EVIDENCE_INVALID");
    }
    const [outboxes, leases] = await Promise.all([
      manager.query("SELECT 1 FROM orchestration_outbox WHERE intent_id=$1", [input.malformedIntentId]),
      manager.query("SELECT 1 FROM project_operation_leases WHERE intent_id=$1", [input.malformedIntentId]),
    ]);
    if (outboxes.length || leases.length) throw new Error("FIRST_RELEASE_RECOVERY_REMEDIATION_SIDE_EFFECT_PRESENT");
    const updated = await manager.query(
      `UPDATE deployment_intents SET status='failed', failure_code=$2,
         failure_message='Invalid first-release recovery result; no candidate or delivery was created.',
         completed_at=clock_timestamp(), updated_at=clock_timestamp()
       WHERE id=$1 AND status='planned' RETURNING id`,
      [input.malformedIntentId, SAFE_CODE],
    );
    const updatedRows = Array.isArray(updated?.[0]) ? updated[0] : updated;
    if (updatedRows.length !== 1) throw new Error("FIRST_RELEASE_RECOVERY_REMEDIATION_FENCE_LOST");
    await manager.query(
      `INSERT INTO audit_logs (actor_user_id, actor_email, actor_role, action, category,
         resource_type, resource_id, status, ip_address, user_agent, metadata)
       SELECT requested_by_user_id,NULL,NULL,'deployment_intent.first_release_recovery_invalid',
         'infrastructure','deployment_intent',id,'failed',NULL,NULL,$2::jsonb
       FROM deployment_intents WHERE id=$1
       AND NOT EXISTS (SELECT 1 FROM audit_logs WHERE resource_type='deployment_intent'
         AND resource_id=$1::text AND action='deployment_intent.first_release_recovery_invalid')`,
      [input.malformedIntentId, JSON.stringify({ safeCode: SAFE_CODE, failedIntentId: input.failedIntentId,
        initialReleaseDraftId: input.initialReleaseDraftId, infrastructureManifestId: input.infrastructureManifestId })],
    );
    return { state: "terminal", safeCode: SAFE_CODE, replayed: false };
  }

  private uuidFromHash(hash: string) {
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  }
}
