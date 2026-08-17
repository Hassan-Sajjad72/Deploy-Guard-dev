import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createRedisConnection } from "../../projects/pipeline/redis.config";
import {
  InactiveV1InfrastructurePlanConsumerCompositionService,
} from "./inactive-v1-infrastructure-plan-consumer-composition.service";
import {
  InactiveV1BullMqConsumerSession,
  V1BullMqConsumerOperationalStatus,
} from "./v1-bullmq-consumer.types";
import { NormalV1InfrastructurePlanConsumerHealthFile } from "./normal-v1-infrastructure-plan-consumer-health";

export type NormalV1InfrastructurePlanConsumerRuntimeStatus = Readonly<{
  state: "disabled" | "blocked" | "starting" | V1BullMqConsumerOperationalStatus["state"];
  ready: boolean;
  safeCode: string;
  activeMessageType: "intent.infrastructure.plan" | null;
  lastOutcome: V1BullMqConsumerOperationalStatus["lastOutcome"];
}>;

/** Default-off process lifecycle for exactly one infrastructure planning scope. */
@Injectable()
export class NormalV1InfrastructurePlanConsumerRuntimeService {
  private readonly logger = new Logger(
    NormalV1InfrastructurePlanConsumerRuntimeService.name,
  );
  private session: InactiveV1BullMqConsumerSession | null = null;
  private lifecycle: "disabled" | "blocked" | "starting" | "stopping" | null = null;
  private safeCode = "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_NOT_STARTED";
  private interval: NodeJS.Timeout | null = null;
  private readonly health = new NormalV1InfrastructurePlanConsumerHealthFile();

  constructor(
    private readonly config: ConfigService,
    private readonly compositionService:
      InactiveV1InfrastructurePlanConsumerCompositionService,
  ) {}

  async start(): Promise<NormalV1InfrastructurePlanConsumerRuntimeStatus> {
    if (this.session) return this.getStatus();
    const composition = this.compositionService.getInactiveComposition();
    if (!composition) {
      this.lifecycle = this.config.get<unknown>(
        "TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_CONSUMER_ENABLED",
      ) === "true" ? "blocked" : "disabled";
      this.safeCode = this.lifecycle === "disabled"
        ? "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_DISABLED"
        : "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_CONFIGURATION_INVALID";
      this.observe();
      return this.getStatus();
    }
    this.lifecycle = "starting";
    this.safeCode = "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_STARTING";
    this.observe();
    this.session = await composition.consumer.start({
      capability: {
        workerId: composition.configuration.workerId,
        role: "infrastructure",
        supportedMessageTypes: ["intent.infrastructure.plan"],
        serviceVersion: "normal-v1-infrastructure-plan-consumer",
        gitSha: this.gitSha(),
        heartbeatTtlMs: 60_000,
        metadata: { runtime: "normal-v1-infrastructure-plan-consumer" },
      },
      connection: createRedisConnection(this.config),
      prefix: this.config.get<string>("OUTBOX_BULLMQ_PREFIX", "bull"),
      scope: {
        ...(composition.configuration.operatingMode === "shared"
          ? { mode: "shared" as const }
          : {}),
        projectIds: composition.configuration.projectIds,
        environmentNames: [composition.configuration.environmentName],
      },
      exactMessageTypes: ["intent.infrastructure.plan"],
      concurrency: 1,
      leaseTtlMs: 60_000,
      leaseHeartbeatIntervalMs: 15_000,
      retryDelayMs: 1_000,
      heartbeatIntervalMs: 15_000,
    });
    this.lifecycle = null;
    this.safeCode = "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_READY";
    this.startObservation();
    this.observe();
    return this.getStatus();
  }

  getStatus(): NormalV1InfrastructurePlanConsumerRuntimeStatus {
    const consumer = this.compositionService.getInactiveComposition()
      ?.consumer.getOperationalStatus();
    if (this.lifecycle) return Object.freeze({
      state: this.lifecycle,
      ready: false,
      safeCode: this.safeCode,
      activeMessageType: null,
      lastOutcome: consumer?.lastOutcome ?? null,
    });
    if (!this.session || !consumer) return Object.freeze({
      state: "stopped",
      ready: false,
      safeCode: "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_STOPPED",
      activeMessageType: null,
      lastOutcome: consumer?.lastOutcome ?? null,
    });
    return Object.freeze({
      state: consumer.state,
      ready: consumer.ready && this.session.isActive(),
      safeCode: consumer.lastOutcome?.safeCode
        ?? (consumer.ready
          ? "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_READY"
          : this.session.lastFailureCode()
            ?? "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_NOT_READY"),
      activeMessageType: consumer.activeMessageType === "intent.infrastructure.plan"
        ? consumer.activeMessageType
        : null,
      lastOutcome: consumer.lastOutcome,
    });
  }

  async stop(): Promise<NormalV1InfrastructurePlanConsumerRuntimeStatus> {
    this.stopObservation();
    if (!this.session) {
      this.lifecycle = null;
      this.safeCode = "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_STOPPED";
      this.observe();
      return this.getStatus();
    }
    this.lifecycle = "stopping";
    this.safeCode = "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_STOPPING";
    this.observe();
    await this.session.stop();
    this.session = null;
    this.lifecycle = null;
    this.safeCode = "NORMAL_V1_INFRASTRUCTURE_PLAN_CONSUMER_STOPPED";
    this.observe();
    return this.getStatus();
  }

  observe() {
    // Logger output is the existing sanitized operational observation surface.
    const status = this.getStatus();
    this.health.write(status);
    this.logger.log(JSON.stringify(status));
    return status;
  }

  private startObservation() {
    this.stopObservation();
    this.interval = setInterval(() => this.observe(), this.observationInterval());
    this.interval.unref();
  }

  private stopObservation() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  private observationInterval() {
    const value = Number(this.config.get<string>(
      "TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_CONSUMER_STATUS_INTERVAL_MS",
      "30000",
    ));
    return Number.isInteger(value) && value >= 5_000 && value <= 300_000
      ? value
      : 30_000;
  }

  private gitSha() {
    const value = this.config.get<unknown>("DEPLOYGUARD_GIT_SHA");
    return typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value)
      ? value.toLowerCase()
      : "local";
  }
}
