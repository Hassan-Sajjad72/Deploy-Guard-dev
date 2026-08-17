import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { hostname } from "os";
import { randomUUID } from "crypto";
import { DataSource, EntityManager } from "typeorm";
import { validateWorkerEnvelopeV1, workerEnvelopeJobId } from "../contracts/worker-envelope.validator";
import { DeployGuardWorkerEnvelopeV1 } from "../contracts/worker-envelope.types";
import { assertFrozenQueueRouting, outboxRetryDelayMs, workerRoleForMessageType } from "./outbox-dispatcher.pure";
import {
  OUTBOX_JOB_PUBLISHER,
  OutboxDeliveryClaimV1,
  OutboxDispatchResultV1,
  OutboxIntentTransitionConflictError,
  OutboxJobPublisher,
} from "./outbox-dispatcher.types";
import { InactiveV1ShadowInsertionAdapter } from "../release-lane/inactive-v1-shadow-insertion.adapter";
import { TerminalOutboxPolicyService } from "./terminal-outbox-policy.service";

type CandidateRow = {
  id: string;
  intentId: string;
  workerEnvelope: DeployGuardWorkerEnvelopeV1;
  status: string;
  intentStatus: string;
};

type ClaimRow = {
  id: string;
  intentId: string;
  workerEnvelope: DeployGuardWorkerEnvelopeV1;
  claimFencingToken: string;
  attemptCount: number;
  claimExpiresAt: Date;
};

/**
 * An explicit activation must never fall back to the dispatcher-wide scan: it
 * is bound to the immutable outbox row that the authenticated caller proved
 * belongs to their prepared intent.
 */
export type ExactOutboxDispatchTargetV1 = Readonly<{
  outboxId: string;
  intentId: string;
  projectId: string;
  environmentName: string;
}>;

@Injectable()
export class DurableOutboxDispatcherService {
  readonly dispatcherId: string;
  private readonly leaseMs: number;
  private readonly capabilityRetryMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaximumMs: number;

  constructor(
    private readonly dataSource: DataSource,
    @Inject(OUTBOX_JOB_PUBLISHER)
    private readonly publisher: OutboxJobPublisher,
    private readonly config: ConfigService,
    @Optional()
    private readonly shadowInsertion?: InactiveV1ShadowInsertionAdapter,
    @Inject(TerminalOutboxPolicyService)
    @Optional()
    private readonly terminalOutbox = new TerminalOutboxPolicyService(),
  ) {
    this.dispatcherId = this.config.get<string>(
      "OUTBOX_DISPATCHER_ID",
      `${hostname()}:${process.pid}:${randomUUID()}`,
    );
    this.leaseMs = this.positiveInteger("OUTBOX_DELIVERY_LEASE_MS", 30_000);
    this.capabilityRetryMs = this.positiveInteger("OUTBOX_CAPABILITY_RETRY_MS", 10_000);
    this.retryBaseMs = this.positiveInteger("OUTBOX_RETRY_BASE_MS", 1_000);
    this.retryMaximumMs = this.positiveInteger("OUTBOX_RETRY_MAX_MS", 60_000);
  }

  async dispatchOne(): Promise<OutboxDispatchResultV1> {
    const claim = await this.claimNext();
    return this.dispatchClaim(claim);
  }

  /**
   * Dispatch one already-authorized, exact outbox row. This does not start a
   * consumer and does not select any other pending outbox row.
   */
  async dispatchExact(
    target: ExactOutboxDispatchTargetV1,
  ): Promise<OutboxDispatchResultV1> {
    const claim = await this.claimExact(target);
    return this.dispatchClaim(claim);
  }

