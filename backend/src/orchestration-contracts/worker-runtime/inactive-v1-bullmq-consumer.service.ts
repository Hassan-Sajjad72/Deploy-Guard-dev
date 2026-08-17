import { Injectable, Optional } from "@nestjs/common";
import {
  DelayedError,
  Job,
  UnrecoverableError,
  Worker,
} from "bullmq";
import {
  DeployGuardWorkerEnvelopeV1,
} from "../contracts/worker-envelope.types";
import {
  assertFrozenBullMqAdapterCompatibility,
} from "../outbox/frozen-bullmq-job.adapter";
import { workerEnvelopeJobId } from "../contracts/worker-envelope.validator";
import { InactiveV1ShadowInsertionAdapter } from "../release-lane/inactive-v1-shadow-insertion.adapter";
import {
  CrossLaneOwnershipClaim,
  CrossLaneOwnershipEnforcementError,
  CrossLaneOwnershipEnforcementService,
} from "../release-lane/cross-lane-ownership-enforcement.service";
import {
  InactiveV1FencedInvocationService,
} from "./inactive-v1-fenced-invocation.service";
import { V1FencedPlaceholderHandlerContext } from "./v1-fenced-invocation.types";
import {
  InactiveV1WorkerRuntimeError,
  V1WorkerHeartbeatSession,
} from "./inactive-v1-worker-runtime.types";
import {
  canonicalizeV1ConsumerStart,
  CanonicalV1ConsumerStart,
  assertV1ConsumerJobScope,
  validateFrozenV1ConsumerJob,
  v1ConsumerResultNeedsRetry,
} from "./v1-bullmq-consumer.pure";
import {
  InactiveV1BullMqConsumerError,
  InactiveV1BullMqConsumerFailureCode,
  InactiveV1BullMqConsumerSession,
  InactiveV1BullMqConsumerStartInput,
  V1BullMqConsumerOperationalStatus,
} from "./v1-bullmq-consumer.types";
import {
  V1FencedInvocationError,
  V1FencedInvocationResult,
} from "./v1-fenced-invocation.types";
import {
  PreExecutionOwnershipError,
} from "./v1-pre-execution-ownership.types";
import { V1WorkerCapabilityService } from "./v1-worker-capability.service";

type ConsumerJob = Job<
  DeployGuardWorkerEnvelopeV1,
  V1FencedInvocationResult,
  string
>;

type ActiveConsumer = {
  config: CanonicalV1ConsumerStart;
  workers: Worker<
    DeployGuardWorkerEnvelopeV1,
    V1FencedInvocationResult,
    string
  >[];
  heartbeat: V1WorkerHeartbeatSession;
  stopping: boolean;
  stopPromise: Promise<void> | null;
  loopFailure: InactiveV1BullMqConsumerFailureCode | null;
  runPromises: Promise<void>[];
  phase: V1BullMqConsumerOperationalStatus["state"];
  activeMessageType: V1BullMqConsumerOperationalStatus["activeMessageType"];
};

@Injectable()
export class InactiveV1BullMqConsumerService {
  private active: ActiveConsumer | null = null;
  private lastOutcome: V1BullMqConsumerOperationalStatus["lastOutcome"] = null;

  constructor(
    private readonly invocation: InactiveV1FencedInvocationService,
    private readonly capabilities: V1WorkerCapabilityService,
    @Optional()
    private readonly shadowInsertion?: InactiveV1ShadowInsertionAdapter,
    @Optional()
    private readonly crossLane?: CrossLaneOwnershipEnforcementService,
    /**
     * Exact production-canary release preparation.  It is supplied only by
     * the gated composition and always runs after ownership has been claimed.
     */
    @Optional()
    private readonly beforeReleaseHandler?: (
      context: V1FencedPlaceholderHandlerContext<"intent.release.execute">,
    ) => Promise<void>,
  ) {}

  isStarted() {
    return this.active !== null && !this.active.stopping;
  }

  getOperationalStatus(): V1BullMqConsumerOperationalStatus {
    const state = this.active;
    return Object.freeze({
      state: state
        ? state.stopping
          ? "stopping"
          : state.phase === "idle" && this.lastOutcome
            ? this.lastOutcome.state
            : state.phase
        : "stopped",
      ready: Boolean(
        state
        && !state.stopping
        && state.loopFailure === null
        && state.heartbeat.isActive(),
      ),
      activeMessageType: state?.activeMessageType ?? null,
      lastOutcome: this.lastOutcome,
    });
  }

