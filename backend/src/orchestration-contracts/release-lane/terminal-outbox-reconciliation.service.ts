import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { TerminalOutboxPolicyService } from "../outbox/terminal-outbox-policy.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION = "deployment_intent.terminal_outbox_reconciled";
const SAFE_CODE = "INTENT_COMPLETED_BEFORE_OUTBOX_DISPATCH";

export type TerminalOutboxReconciliationInput = Readonly<{
  intentId: string;
  outboxId: string;
  projectId: string;
  environmentName: "dev";
  infrastructureRevision: number;
  releaseRevision: number;
}>;

export type TerminalOutboxReconciliationResult = Readonly<{
  state: "reconciled" | "already_reconciled";
  safeCode: typeof SAFE_CODE;
}>;

type LockedTarget = {
  intentId: string;
  requestedByUserId: number | null;
  intentStatus: string;
  classification: string;
  infrastructureStatus: string;
  infrastructureRevision: string;
  releaseStatus: string;
  releaseRevision: string;
  outboxStatus: string;
  attemptCount: number;
  publishedJobId: string | null;
  publishedAt: Date | null;
  claimedBy: string | null;
  claimExpiresAt: Date | null;
  lastError: string | null;
};

/**
 * Explicitly callable terminal repair for an already-completed intent whose
 * outbox was never delivered. It owns no execution lease and has no queue or
 * cloud dependency; its advisory and row locks are released at transaction end.
 */
