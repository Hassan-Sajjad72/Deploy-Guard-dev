import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import {
  assertV1HandlerSideEffectTimeout,
  canonicalizeV1HandlerSideEffectIdentity,
  validateV1HandlerSideEffectOutcome,
  v1HandlerSideEffectRequestFingerprint,
} from "./v1-handler-side-effect.pure";
import {
  V1HandlerSideEffectBoundary,
  V1HandlerSideEffectIdentity,
  V1HandlerSideEffectRequest,
  V1HandlerSideEffectResult,
  V1HandlerSideEffectSafetyError,
  V1HandlerSideEffectSnapshot,
} from "./v1-handler-side-effect.types";

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
  databaseNow?: Date;
};

type ExecutionFence = {
  intentId: string;
  projectId: string;
  environmentName: string;
  leaseId: string;
  workerId: string;
  fencingToken: string;
  signal: AbortSignal;
  isLeaseTrusted(): boolean;
};

type PreparedEffect =
  | { disposition: "execute"; effect: V1HandlerSideEffectSnapshot }
  | V1HandlerSideEffectResult;

const SELECT_COLUMNS = `
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

@Injectable()
export class InactiveV1HandlerSideEffectSafetyService {
  constructor(private readonly dataSource: DataSource) {}

  forExecution(fence: ExecutionFence): V1HandlerSideEffectBoundary {
    const captured = Object.freeze({ ...fence });
    let activeEffects = 0;
    let blockingFailureCode: string | null = null;
    return Object.freeze({
      execute: async (request: V1HandlerSideEffectRequest) => {
        activeEffects += 1;
        try {
          const result = await this.execute(captured, request);
          if (result.disposition === "reconciliation_required") {
            blockingFailureCode = "SIDE_EFFECT_RECONCILIATION_REQUIRED";
          } else if (result.disposition === "in_progress") {
            blockingFailureCode = "SIDE_EFFECT_IN_PROGRESS";
          } else if (result.disposition === "failed") {
            blockingFailureCode =
              result.effect.failureCode ?? "SIDE_EFFECT_FAILED";
          }
          return result;
        } catch (error) {
          blockingFailureCode =
            error instanceof V1HandlerSideEffectSafetyError
              ? error.code
              : "SIDE_EFFECT_TRANSITION_CONFLICT";
          throw error;
        } finally {
          activeEffects -= 1;
        }
      },
      finalizationStatus: () =>
        activeEffects > 0
          ? {
              allowed: false as const,
              safeFailureCode: "SIDE_EFFECT_IN_PROGRESS",
            }
          : blockingFailureCode
            ? {
                allowed: false as const,
                safeFailureCode: blockingFailureCode,
              }
            : { allowed: true as const, safeFailureCode: null },
    });
  }

  async findReconciliationRequired(input: {
    projectId: string;
    environmentName: string;
  }): Promise<V1HandlerSideEffectSnapshot[]> {
    const rows = this.rows<EffectRow>(await this.dataSource.query(
      `SELECT ${SELECT_COLUMNS}
       FROM deployment_side_effects effect
       WHERE effect.project_id = $1
         AND effect.environment_name = $2
         AND (
           effect.reconciliation_required = true
           OR effect.status = 'uncertain'
           OR (
             effect.status = 'started'
             AND effect.deadline_at <= clock_timestamp()
           )
         )
       ORDER BY effect.updated_at, effect.id`,
      [input.projectId, input.environmentName],
    ));
    return rows.map((row) => this.snapshot(row));
  }

  private async execute(
    fence: ExecutionFence,
    request: V1HandlerSideEffectRequest,
  ): Promise<V1HandlerSideEffectResult> {
    if (
      fence.signal.aborted
      || !fence.isLeaseTrusted()
      || typeof request.perform !== "function"
    ) {
      throw new V1HandlerSideEffectSafetyError(
        "SIDE_EFFECT_OWNERSHIP_LOST",
      );
    }
    const timeoutMs = assertV1HandlerSideEffectTimeout(request.timeoutMs);
    const identity = canonicalizeV1HandlerSideEffectIdentity({
      intentId: fence.intentId,
      projectId: fence.projectId,
      environmentName: fence.environmentName,
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      effectType: request.effectType,
      inputFingerprint: request.inputFingerprint,
      leaseId: fence.leaseId,
      workerId: fence.workerId,
      fencingToken: fence.fencingToken,
    });
    const prepared = await this.prepare(identity, timeoutMs);
    if (prepared.disposition !== "execute") return prepared;

    if (fence.signal.aborted || !fence.isLeaseTrusted()) {
      return this.markUncertain(
        prepared.effect,
        "execution_cancelled",
        "SIDE_EFFECT_EXECUTION_CANCELLED",
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
    const deadlineAt = prepared.effect.deadlineAt
      ?? new Date(Date.now() + timeoutMs);
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(0, deadlineAt.getTime() - Date.now()));

    const executorContext = Object.freeze({
      ...identity,
      signal: controller.signal,
      deadlineAt: new Date(deadlineAt),
      isLeaseTrusted: () =>
        !controller.signal.aborted && fence.isLeaseTrusted(),
    });
    const execution = Promise.resolve()
      .then(() => request.perform(executorContext))
      .then((value) => ({
        kind: "outcome" as const,
        value: validateV1HandlerSideEffectOutcome(value),
      }))
      .catch(() => ({ kind: "thrown" as const }));
    const interruption = new Promise<{ kind: "interrupted" }>((resolve) => {
      controller.signal.addEventListener(
        "abort",
        () => resolve({ kind: "interrupted" }),
        { once: true },
      );
    });
    const result = await Promise.race([execution, interruption]);
    clearTimeout(timeout);
    fence.signal.removeEventListener("abort", onCancellation);

    if (result.kind === "interrupted") {
      return this.markUncertain(
        prepared.effect,
        timedOut ? "execution_timed_out" : "execution_cancelled",
        timedOut
          ? "SIDE_EFFECT_EXECUTION_TIMED_OUT"
          : "SIDE_EFFECT_EXECUTION_CANCELLED",
      );
    }
    if (result.kind === "thrown") {
      return this.markUncertain(
        prepared.effect,
        "effect_outcome_uncertain",
        "SIDE_EFFECT_OUTCOME_UNKNOWN",
      );
    }
    if (fence.signal.aborted || !fence.isLeaseTrusted()) {
      return this.markUncertain(
        prepared.effect,
        "ownership_lost",
        "SIDE_EFFECT_OWNERSHIP_LOST",
      );
    }
    if (result.value.outcome === "succeeded") {
      return this.finalizeSucceeded(prepared.effect, result.value);
    }
    if (result.value.outcome === "failed") {
      return this.finalizeFailed(
        prepared.effect,
        result.value.safeFailureCode,
      );
    }
    return this.markUncertain(
      prepared.effect,
      "effect_outcome_uncertain",
      result.value.safeFailureCode,
    );
  }

  private async prepare(
    identity: V1HandlerSideEffectIdentity,
    timeoutMs: number,
  ): Promise<PreparedEffect> {
    const requestFingerprint =
      v1HandlerSideEffectRequestFingerprint(identity);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.dataSource.transaction(
          "SERIALIZABLE",
          async (manager) => this.prepareInTransaction(
            manager,
            identity,
            requestFingerprint,
            timeoutMs,
          ),
        );
      } catch (error) {
        if (attempt === 3 || !this.isRetryableConflict(error)) throw error;
      }
    }
    throw new V1HandlerSideEffectSafetyError(
      "SIDE_EFFECT_TRANSITION_CONFLICT",
    );
  }

  private async prepareInTransaction(
    manager: EntityManager,
    identity: V1HandlerSideEffectIdentity,
    requestFingerprint: string,
    timeoutMs: number,
  ): Promise<PreparedEffect> {
    const ownership = await manager.query(
      `SELECT lease.id
       FROM project_operation_leases lease
       INNER JOIN deployment_intents intent ON intent.id = lease.intent_id
       WHERE lease.id = $1
         AND lease.owner_worker_id = $2
         AND lease.fencing_token = $3::bigint
         AND lease.intent_id = $4
         AND lease.project_id = $5
         AND lease.environment_name = $6
         AND lease.status IN ('acquired','heartbeat_active')
         AND lease.expires_at > clock_timestamp()
         AND intent.status = 'running'
       FOR UPDATE OF lease, intent`,
      [
        identity.leaseId,
        identity.workerId,
        identity.fencingToken,
        identity.intentId,
        identity.projectId,
        identity.environmentName,
      ],
    );
    if (ownership.length !== 1) {
      throw new V1HandlerSideEffectSafetyError(
        "SIDE_EFFECT_OWNERSHIP_LOST",
      );
    }

    const existing = this.rows<EffectRow>(await manager.query(
      `SELECT ${SELECT_COLUMNS}, clock_timestamp() AS "databaseNow"
       FROM deployment_side_effects effect
       WHERE effect.intent_id = $1
         AND (
           effect.operation_id = $2
           OR effect.idempotency_key = $3
         )
       ORDER BY effect.created_at
       FOR UPDATE`,
      [
        identity.intentId,
        identity.operationId,
        identity.idempotencyKey,
      ],
    ));
    if (existing.length > 1) {
      throw new V1HandlerSideEffectSafetyError(
        "SIDE_EFFECT_IDEMPOTENCY_CONFLICT",
      );
    }
    if (existing[0]) {
      const row = existing[0];
      if (
        row.operationId !== identity.operationId
        || row.idempotencyKey !== identity.idempotencyKey
        || row.requestFingerprint !== requestFingerprint
        || row.effectType !== identity.effectType
      ) {
        throw new V1HandlerSideEffectSafetyError(
          "SIDE_EFFECT_IDEMPOTENCY_CONFLICT",
        );
      }
      if (row.status === "started") {
        if (
          row.deadlineAt
          && row.databaseNow
          && new Date(row.deadlineAt) > new Date(row.databaseNow)
        ) {
          return { disposition: "in_progress", effect: this.snapshot(row) };
        }
        const uncertain = await this.markOverdueInTransaction(manager, row);
        return {
          disposition: "reconciliation_required",
          reason: "effect_outcome_uncertain",
          effect: uncertain,
        };
      }
      if (row.status === "uncertain" || row.reconciliationRequired) {
        return {
          disposition: "reconciliation_required",
          reason: "effect_outcome_uncertain",
          effect: this.snapshot(row),
        };
      }
      if (row.status !== "prepared") {
        return row.status === "failed"
          ? { disposition: "failed", effect: this.snapshot(row) }
          : { disposition: "replayed", effect: this.snapshot(row) };
      }
      await manager.query(
        `UPDATE deployment_side_effects
         SET lease_id = $2, owner_worker_id = $3,
             fencing_token = $4::bigint, updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'prepared'`,
        [
          row.id,
          identity.leaseId,
          identity.workerId,
          identity.fencingToken,
        ],
      );
    } else {
      await manager.query(
        `INSERT INTO deployment_side_effects (
           id, intent_id, project_id, environment_name, operation_id,
           effect_type, idempotency_key, request_fingerprint,
           lease_id, owner_worker_id, fencing_token, status,
           reconciliation_required, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11::bigint, 'prepared', false,
           clock_timestamp(), clock_timestamp()
         )`,
        [
          randomUUID(),
          identity.intentId,
          identity.projectId,
          identity.environmentName,
          identity.operationId,
          identity.effectType,
          identity.idempotencyKey,
          requestFingerprint,
          identity.leaseId,
          identity.workerId,
          identity.fencingToken,
        ],
      );
    }

    const rows = this.rows<EffectRow>(await manager.query(
      `UPDATE deployment_side_effects effect
       SET status = 'started',
           attempt_started_at = clock_timestamp(),
           deadline_at = clock_timestamp()
             + ($7::bigint * interval '1 millisecond'),
           updated_at = clock_timestamp()
       WHERE effect.intent_id = $1
         AND effect.operation_id = $2
         AND effect.idempotency_key = $3
         AND effect.request_fingerprint = $4
         AND effect.lease_id = $5
         AND effect.fencing_token = $6::bigint
         AND effect.status = 'prepared'
       RETURNING ${SELECT_COLUMNS.replaceAll("effect.", "")}`,
      [
        identity.intentId,
        identity.operationId,
        identity.idempotencyKey,
        requestFingerprint,
        identity.leaseId,
        identity.fencingToken,
        timeoutMs,
      ],
    ));
    if (rows.length !== 1) {
      throw new V1HandlerSideEffectSafetyError(
        "SIDE_EFFECT_TRANSITION_CONFLICT",
      );
    }
    return { disposition: "execute", effect: this.snapshot(rows[0]) };
  }

  private async finalizeSucceeded(
    effect: V1HandlerSideEffectSnapshot,
    outcome: Extract<
      ReturnType<typeof validateV1HandlerSideEffectOutcome>,
      { outcome: "succeeded" }
    >,
  ): Promise<V1HandlerSideEffectResult> {
    const row = await this.finalizeWithFence(effect, {
      status: "succeeded",
      safeResultCode: outcome.safeResultCode,
      resultFingerprint: outcome.resultFingerprint,
      externalReferenceHash: outcome.externalReferenceHash ?? null,
      failureCode: null,
      reconciliationRequired: false,
    });
    return row
      ? { disposition: "executed", effect: row }
      : this.markUncertain(
          effect,
          "ownership_lost",
          "SIDE_EFFECT_OWNERSHIP_LOST",
        );
  }

  private async finalizeFailed(
    effect: V1HandlerSideEffectSnapshot,
    safeFailureCode: string,
  ): Promise<V1HandlerSideEffectResult> {
    const row = await this.finalizeWithFence(effect, {
      status: "failed",
      safeResultCode: null,
      resultFingerprint: null,
      externalReferenceHash: null,
      failureCode: safeFailureCode,
      reconciliationRequired: false,
    });
    return row
      ? { disposition: "failed", effect: row }
      : this.markUncertain(
          effect,
          "ownership_lost",
          "SIDE_EFFECT_OWNERSHIP_LOST",
        );
  }

  private async finalizeWithFence(
    effect: V1HandlerSideEffectSnapshot,
    result: {
      status: "succeeded" | "failed";
      safeResultCode: string | null;
      resultFingerprint: string | null;
      externalReferenceHash: string | null;
      failureCode: string | null;
      reconciliationRequired: boolean;
    },
  ) {
    const rows = this.rows<EffectRow>(await this.dataSource.query(
      `UPDATE deployment_side_effects effect
       SET status = $5, safe_result_code = $6,
           result_fingerprint = $7,
           external_reference_hash = $8, failure_code = $9,
           reconciliation_required = $10,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE effect.id = $1
         AND effect.lease_id = $2
         AND effect.owner_worker_id = $3
         AND effect.fencing_token = $4::bigint
         AND effect.status = 'started'
         AND EXISTS (
           SELECT 1
           FROM project_operation_leases lease
           INNER JOIN deployment_intents intent
             ON intent.id = lease.intent_id
           WHERE lease.id = effect.lease_id
             AND lease.owner_worker_id = effect.owner_worker_id
             AND lease.fencing_token = effect.fencing_token
             AND lease.status IN ('acquired','heartbeat_active')
             AND lease.expires_at > clock_timestamp()
             AND intent.id = effect.intent_id
             AND intent.status = 'running'
         )
       RETURNING ${SELECT_COLUMNS.replaceAll("effect.", "")}`,
      [
        effect.id,
        effect.leaseId,
        effect.workerId,
        effect.fencingToken,
        result.status,
        result.safeResultCode,
        result.resultFingerprint,
        result.externalReferenceHash,
        result.failureCode,
        result.reconciliationRequired,
      ],
    ));
    return rows[0] ? this.snapshot(rows[0]) : null;
  }

  private async markUncertain(
    effect: V1HandlerSideEffectSnapshot,
    reason: Extract<
      V1HandlerSideEffectResult,
      { disposition: "reconciliation_required" }
    >["reason"],
    safeFailureCode: string,
  ): Promise<V1HandlerSideEffectResult> {
    const rows = this.rows<EffectRow>(await this.dataSource.query(
      `UPDATE deployment_side_effects
       SET status = 'uncertain', failure_code = $5,
           reconciliation_required = true,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1
         AND lease_id = $2
         AND owner_worker_id = $3
         AND fencing_token = $4::bigint
         AND status IN ('prepared','started')
       RETURNING ${SELECT_COLUMNS.replaceAll("effect.", "")}`,
      [
        effect.id,
        effect.leaseId,
        effect.workerId,
        effect.fencingToken,
        safeFailureCode,
      ],
    ));
    const current = rows[0] ?? this.rows<EffectRow>(
      await this.dataSource.query(
        `SELECT ${SELECT_COLUMNS}
         FROM deployment_side_effects effect WHERE effect.id = $1`,
        [effect.id],
      ),
    )[0];
    if (!current) {
      throw new V1HandlerSideEffectSafetyError(
        "SIDE_EFFECT_TRANSITION_CONFLICT",
      );
    }
    return {
      disposition: "reconciliation_required",
      reason,
      effect: this.snapshot(current),
    };
  }

  private async markOverdueInTransaction(
    manager: EntityManager,
    row: EffectRow,
  ) {
    const rows = this.rows<EffectRow>(await manager.query(
      `UPDATE deployment_side_effects
       SET status = 'uncertain',
           failure_code = 'SIDE_EFFECT_PREVIOUS_ATTEMPT_UNCERTAIN',
           reconciliation_required = true,
           completed_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'started'
       RETURNING ${SELECT_COLUMNS.replaceAll("effect.", "")}`,
      [row.id],
    ));
    if (rows.length !== 1) {
      throw new V1HandlerSideEffectSafetyError(
        "SIDE_EFFECT_TRANSITION_CONFLICT",
      );
    }
    return this.snapshot(rows[0]);
  }

  private snapshot(row: EffectRow): V1HandlerSideEffectSnapshot {
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