  async start(
    input: InactiveV1BullMqConsumerStartInput,
  ): Promise<InactiveV1BullMqConsumerSession> {
    if (this.active) {
      throw new InactiveV1BullMqConsumerError("CONSUMER_ALREADY_STARTED");
    }
    const config = canonicalizeV1ConsumerStart(input);
    assertFrozenBullMqAdapterCompatibility();
    const heartbeat = await this.capabilities.startHeartbeatSession(
      config.capability,
      config.heartbeatIntervalMs,
    );
    const state: ActiveConsumer = {
      config,
      workers: [],
      heartbeat,
      stopping: false,
      stopPromise: null,
      loopFailure: null,
      runPromises: [],
      phase: "idle",
      activeMessageType: null,
    };
    try {
      state.workers = config.queueNames.map((queueName) =>
        this.createWorker(queueName, state)
      );
      await Promise.all(state.workers.map((worker) =>
        worker.waitUntilReady()
      ));
      this.active = state;
      state.runPromises = state.workers.map((worker) =>
        worker.run().catch(() => {
          if (!state.stopping) state.loopFailure = "CONSUMER_LOOP_FAILED";
        })
      );
      return Object.freeze({
        workerId: config.capability.workerId,
        queueNames: Object.freeze([...config.queueNames]),
        isActive: () =>
          this.active === state
          && !state.stopping
          && state.loopFailure === null
          && state.heartbeat.isActive(),
        lastFailureCode: () => this.failureCode(state),
        stop: () => this.stopState(state),
      });
    } catch {
      await Promise.allSettled(
        state.workers.map((worker) => worker.close(true)),
      );
      await heartbeat.stop();
      if (this.active === state) this.active = null;
      throw new InactiveV1BullMqConsumerError("CONSUMER_START_FAILED");
    }
  }

  async stop() {
    if (this.active) await this.stopState(this.active);
  }

  private createWorker(queueName: string, state: ActiveConsumer) {
    const worker = new Worker<
      DeployGuardWorkerEnvelopeV1,
      V1FencedInvocationResult,
      string
    >(
      queueName,
      (job, token) => this.processJob(job, token, state),
      {
        connection: state.config.connection,
        prefix: state.config.prefix,
        name: state.config.capability.workerId,
        autorun: false,
        concurrency: state.config.concurrency,
      },
    );
    worker.on("error", () => {
      if (!state.stopping) state.loopFailure = "CONSUMER_REDIS_ERROR";
    });
    return worker;
  }

  private async processJob(
    job: ConsumerJob,
    token: string | undefined,
    state: ActiveConsumer,
  ): Promise<V1FencedInvocationResult> {
    try {
      const envelope = validateFrozenV1ConsumerJob({
        queueName: job.queueName,
        jobName: job.name,
        jobId: job.id,
        data: job.data,
        capability: state.config.capability,
      });
      assertV1ConsumerJobScope(state.config.scope, envelope);
      state.phase = "processing";
      state.activeMessageType = envelope.protocol.messageType;
      this.shadowInsertion?.observeConsumerClaim({
        projectId: envelope.identity.projectId,
        environmentName: envelope.identity.environmentName,
        intentId: envelope.identity.intentId,
        deterministicJobId: workerEnvelopeJobId(envelope),
        lane: envelope.routing.lane,
      });
      const crossLaneClaim = await this.acquireCrossLane(
        envelope,
        state.config.capability.workerId,
        state.config.leaseTtlMs,
      );
      const crossLaneHeartbeat = this.crossLane?.startHeartbeat(
        crossLaneClaim,
        {
          leaseTtlMs: state.config.leaseTtlMs,
          intervalMs: state.config.leaseHeartbeatIntervalMs,
        },
      );
      let result: V1FencedInvocationResult;
      try {
        result = await this.invocation.invoke({
          workerId: state.config.capability.workerId,
          queueName: job.queueName,
          envelope,
          leaseTtlMs: state.config.leaseTtlMs,
          leaseHeartbeatIntervalMs:
            state.config.leaseHeartbeatIntervalMs,
          crossLaneClaim,
          isCrossLaneTrusted: () => crossLaneHeartbeat?.isTrusted() ?? true,
          beforeHandler: envelope.protocol.messageType === "intent.release.execute"
            && this.beforeReleaseHandler
            ? (context) => this.beforeReleaseHandler!(
              context as V1FencedPlaceholderHandlerContext<"intent.release.execute">,
            )
            : undefined,
        });
      } catch (error) {
        await crossLaneHeartbeat?.stop();
        if (
          error instanceof PreExecutionOwnershipError
          || error instanceof CrossLaneOwnershipEnforcementError
        ) {
          await this.crossLane?.release(crossLaneClaim);
        }
        throw error;
      }
      const crossLaneTrusted = await crossLaneHeartbeat?.stop() ?? true;
      if (
        crossLaneTrusted
        && this.shouldReleaseCrossLane(result)
      ) {
        await this.crossLane?.releaseV1(crossLaneClaim, {
          intentId: envelope.identity.intentId,
          operationLeaseId: "leaseId" in result ? result.leaseId : null,
        });
      }
      if (v1ConsumerResultNeedsRetry(result)) {
        this.recordOutcome("reconciling", "CONSUMER_RETRY_SCHEDULED");
        if (!token) {
          throw new InactiveV1BullMqConsumerError(
            "CONSUMER_RETRY_SCHEDULING_FAILED",
          );
        }
        await job.moveToDelayed(Date.now() + state.config.retryDelayMs, token);
        throw new DelayedError();
      }
      if (result.disposition === "failed") {
        this.recordOutcome("terminal", result.safeFailureCode);
        throw new UnrecoverableError(result.safeFailureCode);
      }
      this.recordOutcome(
        "terminal",
        result.disposition === "completed"
          ? "CONSUMER_JOB_COMPLETED"
          : result.disposition === "plan_completed"
            ? "INFRASTRUCTURE_PLAN_COMPLETED"
            : "CONSUMER_JOB_IDEMPOTENT",
      );
      return result;
    } catch (error) {
      if (error instanceof DelayedError || error instanceof UnrecoverableError) {
        throw error;
      }
      const safeCode = this.sanitizedFailureCode(error);
      this.recordOutcome("terminal", safeCode);
      throw new UnrecoverableError(safeCode);
    } finally {
      state.activeMessageType = null;
      if (!state.stopping) state.phase = "idle";
    }
  }

