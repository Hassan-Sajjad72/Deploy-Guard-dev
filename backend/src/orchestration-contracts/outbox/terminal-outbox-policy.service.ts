import { Injectable } from "@nestjs/common";
import { EntityManager } from "typeorm";

export const TERMINAL_DEPLOYMENT_INTENT_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "no_op",
  "rejected",
] as const;

export type TerminalDeploymentIntentStatus =
  typeof TERMINAL_DEPLOYMENT_INTENT_STATUSES[number];

export type TerminalOutboxSafeReason =
  | "INTENT_COMPLETED_BEFORE_OUTBOX_DISPATCH"
  | "INTENT_FAILED_BEFORE_OUTBOX_DISPATCH"
  | "INTENT_CANCELLED_BEFORE_OUTBOX_DISPATCH"
  | "INTENT_NO_OP_BEFORE_OUTBOX_DISPATCH"
  | "INTENT_REJECTED_BEFORE_OUTBOX_DISPATCH"
  | "INTENT_CANCELLED_BEFORE_DISPATCH";

const TERMINAL_STATUSES = new Set<string>(TERMINAL_DEPLOYMENT_INTENT_STATUSES);
const SAFE_REASON = /^[A-Z0-9_]{3,128}$/;

export function isTerminalDeploymentIntentStatus(
  status: unknown,
): status is TerminalDeploymentIntentStatus {
  return typeof status === "string" && TERMINAL_STATUSES.has(status);
}

export function terminalOutboxSafeReason(
  status: TerminalDeploymentIntentStatus,
): TerminalOutboxSafeReason {
  switch (status) {
    case "completed": return "INTENT_COMPLETED_BEFORE_OUTBOX_DISPATCH";
    case "failed": return "INTENT_FAILED_BEFORE_OUTBOX_DISPATCH";
    case "cancelled": return "INTENT_CANCELLED_BEFORE_OUTBOX_DISPATCH";
    case "no_op": return "INTENT_NO_OP_BEFORE_OUTBOX_DISPATCH";
    case "rejected": return "INTENT_REJECTED_BEFORE_OUTBOX_DISPATCH";
  }
}

export type TerminalOutboxResult = Readonly<{
  reason: TerminalOutboxSafeReason;
  transitionedCount: number;
}>;

export type DispatchIntentState =
  | Readonly<{ state: "dispatchable"; intentStatus: "planned" }>
  | Readonly<{
    state: "terminal";
    intentStatus: TerminalDeploymentIntentStatus;
    reason: TerminalOutboxSafeReason;
    transitionedCount: number;
  }>
  | Readonly<{ state: "not_dispatchable"; intentStatus: string }>;

/**
 * One transaction-local policy for a terminal intent's not-yet-published
 * outbox rows. `dead_letter` is the existing truthful terminal state: it
 * preserves the row and safe reason, but excludes it from future delivery.
 */
@Injectable()
export class TerminalOutboxPolicyService {
  async terminalizeUndispatched(
    manager: EntityManager,
    input: {
      intentId: string;
      intentStatus: TerminalDeploymentIntentStatus;
      reason?: TerminalOutboxSafeReason;
    },
  ): Promise<TerminalOutboxResult> {
    const reason = input.reason ?? terminalOutboxSafeReason(input.intentStatus);
    if (!SAFE_REASON.test(reason)) {
      throw new Error("TERMINAL_OUTBOX_REASON_INVALID");
    }
    const rows = this.rows<{ id: string }>(await manager.query(
      `UPDATE orchestration_outbox
       SET status = 'dead_letter', last_error = $2,
           claimed_by = NULL, claim_expires_at = NULL,
           updated_at = clock_timestamp()
       WHERE intent_id = $1
         AND status IN ('pending', 'failed', 'publishing')
         AND published_job_id IS NULL
         AND published_at IS NULL
       RETURNING id`,
      [input.intentId, reason],
    ));
    return Object.freeze({ reason, transitionedCount: rows.length });
  }

  /**
   * Locks the exact intent before a dispatcher publishes anything. A terminal
   * intent is terminalized in this same transaction and is never dispatchable.
   */
  async dispatchState(
    manager: EntityManager,
    intentId: string,
  ): Promise<DispatchIntentState> {
    const rows = this.rows<{ status: string }>(await manager.query(
      `SELECT status FROM deployment_intents WHERE id = $1 FOR UPDATE`,
      [intentId],
    ));
    const intent = rows[0];
    if (!intent) throw new Error("OUTBOX_INTENT_MISSING");
    if (isTerminalDeploymentIntentStatus(intent.status)) {
      const terminalized = await this.terminalizeUndispatched(manager, {
        intentId,
        intentStatus: intent.status,
      });
      return Object.freeze({
        state: "terminal",
        intentStatus: intent.status,
        ...terminalized,
      });
    }
    if (intent.status === "planned") {
      return Object.freeze({ state: "dispatchable", intentStatus: "planned" });
    }
    return Object.freeze({ state: "not_dispatchable", intentStatus: intent.status });
  }

  /**
   * Couples the durable terminal intent transition and pending-outbox closure.
   * A failed conditional transition changes neither record.
   */
  async transitionIntentToTerminal(
    manager: EntityManager,
    input: {
      intentId: string;
      expectedStatus: "running" | "planned";
      status: Extract<TerminalDeploymentIntentStatus, "completed" | "failed" | "cancelled">;
      failureCode: string | null;
      failureMessage: string | null;
      reason?: TerminalOutboxSafeReason;
    },
  ): Promise<boolean> {
    const rows = this.rows<{ id: string }>(await manager.query(
      `UPDATE deployment_intents
       SET status = $2::varchar,
           completed_at = clock_timestamp(),
           failure_code = $3,
           failure_message = $4,
           updated_at = clock_timestamp()
       WHERE id = $1 AND status = $5
       RETURNING id`,
      [
        input.intentId,
        input.status,
        input.failureCode,
        input.failureMessage,
        input.expectedStatus,
      ],
    ));
    if (rows.length !== 1) return false;
    await this.terminalizeUndispatched(manager, {
      intentId: input.intentId,
      intentStatus: input.status,
      reason: input.reason,
    });
    return true;
  }

  private rows<T>(result: unknown): T[] {
    if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0])) {
      return result[0] as T[];
    }
    return Array.isArray(result) ? result as T[] : [];
  }
}
