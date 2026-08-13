import { randomUUID } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { workerEnvelopeJobId } from "../contracts/worker-envelope.validator";
import {
  isTerminalDeploymentIntentStatus,
  TerminalOutboxPolicyService,
} from "../outbox/terminal-outbox-policy.service";
import {
  ExecutableV1MessageType,
  V1ValidatedWorkerRequest,
} from "./inactive-v1-worker-runtime.types";
import { InactiveV1WorkerRuntimeService } from "./inactive-v1-worker-runtime.service";
import {
  assertPreExecutionLeaseTtl,
  assertSafeOwnershipFailureCode,
  preExecutionOperationForEnvelope,
  preExecutionOperationsConflict,
} from "./v1-pre-execution-ownership.pure";
import {
  PreExecutionLeaseSnapshot,
  PreExecutionOperation,
  PreExecutionOwnershipError,
  PreExecutionOwnershipResult,
} from "./v1-pre-execution-ownership.types";

type IntentOwnershipRow = {
  id: string;
  projectId: string;
  environmentName: string;
  status: string;
  classification: string | null;
  canonicalIdempotencyKey: string;
  infrastructureManifestId: string | null;
  releaseManifestId: string | null;
  pipelineRunId: string | null;
  destroyOperationId: string | null;
  createdAt: Date;
  releaseManifestStatus: string | null;
  infrastructureManifestStatus: string | null;
  hasNewerAcceptedIntent: boolean;
};

type LeaseRow = {
  leaseId: string;
  intentId: string;
  projectId: string;
  environmentName: string;
  lane: PreExecutionOperation["lane"];
  scope: PreExecutionOperation["scope"];
  ownerWorkerId: string;
  fencingToken: string;
  status: "acquired" | "heartbeat_active";
  acquiredAt: Date;
  heartbeatAt: Date;
  expiresAt: Date;
  logicalJobId: string | null;
};

const TERMINAL_INTENT_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "no_op",
  "rejected",
]);
const SUPERSEDED_RELEASE_STATUSES = new Set([
  "superseded",
  "cancelled",
  "rolled_back",
]);
const SUPERSEDED_INFRASTRUCTURE_STATUSES = new Set([
  "superseded",
  "destroyed",
]);