  private recordOutcome(
    state: "reconciling" | "terminal",
    safeCode: string,
  ) {
    this.lastOutcome = Object.freeze({
      state,
      safeCode: /^[A-Z0-9_]{3,128}$/.test(safeCode)
        ? safeCode
        : "CONSUMER_OUTCOME_REDACTED",
      observedAt: new Date().toISOString(),
    });
  }

  private sanitizedFailureCode(error: unknown) {
    if (
      error instanceof InactiveV1BullMqConsumerError
      || error instanceof InactiveV1WorkerRuntimeError
      || error instanceof PreExecutionOwnershipError
      || error instanceof V1FencedInvocationError
      || error instanceof CrossLaneOwnershipEnforcementError
    ) {
      return error.code;
    }
    return "CONSUMER_JOB_REJECTED";
  }

  private async acquireCrossLane(
    envelope: DeployGuardWorkerEnvelopeV1,
    workerId: string,
    leaseTtlMs: number,
  ): Promise<CrossLaneOwnershipClaim> {
    if (!this.crossLane) return { enabled: false };
    if (envelope.routing.lane === "deletion") return { enabled: false };
    return this.crossLane.acquireV1({
      projectId: envelope.identity.projectId,
      environmentName: envelope.identity.environmentName,
      intentId: envelope.identity.intentId,
      actorId: workerId,
      requestFingerprint: envelope.idempotency.payloadSha256,
      leaseTtlMs,
    });
  }

  private shouldReleaseCrossLane(result: V1FencedInvocationResult): boolean {
    if (
      result.disposition === "completed"
      || result.disposition === "failed"
      || result.disposition === "released"
    ) {
      return true;
    }
    return result.disposition === "idempotent_no_op"
      && (result.reason === "intent_terminal"
        || result.reason === "intent_superseded");
  }

  private failureCode(
    state: ActiveConsumer,
  ): InactiveV1BullMqConsumerFailureCode | null {
    if (state.loopFailure) return state.loopFailure;
    const heartbeatFailure = state.heartbeat.lastFailureCode();
    if (heartbeatFailure === "CAPABILITY_EXPIRED") {
      return "CONSUMER_CAPABILITY_EXPIRED";
    }
    if (heartbeatFailure === "HEARTBEAT_FAILED") {
      return "CONSUMER_HEARTBEAT_FAILED";
    }
    return null;
  }

  private async stopState(state: ActiveConsumer) {
    if (this.active !== state) return;
    if (state.stopPromise) return state.stopPromise;
    state.stopping = true;
    state.phase = "stopping";
    state.stopPromise = this.closeState(state);
    return state.stopPromise;
  }

  private async closeState(state: ActiveConsumer) {
    const closed = await Promise.allSettled(
      state.workers.map((worker) => worker.close()),
    );
    await Promise.allSettled(state.runPromises);
    await state.heartbeat.stop();
    this.active = null;
    if (closed.some((result) => result.status === "rejected")) {
      throw new InactiveV1BullMqConsumerError("CONSUMER_STOP_FAILED");
    }
  }
}
