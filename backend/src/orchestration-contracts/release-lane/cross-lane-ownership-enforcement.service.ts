import { createHash } from "node:crypto";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { ProjectPipelineRun } from "../../projects/project-pipeline-run.entity";
import { InactiveReleaseLaneCorrelationService } from "./inactive-release-lane-correlation.service";
import { ReleaseLaneCorrelationFence } from "./inactive-release-lane-correlation.types";
import { InactiveReleaseLaneOwnershipService } from "./inactive-release-lane-ownership.service";
import { ReleaseLaneOwnershipResult } from "./inactive-release-lane-ownership.types";
import {
  normalV1Activation,
} from "./normal-v1-activation-policy";

export const TWO_LANE_OWNERSHIP_ENFORCEMENT_FLAG =
  "TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED";
export const TWO_LANE_OWNERSHIP_ROLLOUT_FLAG =
  "TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED";
export const TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST =
  "TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST";
export const TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST =
  "TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST";

export type CrossLaneOwnershipFence = ReleaseLaneCorrelationFence & {
  enabled: true;
  operationId: string;
};

export type CrossLaneOwnershipClaim =
  | { enabled: false }
  | { enabled: true; fence: CrossLaneOwnershipFence };

export type CrossLaneHeartbeat = {
  isTrusted(): boolean;
  stop(): Promise<boolean>;
};

export type CrossLaneOwnershipInspection =
  | { enabled: false }
  | {
      enabled: true;
      ownership: null | {
        ownerLane: "legacy" | "v1";
        status: "acquired" | "heartbeat_active" | "released" | "expired";
        fencingToken: string;
        acquiredAt: Date;
        heartbeatAt: Date;
        expiresAt: Date;
        releasedAt: Date | null;
        hasIntentCorrelation: boolean;
        hasOperationCorrelation: boolean;
        hasLegacyRunCorrelation: boolean;
        hasLegacyRollbackCorrelation: boolean;
      };
    };

export type CrossLaneRecoveryResult =
  | { enabled: false; disposition: "disabled" }
  | {
      enabled: true;
      disposition:
        | "recovered"
        | "already_recovered"
        | "not_terminal"
        | "ownership_lost";
    };

export class CrossLaneOwnershipEnforcementError extends Error {
  constructor(
    readonly code:
      | "CROSS_LANE_BLOCKED_BY_LEGACY"
      | "CROSS_LANE_BLOCKED_BY_V1"
      | "CROSS_LANE_EXPIRED_NOT_RECOVERABLE"
      | "CROSS_LANE_IDEMPOTENCY_CONFLICT"
      | "CROSS_LANE_OWNERSHIP_LOST"
      | "CROSS_LANE_CORRELATION_FAILED",
  ) {
    super(code);
    this.name = "CrossLaneOwnershipEnforcementError";
  }
}

/**
 * Default-off composition over the existing ownership and correlation models.
 * It owns no queue, worker, cloud, Terraform, Docker, ECR, ECS, or deletion API.
 */
@Injectable()
export class CrossLaneOwnershipEnforcementService {
  private readonly logger = new Logger(
    CrossLaneOwnershipEnforcementService.name,
  );

