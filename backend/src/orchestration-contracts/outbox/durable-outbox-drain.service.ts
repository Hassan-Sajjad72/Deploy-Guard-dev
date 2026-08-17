import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { DurableOutboxDispatcherService } from "./durable-outbox-dispatcher.service";
import { OutboxDispatchResultV1 } from "./outbox-dispatcher.types";

const ADVISORY_LOCK_KEY = "deployguard:durable-outbox-drain:v1";

export type DurableOutboxDrainSnapshot = Readonly<{
  pending: number;
  failed: number;
  publishing: number;
  deadLetter: number;
  terminalDeadLetter: number;
  actionableDeadLetter: number;
}>;

export type DurableOutboxDrainRun = Readonly<{
  state: "disabled" | "lock_unavailable" | "drained";
  results: readonly OutboxDispatchResultV1[];
  snapshot: DurableOutboxDrainSnapshot;
}>;

export type DurableOutboxDrainReadiness = Readonly<{
  state: "disabled" | "starting" | "ready" | "unhealthy" | "stopping";
  ready: boolean;
}>;

/**
 * Process-lifecycle recovery for committed outbox work. Exact HTTP dispatch is
 * still the latency optimization; this default-off drain is the durable
 * delivery boundary. A session advisory lock limits each pass to one process,
 * while row claims/fencing remain the correctness boundary after failover.
 */