@Injectable()
export class TerminalOutboxReconciliationService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly terminalOutbox: TerminalOutboxPolicyService,
  ) {}

  async reconcile(
    input: TerminalOutboxReconciliationInput,
  ): Promise<TerminalOutboxReconciliationResult> {
    this.assertInput(input);
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `deployguard:planner:${input.projectId}:${input.environmentName}`,
      ]);
      const target = await this.lockTarget(manager, input);
      this.assertTarget(target, input);

      if (target.outboxStatus === "dead_letter") {
        if (target.lastError !== SAFE_CODE) {
          throw new Error("TERMINAL_OUTBOX_RECONCILIATION_STATE_INVALID");
        }
        await this.recordAudit(manager, target, input);
        return Object.freeze({ state: "already_reconciled", safeCode: SAFE_CODE });
      }

      const active = await manager.query(
        `SELECT
           EXISTS (
             SELECT 1 FROM project_operation_leases
             WHERE intent_id = $1 AND status IN ('acquired','heartbeat_active')
               AND expires_at > clock_timestamp()
           ) AS "activeOperationLease",
           EXISTS (
             SELECT 1 FROM project_release_lane_ownerships
             WHERE project_id = $2 AND environment_name = 'dev'
               AND status IN ('acquired','heartbeat_active')
               AND expires_at > clock_timestamp()
           ) AS "activeCrossLaneOwnership"`,
        [input.intentId, input.projectId],
      ) as Array<{ activeOperationLease: boolean; activeCrossLaneOwnership: boolean }>;
      if (active[0]?.activeOperationLease || active[0]?.activeCrossLaneOwnership) {
        throw new Error("TERMINAL_OUTBOX_RECONCILIATION_OWNERSHIP_ACTIVE");
      }

      const terminalized = await this.terminalOutbox.terminalizeUndispatched(
        manager,
        { intentId: input.intentId, intentStatus: "completed" },
      );
      if (terminalized.transitionedCount !== 1 || terminalized.reason !== SAFE_CODE) {
        throw new Error("TERMINAL_OUTBOX_RECONCILIATION_FENCE_LOST");
      }
      await this.recordAudit(manager, target, input);
      return Object.freeze({ state: "reconciled", safeCode: SAFE_CODE });
    });
  }

  private async lockTarget(
    manager: EntityManager,
    input: TerminalOutboxReconciliationInput,
  ) {
    const rows = await manager.query(
      `SELECT
         intent.id AS "intentId",
         intent.requested_by_user_id AS "requestedByUserId",
         intent.status AS "intentStatus", intent.classification,
         infrastructure.status AS "infrastructureStatus",
         infrastructure.revision::text AS "infrastructureRevision",
         release.status AS "releaseStatus", release.revision::text AS "releaseRevision",
         outbox.status AS "outboxStatus", outbox.attempt_count AS "attemptCount",
         outbox.published_job_id AS "publishedJobId", outbox.published_at AS "publishedAt",
         outbox.claimed_by AS "claimedBy", outbox.claim_expires_at AS "claimExpiresAt",
         outbox.last_error AS "lastError"
       FROM deployment_intents intent
       INNER JOIN orchestration_outbox outbox ON outbox.intent_id = intent.id
       INNER JOIN infrastructure_manifests infrastructure ON infrastructure.id = intent.infrastructure_manifest_id
       INNER JOIN release_manifests release ON release.id = intent.release_manifest_id
       WHERE intent.id = $1 AND outbox.id = $2
         AND intent.project_id = $3 AND intent.environment_name = 'dev'
       FOR UPDATE OF intent, outbox, infrastructure, release`,
      [input.intentId, input.outboxId, input.projectId],
    ) as LockedTarget[];
    if (rows.length !== 1) throw new Error("TERMINAL_OUTBOX_RECONCILIATION_TARGET_NOT_FOUND");
    return rows[0];
  }

  private assertTarget(target: LockedTarget, input: TerminalOutboxReconciliationInput) {
    const pristinePending = target.outboxStatus === "pending"
      && target.attemptCount === 0
      && !target.publishedJobId
      && !target.publishedAt
      && !target.claimedBy
      && !target.claimExpiresAt;
    const alreadyReconciled = target.outboxStatus === "dead_letter"
      && target.attemptCount === 0
      && !target.publishedJobId
      && !target.publishedAt
      && !target.claimedBy
      && !target.claimExpiresAt
      && target.lastError === SAFE_CODE;
    if (target.intentStatus !== "completed"
      || target.classification !== "release_only"
      || target.infrastructureStatus !== "applied"
      || target.releaseStatus !== "stable"
      || Number(target.infrastructureRevision) !== input.infrastructureRevision
      || Number(target.releaseRevision) !== input.releaseRevision
      || (!pristinePending && !alreadyReconciled)) {
      throw new Error("TERMINAL_OUTBOX_RECONCILIATION_STATE_INVALID");
    }
  }

  private async recordAudit(
    manager: EntityManager,
    target: LockedTarget,
    input: TerminalOutboxReconciliationInput,
  ) {
    await manager.query(
      `INSERT INTO audit_logs (
         actor_user_id, action, category, resource_type, resource_id, status, metadata
       )
       SELECT $1::integer, $2::text, 'release', 'orchestration_outbox', $3::text, 'reconciled', $4::jsonb
       WHERE NOT EXISTS (
         SELECT 1 FROM audit_logs
         WHERE action = $2 AND resource_type = 'orchestration_outbox'
           AND resource_id = $3 AND status = 'reconciled'
       )`,
      [
        target.requestedByUserId,
        ACTION,
        input.outboxId,
        JSON.stringify({
          projectId: input.projectId,
          environment: input.environmentName,
          intentId: input.intentId,
          outcome: "terminal_outbox_reconciled",
          safeCode: SAFE_CODE,
        }),
      ],
    );
  }

  private assertInput(input: TerminalOutboxReconciliationInput) {
    if (!UUID.test(input.intentId) || !UUID.test(input.outboxId)
      || !UUID.test(input.projectId) || input.environmentName !== "dev"
      || !Number.isSafeInteger(input.infrastructureRevision)
      || input.infrastructureRevision < 1
      || !Number.isSafeInteger(input.releaseRevision)
      || input.releaseRevision < 1) {
      throw new Error("TERMINAL_OUTBOX_RECONCILIATION_SCOPE_INVALID");
    }
  }
}
