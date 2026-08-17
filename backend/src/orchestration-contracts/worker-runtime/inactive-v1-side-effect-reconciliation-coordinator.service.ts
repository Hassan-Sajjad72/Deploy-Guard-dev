import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import {
  abandonedReconciliationEvidenceFingerprint,
  assertV1ReconciliationCoordinatorClaim,
} from "./v1-side-effect-reconciliation-coordinator.pure";
import {
  V1SideEffectReconciliationCoordinatorError,
  V1SideEffectReconciliationCoordinatorInput,
  V1SideEffectReconciliationCoordinatorResult,
  V1SideEffectReconciliationLeaseSnapshot,
} from "./v1-side-effect-reconciliation-coordinator.types";
import {
  assertV1SideEffectReconciliationTimeout,
  canonicalizeV1SideEffectReconciliationLogicalIdentity,
  v1SideEffectReconciliationRequestFingerprint,
} from "./v1-side-effect-reconciliation.pure";
import {
  InactiveV1SideEffectReconciliationService,
} from "./inactive-v1-side-effect-reconciliation.service";
import {
  V1SideEffectReconciliationError,
} from "./v1-side-effect-reconciliation.types";

type EffectRow = {
  id: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  effectType: string;
  requestFingerprint: string;
  status: string;
  intentStatus: string;
};