  private async dispatchClaim(
    claim:
      | OutboxDeliveryClaimV1
      | { blocked: Extract<OutboxDispatchResultV1, { status: "blocked" }> }
      | { deadLetter: Extract<OutboxDispatchResultV1, { status: "dead_letter" }> }
      | null,
  ): Promise<OutboxDispatchResultV1> {
    if (!claim) return { status: "idle" };
    if ("blocked" in claim) return claim.blocked;
    if ("deadLetter" in claim) return claim.deadLetter;

    this.shadowInsertion?.observeDispatch({
      projectId: claim.envelope.identity.projectId,
      environmentName: claim.envelope.identity.environmentName,
      intentId: claim.intentId,
      deterministicJobId: claim.deterministicJobId,
      lane: claim.envelope.routing.lane,
    });

    let published: { jobId: string };
    try {
      published = await this.publisher.publish(claim.envelope, claim.deterministicJobId);
    } catch {
      const retryable = await this.failDelivery(claim, "REDIS_DELIVERY_UNAVAILABLE");
      return retryable
        ? { status: "retryable", outboxId: claim.outboxId, reason: "REDIS_DELIVERY_UNAVAILABLE" }
        : { status: "ownership_lost", outboxId: claim.outboxId };
    }

    try {
      const finalized = await this.completeDelivery(claim, published.jobId);
      return finalized
        ? { status: "published", outboxId: claim.outboxId, jobId: published.jobId }
        : { status: "ownership_lost", outboxId: claim.outboxId, jobId: published.jobId };
    } catch (error) {
      if (!(error instanceof OutboxIntentTransitionConflictError)) throw error;
      const retryable = await this.failDelivery(claim, "INTENT_TRANSITION_CONFLICT");
      return retryable
        ? { status: "retryable", outboxId: claim.outboxId, reason: "INTENT_TRANSITION_CONFLICT" }
        : { status: "ownership_lost", outboxId: claim.outboxId, jobId: published.jobId };
    }
  }

  async dispatchBatch(limit = 25) {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const results: OutboxDispatchResultV1[] = [];
    for (let index = 0; index < safeLimit; index += 1) {
      const result = await this.dispatchOne();
      results.push(result);
      if (result.status === "idle") break;
    }
    return results;
  }

  async claimNext(): Promise<
    | OutboxDeliveryClaimV1
    | { blocked: Extract<OutboxDispatchResultV1, { status: "blocked" }> }
    | { deadLetter: Extract<OutboxDispatchResultV1, { status: "dead_letter" }> }
    | null
  > {
    return this.dataSource.transaction("READ COMMITTED", async (manager) => {
      const candidates = await manager.query(
        `SELECT outbox.id, outbox.intent_id AS "intentId",
                outbox.worker_envelope AS "workerEnvelope", outbox.status,
                intent.status AS "intentStatus"
         FROM deployment_intents intent
         INNER JOIN orchestration_outbox outbox ON outbox.intent_id = intent.id
         WHERE outbox.available_at <= clock_timestamp()
           AND (
             outbox.status IN ('pending', 'failed')
             OR (outbox.status = 'publishing' AND outbox.claim_expires_at <= clock_timestamp())
           )
           AND (intent.status = 'planned'
             OR intent.status IN ('completed', 'failed', 'cancelled', 'no_op', 'rejected'))
         ORDER BY outbox.available_at ASC, outbox.created_at ASC
         FOR UPDATE OF intent SKIP LOCKED
         LIMIT 1`,
      ) as CandidateRow[];
      const candidate = candidates[0];
      if (!candidate) return null;

      return this.claimCandidate(manager, candidate);
    });
  }

  async claimExact(
    target: ExactOutboxDispatchTargetV1,
  ): Promise<
    | OutboxDeliveryClaimV1
    | { blocked: Extract<OutboxDispatchResultV1, { status: "blocked" }> }
    | { deadLetter: Extract<OutboxDispatchResultV1, { status: "dead_letter" }> }
    | null
  > {
    return this.dataSource.transaction("READ COMMITTED", async (manager) => {
      const candidates = await manager.query(
        `SELECT outbox.id, outbox.intent_id AS "intentId",
                outbox.worker_envelope AS "workerEnvelope", outbox.status,
                intent.status AS "intentStatus"
         FROM deployment_intents intent
         INNER JOIN orchestration_outbox outbox ON outbox.intent_id = intent.id
         WHERE outbox.id = $1
           AND intent.id = $2
           AND intent.project_id = $3
           AND intent.environment_name = $4
           AND outbox.available_at <= clock_timestamp()
           AND (
             outbox.status IN ('pending', 'failed')
             OR (outbox.status = 'publishing' AND outbox.claim_expires_at <= clock_timestamp())
           )
           AND (intent.status = 'planned'
             OR intent.status IN ('completed', 'failed', 'cancelled', 'no_op', 'rejected'))
         FOR UPDATE OF intent SKIP LOCKED`,
        [
          target.outboxId,
          target.intentId,
          target.projectId,
          target.environmentName,
        ],
      ) as CandidateRow[];
      const candidate = candidates[0];
      if (!candidate) return null;
      return this.claimCandidate(manager, candidate);
    });
  }

