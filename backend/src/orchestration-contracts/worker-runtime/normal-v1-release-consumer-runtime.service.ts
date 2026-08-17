import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createRedisConnection } from "../../projects/pipeline/redis.config";
import {
  InactiveV1ReleaseLaneCompositionService,
} from "../release-lane/inactive-v1-release-lane-composition";
import {
  InactiveV1BullMqConsumerSession,
  V1BullMqConsumerOperationalStatus,
} from "./v1-bullmq-consumer.types";
import {
  NormalV1ReleaseConsumerHealthFile,
} from "./normal-v1-release-consumer-health";
import {
  NormalReleaseLaneAutoConvergenceScheduler,
} from "./normal-release-lane-auto-convergence.scheduler";

export type NormalV1ReleaseConsumerRuntimeStatus = Readonly<{
  state:
    | "disabled"
    | "blocked"
    | "starting"
    | "reconciling"
    | V1BullMqConsumerOperationalStatus["state"];
  ready: boolean;
  safeCode: string;
  activeMessageType: "intent.release.execute" | null;
  lastOutcome: V1BullMqConsumerOperationalStatus["lastOutcome"];
}>;

/**
 * Explicit process lifecycle for the production-compatible release consumer.
 * It never dispatches work and is intentionally absent from HTTP lifecycle
 * hooks. Starting it requires the complete existing production-canary gate
 * plus one additional exact operational consumer flag.
 */
@Injectable()
export class NormalV1ReleaseConsumerRuntimeService {
  private readonly logger =
    new Logger(NormalV1ReleaseConsumerRuntimeService.name);
  private session: InactiveV1BullMqConsumerSession | null = null;
  private lifecycleState:
    | "disabled"
    | "blocked"
    | "starting"
    | "stopping"
    | null = null;
  private safeCode = "NORMAL_V1_RELEASE_CONSUMER_NOT_STARTED";
  private observationTimer: NodeJS.Timeout | null = null;
  private lastLoggedStatus = "";
  private readonly health = new NormalV1ReleaseConsumerHealthFile();

  constructor(
    private readonly config: ConfigService,
    private readonly compositionService:
      InactiveV1ReleaseLaneCompositionService,
    private readonly autoConvergence:
      NormalReleaseLaneAutoConvergenceScheduler,
  ) {}

  async start(): Promise<NormalV1ReleaseConsumerRuntimeStatus> {
    if (this.session) return this.getStatus();
    const gate = this.gate();
    if (gate.state !== "ready") {
      this.lifecycleState = gate.state;
      this.safeCode = gate.safeCode;
      this.logStatus(true);
      return this.getStatus();
    }

    this.lifecycleState = "starting";
    this.safeCode = "NORMAL_V1_RELEASE_CONSUMER_STARTING";
    this.logStatus(true);
    const composition = gate.composition;
    this.session = await composition.consumer.start({
      capability: {
        workerId: composition.configuration.workerId,
        role: "release",
        supportedMessageTypes: ["intent.release.execute"],
        serviceVersion: "normal-v1-release-consumer",
        gitSha: this.gitSha(),
        heartbeatTtlMs: 60_000,
        metadata: { runtime: "normal-v1-release-consumer" },
      },
      connection: createRedisConnection(this.config),
      prefix: this.config.get<string>("OUTBOX_BULLMQ_PREFIX", "bull"),
      scope: {
        ...(composition.configuration.operatingMode === "shared"
          ? { mode: "shared" as const }
          : {}),
        projectIds: composition.configuration.projectAllowlist,
        environmentNames: composition.configuration.environmentAllowlist,
      },
      concurrency: 1,
      leaseTtlMs: 60_000,
      leaseHeartbeatIntervalMs: 15_000,
      retryDelayMs: 1_000,
      heartbeatIntervalMs: 15_000,
    });
    this.lifecycleState = null;
    this.safeCode = "NORMAL_V1_RELEASE_CONSUMER_READY";
    this.autoConvergence.start(
      composition.configuration.operatingMode !== "shared"
        ? composition.configuration.projectAllowlist[0]
        : null,
    );
    this.startObservation();
    this.logStatus(true);
    return this.getStatus();
  }

  getStatus(): NormalV1ReleaseConsumerRuntimeStatus {
    const composition =
      this.compositionService.getInactiveComposition();
    const consumer = composition?.consumer.getOperationalStatus();
    const convergence = this.autoConvergence.getStatus();
    if (this.lifecycleState) {
      return Object.freeze({
        state: this.lifecycleState,
        ready: false,
        safeCode: this.safeCode,
        activeMessageType: null,
        lastOutcome: consumer?.lastOutcome ?? null,
      });
    }
    if (!this.session || !consumer) {
      return Object.freeze({
        state: "stopped",
        ready: false,
        safeCode: "NORMAL_V1_RELEASE_CONSUMER_STOPPED",
        activeMessageType: null,
        lastOutcome: consumer?.lastOutcome ?? null,
      });
    }
    if (convergence.state === "reconciling") {
      return Object.freeze({
        state: "reconciling",
        ready: consumer.ready && this.session.isActive(),
        safeCode: convergence.safeCode,
        activeMessageType: null,
        lastOutcome: consumer.lastOutcome,
      });
    }
    if (convergence.state === "terminal") {
      return Object.freeze({
        state: "terminal",
        ready: consumer.ready && this.session.isActive(),
        safeCode: convergence.safeCode,
        activeMessageType: null,
        lastOutcome: consumer.lastOutcome,
      });
    }
    if (
      (consumer.state === "idle" || consumer.state === "terminal")
      && consumer.lastOutcome?.state === "terminal"
    ) {
      // A failed ambiguous rollout is not a terminal operational condition
      // while the exact, default-off convergence scheduler is armed. The next
      // bounded read-only observation may resume the same frozen job; report
      // that truthful pending state instead of asking an operator to infer it
      // from a terminal worker result.
      if (
        consumer.lastOutcome.safeCode === "RELEASE_EVIDENCE_AMBIGUOUS"
        && convergence.state === "idle"
        && this.convergenceIsArmed()
      ) {
        return Object.freeze({
          state: "reconciling",
          ready: consumer.ready && this.session.isActive(),
          safeCode: "NORMAL_RELEASE_CONVERGENCE_RECONCILING",
          activeMessageType: null,
          lastOutcome: consumer.lastOutcome,
        });
      }
      return Object.freeze({
        state: "terminal",
        ready: consumer.ready && this.session.isActive(),
        safeCode: consumer.lastOutcome.safeCode,
        activeMessageType: null,
        lastOutcome: consumer.lastOutcome,
      });
    }
    return Object.freeze({
      state: consumer.state,
      ready: consumer.ready && this.session.isActive(),
      safeCode: consumer.lastOutcome?.safeCode
        ?? (consumer.ready
          ? "NORMAL_V1_RELEASE_CONSUMER_READY"
          : this.session.lastFailureCode()
            ?? "NORMAL_V1_RELEASE_CONSUMER_NOT_READY"),
      activeMessageType: consumer.activeMessageType === "intent.release.execute"
        ? consumer.activeMessageType
        : null,
      lastOutcome: consumer.lastOutcome,
    });
  }