@Injectable()
export class DurableOutboxDrainService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DurableOutboxDrainService.name);
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private timer: NodeJS.Timeout | null = null;
  private active: Promise<void> | null = null;
  private stopping = false;
  private lifecycleStarted = false;
  private lastSuccessfulPassAt = 0;
  private lastFailedPassAt = 0;
  private lastActionableDeadLetterCount: number | null = null;

  constructor(
    private readonly dataSource: DataSource,
    private readonly dispatcher: DurableOutboxDispatcherService,
    private readonly config: ConfigService,
  ) {
    this.intervalMs = boundedInteger(
      this.config.get<unknown>("OUTBOX_DRAIN_INTERVAL_MS"),
      250,
      300_000,
      5_000,
    );
    this.batchSize = boundedInteger(
      this.config.get<unknown>("OUTBOX_DRAIN_BATCH_SIZE"),
      1,
      100,
      25,
    );
  }

  onApplicationBootstrap() {
    if (!this.enabled()) return;
    this.lifecycleStarted = true;
    this.logger.log("DURABLE_OUTBOX_DRAIN_READY");
    this.schedule(0);
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.active;
  }

  readiness(now = Date.now()): DurableOutboxDrainReadiness {
    if (!this.enabled()) return Object.freeze({ state: "disabled", ready: false });
    if (this.stopping) return Object.freeze({ state: "stopping", ready: false });
    if (!this.lifecycleStarted) {
      return Object.freeze({ state: "starting", ready: false });
    }
    if (this.lastSuccessfulPassAt === 0) {
      return this.lastFailedPassAt > 0
        ? Object.freeze({ state: "unhealthy", ready: false })
        : Object.freeze({ state: "starting", ready: false });
    }
    const staleAfterMs = Math.max(this.intervalMs * 3, 5_000);
    const failedAfterSuccess = this.lastFailedPassAt > this.lastSuccessfulPassAt;
    const stale = now - this.lastSuccessfulPassAt > staleAfterMs;
    return failedAfterSuccess || stale
      ? Object.freeze({ state: "unhealthy", ready: false })
      : Object.freeze({ state: "ready", ready: true });
  }

  async runOnce(): Promise<DurableOutboxDrainRun> {
    if (!this.enabled()) {
      return { state: "disabled", results: [], snapshot: await this.snapshot() };
    }
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    let acquired = false;
    try {
      const lockRows = rows<{ acquired: boolean }>(await runner.query(
        "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired",
        [ADVISORY_LOCK_KEY],
      ));
      acquired = lockRows[0]?.acquired === true;
      if (!acquired) {
        return { state: "lock_unavailable", results: [], snapshot: await this.snapshot() };
      }
      const results = await this.dispatcher.dispatchBatch(this.batchSize);
      const snapshot = await this.snapshot();
      if (
        snapshot.actionableDeadLetter > 0
        && snapshot.actionableDeadLetter !== this.lastActionableDeadLetterCount
      ) {
        this.logger.warn(
          `DURABLE_OUTBOX_ACTIONABLE_DEAD_LETTER_PRESENT count=${snapshot.actionableDeadLetter}`,
        );
      }
      this.lastActionableDeadLetterCount = snapshot.actionableDeadLetter;
      return { state: "drained", results, snapshot };
    } finally {
      if (acquired) {
        await runner.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_KEY]);
      }
      await runner.release();
    }
  }

  async snapshot(): Promise<DurableOutboxDrainSnapshot> {
    const result = rows<{
      pending: string;
      failed: string;
      publishing: string;
      deadLetter: string;
      terminalDeadLetter: string;
      actionableDeadLetter: string;
    }>(await this.dataSource.query(
      `SELECT
         count(*) FILTER (WHERE status = 'pending')::text AS pending,
         count(*) FILTER (WHERE status = 'failed')::text AS failed,
         count(*) FILTER (WHERE status = 'publishing')::text AS publishing,
         count(*) FILTER (WHERE status = 'dead_letter')::text AS "deadLetter",
         count(*) FILTER (
           WHERE status = 'dead_letter'
             AND last_error IN (
               'INTENT_COMPLETED_BEFORE_OUTBOX_DISPATCH',
               'INTENT_FAILED_BEFORE_OUTBOX_DISPATCH',
               'INTENT_CANCELLED_BEFORE_OUTBOX_DISPATCH',
               'INTENT_NO_OP_BEFORE_OUTBOX_DISPATCH',
               'INTENT_REJECTED_BEFORE_OUTBOX_DISPATCH',
               'INTENT_CANCELLED_BEFORE_DISPATCH'
             )
         )::text AS "terminalDeadLetter",
         count(*) FILTER (
           WHERE status = 'dead_letter'
             AND (
               last_error IS NULL
               OR last_error NOT IN (
                 'INTENT_COMPLETED_BEFORE_OUTBOX_DISPATCH',
                 'INTENT_FAILED_BEFORE_OUTBOX_DISPATCH',
                 'INTENT_CANCELLED_BEFORE_OUTBOX_DISPATCH',
                 'INTENT_NO_OP_BEFORE_OUTBOX_DISPATCH',
                 'INTENT_REJECTED_BEFORE_OUTBOX_DISPATCH',
                 'INTENT_CANCELLED_BEFORE_DISPATCH'
               )
             )
         )::text AS "actionableDeadLetter"
       FROM orchestration_outbox`,
    ))[0];
    return Object.freeze({
      pending: Number(result?.pending || 0),
      failed: Number(result?.failed || 0),
      publishing: Number(result?.publishing || 0),
      deadLetter: Number(result?.deadLetter || 0),
      terminalDeadLetter: Number(result?.terminalDeadLetter || 0),
      actionableDeadLetter: Number(result?.actionableDeadLetter || 0),
    });
  }

  private schedule(delayMs: number) {
    if (this.stopping || !this.enabled()) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const work = this.runOnce()
        .then((run) => {
          const deliveryUnhealthy = run.results.some((result) =>
            result.status === "retryable"
            || result.status === "blocked"
            || result.status === "ownership_lost");
          if (deliveryUnhealthy) {
            this.lastFailedPassAt = Date.now();
            this.logger.warn("DURABLE_OUTBOX_DRAIN_PASS_FAILED");
            return;
          }
          this.lastSuccessfulPassAt = Date.now();
        })
        .catch(() => {
          this.lastFailedPassAt = Date.now();
          this.logger.warn("DURABLE_OUTBOX_DRAIN_PASS_FAILED");
        })
        .finally(() => {
          this.active = null;
          this.schedule(this.intervalMs);
        });
      this.active = work;
    }, delayMs);
    this.timer.unref();
  }

  private enabled() {
    return this.config.get<unknown>("OUTBOX_DRAIN_ENABLED") === "true";
  }
}

function rows<T>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? result as T[] : [];
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}
