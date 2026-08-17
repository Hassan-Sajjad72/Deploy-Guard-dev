import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import {
  ReleaseLaneOwner,
  ReleaseLaneOwnershipStatus,
} from "../entities/release-lane-ownership.entity";
import {
  assertReleaseLaneOwnershipInput,
  normalizeReleaseLaneEnvironment,
} from "./inactive-release-lane-ownership.pure";
import {
  ReleaseLaneOwnershipError,
  ReleaseLaneOwnershipResult,
  ReleaseLaneOwnershipSnapshot,
} from "./inactive-release-lane-ownership.types";

type OwnershipRow = ReleaseLaneOwnershipSnapshot & {
  actorId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  databaseNow?: Date;
};

const ACTIVE_LEGACY_STATUSES = [
  "queued", "running", "cost_analysis_running", "waiting_for_cost_approval",
  "state_lock_acquiring", "waiting_for_state_lock", "state_lock_acquired",
  "state_heartbeat_active", "state_validation_running", "state_lock_released",
  "storage_evaluation_running", "storage_not_required", "storage_provisioning",
  "storage_provisioned", "backup_configuring", "backup_configured",
  "ecs_deployment_queued", "ecs_task_definition_registering",
  "ecs_service_updating", "ecs_waiting_for_stability", "ecs_service_healthy",
  "rollback_started", "spot_interruption_handled", "apply_disabled",
];
const ACTIVE_V1_INTENT_STATUSES = ["received", "planned", "enqueued", "running"];
const ACTIVE_LEASE_STATUSES = ["acquired", "heartbeat_active"];

@Injectable()
export class InactiveReleaseLaneOwnershipService {
  constructor(private readonly dataSource: DataSource) {}