  constructor(
    private readonly config: ConfigService,
    private readonly ownership: InactiveReleaseLaneOwnershipService,
    private readonly correlation: InactiveReleaseLaneCorrelationService,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  isEnabled(): boolean {
    return this.config.get<unknown>(TWO_LANE_OWNERSHIP_ENFORCEMENT_FLAG) === "true";
  }

  isEnabledForScope(projectId: string, environmentName: string): boolean {
    if (!this.isEnabled()) return false;
    if (this.config.get<unknown>(TWO_LANE_OWNERSHIP_ROLLOUT_FLAG) !== "true") {
      return true;
    }
    const projects = this.allowlist(
      this.config.get<unknown>(TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST),
    );
    const environments = this.allowlist(
      this.config.get<unknown>(TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST),
    );
    const activation = normalV1Activation(this.config);
    if (activation?.mode === "shared") {
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(projectId)
        && environments.length === 1
        && environments[0] === "dev"
        && environmentName === "dev";
    }
    return projects.length === 1
      && environments.length === 1
      && environments[0] === "dev"
      && projects[0] === projectId
      && environmentName === "dev";
  }

  rolloutStatus() {
    if (!this.isEnabled()) {
      return Object.freeze({
        state: "disabled" as const,
        projectAllowlistCount: 0,
        environmentAllowlistCount: 0,
      });
    }
    if (this.config.get<unknown>(TWO_LANE_OWNERSHIP_ROLLOUT_FLAG) !== "true") {
      return Object.freeze({
        state: "global" as const,
        projectAllowlistCount: 0,
        environmentAllowlistCount: 0,
      });
    }
    const projects = this.allowlist(
      this.config.get<unknown>(TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST),
    );
    const environments = this.allowlist(
      this.config.get<unknown>(TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST),
    );
    const activation = normalV1Activation(this.config);
    const shared = activation?.mode === "shared";
    const valid = (shared || projects.length === 1)
      && environments.length === 1
      && environments[0] === "dev";
    return Object.freeze({
      state: valid
        ? shared ? "global" as const : "allowlisted" as const
        : "blocked" as const,
      projectAllowlistCount: valid && !shared ? 1 : 0,
      environmentAllowlistCount: valid ? 1 : 0,
    });
  }

  async inspect(
    projectId: string,
    environmentName: string,
  ): Promise<CrossLaneOwnershipInspection> {
    if (!this.isEnabledForScope(projectId, environmentName)) {
      return { enabled: false };
    }
    if (!this.dataSource) {
      return { enabled: true, ownership: null };
    }
    const rows = await this.dataSource.query(
      `SELECT o.owner_lane AS "ownerLane", o.status,
              fencing_token::text AS "fencingToken",
              acquired_at AS "acquiredAt", heartbeat_at AS "heartbeatAt",
              expires_at AS "expiresAt", released_at AS "releasedAt",
              deployment_intent_id IS NOT NULL AS "hasIntentCorrelation",
              operation_lease_id IS NOT NULL AS "hasOperationCorrelation",
              EXISTS (
                SELECT 1 FROM project_pipeline_runs r
                WHERE r.cross_lane_ownership_id = o.id
              ) AS "hasLegacyRunCorrelation",
              EXISTS (
                SELECT 1 FROM project_rollback_records r
                WHERE r.cross_lane_ownership_id = o.id
              ) AS "hasLegacyRollbackCorrelation"
       FROM project_release_lane_ownerships o
       WHERE o.project_id = $1 AND o.environment_name = $2`,
      [projectId, environmentName],
    );
    const row = rows[0];
    return {
      enabled: true,
      ownership: row
        ? {
            ownerLane: row.ownerLane,
            status: row.status,
            fencingToken: String(row.fencingToken),
            acquiredAt: new Date(row.acquiredAt),
            heartbeatAt: new Date(row.heartbeatAt),
            expiresAt: new Date(row.expiresAt),
            releasedAt: row.releasedAt ? new Date(row.releasedAt) : null,
            hasIntentCorrelation: Boolean(row.hasIntentCorrelation),
            hasOperationCorrelation: Boolean(row.hasOperationCorrelation),
            hasLegacyRunCorrelation: Boolean(row.hasLegacyRunCorrelation),
            hasLegacyRollbackCorrelation: Boolean(
              row.hasLegacyRollbackCorrelation,
            ),
          }
        : null,
    };
  }

  async recoverLegacyRunAfterDurableFinality(input: {
    claim: CrossLaneOwnershipClaim;
    pipelineRunId: string;
  }): Promise<CrossLaneRecoveryResult> {
    if (!input.claim.enabled) {
      return { enabled: false, disposition: "disabled" };
    }
    const fence = input.claim.fence;
    if (
      !this.isEnabledForScope(fence.projectId, fence.environmentName)
      || fence.lane !== "legacy"
      || fence.environmentName !== "dev"
      || fence.operationId !== input.pipelineRunId
      || !this.dataSource
    ) {
      return { enabled: true, disposition: "ownership_lost" };
    }
    const result = await this.dataSource.transaction(
      "SERIALIZABLE",
      async (manager) => {
        await manager.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `deployguard:release-lane-ownership:${fence.projectId}:dev`,
        ]);
        const rows = await manager.query(
          `SELECT o.id AS "ownershipId", o.status AS "ownershipStatus",
                  r.status AS "runStatus"
           FROM project_release_lane_ownerships o
           JOIN project_pipeline_runs r
             ON r.cross_lane_ownership_id = o.id
            AND r.id = $7 AND r.project_id = o.project_id
           WHERE o.project_id = $1 AND o.environment_name = $2
             AND o.owner_lane = $3 AND o.lease_id = $4
             AND o.actor_id = $5 AND o.fencing_token = $6::bigint
             AND r.cross_lane_owner_fencing_token = $6::bigint
             AND r.cross_lane_owner_lease_id = $4
             AND r.cross_lane_owner_actor_id = $5
             AND r.cross_lane_owner_lane = $3
             AND r.cross_lane_owner_environment_name = $2
           FOR UPDATE OF o, r`,
          [
            fence.projectId,
            fence.environmentName,
            fence.lane,
            fence.ownershipLeaseId,
            fence.actorId,
            fence.ownershipFencingToken,
            input.pipelineRunId,
          ],
        );
        const row = rows[0];
        if (!row) {
          const released = await manager.query(
            `SELECT 1 FROM project_release_lane_ownerships
             WHERE project_id = $1 AND environment_name = $2
               AND owner_lane = $3 AND lease_id = $4
               AND actor_id = $5 AND fencing_token = $6::bigint
               AND status = 'released'`,
            [
              fence.projectId,
              fence.environmentName,
              fence.lane,
              fence.ownershipLeaseId,
              fence.actorId,
              fence.ownershipFencingToken,
            ],
          );
          return released.length === 1
            ? "already_recovered" as const
            : "ownership_lost" as const;
        }
        const requiredDecision =
          row.runStatus === "completed"
            ? "completed"
            : ["failed", "storage_failed"].includes(row.runStatus)
              ? "failed_after_retries_exhausted"
              : null;
        if (!requiredDecision) return "not_terminal" as const;
        const finality = await manager.query(
          `SELECT 1 FROM project_pipeline_job_finalities
           WHERE pipeline_run_id = $1 AND project_id = $2
             AND decision = $3 LIMIT 1`,
          [input.pipelineRunId, fence.projectId, requiredDecision],
        );
        if (finality.length !== 1) return "not_terminal" as const;
        const ownershipUpdate = await manager.query(
          `UPDATE project_release_lane_ownerships
           SET status = 'released', released_at = clock_timestamp(),
               updated_at = clock_timestamp()
           WHERE id = $1 AND project_id = $2 AND environment_name = 'dev'
             AND owner_lane = 'legacy' AND lease_id = $3
             AND actor_id = $4 AND fencing_token = $5::bigint
             AND status IN ('acquired','heartbeat_active','expired')`,
          [
            row.ownershipId,
            fence.projectId,
            fence.ownershipLeaseId,
            fence.actorId,
            fence.ownershipFencingToken,
          ],
        );
        if (this.affected(ownershipUpdate) !== 1) {
          return "ownership_lost" as const;
        }
        const runUpdate = await manager.query(
          `UPDATE project_pipeline_runs
           SET cross_lane_ownership_id = NULL,
               cross_lane_owner_lane = NULL,
               cross_lane_owner_environment_name = NULL,
               cross_lane_owner_lease_id = NULL,
               cross_lane_owner_actor_id = NULL,
               cross_lane_owner_fencing_token = NULL
           WHERE id = $1 AND project_id = $2
             AND cross_lane_ownership_id = $3
             AND cross_lane_owner_lease_id = $4
             AND cross_lane_owner_actor_id = $5
             AND cross_lane_owner_fencing_token = $6::bigint`,
          [
            input.pipelineRunId,
            fence.projectId,
            row.ownershipId,
            fence.ownershipLeaseId,
            fence.actorId,
            fence.ownershipFencingToken,
          ],
        );
        if (this.affected(runUpdate) !== 1) {
          throw new Error("CROSS_LANE_RECOVERY_TRANSACTION_FAILED");
        }
        return "recovered" as const;
      },
    );
    this.log("recovery", fence.projectId, "dev", "legacy", result);
    return { enabled: true, disposition: result };
  }

  async acquireLegacy(input: {
    projectId: string;
    operationId: string;
    actorId: string;
    operationClass: string;
    leaseTtlMs?: number;
  }): Promise<CrossLaneOwnershipClaim> {
    return this.acquire({
      ...input,
      environmentName: "dev",
      lane: "legacy",
    });
  }

  async acquireV1(input: {
    projectId: string;
    environmentName: string;
    intentId: string;
    /** A fenced recovery may use a distinct operation identity while retaining intent correlation. */
    operationId?: string;
    actorId: string;
    requestFingerprint: string;
    leaseTtlMs?: number;
  }): Promise<CrossLaneOwnershipClaim> {
    const claim = await this.acquire({
      projectId: input.projectId,
      environmentName: input.environmentName,
      lane: "v1",
      operationId: input.operationId ?? input.intentId,
      actorId: input.actorId,
      operationClass: "v1_intent_execution",
      requestFingerprint: input.requestFingerprint,
      leaseTtlMs: input.leaseTtlMs,
    });
    if (!claim.enabled) return claim;
    const linked = await this.correlation.linkV1IntentOwnership({
      ...claim.fence,
      intentId: input.intentId,
    });
    if (linked.disposition !== "linked" && linked.disposition !== "already_linked") {
      await this.release(claim.fence);
      throw new CrossLaneOwnershipEnforcementError(
        "CROSS_LANE_CORRELATION_FAILED",
      );
    }
    return claim;
  }

  async linkLegacyRun(
    claim: CrossLaneOwnershipClaim,
    pipelineRunId: string,
  ): Promise<void> {
    if (!claim.enabled) return;
    const linked = await this.correlation.linkLegacyRun({
      ...claim.fence,
      pipelineRunId,
    });
    if (linked.disposition !== "linked" && linked.disposition !== "already_linked") {
      await this.release(claim.fence);
      throw new CrossLaneOwnershipEnforcementError(
        "CROSS_LANE_CORRELATION_FAILED",
      );
    }
    this.log(
      "correlated",
      claim.fence.projectId,
      claim.fence.environmentName,
      claim.fence.lane,
      linked.disposition,
    );
  }

  async linkLegacyRollback(
    claim: CrossLaneOwnershipClaim,
    rollbackRecordId: string,
  ): Promise<void> {
    if (!claim.enabled) return;
    const linked = await this.correlation.linkLegacyRollback({
      ...claim.fence,
      rollbackRecordId,
    });
    if (linked.disposition !== "linked" && linked.disposition !== "already_linked") {
      await this.release(claim.fence);
      throw new CrossLaneOwnershipEnforcementError(
        "CROSS_LANE_CORRELATION_FAILED",
      );
    }
  }

  async attachV1OperationLease(
    claim: CrossLaneOwnershipClaim,
    operation: {
      intentId: string;
      operationLeaseId: string;
      operationWorkerId: string;
      operationFencingToken: string;
    },
  ): Promise<void> {
    if (!claim.enabled) return;
    if (claim.fence.ownershipLeaseId === operation.operationLeaseId) {
      throw new CrossLaneOwnershipEnforcementError(
        "CROSS_LANE_CORRELATION_FAILED",
      );
    }
    const linked = await this.correlation.attachClaimedV1OperationLease({
      ...claim.fence,
      ...operation,
    });
    if (linked.disposition !== "linked" && linked.disposition !== "already_linked") {
      throw new CrossLaneOwnershipEnforcementError(
        "CROSS_LANE_CORRELATION_FAILED",
      );
    }
  }

  async validateV1Fences(
    claim: CrossLaneOwnershipClaim,
    operation: {
      intentId: string;
      operationLeaseId: string;
      operationWorkerId: string;
      operationFencingToken: string;
    },
  ): Promise<boolean> {
    if (!claim.enabled) return true;
    const result = await this.correlation.validateBothIndependentFences({
      ...claim.fence,
      ...operation,
    });
    return result.disposition === "already_linked";
  }

  legacyClaimFromRun(run: ProjectPipelineRun): CrossLaneOwnershipClaim {
    if (!this.isEnabledForScope(run.projectId, "dev")) {
      return { enabled: false };
    }
    if (
      run.crossLaneOwnerLane !== "legacy"
      || run.crossLaneOwnerEnvironmentName !== "dev"
      || !run.crossLaneOwnerLeaseId
      || !run.crossLaneOwnerActorId
      || !run.crossLaneOwnerFencingToken
    ) {
      throw new CrossLaneOwnershipEnforcementError(
        "CROSS_LANE_OWNERSHIP_LOST",
      );
    }
    return {
      enabled: true,
      fence: {
        enabled: true,
        projectId: run.projectId,
        environmentName: "dev",
        lane: "legacy",
        ownershipLeaseId: run.crossLaneOwnerLeaseId,
        actorId: run.crossLaneOwnerActorId,
        ownershipFencingToken: String(run.crossLaneOwnerFencingToken),
        operationId: run.id,
      },
    };
  }

  async renew(
    claim: CrossLaneOwnershipClaim,
    leaseTtlMs = 60_000,
  ): Promise<boolean> {
    if (!claim.enabled) return true;
    const result = await this.ownership.renew({
      projectId: claim.fence.projectId,
      environmentName: claim.fence.environmentName,
      lane: claim.fence.lane,
      leaseId: claim.fence.ownershipLeaseId,
      actorId: claim.fence.actorId,
      fencingToken: claim.fence.ownershipFencingToken,
      leaseTtlMs,
    });
    const owns = this.owns(result);
    this.log(
      "heartbeat",
      claim.fence.projectId,
      claim.fence.environmentName,
      claim.fence.lane,
      owns ? "renewed" : "ownership_lost",
    );
    return owns;
  }

  startHeartbeat(
    claim: CrossLaneOwnershipClaim,
    input: { leaseTtlMs?: number; intervalMs?: number } = {},
  ): CrossLaneHeartbeat {
    if (!claim.enabled) {
      return { isTrusted: () => true, stop: async () => true };
    }
    const leaseTtlMs = input.leaseTtlMs ?? 60_000;
    const intervalMs = Math.max(
      250,
      Math.min(input.intervalMs ?? Math.floor(leaseTtlMs / 3), leaseTtlMs - 1),
    );
    let trusted = true;
    let stopped = false;
    let renewing: Promise<void> = Promise.resolve();
    const timer = setInterval(() => {
      if (stopped || !trusted) return;
      renewing = renewing.then(async () => {
        if (!(await this.renew(claim, leaseTtlMs))) trusted = false;
      }).catch(() => {
        trusted = false;
      });
    }, intervalMs);
    timer.unref?.();
    return {
      isTrusted: () => trusted,
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await renewing;
        return trusted;
      },
    };
  }

  async release(claim: CrossLaneOwnershipClaim | CrossLaneOwnershipFence): Promise<boolean> {
    if (!("enabled" in claim) || !claim.enabled) return true;
    const fence = "fence" in claim ? claim.fence : claim;
    const result = await this.ownership.release({
      projectId: fence.projectId,
      environmentName: fence.environmentName,
      lane: fence.lane,
      leaseId: fence.ownershipLeaseId,
      actorId: fence.actorId,
      fencingToken: fence.ownershipFencingToken,
    });
    const owns = this.owns(result);
    this.log(
      "release",
      fence.projectId,
      fence.environmentName,
      fence.lane,
      owns ? "released" : "ownership_lost",
    );
    return owns;
  }

  async releaseLegacyRun(
    claim: CrossLaneOwnershipClaim,
    pipelineRunId: string,
  ): Promise<boolean> {
    if (!claim.enabled) return true;
    const released = await this.release(claim);
    if (!released) return false;
    const cleared = await this.correlation.clearLegacyRunAfterRelease({
      ...claim.fence,
      pipelineRunId,
    });
    return cleared.disposition === "cleared"
      || cleared.disposition === "already_cleared";
  }

  async releaseLegacyRollback(
    claim: CrossLaneOwnershipClaim,
    rollbackRecordId: string,
  ): Promise<boolean> {
    if (!claim.enabled) return true;
    const released = await this.release(claim);
    if (!released) return false;
    const cleared = await this.correlation.clearLegacyRollbackAfterRelease({
      ...claim.fence,
      rollbackRecordId,
    });
    return cleared.disposition === "cleared"
      || cleared.disposition === "already_cleared";
  }

  async releaseV1(
    claim: CrossLaneOwnershipClaim,
    input: { intentId: string; operationLeaseId: string | null },
  ): Promise<boolean> {
    if (!claim.enabled) return true;
    const released = await this.release(claim);
    if (!released) return false;
    const cleared = await this.correlation.clearV1AfterRelease({
      ...claim.fence,
      ...input,
    });
    return cleared.disposition === "cleared"
      || cleared.disposition === "already_cleared";
  }

  private async acquire(input: {
    projectId: string;
    environmentName: string;
    lane: "legacy" | "v1";
    operationId: string;
    actorId: string;
    operationClass: string;
    requestFingerprint?: string;
    leaseTtlMs?: number;
  }): Promise<CrossLaneOwnershipClaim> {
    if (!this.isEnabledForScope(input.projectId, input.environmentName)) {
      return { enabled: false };
    }
    const identity = [
      input.lane,
      input.operationClass,
      input.projectId,
      input.environmentName,
      input.operationId,
    ].join(":");
    const result = await this.ownership.acquire({
      projectId: input.projectId,
      environmentName: input.environmentName,
      lane: input.lane,
      leaseId: deterministicUuid(`ownership:${identity}`),
      actorId: input.actorId,
      idempotencyKey: digest(`idempotency:${identity}`),
      requestFingerprint:
        input.requestFingerprint ?? digest(`request:${identity}`),
      leaseTtlMs: input.leaseTtlMs,
      ownLegacyRunId: input.lane === "legacy" ? input.operationId : undefined,
      ownV1IntentId: input.lane === "v1" ? input.operationId : undefined,
    });
    if (result.disposition !== "acquired" && result.disposition !== "already_owned") {
      this.log(
        "acquire",
        input.projectId,
        input.environmentName,
        input.lane,
        result.disposition,
      );
      throw new CrossLaneOwnershipEnforcementError(
        result.disposition === "blocked_by_legacy"
          ? "CROSS_LANE_BLOCKED_BY_LEGACY"
          : result.disposition === "blocked_by_v1"
            ? "CROSS_LANE_BLOCKED_BY_V1"
            : result.disposition === "expired_not_recoverable"
              ? "CROSS_LANE_EXPIRED_NOT_RECOVERABLE"
              : result.disposition === "idempotency_conflict"
                ? "CROSS_LANE_IDEMPOTENCY_CONFLICT"
                : "CROSS_LANE_OWNERSHIP_LOST",
      );
    }
    this.log(
      "acquire",
      input.projectId,
      input.environmentName,
      input.lane,
      result.disposition,
    );
    return {
      enabled: true,
      fence: {
        enabled: true,
        projectId: result.ownership.projectId,
        environmentName: result.ownership.environmentName,
        lane: result.ownership.ownerLane,
        ownershipLeaseId: result.ownership.leaseId,
        actorId: input.actorId,
        ownershipFencingToken: result.ownership.fencingToken,
        operationId: input.operationId,
      },
    };
  }

  private owns(result: ReleaseLaneOwnershipResult): boolean {
    return result.disposition === "acquired" || result.disposition === "already_owned";
  }

  private allowlist(value: unknown): string[] {
    if (typeof value !== "string") return [];
    const entries = value.split(",").map((entry) => entry.trim());
    if (
      entries.length === 0
      || entries.some((entry) => !entry)
    ) {
      return [];
    }
    return [...new Set(entries)].sort();
  }

  private affected(value: unknown): number {
    if (
      Array.isArray(value)
      && value.length === 2
      && typeof value[1] === "number"
    ) {
      return value[1];
    }
    return 0;
  }

  private log(
    event: string,
    projectId: string,
    environmentName: string,
    lane: "legacy" | "v1",
    disposition: string,
  ) {
    const scopeHash = createHash("sha256")
      .update(`${projectId}:${environmentName}`)
      .digest("hex")
      .slice(0, 12);
    this.logger.log(
      `event=${event} scope_hash=${scopeHash} environment=${environmentName} lane=${lane} disposition=${disposition}`,
    );
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function deterministicUuid(value: string): string {
  const hex = digest(value).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const raw = hex.join("");
  return [
    raw.slice(0, 8),
    raw.slice(8, 12),
    raw.slice(12, 16),
    raw.slice(16, 20),
    raw.slice(20),
  ].join("-");
}
