import { Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataSource } from "typeorm";
import { V1InfrastructureManifestApplyService } from "../infrastructure/v1-infrastructure-manifest-apply.service";
import { CrossLaneOwnershipEnforcementService } from "../release-lane/cross-lane-ownership-enforcement.service";
import { InactiveV1ShadowInsertionAdapter } from "../release-lane/inactive-v1-shadow-insertion.adapter";
import { TerminalOutboxPolicyService } from "../outbox/terminal-outbox-policy.service";
import { InactiveV1BullMqConsumerService } from "./inactive-v1-bullmq-consumer.service";
import { InactiveV1ExecutionLeaseHeartbeatService } from "./inactive-v1-execution-lease-heartbeat.service";
import { InactiveV1FencedInvocationService } from "./inactive-v1-fenced-invocation.service";
import { InactiveV1HandlerSideEffectSafetyService } from "./inactive-v1-handler-side-effect-safety.service";
import { InactiveV1InfrastructureApplyHandler } from "./inactive-v1-infrastructure-apply.handler";
import { InactiveV1PreExecutionOwnershipService } from "./inactive-v1-pre-execution-ownership.service";
import { InactiveV1WorkerRuntimeService } from "./inactive-v1-worker-runtime.service";
import { buildV1InactiveInfrastructureApplyHandlerRegistry } from "./v1-placeholder-handlers";
import { V1WorkerCapabilityService } from "./v1-worker-capability.service";
import { normalV1Activation } from "../release-lane/normal-v1-activation-policy";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,159}$/;

@Injectable()
export class InactiveV1InfrastructureApplyConsumerCompositionService {
  private readonly composition: { configuration: { workerId: string; operatingMode: "canary" | "shared"; projectIds: readonly string[]; environmentName: "dev" }; consumer: InactiveV1BullMqConsumerService } | null;
  constructor(config: ConfigService, dataSource: DataSource, apply: V1InfrastructureManifestApplyService,
    terminal: TerminalOutboxPolicyService, crossLane: CrossLaneOwnershipEnforcementService,
    @Optional() shadow?: InactiveV1ShadowInsertionAdapter) {
    const workerId = config.get<unknown>("TWO_LANE_INFRASTRUCTURE_APPLY_WORKER_ID");
    const activation = normalV1Activation(config);
    if (config.get<unknown>("TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_CONSUMER_ENABLED") !== "true"
      || config.get<unknown>("TWO_LANE_NORMAL_INFRASTRUCTURE_APPLY_ENABLED") !== "true"
      || config.get<unknown>("TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED") !== "true"
      || config.get<unknown>("TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED") !== "true"
      || typeof workerId !== "string" || !WORKER.test(workerId)
      || !activation
      || config.get<unknown>("TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST") !== "dev"
      || (activation.mode === "canary"
        && config.get<unknown>("TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST") !== activation.projectIds[0])) { this.composition = null; return; }
    const runtime = new InactiveV1WorkerRuntimeService(dataSource, new V1WorkerCapabilityService(dataSource), config);
    const ownership = new InactiveV1PreExecutionOwnershipService(dataSource, runtime, terminal);
    const invocation = new InactiveV1FencedInvocationService(dataSource, ownership,
      buildV1InactiveInfrastructureApplyHandlerRegistry(new InactiveV1InfrastructureApplyHandler(dataSource, apply)),
      new InactiveV1ExecutionLeaseHeartbeatService(ownership), new InactiveV1HandlerSideEffectSafetyService(dataSource), crossLane);
    this.composition = { configuration: { workerId, operatingMode: activation.mode, projectIds: activation.projectIds, environmentName: "dev" }, consumer: new InactiveV1BullMqConsumerService(invocation, new V1WorkerCapabilityService(dataSource), shadow, crossLane) };
  }
  getInactiveComposition() { return this.composition; }
}