  private async claimCandidate(
    manager: EntityManager,
    candidate: CandidateRow,
  ): Promise<
    | OutboxDeliveryClaimV1
    | { blocked: Extract<OutboxDispatchResultV1, { status: "blocked" }> }
    | { deadLetter: Extract<OutboxDispatchResultV1, { status: "dead_letter" }> }
    | null
  > {

      const dispatchState = await this.terminalOutbox.dispatchState(
        manager,
        candidate.intentId,
      );
      if (dispatchState.state === "terminal") {
        return {
          deadLetter: {
            status: "dead_letter",
            outboxId: candidate.id,
            reason: "TERMINAL_INTENT_NOT_DISPATCHABLE",
          },
        };
      }
      if (dispatchState.state !== "dispatchable") return null;

      const lock = await manager.query(
        `SELECT id FROM orchestration_outbox
         WHERE id = $1
           AND available_at <= clock_timestamp()
           AND (status IN ('pending', 'failed')
             OR (status = 'publishing' AND claim_expires_at <= clock_timestamp()))
         FOR UPDATE`,
        [candidate.id],
      ) as Array<{ id: string }>;
      if (lock.length !== 1) return null;

      let envelope: DeployGuardWorkerEnvelopeV1;
      try {
        const [clock] = await manager.query(`SELECT clock_timestamp() AS now`);
        envelope = validateWorkerEnvelopeV1(candidate.workerEnvelope, new Date(clock.now));
        assertFrozenQueueRouting(envelope);
      } catch {
        await manager.query(
          `UPDATE orchestration_outbox
           SET status = 'dead_letter', last_error = 'INVALID_WORKER_ENVELOPE',
               claimed_by = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
           WHERE id = $1`,
          [candidate.id],
        );
        return {
          deadLetter: {
            status: "dead_letter",
            outboxId: candidate.id,
            reason: "INVALID_WORKER_ENVELOPE",
          },
        };
      }

      if (!await this.hasCompatibleWorker(manager, envelope)) {
        await manager.query(
          `UPDATE orchestration_outbox
           SET status = 'pending', last_error = 'WORKER_PROTOCOL_UNAVAILABLE',
               available_at = clock_timestamp() + ($2::bigint * interval '1 millisecond'),
               claimed_by = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
           WHERE id = $1`,
          [candidate.id, this.capabilityRetryMs],
        );
        return {
          blocked: {
            status: "blocked",
            outboxId: candidate.id,
            reason: "WORKER_PROTOCOL_UNAVAILABLE",
          },
        };
      }

      const claimedResult = await manager.query(
        `UPDATE orchestration_outbox
         SET status = 'publishing', claimed_by = $2,
             claim_expires_at = clock_timestamp() + ($3::bigint * interval '1 millisecond'),
             claim_fencing_token = claim_fencing_token + 1,
             attempt_count = attempt_count + 1,
             last_error = NULL, updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING id, intent_id AS "intentId", worker_envelope AS "workerEnvelope",
                   claim_fencing_token AS "claimFencingToken",
                   attempt_count AS "attemptCount",
                   claim_expires_at AS "claimExpiresAt"`,
        [candidate.id, this.dispatcherId, this.leaseMs],
      );
      const claimed = this.returningRows<ClaimRow>(claimedResult);
      if (!claimed[0]) return null;
      return {
        outboxId: claimed[0].id,
        intentId: claimed[0].intentId,
        ownerId: this.dispatcherId,
        fencingToken: claimed[0].claimFencingToken,
        deliveryAttempt: claimed[0].attemptCount,
        leaseExpiresAt: new Date(claimed[0].claimExpiresAt),
        envelope,
        deterministicJobId: workerEnvelopeJobId(envelope),
      };
  }

