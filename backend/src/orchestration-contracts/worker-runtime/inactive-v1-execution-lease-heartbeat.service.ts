import { Injectable } from "@nestjs/common";
import { InactiveV1PreExecutionOwnershipService } from "./inactive-v1-pre-execution-ownership.service";
import { canonicalExecutionLeaseHeartbeatInterval } from "./v1-execution-lease-heartbeat.pure";
import {
  V1ExecutionLeaseHeartbeatDisposition,
  V1ExecutionLeaseHeartbeatFailureCode,
  V1ExecutionLeaseHeartbeatSession,
} from "./v1-execution-lease-heartbeat.types";

type HeartbeatState = {
  disposition: V1ExecutionLeaseHeartbeatDisposition;
  failureCode: V1ExecutionLeaseHeartbeatFailureCode | null;
  stopping: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  renewal: Promise<void> | null;
  stopPromise: Promise<V1ExecutionLeaseHeartbeatDisposition> | null;
};

@Injectable()
export class InactiveV1ExecutionLeaseHeartbeatService {
  constructor(
    private readonly ownership: InactiveV1PreExecutionOwnershipService,
  ) {}

  start(input: {
    leaseId: string;
    workerId: string;
    fencingToken: string;
    leaseTtlMs: number;
    intervalMs?: number;
    abortSignal?: AbortSignal;
  }): V1ExecutionLeaseHeartbeatSession {
    const intervalMs = canonicalExecutionLeaseHeartbeatInterval(
      input.leaseTtlMs,
      input.intervalMs,
    );
    const controller = new AbortController();
    const state: HeartbeatState = {
      disposition: "active",
      failureCode: null,
      stopping: false,
      timer: null,
      renewal: null,
      stopPromise: null,
    };
    const loseTrust = (
      disposition: Exclude<
        V1ExecutionLeaseHeartbeatDisposition,
        "active" | "stopped"
      >,
      failureCode: V1ExecutionLeaseHeartbeatFailureCode,
    ) => {
      if (state.disposition !== "active") return;
      state.disposition = disposition;
      state.failureCode = failureCode;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      controller.abort();
    };
    const onCancellation = () => {
      loseTrust("cancelled", "EXECUTION_CANCELLED");
    };
    input.abortSignal?.addEventListener("abort", onCancellation, {
      once: true,
    });
    if (input.abortSignal?.aborted) onCancellation();

    const schedule = () => {
      if (state.stopping || state.disposition !== "active") return;
      state.timer = setTimeout(() => {
        state.timer = null;
        if (state.renewal) return;
        state.renewal = this.ownership.renew({
          leaseId: input.leaseId,
          workerId: input.workerId,
          fencingToken: input.fencingToken,
          leaseTtlMs: input.leaseTtlMs,
        }).then((renewed) => {
          if (!renewed) {
            loseTrust("ownership_lost", "EXECUTION_OWNERSHIP_LOST");
          }
        }).catch(() => {
          loseTrust("heartbeat_failed", "EXECUTION_HEARTBEAT_FAILED");
        }).finally(() => {
          state.renewal = null;
          schedule();
        });
      }, intervalMs);
      state.timer.unref?.();
    };
    schedule();

    const stop = () => {
      if (state.stopPromise) return state.stopPromise;
      state.stopping = true;
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      input.abortSignal?.removeEventListener("abort", onCancellation);
      state.stopPromise = (async () => {
        if (state.renewal) await state.renewal;
        if (state.disposition === "active") state.disposition = "stopped";
        return state.disposition;
      })();
      return state.stopPromise;
    };

    return Object.freeze({
      signal: controller.signal,
      isTrusted: () =>
        !state.stopping && state.disposition === "active",
      disposition: () => state.disposition,
      lastFailureCode: () => state.failureCode,
      stop,
    });
  }
}