@Injectable()
export class InactiveV1PreExecutionOwnershipService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly runtime: InactiveV1WorkerRuntimeService,
    @Inject(TerminalOutboxPolicyService)
    @Optional()
    private readonly terminalOutbox = new TerminalOutboxPolicyService(),
  ) {}

  async claim(input: {
    workerId: string;
    queueName: string;
    envelope: unknown;
    leaseTtlMs?: number;
  }): Promise<PreExecutionOwnershipResult> {
    const validated = await this.runtime.validate(input);
    if (validated.disposition === "idempotent_no_op") {
      await this.dataSource.transaction("SERIALIZABLE", async (manager) => {
        await this.terminalOutbox.dispatchState(manager, validated.intentId);
      });
      return validated;
    }
    if (!validated.envelope.execution.fencingTokenRequired) {
      throw new PreExecutionOwnershipError("FENCING_REQUIRED");
    }

    let leaseTtlMs: number;
    try {
      leaseTtlMs = assertPreExecutionLeaseTtl(
        input.leaseTtlMs ?? 60_000,
      );
    } catch {
      throw new PreExecutionOwnershipError("LEASE_TTL_INVALID");
    }
    const operation = preExecutionOperationForEnvelope(validated.envelope);
    const logicalJobId = workerEnvelopeJobId(validated.envelope);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.dataSource.transaction(
          "SERIALIZABLE",
          async (manager) => this.claimInTransaction(
            manager,
            validated,
            operation,
            logicalJobId,
            leaseTtlMs,
          ),
        );
      } catch (error) {
        if (attempt === 3 || !this.isSerializationFailure(error)) throw error;
      }
    }
    throw new PreExecutionOwnershipError("OWNERSHIP_TRANSITION_CONFLICT");
  }

  async renew(input: {
    leaseId: string;
    workerId: string;
    fencingToken: string;
    leaseTtlMs?: number;
  }): Promise<PreExecutionLeaseSnapshot | null> {
    let leaseTtlMs: number;
    try {
      leaseTtlMs = assertPreExecutionLeaseTtl(
        input.leaseTtlMs ?? 60_000,
      );
    } catch {
      throw new PreExecutionOwnershipError("LEASE_TTL_INVALID");
    }
    const rows = this.rows<LeaseRow>(await this.dataSource.query(
      `UPDATE project_operation_leases lease
       SET status = 'heartbeat_active',
           heartbeat_at = clock_timestamp(),
           expires_at = clock_timestamp()
             + ($4::bigint * interval '1 millisecond'),
           updated_at = clock_timestamp()
       WHERE lease.id = $1
         AND lease.owner_worker_id = $2
         AND lease.fencing_token = $3::bigint
         AND lease.status IN ('acquired','heartbeat_active')
         AND lease.expires_at > clock_timestamp()
         AND EXISTS (
           SELECT 1 FROM worker_capabilities capability
           WHERE capability.worker_id = lease.owner_worker_id
             AND capability.role = lease.lane
             AND capability.expires_at > clock_timestamp()
             AND capability.minimum_protocol <= 1
             AND capability.maximum_protocol >= 1
             AND capability.supported_message_types
               @> jsonb_build_array(lease.metadata->>'messageType')
         )
       RETURNING
         lease.id AS "leaseId", lease.intent_id AS "intentId",
         lease.project_id AS "projectId",
         lease.environment_name AS "environmentName",
         lease.lane, lease.scope,
         lease.owner_worker_id AS "ownerWorkerId",
         lease.fencing_token AS "fencingToken", lease.status,
         lease.acquired_at AS "acquiredAt",
         lease.heartbeat_at AS "heartbeatAt",
         lease.expires_at AS "expiresAt",
         lease.metadata->>'logicalJobId' AS "logicalJobId"`,
      [input.leaseId, input.workerId, input.fencingToken, leaseTtlMs],
    ));
    return rows[0] ? this.leaseSnapshot(rows[0]) : null;
  }

  async complete(input: {
    leaseId: string;
    workerId: string;
    fencingToken: string;
  }) {
    return this.finish(input, "completed", null);
  }

  async fail(input: {
    leaseId: string;
    workerId: string;
    fencingToken: string;
    safeFailureCode: string;
  }) {
    let safeFailureCode: string;
    try {
      safeFailureCode = assertSafeOwnershipFailureCode(input.safeFailureCode);
    } catch {
      throw new PreExecutionOwnershipError(
        "OWNERSHIP_TRANSITION_CONFLICT",
      );
    }
    return this.finish(input, "failed", safeFailureCode);
  }

  async release(input: {
    leaseId: string;
    workerId: string;
    fencingToken: string;
  }) {
    return this.finish(input, "enqueued", null);
  }

  private async claimInTransaction(
    manager: EntityManager,
    validated: V1ValidatedWorkerRequest,
    operation: PreExecutionOperation,
    logicalJobId: string,
    leaseTtlMs: number,
  ): Promise<PreExecutionOwnershipResult> {
    const projectRows = await manager.query(
      `SELECT id, deletion_fence_token AS "deletionFenceToken",
              deletion_intent_id AS "deletionIntentId",
              deletion_started_at AS "deletionStartedAt",
              clock_timestamp() AS "databaseNow"
       FROM projects
       WHERE id = $1
       FOR UPDATE`,
      [validated.intent.projectId],
    );
    if (!projectRows[0]) {
      throw new PreExecutionOwnershipError("INTENT_STATE_CHANGED");
    }
    if (
      new Date(validated.envelope.expiresAt)
        <= new Date(projectRows[0].databaseNow)
    ) {
      throw new PreExecutionOwnershipError("INTENT_STATE_CHANGED");
    }

    const intent = await this.lockIntent(manager, validated.intent.id);
    if (!intent || !this.intentIdentityMatches(intent, validated)) {
      throw new PreExecutionOwnershipError("INTENT_STATE_CHANGED");
    }
    if (isTerminalDeploymentIntentStatus(intent.status)) {
      await this.terminalOutbox.terminalizeUndispatched(manager, {
        intentId: intent.id,
        intentStatus: intent.status,
      });
    }
    const capabilityRows = await manager.query(
      `SELECT worker_id
       FROM worker_capabilities
       WHERE worker_id = $1
         AND role = $2
         AND expires_at > clock_timestamp()
         AND minimum_protocol <= 1
         AND maximum_protocol >= 1
         AND supported_message_types @> $3::jsonb
       LIMIT 1`,
      [
        validated.workerId,
        operation.lane,
        JSON.stringify([validated.messageType]),
      ],
    );
    if (capabilityRows.length !== 1) {
      throw new PreExecutionOwnershipError("INTENT_STATE_CHANGED");
    }
    const terminalOrSuperseded = this.terminalOrSuperseded(
      validated,
      intent,
    );
    if (terminalOrSuperseded) return terminalOrSuperseded;
    this.assertDeletionFence(projectRows[0], intent, operation);

    await manager.query(
      `UPDATE project_operation_leases
       SET status = 'expired', updated_at = clock_timestamp()
       WHERE project_id = $1
         AND environment_name = $2
         AND status IN ('acquired','heartbeat_active')
         AND expires_at <= clock_timestamp()`,
      [intent.projectId, intent.environmentName],
    );

    const active = this.rows<LeaseRow>(await manager.query(
      `SELECT
         id AS "leaseId", intent_id AS "intentId",
         project_id AS "projectId",
         environment_name AS "environmentName", lane, scope,
         owner_worker_id AS "ownerWorkerId",
         fencing_token AS "fencingToken", status,
         acquired_at AS "acquiredAt", heartbeat_at AS "heartbeatAt",
         expires_at AS "expiresAt",
         metadata->>'logicalJobId' AS "logicalJobId"
       FROM project_operation_leases
       WHERE project_id = $1
         AND environment_name = $2
         AND status IN ('acquired','heartbeat_active')
         AND expires_at > clock_timestamp()
       ORDER BY fencing_token DESC`,
      [intent.projectId, intent.environmentName],
    ));
    const duplicate = active.find((lease) =>
      lease.intentId === intent.id
      && lease.lane === operation.lane
      && lease.scope === operation.scope
      && lease.logicalJobId === logicalJobId
    );
    if (duplicate) {
      if (duplicate.ownerWorkerId === validated.workerId) {
        return {
          disposition: "already_owned",
          intentStatus: "running",
          logicalJobId,
          lease: this.leaseSnapshot(duplicate),
        };
      }
      return {
        disposition: "idempotent_no_op",
        reason: "duplicate_delivery_owned_elsewhere",
        workerId: validated.workerId,
        intentId: intent.id,
        projectId: intent.projectId,
        messageType: validated.messageType,
      };
    }
    if (active.some((lease) => preExecutionOperationsConflict(
      operation,
      { lane: lease.lane, scope: lease.scope },
    ))) {
      throw new PreExecutionOwnershipError("OPERATION_CONFLICT");
    }

    const reclaimed = intent.status === "running"
      ? await this.hasExpiredLogicalClaim(
          manager,
          intent.id,
          operation,
          logicalJobId,
        )
      : false;
    if (intent.status !== "enqueued" && !reclaimed) {
      throw new PreExecutionOwnershipError("INTENT_NOT_ENQUEUED");
    }

    const [tokenRow] = await manager.query(
      `SELECT COALESCE(MAX(fencing_token), 0)::bigint + 1 AS token
       FROM project_operation_leases
       WHERE project_id = $1 AND environment_name = $2`,
      [intent.projectId, intent.environmentName],
    );
    const fencingToken = String(tokenRow.token);
    const leaseId = randomUUID();
    const leaseRows = this.rows<LeaseRow>(await manager.query(
      `INSERT INTO project_operation_leases (
         id, project_id, environment_name, lane, scope, intent_id,
         pipeline_run_id, destroy_operation_id, owner_worker_id,
         fencing_token, status, acquired_at, heartbeat_at, expires_at,
         released_at, metadata, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         $10::bigint, 'acquired', clock_timestamp(), clock_timestamp(),
         clock_timestamp() + ($11::bigint * interval '1 millisecond'),
         NULL, $12::jsonb, clock_timestamp(), clock_timestamp()
       )
       RETURNING
         id AS "leaseId", intent_id AS "intentId",
         project_id AS "projectId",
         environment_name AS "environmentName", lane, scope,
         owner_worker_id AS "ownerWorkerId",
         fencing_token AS "fencingToken", status,
         acquired_at AS "acquiredAt", heartbeat_at AS "heartbeatAt",
         expires_at AS "expiresAt",
         metadata->>'logicalJobId' AS "logicalJobId"`,
      [
        leaseId,
        intent.projectId,
        intent.environmentName,
        operation.lane,
        operation.scope,
        intent.id,
        intent.pipelineRunId,
        intent.destroyOperationId,
        validated.workerId,
        fencingToken,
        leaseTtlMs,
        JSON.stringify({
          protocol: "deployguard.worker/v1",
          logicalJobId,
          payloadSha256: validated.envelope.idempotency.payloadSha256,
          messageType: validated.messageType,
        }),
      ],
    ));
    if (leaseRows.length !== 1) {
      throw new PreExecutionOwnershipError(
        "OWNERSHIP_TRANSITION_CONFLICT",
      );
    }

    if (intent.status === "enqueued") {
      const transitioned = this.rows<{ id: string }>(await manager.query(
        `UPDATE deployment_intents
         SET status = 'running',
             started_at = COALESCE(started_at, clock_timestamp()),
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'enqueued'
         RETURNING id`,
        [intent.id],
      ));
      if (transitioned.length !== 1) {
        throw new PreExecutionOwnershipError(
          "OWNERSHIP_TRANSITION_CONFLICT",
        );
      }
    }
    return {
      disposition: "claimed",
      intentStatus: "running",
      logicalJobId,
      lease: this.leaseSnapshot(leaseRows[0]),
    };
  }

  private async finish(
    input: {
      leaseId: string;
      workerId: string;
      fencingToken: string;
    },
    intentStatus: "completed" | "failed" | "enqueued",
    safeFailureCode: string | null,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const rows = this.rows<{ intentId: string }>(await manager.query(
        `UPDATE project_operation_leases
         SET status = $4,
             released_at = clock_timestamp(),
             updated_at = clock_timestamp()
         WHERE id = $1
           AND owner_worker_id = $2
           AND fencing_token = $3::bigint
           AND status IN ('acquired','heartbeat_active')
           AND expires_at > clock_timestamp()
         RETURNING intent_id AS "intentId"`,
        [
          input.leaseId,
          input.workerId,
          input.fencingToken,
          intentStatus === "failed" ? "failed" : "released",
        ],
      ));
      if (rows.length !== 1) return false;

      if (intentStatus === "enqueued") {
        const transitioned = this.rows<{ id: string }>(await manager.query(
          `UPDATE deployment_intents
           SET status = 'enqueued', completed_at = NULL, started_at = NULL,
               failure_code = NULL, failure_message = NULL,
               updated_at = clock_timestamp()
           WHERE id = $1 AND status = 'running'
           RETURNING id`,
          [rows[0].intentId],
        ));
        if (transitioned.length !== 1) {
          throw new PreExecutionOwnershipError("OWNERSHIP_TRANSITION_CONFLICT");
        }
      } else {
        const transitioned = await this.terminalOutbox.transitionIntentToTerminal(
          manager,
          {
            intentId: rows[0].intentId,
            expectedStatus: "running",
            status: intentStatus,
            failureCode: safeFailureCode,
            failureMessage: null,
          },
        );
        if (!transitioned) {
          throw new PreExecutionOwnershipError("OWNERSHIP_TRANSITION_CONFLICT");
        }
      }
      return true;
    });
  }

  private async lockIntent(manager: EntityManager, intentId: string) {
    const rows = this.rows<IntentOwnershipRow>(await manager.query(
      `SELECT
         intent.id, intent.project_id AS "projectId",
         intent.environment_name AS "environmentName", intent.status,
         intent.classification,
         intent.canonical_idempotency_key AS "canonicalIdempotencyKey",
         intent.infrastructure_manifest_id AS "infrastructureManifestId",
         intent.release_manifest_id AS "releaseManifestId",
         intent.pipeline_run_id AS "pipelineRunId",
         intent.destroy_operation_id AS "destroyOperationId",
         intent.created_at AS "createdAt",
         release.status AS "releaseManifestStatus",
         infrastructure.status AS "infrastructureManifestStatus",
         EXISTS (
           SELECT 1 FROM deployment_intents newer
           WHERE newer.project_id = intent.project_id
             AND newer.environment_name = intent.environment_name
             AND newer.created_at > intent.created_at
             AND newer.status IN ('planned','enqueued','running','completed')
             AND newer.classification IN (
               'release_only','infrastructure_change','deletion'
             )
             AND (
               newer.classification = intent.classification
               OR newer.classification = 'deletion'
             )
         ) AS "hasNewerAcceptedIntent"
       FROM deployment_intents intent
       LEFT JOIN release_manifests release
         ON release.id = intent.release_manifest_id
       LEFT JOIN infrastructure_manifests infrastructure
         ON infrastructure.id = intent.infrastructure_manifest_id
       WHERE intent.id = $1
       FOR UPDATE OF intent`,
      [intentId],
    ));
    return rows[0] || null;
  }

  private intentIdentityMatches(
    intent: IntentOwnershipRow,
    validated: V1ValidatedWorkerRequest,
  ) {
    return intent.projectId === validated.envelope.identity.projectId
      && intent.environmentName
        === validated.envelope.identity.environmentName
      && intent.pipelineRunId === validated.envelope.identity.pipelineRunId
      && intent.destroyOperationId
        === validated.envelope.identity.destroyOperationId
      && intent.infrastructureManifestId
        === validated.envelope.identity.infrastructureManifestId
      && intent.releaseManifestId
        === validated.envelope.identity.releaseManifestId
      && intent.canonicalIdempotencyKey
        === validated.envelope.idempotency.canonicalKey
      && intent.classification === validated.intent.classification;
  }

  private terminalOrSuperseded(
    validated: V1ValidatedWorkerRequest,
    intent: IntentOwnershipRow,
  ): PreExecutionOwnershipResult | null {
    if (TERMINAL_INTENT_STATUSES.has(intent.status)) {
      return {
        disposition: "idempotent_no_op",
        reason: "intent_terminal",
        workerId: validated.workerId,
        intentId: intent.id,
        projectId: intent.projectId,
        messageType: validated.messageType,
      };
    }
    if (
      intent.hasNewerAcceptedIntent
      || (
        !!intent.releaseManifestStatus
        && SUPERSEDED_RELEASE_STATUSES.has(intent.releaseManifestStatus)
      )
      || (
        !!intent.infrastructureManifestStatus
        && SUPERSEDED_INFRASTRUCTURE_STATUSES.has(
          intent.infrastructureManifestStatus,
        )
      )
    ) {
      return {
        disposition: "idempotent_no_op",
        reason: "intent_superseded",
        workerId: validated.workerId,
        intentId: intent.id,
        projectId: intent.projectId,
        messageType: validated.messageType,
      };
    }
    return null;
  }

  private assertDeletionFence(
    project: {
      deletionFenceToken: string | null;
      deletionIntentId: string | null;
      deletionStartedAt: Date | null;
    },
    intent: IntentOwnershipRow,
    operation: PreExecutionOperation,
  ) {
    const hasFence =
      project.deletionFenceToken !== null
      || project.deletionIntentId !== null
      || project.deletionStartedAt !== null;
    if (operation.lane !== "deletion" && hasFence) {
      throw new PreExecutionOwnershipError("INTENT_STATE_CHANGED");
    }
    if (
      operation.lane === "deletion"
      && (
        !project.deletionFenceToken
        || project.deletionIntentId !== intent.id
        || !project.deletionStartedAt
      )
    ) {
      throw new PreExecutionOwnershipError("INTENT_STATE_CHANGED");
    }
  }

  private async hasExpiredLogicalClaim(
    manager: EntityManager,
    intentId: string,
    operation: PreExecutionOperation,
    logicalJobId: string,
  ) {
    const rows = await manager.query(
      `SELECT id FROM project_operation_leases
       WHERE intent_id = $1
         AND lane = $2
         AND scope = $3
         AND status = 'expired'
         AND metadata->>'logicalJobId' = $4
       LIMIT 1`,
      [intentId, operation.lane, operation.scope, logicalJobId],
    );
    return rows.length === 1;
  }

  private leaseSnapshot(row: LeaseRow): PreExecutionLeaseSnapshot {
    return {
      leaseId: row.leaseId,
      intentId: row.intentId,
      projectId: row.projectId,
      environmentName: row.environmentName,
      lane: row.lane,
      scope: row.scope,
      ownerWorkerId: row.ownerWorkerId,
      fencingToken: String(row.fencingToken),
      status: row.status,
      acquiredAt: new Date(row.acquiredAt),
      heartbeatAt: new Date(row.heartbeatAt),
      expiresAt: new Date(row.expiresAt),
    };
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

  private isSerializationFailure(error: unknown) {
    if (!error || typeof error !== "object") return false;
    const code = "code" in error ? String(error.code) : "";
    return code === "40001" || code === "40P01";
  }
}
