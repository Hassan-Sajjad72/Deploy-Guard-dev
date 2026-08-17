import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { normalizeReleaseLaneEnvironment } from "./inactive-release-lane-ownership.pure";
import {
  ReleaseLaneCorrelationError,
  ReleaseLaneCorrelationFence,
  ReleaseLaneCorrelationResult,
  V1OperationFence,
} from "./inactive-release-lane-correlation.types";

type OwnershipRow = {
  id: string;
  projectId: string;
  environmentName: string;
  ownerLane: "legacy" | "v1";
  leaseId: string;
  actorId: string;
  fencingToken: string;
  status: "acquired" | "heartbeat_active" | "released" | "expired";
  deploymentIntentId: string | null;
  operationLeaseId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTOR = /^[A-Za-z0-9._:@/-]{1,160}$/;
const ACTIVE_OPERATION_STATUSES = ["acquired", "heartbeat_active"];

/**
 * Explicitly inactive evidence adapter. It correlates records only; it never
 * acquires, renews, releases, schedules, or enforces cross-lane ownership.
 */
@Injectable()
export class InactiveReleaseLaneCorrelationService {
  constructor(private readonly dataSource: DataSource) {}

  async linkLegacyRun(input: ReleaseLaneCorrelationFence & { pipelineRunId: string }): Promise<ReleaseLaneCorrelationResult> {
    return this.transaction(input, async (manager, fence) => {
      if (fence.lane !== "legacy" || fence.environmentName !== "dev" || !isUuid(input.pipelineRunId)) {
        throw new ReleaseLaneCorrelationError("CORRELATION_INPUT_INVALID");
      }
      const ownership = await this.activeOwnership(manager, fence);
      if (!ownership) return { disposition: "ownership_lost" };
      const rows = await manager.query(
        `SELECT id, project_id AS "projectId", cross_lane_ownership_id AS "ownershipId",
                cross_lane_owner_lane AS "ownerLane", cross_lane_owner_environment_name AS "environmentName",
                cross_lane_owner_lease_id AS "leaseId", cross_lane_owner_actor_id AS "actorId",
                cross_lane_owner_fencing_token::text AS "fencingToken"
         FROM project_pipeline_runs WHERE id = $1 AND project_id = $2 FOR UPDATE`,
        [input.pipelineRunId, fence.projectId],
      );
      const row = rows[0];
      if (!row) return { disposition: "identity_mismatch" };
      return this.linkLegacyRecord(manager, "project_pipeline_runs", input.pipelineRunId, row, ownership, fence);
    });
  }

  async linkLegacyRollback(input: ReleaseLaneCorrelationFence & { rollbackRecordId: string }): Promise<ReleaseLaneCorrelationResult> {
    return this.transaction(input, async (manager, fence) => {
      if (fence.lane !== "legacy" || fence.environmentName !== "dev" || !isUuid(input.rollbackRecordId)) {
        throw new ReleaseLaneCorrelationError("CORRELATION_INPUT_INVALID");
      }
      const ownership = await this.activeOwnership(manager, fence);
      if (!ownership) return { disposition: "ownership_lost" };
      const rows = await manager.query(
        `SELECT id, project_id AS "projectId", cross_lane_ownership_id AS "ownershipId",
                cross_lane_owner_lane AS "ownerLane", cross_lane_owner_environment_name AS "environmentName",
                cross_lane_owner_lease_id AS "leaseId", cross_lane_owner_actor_id AS "actorId",
                cross_lane_owner_fencing_token::text AS "fencingToken"
         FROM project_rollback_records WHERE id = $1 AND project_id = $2 FOR UPDATE`,
        [input.rollbackRecordId, fence.projectId],
      );
      const row = rows[0];
      if (!row) return { disposition: "identity_mismatch" };
      return this.linkLegacyRecord(manager, "project_rollback_records", input.rollbackRecordId, row, ownership, fence);
    });
  }

  async linkV1IntentOwnership(input: ReleaseLaneCorrelationFence & { intentId: string }): Promise<ReleaseLaneCorrelationResult> {
    return this.transaction(input, async (manager, fence) => {
      if (fence.lane !== "v1" || !isUuid(input.intentId)) {
        throw new ReleaseLaneCorrelationError("CORRELATION_INPUT_INVALID");
      }
      const ownership = await this.activeOwnership(manager, fence);
      if (!ownership) return { disposition: "ownership_lost" };
      const intent = await manager.query(
        `SELECT id FROM deployment_intents
         WHERE id = $1 AND project_id = $2 AND environment_name = $3 FOR UPDATE`,
        [input.intentId, fence.projectId, fence.environmentName],
      );
      if (intent.length !== 1) return { disposition: "identity_mismatch" };
      if (ownership.deploymentIntentId === input.intentId) return { disposition: "already_linked" };
      if (ownership.deploymentIntentId !== null) return { disposition: "correlation_conflict" };
      const updated = await manager.query(
        `UPDATE project_release_lane_ownerships SET deployment_intent_id = $1, updated_at = clock_timestamp()
         WHERE id = $2 AND project_id = $3 AND environment_name = $4 AND owner_lane = 'v1'
           AND lease_id = $5 AND actor_id = $6 AND fencing_token = $7::bigint
           AND deployment_intent_id IS NULL AND status IN ('acquired','heartbeat_active')
           AND expires_at > clock_timestamp()`,
        [input.intentId, ownership.id, fence.projectId, fence.environmentName, fence.ownershipLeaseId, fence.actorId, fence.ownershipFencingToken],
      );
      return affected(updated) === 1 ? { disposition: "linked" } : { disposition: "ownership_lost" };
    });
  }

  async attachClaimedV1OperationLease(
    input: ReleaseLaneCorrelationFence & { intentId: string } & V1OperationFence,
  ): Promise<ReleaseLaneCorrelationResult> {
    return this.transaction(input, async (manager, fence) => {
      if (fence.lane !== "v1" || !isUuid(input.intentId) || !isUuid(input.operationLeaseId)
        || !ACTOR.test(input.operationWorkerId) || !isToken(input.operationFencingToken)) {
        throw new ReleaseLaneCorrelationError("CORRELATION_INPUT_INVALID");
      }
      const ownership = await this.activeOwnership(manager, fence);
      if (!ownership) return { disposition: "ownership_lost" };
      if (ownership.deploymentIntentId !== input.intentId) return { disposition: "identity_mismatch" };
      const lease = await manager.query(
        `SELECT id FROM project_operation_leases
         WHERE id = $1 AND project_id = $2 AND environment_name = $3 AND intent_id = $4
           AND owner_worker_id = $5 AND fencing_token = $6::bigint
           AND status = ANY($7::varchar[]) AND expires_at > clock_timestamp()
         FOR UPDATE`,
        [input.operationLeaseId, fence.projectId, fence.environmentName, input.intentId,
          input.operationWorkerId, input.operationFencingToken, ACTIVE_OPERATION_STATUSES],
      );
      if (lease.length !== 1) return { disposition: "operation_lost" };
      if (ownership.operationLeaseId === input.operationLeaseId) return { disposition: "already_linked" };
      if (ownership.operationLeaseId !== null) return { disposition: "correlation_conflict" };
      const updated = await manager.query(
        `UPDATE project_release_lane_ownerships SET operation_lease_id = $1, updated_at = clock_timestamp()
         WHERE id = $2 AND project_id = $3 AND environment_name = $4 AND owner_lane = 'v1'
           AND lease_id = $5 AND actor_id = $6 AND fencing_token = $7::bigint
           AND deployment_intent_id = $8 AND operation_lease_id IS NULL
           AND status IN ('acquired','heartbeat_active') AND expires_at > clock_timestamp()`,
        [input.operationLeaseId, ownership.id, fence.projectId, fence.environmentName,
          fence.ownershipLeaseId, fence.actorId, fence.ownershipFencingToken, input.intentId],
      );
      return affected(updated) === 1 ? { disposition: "linked" } : { disposition: "ownership_lost" };
    });
  }

  async validateBothIndependentFences(
    input: ReleaseLaneCorrelationFence & { intentId: string } & V1OperationFence,
  ): Promise<ReleaseLaneCorrelationResult> {
    return this.transaction(input, async (manager, fence) => {
      if (fence.lane !== "v1" || !isUuid(input.intentId) || !isUuid(input.operationLeaseId)
        || !ACTOR.test(input.operationWorkerId) || !isToken(input.operationFencingToken)) {
        throw new ReleaseLaneCorrelationError("CORRELATION_INPUT_INVALID");
      }
      const ownership = await this.activeOwnership(manager, fence);
      if (!ownership) return { disposition: "ownership_lost" };
      if (ownership.deploymentIntentId !== input.intentId || ownership.operationLeaseId !== input.operationLeaseId) {
        return { disposition: "identity_mismatch" };
      }
      const lease = await manager.query(
        `SELECT 1 FROM project_operation_leases
         WHERE id = $1 AND project_id = $2 AND environment_name = $3 AND intent_id = $4
           AND owner_worker_id = $5 AND fencing_token = $6::bigint
           AND status = ANY($7::varchar[]) AND expires_at > clock_timestamp()`,
        [input.operationLeaseId, fence.projectId, fence.environmentName, input.intentId,
          input.operationWorkerId, input.operationFencingToken, ACTIVE_OPERATION_STATUSES],
      );
      return lease.length === 1 ? { disposition: "already_linked" } : { disposition: "operation_lost" };
    });
  }

  async clearLegacyRunAfterRelease(input: ReleaseLaneCorrelationFence & { pipelineRunId: string }): Promise<ReleaseLaneCorrelationResult> {
    return this.clearLegacyRecord(input, "project_pipeline_runs", input.pipelineRunId);
  }

  async clearLegacyRollbackAfterRelease(input: ReleaseLaneCorrelationFence & { rollbackRecordId: string }): Promise<ReleaseLaneCorrelationResult> {
    return this.clearLegacyRecord(input, "project_rollback_records", input.rollbackRecordId);
  }

  async clearV1OperationLeaseAfterRelease(input: ReleaseLaneCorrelationFence & { intentId: string; operationLeaseId: string }): Promise<ReleaseLaneCorrelationResult> {
    return this.transaction(input, async (manager, fence) => {
      if (fence.lane !== "v1" || !isUuid(input.intentId) || !isUuid(input.operationLeaseId)) {
        throw new ReleaseLaneCorrelationError("CORRELATION_INPUT_INVALID");
      }
      const ownership = await this.releasedOwnership(manager, fence);
      if (!ownership) return { disposition: "ownership_lost" };
      if (ownership.deploymentIntentId !== input.intentId || ownership.operationLeaseId === null) {
        return { disposition: "identity_mismatch" };
      }
      if (ownership.operationLeaseId !== input.operationLeaseId) return { disposition: "correlation_conflict" };
      const updated = await manager.query(
        `UPDATE project_release_lane_ownerships SET operation_lease_id = NULL, updated_at = clock_timestamp()
         WHERE id = $1 AND operation_lease_id = $2 AND status IN ('released','expired')`,
        [ownership.id, input.operationLeaseId],
      );
      return affected(updated) === 1 ? { disposition: "cleared" } : { disposition: "ownership_lost" };
    });
  }

  async clearV1AfterRelease(
    input: ReleaseLaneCorrelationFence & {
      intentId: string;
      operationLeaseId: string | null;
    },
  ): Promise<ReleaseLaneCorrelationResult> {
    return this.transaction(input, async (manager, fence) => {
      if (
        fence.lane !== "v1"
        || !isUuid(input.intentId)
        || (input.operationLeaseId !== null && !isUuid(input.operationLeaseId))
      ) {
        throw new ReleaseLaneCorrelationError("CORRELATION_INPUT_INVALID");
      }
      const ownership = await this.releasedOwnership(manager, fence);
      if (!ownership) return { disposition: "ownership_lost" };
      if (ownership.deploymentIntentId !== input.intentId) {
        return { disposition: "identity_mismatch" };
      }
      if (
        input.operationLeaseId !== null
        && ownership.operationLeaseId !== input.operationLeaseId
      ) {
        return { disposition: "correlation_conflict" };
      }
      const updated = await manager.query(
        `UPDATE project_release_lane_ownerships
         SET deployment_intent_id = NULL, operation_lease_id = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1 AND deployment_intent_id = $2
           AND ($3::uuid IS NULL OR operation_lease_id = $3::uuid)
           AND status IN ('released','expired')`,
        [ownership.id, input.intentId, input.operationLeaseId],
      );
      return affected(updated) === 1
        ? { disposition: "cleared" }
        : { disposition: "ownership_lost" };
    });
  }

  private async clearLegacyRecord(
    input: ReleaseLaneCorrelationFence,
    table: "project_pipeline_runs" | "project_rollback_records",
    recordId: string,
  ): Promise<ReleaseLaneCorrelationResult> {
    return this.transaction(input, async (manager, fence) => {
      if (fence.lane !== "legacy" || fence.environmentName !== "dev" || !isUuid(recordId)) {
        throw new ReleaseLaneCorrelationError("CORRELATION_INPUT_INVALID");
      }
      const ownership = await this.releasedOwnership(manager, fence);
      if (!ownership) return { disposition: "ownership_lost" };
      const updated = await manager.query(
        `UPDATE ${table}
         SET cross_lane_ownership_id = NULL, cross_lane_owner_lane = NULL,
             cross_lane_owner_environment_name = NULL, cross_lane_owner_lease_id = NULL,
             cross_lane_owner_actor_id = NULL, cross_lane_owner_fencing_token = NULL
         WHERE id = $1 AND project_id = $2 AND cross_lane_ownership_id = $3
           AND cross_lane_owner_lane = $4 AND cross_lane_owner_environment_name = $5
           AND cross_lane_owner_lease_id = $6 AND cross_lane_owner_actor_id = $7
           AND cross_lane_owner_fencing_token = $8::bigint`,
        [recordId, fence.projectId, ownership.id, fence.lane, fence.environmentName,
          fence.ownershipLeaseId, fence.actorId, fence.ownershipFencingToken],
      );
      if (affected(updated) === 1) return { disposition: "cleared" };
      const record = await manager.query(`SELECT id FROM ${table} WHERE id = $1 AND project_id = $2`, [recordId, fence.projectId]);
      return record.length === 1 ? { disposition: "already_cleared" } : { disposition: "identity_mismatch" };
    });
  }

  private async linkLegacyRecord(
    manager: EntityManager,
    table: "project_pipeline_runs" | "project_rollback_records",
    recordId: string,
    record: Record<string, unknown>,
    ownership: OwnershipRow,
    fence: ReleaseLaneCorrelationFence,
  ): Promise<ReleaseLaneCorrelationResult> {
    const same = record.ownershipId === ownership.id
      && record.ownerLane === fence.lane && record.environmentName === fence.environmentName
      && record.leaseId === fence.ownershipLeaseId && record.actorId === fence.actorId
      && String(record.fencingToken) === fence.ownershipFencingToken;
    if (same) return { disposition: "already_linked" };
    if (record.ownershipId !== null) return { disposition: "correlation_conflict" };
    const updated = await manager.query(
      `UPDATE ${table}
       SET cross_lane_ownership_id = $1, cross_lane_owner_lane = $2,
           cross_lane_owner_environment_name = $3, cross_lane_owner_lease_id = $4,
           cross_lane_owner_actor_id = $5, cross_lane_owner_fencing_token = $6::bigint
       WHERE id = $7 AND project_id = $8 AND cross_lane_ownership_id IS NULL`,
      [ownership.id, fence.lane, fence.environmentName, fence.ownershipLeaseId,
        fence.actorId, fence.ownershipFencingToken, recordId, fence.projectId],
    );
    return affected(updated) === 1 ? { disposition: "linked" } : { disposition: "correlation_conflict" };
  }

  private async activeOwnership(manager: EntityManager, fence: ReleaseLaneCorrelationFence): Promise<OwnershipRow | null> {
    const rows = await manager.query(
      `SELECT id, project_id AS "projectId", environment_name AS "environmentName", owner_lane AS "ownerLane",
              lease_id AS "leaseId", actor_id AS "actorId", fencing_token::text AS "fencingToken",
              status, deployment_intent_id AS "deploymentIntentId", operation_lease_id AS "operationLeaseId"
       FROM project_release_lane_ownerships
       WHERE project_id = $1 AND environment_name = $2 AND owner_lane = $3
         AND lease_id = $4 AND actor_id = $5 AND fencing_token = $6::bigint
         AND status IN ('acquired','heartbeat_active') AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [fence.projectId, fence.environmentName, fence.lane, fence.ownershipLeaseId,
        fence.actorId, fence.ownershipFencingToken],
    );
    return rows[0] ?? null;
  }

  private async releasedOwnership(manager: EntityManager, fence: ReleaseLaneCorrelationFence): Promise<OwnershipRow | null> {
    const rows = await manager.query(
      `SELECT id, project_id AS "projectId", environment_name AS "environmentName", owner_lane AS "ownerLane",
              lease_id AS "leaseId", actor_id AS "actorId", fencing_token::text AS "fencingToken",
              status, deployment_intent_id AS "deploymentIntentId", operation_lease_id AS "operationLeaseId"
       FROM project_release_lane_ownerships
       WHERE project_id = $1 AND environment_name = $2 AND owner_lane = $3
         AND lease_id = $4 AND actor_id = $5 AND fencing_token = $6::bigint
         AND status IN ('released','expired')
       FOR UPDATE`,
      [fence.projectId, fence.environmentName, fence.lane, fence.ownershipLeaseId,
        fence.actorId, fence.ownershipFencingToken],
    );
    return rows[0] ?? null;
  }

  private async transaction<T>(
    input: ReleaseLaneCorrelationFence,
    action: (manager: EntityManager, fence: ReleaseLaneCorrelationFence) => Promise<T>,
  ): Promise<T> {
    const fence = this.validateFence(input);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.dataSource.transaction("SERIALIZABLE", async (manager) => {
          await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
            `deployguard:release-lane-ownership:${fence.projectId}:${fence.environmentName}`,
          ]);
          return action(manager, fence);
        });
      } catch (error) {
        if (attempt === 3 || !isSerializationFailure(error)) throw error;
      }
    }
    throw new ReleaseLaneCorrelationError("CORRELATION_TRANSACTION_CONFLICT");
  }

  private validateFence(input: ReleaseLaneCorrelationFence): ReleaseLaneCorrelationFence {
    const environmentName = normalizeReleaseLaneEnvironment(input.environmentName);
    if (!isUuid(input.projectId) || !isUuid(input.ownershipLeaseId) || !ACTOR.test(input.actorId)
      || (input.lane !== "legacy" && input.lane !== "v1") || !isToken(input.ownershipFencingToken)) {
      throw new ReleaseLaneCorrelationError("CORRELATION_INPUT_INVALID");
    }
    return { ...input, environmentName };
  }
}

function affected(value: unknown): number {
  if (Array.isArray(value) && value.length === 2 && typeof value[1] === "number") return value[1];
  return 0;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value) && Number(value) > 0;
}

function isSerializationFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && (error as { code?: string }).code === "40001";
}