  async stop(): Promise<NormalV1ReleaseConsumerRuntimeStatus> {
    this.stopObservation();
    await this.autoConvergence.stop();
    const session = this.session;
    if (!session) {
      this.lifecycleState = null;
      this.safeCode = "NORMAL_V1_RELEASE_CONSUMER_STOPPED";
      this.logStatus(true);
      return this.getStatus();
    }
    this.lifecycleState = "stopping";
    this.safeCode = "NORMAL_V1_RELEASE_CONSUMER_STOPPING";
    this.logStatus(true);
    await session.stop();
    this.session = null;
    this.lifecycleState = null;
    this.safeCode = "NORMAL_V1_RELEASE_CONSUMER_STOPPED";
    this.logStatus(true);
    return this.getStatus();
  }

  observe() {
    this.logStatus(true);
    return this.getStatus();
  }

  private gate():
    | { state: "disabled"; safeCode: string }
    | { state: "blocked"; safeCode: string }
    | {
      state: "ready";
      composition: NonNullable<
        ReturnType<
          InactiveV1ReleaseLaneCompositionService["getInactiveComposition"]
        >
      >;
    } {
    if (
      this.config.get<unknown>(
        "TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED",
      ) !== "true"
    ) {
      return {
        state: "disabled",
        safeCode: "NORMAL_V1_RELEASE_CONSUMER_DISABLED",
      };
    }
    if (
      this.config.get<unknown>(
        "TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED",
      ) !== "true"
      || this.config.get<unknown>(
        "TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED",
      ) !== "true"
    ) {
      return {
        state: "blocked",
        safeCode: "NORMAL_V1_RELEASE_CONSUMER_CONFIGURATION_INVALID",
      };
    }
    const compositionStatus = this.compositionService.getStatus();
    const composition =
      this.compositionService.getInactiveComposition();
    if (
      compositionStatus.state !== "ready"
      || !composition
      || !composition.laterReleaseImageClient
      || composition.configuration.environmentAllowlist.length !== 1
      || composition.configuration.environmentAllowlist[0] !== "dev"
      || (composition.configuration.operatingMode !== "shared"
        && composition.configuration.projectAllowlist.length !== 1)
      || (composition.configuration.operatingMode === "shared"
        && composition.configuration.projectAllowlist.length !== 0)
      || !this.compositionModeAllowed(compositionStatus.mode)
    ) {
      return {
        state: "blocked",
        safeCode: "NORMAL_V1_RELEASE_CONSUMER_CONFIGURATION_INVALID",
      };
    }
    return { state: "ready", composition };
  }

  private compositionModeAllowed(
    mode: ReturnType<
      InactiveV1ReleaseLaneCompositionService["getStatus"]
    >["mode"],
  ) {
    if (mode === "production_canary" || mode === "production_shared") return true;
    return mode === "fixture"
      && this.config.get<unknown>("NODE_ENV") === "test"
      && this.config.get<unknown>(
        "TWO_LANE_LOCAL_RELEASE_FIXTURE_EXECUTION_ENABLED",
      ) === "true";
  }

  private startObservation() {
    this.stopObservation();
    const raw = Number(
      this.config.get<string>(
        "TWO_LANE_NORMAL_RELEASE_CONSUMER_STATUS_INTERVAL_MS",
        "30000",
      ),
    );
    const interval = Number.isInteger(raw) && raw >= 5_000 && raw <= 300_000
      ? raw
      : 30_000;
    this.observationTimer = setInterval(() => this.logStatus(), interval);
    this.observationTimer.unref();
  }

  private stopObservation() {
    if (this.observationTimer) clearInterval(this.observationTimer);
    this.observationTimer = null;
  }

  private logStatus(force = false) {
    const status = this.getStatus();
    this.health.write(status);
    const serialized = JSON.stringify(status);
    if (force || serialized !== this.lastLoggedStatus) {
      this.logger.log(serialized);
      this.lastLoggedStatus = serialized;
    }
  }

  private gitSha() {
    const value = this.config.get<unknown>("DEPLOYGUARD_GIT_SHA");
    return typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value)
      ? value.toLowerCase()
      : "local";
  }

  private convergenceIsArmed() {
    return this.config.get<unknown>(
      "TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED",
    ) === "true" && this.config.get<unknown>(
      "TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED",
    ) === "true";
  }
}
