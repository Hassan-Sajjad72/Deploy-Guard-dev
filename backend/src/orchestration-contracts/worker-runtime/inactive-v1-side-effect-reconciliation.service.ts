import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import {
  assertV1SideEffectReconciliationTimeout,
  canonicalizeV1SideEffectReconciliationIdentity,
  safeInconclusiveReconciliationEvidence,
  validateV1ReadOnlySideEffectEvidence,
  v1SideEffectReconciliationRequestFingerprint,
} from "./v1-side-effect-reconciliation.pure";
import {
  V1ReadOnlySideEffectEvidence,
  V1SideEffectReconciliationBoundary,
  V1SideEffectReconciliationError,
  V1SideEffectReconciliationIdentity,
  V1SideEffectReconciliationRequest,
  V1SideEffectReconciliationResult,
  V1SideEffectReconciliationSnapshot,
} from "./v1-side-effect-reconciliation.types";
import {
  V1HandlerSideEffectSnapshot,
} from "./v1-handler-side-effect.types";

type ReconciliationFence = {
  intentId: string;
  projectId: string;
  environmentName: string;
  leaseId: string;
  workerId: string;
  fencingToken: string;
  signal: AbortSignal;
  isLeaseTrusted(): boolean;
};

type EffectRow = {
  id: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  operationId: string;
  effectType: string;
  idempotencyKey: string;
  requestFingerprint: string;
  leaseId: string;
  ownerWorkerId: string;
  fencingToken: string;
  status: V1HandlerSideEffectSnapshot["status"];
  safeResultCode: string | null;
  resultFingerprint: string | null;
  externalReferenceHash: string | null;
  failureCode: string | null;
  reconciliationRequired: boolean;
  attemptStartedAt: Date | null;
  deadlineAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type ReconciliationRow = {
  id: string;
  sideEffectId: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  operationId: string;
  idempotencyKey: string;
  adapterId: string;
  requestFingerprint: string;
  leaseId: string;
  ownerWorkerId: string;
  fencingToken: string;
  classification: V1SideEffectReconciliationSnapshot["classification"];
  safeEvidenceCode: string | null;
  evidenceFingerprint: string | null;
  resultFingerprint: string | null;
  externalReferenceHash: string | null;
  failureCode: string | null;
  inspectionStartedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
};

type PreparedReconciliation =
  | {
      disposition: "inspect";
      identity: V1SideEffectReconciliationIdentity;
      requestFingerprint: string;
      sideEffect: V1HandlerSideEffectSnapshot;
      reconciliation: V1SideEffectReconciliationSnapshot;
    }
  | V1SideEffectReconciliationResult;

const EFFECT_COLUMNS = `
  effect.id, effect.intent_id AS "intentId",
  effect.project_id AS "projectId",
  effect.environment_name AS "environmentName",
  effect.operation_id AS "operationId",
  effect.effect_type AS "effectType",
  effect.idempotency_key AS "idempotencyKey",
  effect.request_fingerprint AS "requestFingerprint",
  effect.lease_id AS "leaseId",
  effect.owner_worker_id AS "ownerWorkerId",
  effect.fencing_token AS "fencingToken", effect.status,
  effect.safe_result_code AS "safeResultCode",
  effect.result_fingerprint AS "resultFingerprint",
  effect.external_reference_hash AS "externalReferenceHash",
  effect.failure_code AS "failureCode",
  effect.reconciliation_required AS "reconciliationRequired",
  effect.attempt_started_at AS "attemptStartedAt",
  effect.deadline_at AS "deadlineAt",
  effect.completed_at AS "completedAt",
  effect.created_at AS "createdAt", effect.updated_at AS "updatedAt"
`;

const RECONCILIATION_COLUMNS = `
  reconciliation.id,
  reconciliation.side_effect_id AS "sideEffectId",
  reconciliation.intent_id AS "intentId",
  reconciliation.project_id AS "projectId",
  reconciliation.environment_name AS "environmentName",
  reconciliation.operation_id AS "operationId",
  reconciliation.idempotency_key AS "idempotencyKey",
  reconciliation.adapter_id AS "adapterId",
  reconciliation.request_fingerprint AS "requestFingerprint",
  reconciliation.lease_id AS "leaseId",
  reconciliation.owner_worker_id AS "ownerWorkerId",
  reconciliation.fencing_token AS "fencingToken",
  reconciliation.classification,
  reconciliation.safe_evidence_code AS "safeEvidenceCode",
  reconciliation.evidence_fingerprint AS "evidenceFingerprint",
  reconciliation.result_fingerprint AS "resultFingerprint",
  reconciliation.external_reference_hash AS "externalReferenceHash",
  reconciliation.failure_code AS "failureCode",
  reconciliation.inspection_started_at AS "inspectionStartedAt",
  reconciliation.completed_at AS "completedAt",
  reconciliation.created_at AS "createdAt"
`;

@Injectable()
export class InactiveV1SideEffectReconciliationService {
  constructor(private readonly dataSource: DataSource) {}

  forOwnership(
    fence: ReconciliationFence,
  ): V1SideEffectReconciliationBoundary {
    const captured = Object.freeze({ ...fence });
    return Object.freeze({
      reconcile: (request: V1SideEffectReconciliationRequest) =>
        this.reconcile(captured, request),
    });
  }

  private async reconcile(
    fence: ReconciliationFence,
    request: V1SideEffectReconciliationRequest,
  ): Promise<V1SideEffectReconciliationResult> {
    if (
      fence.signal.aborted
      || !fence.isLeaseTrusted()
    ) {
      throw new V1SideEffectReconciliationError(
        "SIDE_EFFECT_RECONCILIATION_OWNERSHIP_LOST",
      );
    }
    if (
      !request.adapter
      || request.adapter.policy
        !== "deployguard.side-effect-reconciliation/read-only-v1"
      || typeof request.adapter.inspect !== "function"
    ) {
      throw new V1SideEffectReconciliationError(
        "SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID",
      );
    }
    const timeoutMs =
      assertV1SideEffectReconciliationTimeout(request.timeoutMs);
    const prepared = await this.prepare(fence, request);
    if (prepared.disposition !== "inspect") return prepared;

    if (fence.signal.aborted || !fence.isLeaseTrusted()) {
      return this.finalizeWithoutTrustedOwnership(
        prepared,
        safeInconclusiveReconciliationEvidence(
          prepared.sideEffect.id,
          prepared.requestFingerprint,
          "RECONCILIATION_OWNERSHIP_LOST",
        ),
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const onCancellation = () => {
      cancelled = true;
      controller.abort();
    };
    fence.signal.addEventListener("abort", onCancellation, { once: true });
    const deadlineAt = new Date(Date.now() + timeoutMs);
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const inspectionContext = Object.freeze({
      readOnly: true as const,
      sideEffect: prepared.sideEffect,
      signal: controller.signal,
      deadlineAt,
      intentId: fence.intentId,
      projectId: fence.projectId,
      environmentName: fence.environmentName,
      leaseId: fence.leaseId,
      workerId: fence.workerId,
      fencingToken: fence.fencingToken,
      isLeaseTrusted: () =>
        !controller.signal.aborted && fence.isLeaseTrusted(),
    });
    const inspection = Promise.resolve()
      .then(() => request.adapter.inspect(inspectionContext))
      .then((value) => ({
        kind: "evidence" as const,
        value: validateV1ReadOnlySideEffectEvidence(value),
      }))
      .catch(() => ({ kind: "failed" as const }));
    const interruption = new Promise<{ kind: "interrupted" }>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () => resolve({ kind: "interrupted" }),
        { once: true },
      );
    });
    const inspected = await Promise.race([inspection, interruption]);
    clearTimeout(timeout);
    fence.signal.removeEventListener("abort", onCancellation);

    let evidence: V1ReadOnlySideEffectEvidence;
    if (inspected.kind === "interrupted") {
      evidence = safeInconclusiveReconciliationEvidence(
        prepared.sideEffect.id,
        prepared.requestFingerprint,
        timedOut
          ? "RECONCILIATION_INSPECTION_TIMED_OUT"
          : "RECONCILIATION_INSPECTION_CANCELLED",
      );
    } else if (inspected.kind === "failed") {
      evidence = safeInconclusiveReconciliationEvidence(
        prepared.sideEffect.id,
        prepared.requestFingerprint,
        "RECONCILIATION_INSPECTION_FAILED",
      );
    } else {
      evidence = inspected.value;
    }

    if (
      cancelled
      || fence.signal.aborted
      || !fence.isLeaseTrusted()
    ) {
      return this.finalizeWithoutTrustedOwnership(
        prepared,
        safeInconclusiveReconciliationEvidence(
          prepared.sideEffect.id,
          prepared.requestFingerprint,
          "RECONCILIATION_OWNERSHIP_LOST",
        ),
      );
    }
    try {
      return await this.finalizeWithFence(prepared, evidence);
    } catch (error) {
      if (
        error instanceof V1SideEffectReconciliationError
        && error.code === "SIDE_EFFECT_RECONCILIATION_OWNERSHIP_LOST"
      ) {
        return this.finalizeWithoutTrustedOwnership(
          prepared,
          safeInconclusiveReconciliationEvidence(
            prepared.sideEffect.id,
            prepared.requestFingerprint,
            "RECONCILIATION_OWNERSHIP_LOST",
          ),
        );
      }
      throw error;
    }
  }

  private async prepare(
    fence: ReconciliationFence,
    request: V1SideEffectReconciliationRequest,
  ): Promise<PreparedReconciliation> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.dataSource.transaction(
          "SERIALIZABLE",
          (manager) => this.prepareInTransaction(manager, fence, request),
        );
      } catch (error) {
        if (attempt === 3 || !this.isRetryableConflict(error)) throw error;
      }
    }
    throw new V1SideEffectReconciliationError(
      "SIDE_EFFECT_RECONCILIATION_TRANSITION_CONFLICT",
    );
  }

  private async prepareInTransaction(
    manager: EntityManager,
    fence: ReconciliationFence,
    request: V1SideEffectReconciliationRequest,
  ): Promise<PreparedReconciliation> {
    await this.requireActiveFence(manager, fence);
    const effectRows = this.rows<EffectRow>(await manager.query(
      `SELECT ${EFFECT_COLUMNS}
       FROM deployment_side_effects effect
       WHERE effect.id = $1
         AND effect.intent_id = $2
         AND effect.project_id = $3
         AND effect.environment_name = $4
       FOR UPDATE OF effect`,
      [
        request.sideEffectId,
        fence.intentId,
        fence.projectId,
        fence.environmentName,
      ],
    ));
    const effect = effectRows[0];
    if (!effect || effect.effectType !== request.adapter.effectType) {
      throw new V1SideEffectReconciliationError(
        "SIDE_EFFECT_RECONCILIATION_CONTRACT_INVALID",
      );
    }
    const identity = canonicalizeV1SideEffectReconciliationIdentity({
      sideEffectId: effect.id,
      intentId: fence.intentId,
      projectId: fence.projectId,
      environmentName: fence.environmentName,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      adapterId: request.adapter.adapterId,
      inspectionFingerprint: request.inspectionFingerprint,
      effectRequestFingerprint: effect.requestFingerprint,
      leaseId: fence.leaseId,
      workerId: fence.workerId,
      fencingToken: fence.fencingToken,
    });
    const requestFingerprint =
      v1SideEffectReconciliationRequestFingerprint(identity);
    const existing = this.rows<ReconciliationRow>(await manager.query(
      `SELECT ${RECONCILIATION_COLUMNS}
       FROM deployment_side_effect_reconciliations reconciliation
       WHERE reconciliation.side_effect_id = $1
         AND (
           reconciliation.operation_id = $2
           OR reconciliation.idempotency_key = $3
         )
       FOR UPDATE OF reconciliation`,
      [effect.id, identity.operationId, identity.idempotencyKey],
    ));
    if (existing.length > 0) {
      const exact = existing.find((row) =>
        row.operationId === identity.operationId
        && row.idempotencyKey === identity.idempotencyKey
        && row.requestFingerprint === requestFingerprint
      );
      if (!exact || existing.length !== 1) {
        throw new V1SideEffectReconciliationError(
          "SIDE_EFFECT_RECONCILIATION_IDEMPOTENCY_CONFLICT",
        );
      }
      const reconciliation = this.reconciliationSnapshot(exact);
      const sideEffect = this.effectSnapshot(effect);
      if (!reconciliation.classification) {
        return {
          disposition: "inspection_in_progress",
          sideEffect,
          reconciliation,
        };
      }
      return {
        disposition: "replayed",
        classification: reconciliation.classification,
        sideEffect,
        reconciliation,
      };
    }
    if (effect.status !== "started" && effect.status !== "uncertain") {
      throw new V1SideEffectReconciliationError(
        "SIDE_EFFECT_RECONCILIATION_EFFECT_NOT_ELIGIBLE",
      );
    }
    const inserted = this.rows<ReconciliationRow>(await manager.query(
      `INSERT INTO deployment_side_effect_reconciliations (
         side_effect_id, intent_id, project_id, environment_name,
         operation_id, idempotency_key, adapter_id, request_fingerprint,
         lease_id, owner_worker_id, fencing_token,
         inspection_started_at, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8,
         $9, $10, $11::bigint, clock_timestamp(), clock_timestamp()
       )
       RETURNING ${RECONCILIATION_COLUMNS.replaceAll(
        "reconciliation.",
        "",
      )}`,
      [
        effect.id,
        fence.intentId,
        fence.projectId,
        fence.environmentName,
        identity.operationId,
        identity.idempotencyKey,
        identity.adapterId,
        requestFingerprint,
        fence.leaseId,
        fence.workerId,
        fence.fencingToken,
      ],
    ));
    if (inserted.length !== 1) {
      throw new V1SideEffectReconciliationError(
        "SIDE_EFFECT_RECONCILIATION_TRANSITION_CONFLICT",
      );
    }
    return {
      disposition: "inspect",
      identity,
      requestFingerprint,
      sideEffect: this.effectSnapshot(effect),
      reconciliation: this.reconciliationSnapshot(inserted[0]),
    };
  }

  private async finalizeWithFence(
    prepared: Extract<PreparedReconciliation, { disposition: "inspect" }>,
    evidence: V1ReadOnlySideEffectEvidence,
  ): Promise<V1SideEffectReconciliationResult> {
    return this.dataSource.transaction("SERIALIZABLE", async (manager) => {
      await this.requireActiveFence(manager, {
        intentId: prepared.identity.intentId,
        projectId: prepared.identity.projectId,
        environmentName: prepared.identity.environmentName,
        leaseId: prepared.identity.leaseId,
        workerId: prepared.identity.workerId,
        fencingToken: prepared.identity.fencingToken,
      });
      const reconciliationRows = this.rows<ReconciliationRow>(
        await manager.query(
          `SELECT ${RECONCILIATION_COLUMNS}
           FROM deployment_side_effect_reconciliations reconciliation
           WHERE reconciliation.id = $1
             AND reconciliation.lease_id = $2
             AND reconciliation.owner_worker_id = $3
             AND reconciliation.fencing_token = $4::bigint
           FOR UPDATE OF reconciliation`,
          [
            prepared.reconciliation.id,
            prepared.identity.leaseId,
            prepared.identity.workerId,
            prepared.identity.fencingToken,
          ],
        ),
      );
      const reconciliation = reconciliationRows[0];
      if (!reconciliation) {
        throw new V1SideEffectReconciliationError(
          "SIDE_EFFECT_RECONCILIATION_OWNERSHIP_LOST",
        );
      }
      if (reconciliation.classification) {
        return {
          disposition: "replayed",
          classification: reconciliation.classification,
          sideEffect: prepared.sideEffect,
          reconciliation: this.reconciliationSnapshot(reconciliation),
        };
      }
      const effectRows = this.rows<EffectRow>(await manager.query(
        `SELECT ${EFFECT_COLUMNS}
         FROM deployment_side_effects effect
         WHERE effect.id = $1
           AND effect.status IN ('started','uncertain')
         FOR UPDATE OF effect`,
        [prepared.sideEffect.id],
      ));
      if (effectRows.length !== 1) {
        throw new V1SideEffectReconciliationError(
          "SIDE_EFFECT_RECONCILIATION_EFFECT_NOT_ELIGIBLE",
        );
      }
      const fields = this.evidenceFields(evidence);
      const updatedEffects = this.rows<EffectRow>(await manager.query(
        `UPDATE deployment_side_effects effect
         SET status = $2,
             safe_result_code = $3,
             result_fingerprint = $4,
             external_reference_hash = $5,
             failure_code = $6,
             reconciliation_required = $7,
             completed_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE effect.id = $1
           AND effect.status IN ('started','uncertain')
         RETURNING ${EFFECT_COLUMNS.replaceAll("effect.", "")}`,
        [
          prepared.sideEffect.id,
          fields.effectStatus,
          fields.safeResultCode,
          fields.resultFingerprint,
          fields.externalReferenceHash,
          fields.failureCode,
          fields.reconciliationRequired,
        ],
      ));
      const updatedReconciliations = this.rows<ReconciliationRow>(
        await manager.query(
          `UPDATE deployment_side_effect_reconciliations reconciliation
           SET classification = $2,
               safe_evidence_code = $3,
               evidence_fingerprint = $4,
               result_fingerprint = $5,
               external_reference_hash = $6,
               failure_code = $7,
               completed_at = clock_timestamp()
           WHERE reconciliation.id = $1
             AND reconciliation.classification IS NULL
             AND reconciliation.lease_id = $8
             AND reconciliation.owner_worker_id = $9
             AND reconciliation.fencing_token = $10::bigint
           RETURNING ${RECONCILIATION_COLUMNS.replaceAll(
            "reconciliation.",
            "",
          )}`,
          [
            reconciliation.id,
            evidence.classification,
            fields.safeEvidenceCode,
            evidence.evidenceFingerprint,
            fields.resultFingerprint,
            fields.externalReferenceHash,
            fields.failureCode,
            prepared.identity.leaseId,
            prepared.identity.workerId,
            prepared.identity.fencingToken,
          ],
        ),
      );
      if (
        updatedEffects.length !== 1
        || updatedReconciliations.length !== 1
      ) {
        throw new V1SideEffectReconciliationError(
          "SIDE_EFFECT_RECONCILIATION_TRANSITION_CONFLICT",
        );
      }
      return {
        disposition: "classified",
        classification: evidence.classification,
        sideEffect: this.effectSnapshot(updatedEffects[0]),
        reconciliation: this.reconciliationSnapshot(
          updatedReconciliations[0],
        ),
      };
    });
  }

  private async finalizeWithoutTrustedOwnership(
    prepared: Extract<PreparedReconciliation, { disposition: "inspect" }>,
    evidence: V1ReadOnlySideEffectEvidence,
  ): Promise<V1SideEffectReconciliationResult> {
    const fields = this.evidenceFields(evidence);
    const rows = this.rows<ReconciliationRow>(await this.dataSource.query(
      `UPDATE deployment_side_effect_reconciliations reconciliation
       SET classification = 'pending',
           safe_evidence_code = $5,
           evidence_fingerprint = $6,
           failure_code = NULL,
           completed_at = clock_timestamp()
       WHERE reconciliation.id = $1
         AND reconciliation.lease_id = $2
         AND reconciliation.owner_worker_id = $3
         AND reconciliation.fencing_token = $4::bigint
         AND reconciliation.classification IS NULL
       RETURNING ${RECONCILIATION_COLUMNS.replaceAll(
        "reconciliation.",
        "",
      )}`,
      [
        prepared.reconciliation.id,
        prepared.identity.leaseId,
        prepared.identity.workerId,
        prepared.identity.fencingToken,
        fields.safeEvidenceCode ?? "RECONCILIATION_OWNERSHIP_LOST",
        evidence.evidenceFingerprint,
      ],
    ));
    const reconciliation = rows[0] ?? this.rows<ReconciliationRow>(
      await this.dataSource.query(
        `SELECT ${RECONCILIATION_COLUMNS}
         FROM deployment_side_effect_reconciliations reconciliation
         WHERE reconciliation.id = $1`,
        [prepared.reconciliation.id],
      ),
    )[0];
    const sideEffect = this.rows<EffectRow>(await this.dataSource.query(
      `SELECT ${EFFECT_COLUMNS}
       FROM deployment_side_effects effect WHERE effect.id = $1`,
      [prepared.sideEffect.id],
    ))[0];
    if (!reconciliation || !sideEffect || !reconciliation.classification) {
      throw new V1SideEffectReconciliationError(
        "SIDE_EFFECT_RECONCILIATION_TRANSITION_CONFLICT",
      );
    }
    return {
      disposition: "classified",
      classification: reconciliation.classification,
      sideEffect: this.effectSnapshot(sideEffect),
      reconciliation: this.reconciliationSnapshot(reconciliation),
    };
  }

  private async requireActiveFence(
    manager: EntityManager,
    fence: Pick<
      ReconciliationFence,
      | "intentId"
      | "projectId"
      | "environmentName"
      | "leaseId"
      | "workerId"
      | "fencingToken"
    >,
  ) {
    const ownership = await manager.query(
      `SELECT lease.id
       FROM deployment_side_effect_reconciliation_leases lease
       INNER JOIN deployment_intents intent ON intent.id = lease.intent_id
       WHERE lease.id = $1
         AND lease.owner_worker_id = $2
         AND lease.fencing_token = $3::bigint
         AND lease.intent_id = $4
         AND lease.project_id = $5
         AND lease.environment_name = $6
         AND lease.status IN ('acquired','heartbeat_active')
         AND lease.expires_at > clock_timestamp()
         AND intent.status IN ('running','failed')
       FOR UPDATE OF lease, intent`,
      [
        fence.leaseId,
        fence.workerId,
        fence.fencingToken,
        fence.intentId,
        fence.projectId,
        fence.environmentName,
      ],
    );
    if (this.rows(ownership).length !== 1) {
      throw new V1SideEffectReconciliationError(
        "SIDE_EFFECT_RECONCILIATION_OWNERSHIP_LOST",
      );
    }
  }

  private evidenceFields(evidence: V1ReadOnlySideEffectEvidence) {
    if (evidence.classification === "succeeded") {
      return {
        effectStatus: "succeeded",
        safeEvidenceCode: evidence.safeEvidenceCode,
        safeResultCode: evidence.safeEvidenceCode,
        resultFingerprint: evidence.resultFingerprint,
        externalReferenceHash: evidence.externalReferenceHash ?? null,
        failureCode: null,
        reconciliationRequired: false,
      };
    }
    if (evidence.classification === "failed") {
      return {
        effectStatus: "failed",
        safeEvidenceCode: null,
        safeResultCode: null,
        resultFingerprint: null,
        externalReferenceHash: null,
        failureCode: evidence.safeFailureCode,
        reconciliationRequired: false,
      };
    }
    if (evidence.classification === "pending") {
      return {
        effectStatus: "uncertain",
        safeEvidenceCode: evidence.safeEvidenceCode,
        safeResultCode: null,
        resultFingerprint: null,
        externalReferenceHash: null,
        failureCode: evidence.safeEvidenceCode,
        reconciliationRequired: true,
      };
    }
    return {
      effectStatus: "uncertain",
      safeEvidenceCode: null,
      safeResultCode: null,
      resultFingerprint: null,
      externalReferenceHash: null,
      failureCode: evidence.safeFailureCode,
      reconciliationRequired: true,
    };
  }

  private effectSnapshot(row: EffectRow): V1HandlerSideEffectSnapshot {
    return Object.freeze({
      id: row.id,
      intentId: row.intentId,
      projectId: row.projectId,
      environmentName: row.environmentName,
      operationId: row.operationId,
      effectType: row.effectType,
      idempotencyKey: row.idempotencyKey,
      requestFingerprint: row.requestFingerprint,
      leaseId: row.leaseId,
      workerId: row.ownerWorkerId,
      fencingToken: String(row.fencingToken),
      status: row.status,
      safeResultCode: row.safeResultCode,
      resultFingerprint: row.resultFingerprint,
      externalReferenceHash: row.externalReferenceHash,
      failureCode: row.failureCode,
      reconciliationRequired: row.reconciliationRequired,
      attemptStartedAt: row.attemptStartedAt
        ? new Date(row.attemptStartedAt)
        : null,
      deadlineAt: row.deadlineAt ? new Date(row.deadlineAt) : null,
      completedAt: row.completedAt ? new Date(row.completedAt) : null,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    });
  }

  private reconciliationSnapshot(
    row: ReconciliationRow,
  ): V1SideEffectReconciliationSnapshot {
    return Object.freeze({
      id: row.id,
      sideEffectId: row.sideEffectId,
      intentId: row.intentId,
      projectId: row.projectId,
      environmentName: row.environmentName,
      operationId: row.operationId,
      idempotencyKey: row.idempotencyKey,
      adapterId: row.adapterId,
      requestFingerprint: row.requestFingerprint,
      leaseId: row.leaseId,
      workerId: row.ownerWorkerId,
      fencingToken: String(row.fencingToken),
      classification: row.classification,
      safeEvidenceCode: row.safeEvidenceCode,
      evidenceFingerprint: row.evidenceFingerprint,
      resultFingerprint: row.resultFingerprint,
      externalReferenceHash: row.externalReferenceHash,
      failureCode: row.failureCode,
      inspectionStartedAt: new Date(row.inspectionStartedAt),
      completedAt: row.completedAt ? new Date(row.completedAt) : null,
      createdAt: new Date(row.createdAt),
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

  private isRetryableConflict(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const code = "code" in error ? String(error.code) : "";
    return code === "23505" || code === "40001" || code === "40P01";
  }
}