type LeaseRow = {
  id: string;
  sideEffectId: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  ownerWorkerId: string;
  fencingToken: string;
  status: V1SideEffectReconciliationLeaseSnapshot["status"];
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ReconciliationRow = {
  id: string;
  sideEffectId: string;
  operationId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  leaseId: string;
  fencingToken: string;
  classification:
    | "succeeded"
    | "failed"
    | "pending"
    | "manual_review"
    | null;
  safeEvidenceCode: string | null;
  evidenceFingerprint: string | null;
  resultFingerprint: string | null;
  externalReferenceHash: string | null;
  failureCode: string | null;
};

type ClaimResult =
  | {
      disposition: "claimed";
      lease: V1SideEffectReconciliationLeaseSnapshot;
      effect: EffectRow;
    }
  | Exclude<
      V1SideEffectReconciliationCoordinatorResult,
      { disposition: "coordinated" }
    >;

const LEASE_COLUMNS = `
  lease.id, lease.side_effect_id AS "sideEffectId",
  lease.intent_id AS "intentId", lease.project_id AS "projectId",
  lease.environment_name AS "environmentName",
  lease.owner_worker_id AS "ownerWorkerId",
  lease.fencing_token AS "fencingToken", lease.status,
  lease.acquired_at AS "acquiredAt",
  lease.heartbeat_at AS "heartbeatAt",
  lease.expires_at AS "expiresAt",
  lease.released_at AS "releasedAt",
  lease.created_at AS "createdAt", lease.updated_at AS "updatedAt"
`;

const RECONCILIATION_COLUMNS = `
  reconciliation.id,
  reconciliation.side_effect_id AS "sideEffectId",
  reconciliation.operation_id AS "operationId",
  reconciliation.idempotency_key AS "idempotencyKey",
  reconciliation.request_fingerprint AS "requestFingerprint",
  reconciliation.lease_id AS "leaseId",
  reconciliation.fencing_token AS "fencingToken",
  reconciliation.classification,
  reconciliation.safe_evidence_code AS "safeEvidenceCode",
  reconciliation.evidence_fingerprint AS "evidenceFingerprint",
  reconciliation.result_fingerprint AS "resultFingerprint",
  reconciliation.external_reference_hash AS "externalReferenceHash",
  reconciliation.failure_code AS "failureCode"
`;

@Injectable()
export class InactiveV1SideEffectReconciliationCoordinatorService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly reconciliation:
      InactiveV1SideEffectReconciliationService,
  ) {}

  async coordinate(
    input: V1SideEffectReconciliationCoordinatorInput,
  ): Promise<V1SideEffectReconciliationCoordinatorResult> {
    const timeoutMs =
      assertV1SideEffectReconciliationTimeout(input.request.timeoutMs);
    assertV1ReconciliationCoordinatorClaim({
      sideEffectId: input.request.sideEffectId,
      workerId: input.workerId,
      leaseTtlMs: input.leaseTtlMs,
      inspectionTimeoutMs: timeoutMs,
    });
    if (
      input.abortSignal?.aborted
      || !input.request.adapter
      || input.request.adapter.policy
        !== "deployguard.side-effect-reconciliation/read-only-v1"
      || typeof input.request.adapter.inspect !== "function"
    ) {
      throw new V1SideEffectReconciliationCoordinatorError(
        "RECONCILIATION_COORDINATOR_CONTRACT_INVALID",
      );
    }

    const claim = await this.claim(input);
    if (claim.disposition !== "claimed") return claim;

    let trusted = true;
    const signal = input.abortSignal ?? new AbortController().signal;
    const boundary = this.reconciliation.forOwnership({
      intentId: claim.effect.intentId,
      projectId: claim.effect.projectId,
      environmentName: claim.effect.environmentName,
      leaseId: claim.lease.id,
      workerId: claim.lease.ownerWorkerId,
      fencingToken: claim.lease.fencingToken,
      signal,
      isLeaseTrusted: () => trusted && !signal.aborted,
    });
    try {
      const result = await boundary.reconcile(input.request);
      trusted = false;
      const lease = await this.release(claim.lease);
      return { disposition: "coordinated", lease, result };
    } catch (error) {
      trusted = false;
      await this.fail(claim.lease);
      throw error;
    }
  }

  private async claim(
    input: V1SideEffectReconciliationCoordinatorInput,
  ): Promise<ClaimResult> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.dataSource.transaction(
          "SERIALIZABLE",
          (manager) => this.claimInTransaction(manager, input),
        );
      } catch (error) {
        if (attempt === 3 || !this.isRetryableConflict(error)) throw error;
      }
    }
    throw new V1SideEffectReconciliationCoordinatorError(
      "RECONCILIATION_COORDINATOR_TRANSITION_CONFLICT",
    );
  }

  private async claimInTransaction(
    manager: EntityManager,
    input: V1SideEffectReconciliationCoordinatorInput,
  ): Promise<ClaimResult> {
    const effectRows = this.rows<EffectRow>(await manager.query(
      `SELECT effect.id, effect.intent_id AS "intentId",
              effect.project_id AS "projectId",
              effect.environment_name AS "environmentName",
              effect.effect_type AS "effectType",
              effect.request_fingerprint AS "requestFingerprint",
              effect.status, intent.status AS "intentStatus"
       FROM deployment_side_effects effect
       INNER JOIN deployment_intents intent ON intent.id = effect.intent_id
       WHERE effect.id = $1
       FOR UPDATE OF effect`,
      [input.request.sideEffectId],
    ));
    const effect = effectRows[0];
    if (!effect || effect.effectType !== input.request.adapter.effectType) {
      throw new V1SideEffectReconciliationCoordinatorError(
        "RECONCILIATION_COORDINATOR_CONTRACT_INVALID",
      );
    }
    const logicalIdentity =
      canonicalizeV1SideEffectReconciliationLogicalIdentity({
        sideEffectId: effect.id,
        intentId: effect.intentId,
        projectId: effect.projectId,
        environmentName: effect.environmentName,
        operationId: input.request.operationId,
        idempotencyKey: input.request.idempotencyKey,
        adapterId: input.request.adapter.adapterId,
        inspectionFingerprint: input.request.inspectionFingerprint,
        effectRequestFingerprint: effect.requestFingerprint,
      });
    const requestFingerprint =
      v1SideEffectReconciliationRequestFingerprint(logicalIdentity);

    await manager.query(
      `UPDATE deployment_side_effect_reconciliation_leases
       SET status = 'expired', released_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE side_effect_id = $1
         AND status IN ('acquired','heartbeat_active')
         AND expires_at <= clock_timestamp()`,
      [effect.id],
    );
    await this.closeAbandonedInspections(manager, effect);

    const matching = this.rows<ReconciliationRow>(await manager.query(
      `SELECT ${RECONCILIATION_COLUMNS}
       FROM deployment_side_effect_reconciliations reconciliation
       WHERE reconciliation.side_effect_id = $1
         AND (
           reconciliation.operation_id = $2
           OR reconciliation.idempotency_key = $3
         )
       FOR UPDATE OF reconciliation`,
      [
        effect.id,
        input.request.operationId,
        input.request.idempotencyKey,
      ],
    ));
    if (matching.length > 0) {
      const exact = matching.find((row) =>
        row.operationId === input.request.operationId
        && row.idempotencyKey === input.request.idempotencyKey
        && row.requestFingerprint === requestFingerprint
      );
      if (!exact || matching.length !== 1) {
        throw new V1SideEffectReconciliationCoordinatorError(
          "RECONCILIATION_COORDINATOR_IDEMPOTENCY_CONFLICT",
        );
      }
      if (!exact.classification) {
        return {
          disposition: "inspection_in_progress",
          sideEffectId: effect.id,
        };
      }
      if (!exact.evidenceFingerprint) {
        throw new V1SideEffectReconciliationCoordinatorError(
          "RECONCILIATION_COORDINATOR_TRANSITION_CONFLICT",
        );
      }
      return {
        disposition: "terminal_evidence_replayed",
        sideEffectId: effect.id,
        reconciliationId: exact.id,
        classification: exact.classification,
        safeEvidenceCode: exact.safeEvidenceCode,
        evidenceFingerprint: exact.evidenceFingerprint,
        resultFingerprint: exact.resultFingerprint,
        externalReferenceHash: exact.externalReferenceHash,
        failureCode: exact.failureCode,
      };
    }

    const active = this.rows<LeaseRow>(await manager.query(
      `SELECT ${LEASE_COLUMNS}
       FROM deployment_side_effect_reconciliation_leases lease
       WHERE lease.side_effect_id = $1
         AND lease.status IN ('acquired','heartbeat_active')
         AND lease.expires_at > clock_timestamp()
       FOR UPDATE OF lease`,
      [effect.id],
    ));
    if (active.length > 0) {
      return {
        disposition: "inspection_in_progress",
        sideEffectId: effect.id,
      };
    }
    if (
      (effect.status !== "started" && effect.status !== "uncertain")
      || !["running", "failed"].includes(effect.intentStatus)
    ) {
      return { disposition: "effect_not_eligible", sideEffectId: effect.id };
    }

    const [tokenRow] = this.rows<{ token: string }>(await manager.query(
      `SELECT COALESCE(MAX(fencing_token), 0)::bigint + 1 AS token
       FROM deployment_side_effect_reconciliation_leases
       WHERE side_effect_id = $1`,
      [effect.id],
    ));
    if (!tokenRow || !/^[1-9][0-9]*$/.test(String(tokenRow.token))) {
      throw new V1SideEffectReconciliationCoordinatorError(
        "RECONCILIATION_COORDINATOR_TRANSITION_CONFLICT",
      );
    }
    const inserted = this.rows<LeaseRow>(await manager.query(
      `INSERT INTO deployment_side_effect_reconciliation_leases (
         side_effect_id, intent_id, project_id, environment_name,
         owner_worker_id, fencing_token, status, origin,
         acquired_at, heartbeat_at, expires_at, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6::bigint, 'acquired', 'coordinator',
         clock_timestamp(), clock_timestamp(),
         clock_timestamp() + ($7 * interval '1 millisecond'),
         clock_timestamp(), clock_timestamp()
       )
       RETURNING ${LEASE_COLUMNS.replaceAll("lease.", "")}`,
      [
        effect.id,
        effect.intentId,
        effect.projectId,
        effect.environmentName,
        input.workerId,
        tokenRow.token,
        input.leaseTtlMs,
      ],
    ));
    if (inserted.length !== 1) {
      throw new V1SideEffectReconciliationCoordinatorError(
        "RECONCILIATION_COORDINATOR_TRANSITION_CONFLICT",
      );
    }
    return {
      disposition: "claimed",
      lease: this.leaseSnapshot(inserted[0]),
      effect,
    };
  }

  private async closeAbandonedInspections(
    manager: EntityManager,
    effect: EffectRow,
  ) {
    const abandoned = this.rows<ReconciliationRow>(await manager.query(
      `SELECT ${RECONCILIATION_COLUMNS}
       FROM deployment_side_effect_reconciliations reconciliation
       INNER JOIN deployment_side_effect_reconciliation_leases lease
         ON lease.id = reconciliation.lease_id
       WHERE reconciliation.side_effect_id = $1
         AND reconciliation.classification IS NULL
         AND (
           lease.status NOT IN ('acquired','heartbeat_active')
           OR lease.expires_at <= clock_timestamp()
         )
       FOR UPDATE OF reconciliation, lease`,
      [effect.id],
    ));
    for (const row of abandoned) {
      const evidenceFingerprint =
        abandonedReconciliationEvidenceFingerprint({
          sideEffectId: effect.id,
          reconciliationId: row.id,
          requestFingerprint: row.requestFingerprint,
          leaseId: row.leaseId,
          fencingToken: String(row.fencingToken),
        });
      const result = await manager.query(
        `UPDATE deployment_side_effect_reconciliations
         SET classification = 'pending',
             safe_evidence_code =
               'RECONCILIATION_PREVIOUS_INSPECTION_ABANDONED',
             evidence_fingerprint = $2,
             failure_code = NULL,
             completed_at = clock_timestamp()
         WHERE id = $1 AND classification IS NULL`,
        [row.id, evidenceFingerprint],
      );
      if (this.affected(result) !== 1) {
        throw new V1SideEffectReconciliationCoordinatorError(
          "RECONCILIATION_COORDINATOR_TRANSITION_CONFLICT",
        );
      }
    }
    if (abandoned.length > 0) {
      const result = await manager.query(
        `UPDATE deployment_side_effects
         SET status = 'uncertain', reconciliation_required = true,
             failure_code =
               'RECONCILIATION_PREVIOUS_INSPECTION_ABANDONED',
             updated_at = clock_timestamp()
         WHERE id = $1 AND status IN ('started','uncertain')`,
        [effect.id],
      );
      if (this.affected(result) !== 1) {
        throw new V1SideEffectReconciliationCoordinatorError(
          "RECONCILIATION_COORDINATOR_TRANSITION_CONFLICT",
        );
      }
      effect.status = "uncertain";
    }
  }

  private async release(
    lease: V1SideEffectReconciliationLeaseSnapshot,
  ): Promise<V1SideEffectReconciliationLeaseSnapshot> {
    const rows = this.rows<LeaseRow>(await this.dataSource.query(
      `UPDATE deployment_side_effect_reconciliation_leases lease
       SET status = 'released', released_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE lease.id = $1
         AND lease.owner_worker_id = $2
         AND lease.fencing_token = $3::bigint
         AND lease.status IN ('acquired','heartbeat_active')
         AND lease.expires_at > clock_timestamp()
       RETURNING ${LEASE_COLUMNS.replaceAll("lease.", "")}`,
      [lease.id, lease.ownerWorkerId, lease.fencingToken],
    ));
    if (rows[0]) return this.leaseSnapshot(rows[0]);
    const current = this.rows<LeaseRow>(await this.dataSource.query(
      `SELECT ${LEASE_COLUMNS}
       FROM deployment_side_effect_reconciliation_leases lease
       WHERE lease.id = $1
         AND lease.owner_worker_id = $2
         AND lease.fencing_token = $3::bigint`,
      [lease.id, lease.ownerWorkerId, lease.fencingToken],
    ))[0];
    return current ? this.leaseSnapshot(current) : lease;
  }

  private async fail(
    lease: V1SideEffectReconciliationLeaseSnapshot,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE deployment_side_effect_reconciliation_leases
       SET status = 'failed', released_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1
         AND owner_worker_id = $2
         AND fencing_token = $3::bigint
         AND status IN ('acquired','heartbeat_active')`,
      [lease.id, lease.ownerWorkerId, lease.fencingToken],
    );
  }

  private leaseSnapshot(
    row: LeaseRow,
  ): V1SideEffectReconciliationLeaseSnapshot {
    return Object.freeze({
      id: row.id,
      sideEffectId: row.sideEffectId,
      intentId: row.intentId,
      projectId: row.projectId,
      environmentName: row.environmentName,
      ownerWorkerId: row.ownerWorkerId,
      fencingToken: String(row.fencingToken),
      status: row.status,
      acquiredAt: new Date(row.acquiredAt),
      heartbeatAt: new Date(row.heartbeatAt),
      expiresAt: new Date(row.expiresAt),
      releasedAt: row.releasedAt ? new Date(row.releasedAt) : null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    });
  }

  private rows<T>(result: unknown): T[] {
    if (
      Array.isArray(result)
      && result.length === 2
      && Array.isArray(result[0])
      && typeof result[1] === "number"
    ) {
      return result[0] as T[];
    }
    return Array.isArray(result) ? result as T[] : [];
  }

  private affected(result: unknown) {
    if (Array.isArray(result) && typeof result[1] === "number") {
      return result[1];
    }
    return 0;
  }

  private isRetryableConflict(error: unknown) {
    if (error instanceof V1SideEffectReconciliationError) return false;
    if (!error || typeof error !== "object") return false;
    const code = "code" in error ? String(error.code) : "";
    return code === "23505" || code === "40001" || code === "40P01";
  }
}