  async acquire(input: {
    projectId: string;
    environmentName: string;
    lane: ReleaseLaneOwner;
    leaseId: string;
    actorId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    leaseTtlMs?: number;
    ownLegacyRunId?: string;
    ownV1IntentId?: string;
  }): Promise<ReleaseLaneOwnershipResult> {
    const normalized = normalizeReleaseLaneEnvironment(input.environmentName);
    const leaseTtlMs = input.leaseTtlMs ?? 60_000;
    assertReleaseLaneOwnershipInput({ ...input, environmentName: normalized, leaseTtlMs });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.dataSource.transaction("SERIALIZABLE", (manager) =>
          this.acquireInTransaction(manager, { ...input, environmentName: normalized, leaseTtlMs }),
        );
      } catch (error) {
        if (attempt === 3 || !this.isSerializationFailure(error)) throw error;
      }
    }
    throw new ReleaseLaneOwnershipError("OWNERSHIP_TRANSACTION_CONFLICT");
  }

  async renew(input: {
    projectId: string;
    environmentName: string;
    lane: ReleaseLaneOwner;
    leaseId: string;
    actorId: string;
    fencingToken: string;
    leaseTtlMs?: number;
  }): Promise<ReleaseLaneOwnershipResult> {
    const environmentName = normalizeReleaseLaneEnvironment(input.environmentName);
    const leaseTtlMs = input.leaseTtlMs ?? 60_000;
    if (!/^\d+$/.test(input.fencingToken)) {
      throw new ReleaseLaneOwnershipError("OWNERSHIP_INPUT_INVALID");
    }
    assertReleaseLaneOwnershipInput({
      projectId: input.projectId,
      environmentName,
      lane: input.lane,
      leaseId: input.leaseId,
      actorId: input.actorId,
      idempotencyKey: "0".repeat(64),
      requestFingerprint: "0".repeat(64),
      leaseTtlMs,
    });
    const rows = this.rows<OwnershipRow>(await this.dataSource.query(
      `UPDATE project_release_lane_ownerships
       SET status = 'heartbeat_active', heartbeat_at = clock_timestamp(),
           expires_at = clock_timestamp() + ($7::bigint * interval '1 millisecond'),
           updated_at = clock_timestamp()
       WHERE project_id = $1 AND environment_name = $2 AND owner_lane = $3
         AND lease_id = $4 AND actor_id = $5 AND fencing_token = $6::bigint
         AND status IN ('acquired','heartbeat_active')
         AND expires_at > clock_timestamp()
       RETURNING ${this.returningColumns()}`,
      [input.projectId, environmentName, input.lane, input.leaseId, input.actorId, input.fencingToken, leaseTtlMs],
    ));
    return rows[0]
      ? { disposition: "already_owned", ownership: this.snapshot(rows[0]) }
      : { disposition: "ownership_lost" };
  }

  async release(input: {
    projectId: string;
    environmentName: string;
    lane: ReleaseLaneOwner;
    leaseId: string;
    actorId: string;
    fencingToken: string;
  }): Promise<ReleaseLaneOwnershipResult> {
    const environmentName = normalizeReleaseLaneEnvironment(input.environmentName);
    if (!/^\d+$/.test(input.fencingToken)) {
      throw new ReleaseLaneOwnershipError("OWNERSHIP_INPUT_INVALID");
    }
    const rows = this.rows<OwnershipRow>(await this.dataSource.query(
      `UPDATE project_release_lane_ownerships
       SET status = 'released', released_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE project_id = $1 AND environment_name = $2 AND owner_lane = $3
         AND lease_id = $4 AND actor_id = $5 AND fencing_token = $6::bigint
         AND status IN ('acquired','heartbeat_active')
         AND expires_at > clock_timestamp()
       RETURNING ${this.returningColumns()}`,
      [input.projectId, environmentName, input.lane, input.leaseId, input.actorId, input.fencingToken],
    ));
    return rows[0]
      ? { disposition: "already_owned", ownership: this.snapshot(rows[0]) }
      : { disposition: "ownership_lost" };
  }

  private async acquireInTransaction(
    manager: EntityManager,
    input: Omit<
      Parameters<InactiveReleaseLaneOwnershipService["acquire"]>[0],
      "leaseTtlMs"
    > & { leaseTtlMs: number },
  ): Promise<ReleaseLaneOwnershipResult> {
    await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `deployguard:release-lane-ownership:${input.projectId}:${input.environmentName}`,
    ]);
    const project = await manager.query(
      "SELECT id FROM projects WHERE id = $1 FOR UPDATE",
      [input.projectId],
    );
    if (project.length !== 1) {
      throw new ReleaseLaneOwnershipError("OWNERSHIP_TRANSACTION_CONFLICT");
    }
    const rows = this.rows<OwnershipRow>(await manager.query(
      `SELECT ${this.returningColumns()}, clock_timestamp() AS "databaseNow"
       FROM project_release_lane_ownerships
       WHERE project_id = $1 AND environment_name = $2 FOR UPDATE`,
      [input.projectId, input.environmentName],
    ));
    const current = rows[0] ?? null;
    const sameRequest = current
      && current.ownerLane === input.lane
      && current.leaseId === input.leaseId
      && current.actorId === input.actorId
      && current.idempotencyKey === input.idempotencyKey
      && current.requestFingerprint === input.requestFingerprint;
    const sameKeyDifferentRequest = current
      && current.idempotencyKey === input.idempotencyKey
      && !sameRequest;
    if (sameKeyDifferentRequest) return { disposition: "idempotency_conflict" };
    if (current && this.isActive(current)) {
      if (sameRequest) return { disposition: "already_owned", ownership: this.snapshot(current) };
      return { disposition: current.ownerLane === "legacy" ? "blocked_by_legacy" : "blocked_by_v1" };
    }

    const blockers = await this.underlyingBlockers(
      manager,
      input.projectId,
      input.environmentName,
      input.lane === "legacy" ? input.ownLegacyRunId : undefined,
      input.lane === "v1" ? input.ownV1IntentId : undefined,
    );
    const expiredActiveOwnership = current
      && (current.status === "acquired" || current.status === "heartbeat_active");
    if (expiredActiveOwnership && (blockers.legacy || blockers.v1)) {
      return { disposition: "expired_not_recoverable" };
    }
    if (blockers.legacy) {
      return { disposition: "blocked_by_legacy" };
    }
    if (input.lane === "legacy" && blockers.v1) {
      return { disposition: "blocked_by_v1" };
    }
    const token = String((current ? Number(current.fencingToken) : 0) + 1);
    const saved = this.rows<OwnershipRow>(await manager.query(
      current
        ? `UPDATE project_release_lane_ownerships
           SET owner_lane = $3, lease_id = $4, actor_id = $5,
               idempotency_key = $6, request_fingerprint = $7,
               fencing_token = $8::bigint, status = 'acquired',
               deployment_intent_id = NULL, operation_lease_id = NULL,
               acquired_at = clock_timestamp(), heartbeat_at = clock_timestamp(),
               expires_at = clock_timestamp() + ($9::bigint * interval '1 millisecond'),
               released_at = NULL, updated_at = clock_timestamp()
           WHERE project_id = $1 AND environment_name = $2
           RETURNING ${this.returningColumns()}`
        : `INSERT INTO project_release_lane_ownerships (
             project_id, environment_name, owner_lane, lease_id, actor_id,
             idempotency_key, request_fingerprint, fencing_token, status,
             acquired_at, heartbeat_at, expires_at, released_at, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::bigint,'acquired',clock_timestamp(),clock_timestamp(),
             clock_timestamp() + ($9::bigint * interval '1 millisecond'),NULL,clock_timestamp(),clock_timestamp())
           RETURNING ${this.returningColumns()}`,
      [input.projectId, input.environmentName, input.lane, input.leaseId, input.actorId,
        input.idempotencyKey, input.requestFingerprint, token, input.leaseTtlMs],
    ));
    if (saved.length !== 1) {
      throw new ReleaseLaneOwnershipError("OWNERSHIP_TRANSACTION_CONFLICT");
    }
    return { disposition: "acquired", ownership: this.snapshot(saved[0]) };
  }

  private async underlyingBlockers(
    manager: EntityManager,
    projectId: string,
    environmentName: string,
    ownLegacyRunId?: string,
    ownV1IntentId?: string,
  ) {
    // Legacy runs have no environment column. Existing production semantics put
    // them in dev, so only the normalized dev scope can conflict with them.
    const legacy = environmentName === "dev"
      ? await manager.query(
          `SELECT 1 FROM project_pipeline_runs WHERE project_id = $1
           AND status::text = ANY($2::varchar[])
           AND ($3::uuid IS NULL OR id <> $3::uuid) LIMIT 1`,
          [projectId, ACTIVE_LEGACY_STATUSES, ownLegacyRunId ?? null],
        )
      : [];
    const v1Intent = await manager.query(
        `SELECT 1 FROM deployment_intents WHERE project_id = $1
         AND environment_name = $2 AND status = ANY($3::varchar[])
         AND ($4::uuid IS NULL OR id <> $4::uuid) LIMIT 1`,
        [projectId, environmentName, ACTIVE_V1_INTENT_STATUSES, ownV1IntentId ?? null],
      );
    const v1Lease = await manager.query(
        `SELECT 1 FROM project_operation_leases WHERE project_id = $1
         AND environment_name = $2 AND status = ANY($3::varchar[])
         AND expires_at > clock_timestamp() LIMIT 1`,
        [projectId, environmentName, ACTIVE_LEASE_STATUSES],
      );
    return { legacy: legacy.length > 0, v1: v1Intent.length > 0 || v1Lease.length > 0 };
  }

  private isActive(row: OwnershipRow) {
    return (row.status === "acquired" || row.status === "heartbeat_active")
      && new Date(row.expiresAt).getTime()
        > new Date(row.databaseNow ?? new Date()).getTime();
  }

  private returningColumns() {
    return `project_id AS "projectId", environment_name AS "environmentName",
      owner_lane AS "ownerLane", lease_id AS "leaseId", actor_id AS "actorId",
      idempotency_key AS "idempotencyKey", request_fingerprint AS "requestFingerprint",
      fencing_token AS "fencingToken", status, acquired_at AS "acquiredAt",
      heartbeat_at AS "heartbeatAt", expires_at AS "expiresAt", released_at AS "releasedAt"`;
  }

  private snapshot(row: OwnershipRow): ReleaseLaneOwnershipSnapshot {
    return {
      projectId: row.projectId,
      environmentName: row.environmentName,
      ownerLane: row.ownerLane,
      leaseId: row.leaseId,
      fencingToken: String(row.fencingToken),
      status: row.status as ReleaseLaneOwnershipStatus,
      acquiredAt: new Date(row.acquiredAt),
      heartbeatAt: new Date(row.heartbeatAt),
      expiresAt: new Date(row.expiresAt),
      releasedAt: row.releasedAt ? new Date(row.releasedAt) : null,
    };
  }

  private rows<T>(value: unknown): T[] {
    if (!Array.isArray(value)) return [];
    // TypeORM's PostgreSQL driver returns [records, affected] for some raw
    // UPDATE ... RETURNING calls, while SELECT returns records directly.
    if (value.length === 2 && Array.isArray(value[0]) && typeof value[1] === "number") {
      return value[0] as T[];
    }
    return value as T[];
  }

  private isSerializationFailure(error: unknown) {
    return typeof error === "object" && error !== null
      && "code" in error && (error as { code?: string }).code === "40001";
  }
}
