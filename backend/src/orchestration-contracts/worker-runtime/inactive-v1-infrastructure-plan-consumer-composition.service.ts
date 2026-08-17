import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import {
  V1InfrastructureManifestPlanService,
} from "../infrastructure/v1-infrastructure-manifest-plan.service";
import {
  InfrastructurePlanCompletionContinuationService,
} from "../infrastructure/infrastructure-plan-completion-continuation.service";
import {
  CrossLaneOwnershipEnforcementService,
} from "../release-lane/cross-lane-ownership-enforcement.service";
import { InactiveV1ShadowInsertionAdapter } from "../release-lane/inactive-v1-shadow-insertion.adapter";
import { TerminalOutboxPolicyService } from "../outbox/terminal-outbox-policy.service";
import { InactiveV1BullMqConsumerService } from "./inactive-v1-bullmq-consumer.service";
import { InactiveV1ExecutionLeaseHeartbeatService } from "./inactive-v1-execution-lease-heartbeat.service";
import { InactiveV1FencedInvocationService } from "./inactive-v1-fenced-invocation.service";
import { InactiveV1HandlerSideEffectSafetyService } from "./inactive-v1-handler-side-effect-safety.service";
import { InactiveV1InfrastructurePlanHandler } from "./inactive-v1-infrastructure-plan.handler";
import { InactiveV1PreExecutionOwnershipService } from "./inactive-v1-pre-execution-ownership.service";
import { InactiveV1WorkerRuntimeService } from "./inactive-v1-worker-runtime.service";
import { buildV1InactiveInfrastructurePlanHandlerRegistry } from "./v1-placeholder-handlers";
import { V1WorkerCapabilityService } from "./v1-worker-capability.service";
import { normalV1Activation } from "../release-lane/normal-v1-activation-policy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,159}$/;

export type InactiveV1InfrastructurePlanConsumerConfiguration = Readonly<{
  workerId: string;
  operatingMode: "canary" | "shared";
  projectIds: readonly string[];
  environmentName: "dev";
}>;

export type InactiveV1InfrastructurePlanConsumerComposition = Readonly<{
  configuration: InactiveV1InfrastructurePlanConsumerConfiguration;
  consumer: InactiveV1BullMqConsumerService;
}>;

/**
 * A standalone composition so creating it cannot construct release/AWS
 * clients.  It is plan-only and remains unreachable unless every exact gate
 * below is true.
 */
@Injectable()
export class InactiveV1InfrastructurePlanConsumerCompositionService {
  private readonly composition: InactiveV1InfrastructurePlanConsumerComposition | null;

  constructor(
    private readonly config: ConfigService,
    private readonly dataSource: DataSource,
    private readonly planService: V1InfrastructureManifestPlanService,
    private readonly continuation: InfrastructurePlanCompletionContinuationService,
    private readonly terminalOutbox: TerminalOutboxPolicyService,
    private readonly crossLane: CrossLaneOwnershipEnforcementService,
    @Optional() private readonly shadowInsertion?: InactiveV1ShadowInsertionAdapter,
  ) {
    const configuration = this.configuration();
    if (!configuration) {
      this.composition = null;
      return;
    }
    const capabilities = new V1WorkerCapabilityService(this.dataSource);
    const runtime = new InactiveV1WorkerRuntimeService(
      this.dataSource,
      capabilities,
      this.config,
    );
    const ownership = new InactiveV1PreExecutionOwnershipService(
      this.dataSource,
      runtime,
      this.terminalOutbox,
    );
    const invocation = new InactiveV1FencedInvocationService(
      this.dataSource,
      ownership,
      buildV1InactiveInfrastructurePlanHandlerRegistry(
        new InactiveV1InfrastructurePlanHandler(this.dataSource, this.planService),
      ),
      new InactiveV1ExecutionLeaseHeartbeatService(ownership),
      new InactiveV1HandlerSideEffectSafetyService(this.dataSource),
      this.crossLane,
      this.continuation,
    );
    this.composition = Object.freeze({
      configuration,
      consumer: new InactiveV1BullMqConsumerService(
        invocation,
        capabilities,
        this.shadowInsertion,
        this.crossLane,
      ),
    });
  }

  getInactiveComposition() {
    return this.composition;
  }

  private configuration(): InactiveV1InfrastructurePlanConsumerConfiguration | null {
    if (
      this.config.get<unknown>("TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_CONSUMER_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED") !== "true"
      || this.config.get<unknown>("TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED") !== "true"
    ) return null;
    const workerId = this.config.get<unknown>("TWO_LANE_INFRASTRUCTURE_WORKER_ID");
    const activation = normalV1Activation(this.config);
    const ownershipEnvironment = this.exactAllowlist(
      "TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST", /^dev$/,
    );
    if (
      typeof workerId !== "string" || !WORKER_ID.test(workerId)
      || !activation || ownershipEnvironment !== "dev"
    ) return null;
    if (activation.mode === "canary") {
      const ownershipProject = this.exactAllowlist(
        "TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST", UUID,
      );
      if (ownershipProject !== activation.projectIds[0]) return null;
    }
    return Object.freeze({
      workerId,
      operatingMode: activation.mode,
      projectIds: activation.projectIds,
      environmentName: "dev" as const,
    });
  }

  private exactAllowlist(name: string, pattern: RegExp) {
    const value = this.config.get<unknown>(name);
    if (typeof value !== "string") return null;
    const entries = value.split(",").map((entry) => entry.trim());
    return entries.length === 1 && pattern.test(entries[0]) ? entries[0] : null;
  }
}