  async completeDelivery(claim: OutboxDeliveryClaimV1, publishedJobId: string) {
    if (publishedJobId !== claim.deterministicJobId) return false;
    return this.dataSource.transaction("READ COMMITTED", async (manager) => {
      const dispatchState = await this.terminalOutbox.dispatchState(
        manager,
        claim.intentId,
      );
      if (dispatchState.state !== "dispatchable") return false;
      const result = await manager.query(
        `UPDATE orchestration_outbox
         SET status = 'published', published_job_id = $4, published_at = clock_timestamp(),
             claimed_by = NULL, claim_expires_at = NULL, last_error = NULL,
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'publishing' AND claimed_by = $2
           AND claim_fencing_token = $3::bigint
           AND claim_expires_at > clock_timestamp()
         RETURNING intent_id AS "intentId"`,
        [claim.outboxId, claim.ownerId, claim.fencingToken, publishedJobId],
      );
      const rows = this.returningRows<{ intentId: string }>(result);
      if (!rows[0]) return false;
      const transitioned = this.returningRows<{ id: string }>(await manager.query(
        `UPDATE deployment_intents
         SET status = 'enqueued', enqueued_at = COALESCE(enqueued_at, clock_timestamp()),
             updated_at = clock_timestamp()
         WHERE id = $1 AND status = 'planned'
         RETURNING id`,
        [rows[0].intentId],
      ));
      if (transitioned.length !== 1) {
        throw new OutboxIntentTransitionConflictError();
      }
      return true;
    });
  }

  async failDelivery(
    claim: OutboxDeliveryClaimV1,
    safeErrorCode: "REDIS_DELIVERY_UNAVAILABLE" | "INTENT_TRANSITION_CONFLICT",
  ) {
    const delay = outboxRetryDelayMs(
      claim.deliveryAttempt,
      this.retryBaseMs,
      this.retryMaximumMs,
    );
    const result = await this.dataSource.query(
      `UPDATE orchestration_outbox
       SET status = 'failed', last_error = $4,
           available_at = clock_timestamp() + ($5::bigint * interval '1 millisecond'),
           claimed_by = NULL, claim_expires_at = NULL, updated_at = clock_timestamp()
       WHERE id = $1 AND status = 'publishing' AND claimed_by = $2
         AND claim_fencing_token = $3::bigint
         AND claim_expires_at > clock_timestamp()`,
      [claim.outboxId, claim.ownerId, claim.fencingToken, safeErrorCode, delay],
    );
    return this.affectedRows(result) > 0;
  }

  private async hasCompatibleWorker(
    manager: EntityManager,
    envelope: DeployGuardWorkerEnvelopeV1,
  ) {
    const role = workerRoleForMessageType(envelope.protocol.messageType);
    const rows = await manager.query(
      `SELECT worker_id
       FROM worker_capabilities
       WHERE role = $1
         AND expires_at > clock_timestamp()
         AND minimum_protocol <= $2
         AND maximum_protocol >= $2
         AND supported_message_types @> $3::jsonb
       ORDER BY expires_at DESC
       LIMIT 1`,
      [
        role,
        envelope.protocol.schemaVersion,
        JSON.stringify([envelope.protocol.messageType]),
      ],
    );
    return rows.length > 0;
  }

  private positiveInteger(key: string, fallback: number) {
    const value = Number(this.config.get<string>(key, String(fallback)));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  private returningRows<T>(result: unknown): T[] {
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

  private affectedRows(result: unknown) {
    if (
      Array.isArray(result)
      && result.length === 2
      && typeof result[1] === "number"
    ) {
      return result[1];
    }
    return 0;
  }
}
