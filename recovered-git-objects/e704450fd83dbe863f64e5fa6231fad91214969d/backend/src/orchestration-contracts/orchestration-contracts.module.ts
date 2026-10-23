import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { DeploymentIntent } from "./entities/deployment-intent.entity";
import { InfrastructureManifest } from "./entities/infrastructure-manifest.entity";
import { OrchestrationOutbox } from "./entities/orchestration-outbox.entity";
import { ProjectOperationLease } from "./entities/project-operation-lease.entity";
import { ProjectStateRevision } from "./entities/project-state-revision.entity";
import { ReleaseManifest } from "./entities/release-manifest.entity";
import { WorkerCapability } from "./entities/worker-capability.entity";
import { DeploymentSideEffect } from "./entities/deployment-side-effect.entity";
import { DeploymentSideEffectReconciliation } from "./entities/deployment-side-effect-reconciliation.entity";
import { DeploymentSideEffectReconciliationLease } from "./entities/deployment-side-effect-reconciliation-lease.entity";
import { ProjectReleaseLaneOwnership } from "./entities/release-lane-ownership.entity";
import { ProjectReleaseLaneShadowObservation } from "./entities/release-lane-shadow-observation.entity";
import { TransactionalDeploymentPlannerService } from "./planner/transactional-deployment-planner.service";
import { BullMqOutboxPublisher } from "./outbox/bullmq-outbox.publisher";
import { DurableOutboxDispatcherService } from "./outbox/durable-outbox-dispatcher.service";
import { OUTBOX_JOB_PUBLISHER } from "./outbox/outbox-dispatcher.types";
import { InactiveV1ReleaseLaneCompositionService } from
  "./release-lane/inactive-v1-release-lane-composition";
import {
  V1_RELEASE_LANE_PRODUCTION_CANARY_ADAPTER_FACTORY,
} from "./release-lane/inactive-v1-release-lane-composition";
import { ProductionV1ReleaseCanaryAdapterFactory } from "./release-lane/production-v1-release-canary-adapter.factory";
import { ProductionV1ReleaseCanaryPreflightService } from "./release-lane/production-v1-release-canary-preflight.service";
import { InactiveReleaseLaneOwnershipService } from "./release-lane/inactive-release-lane-ownership.service";
import { InactiveReleaseLaneCorrelationService } from "./release-lane/inactive-release-lane-correlation.service";
import { InactiveReleaseLaneShadowObserverService } from "./release-lane/inactive-release-lane-shadow-observer.service";
import { InactiveV1ShadowInsertionAdapter } from "./release-lane/inactive-v1-shadow-insertion.adapter";
import { InactiveLegacyShadowInsertionAdapter } from "./release-lane/inactive-legacy-shadow-insertion.adapter";
import { CrossLaneOwnershipEnforcementService } from "./release-lane/cross-lane-ownership-enforcement.service";
import { TerraformRunnerService } from "../infrastructure/terraform-runner.service";
import { V1InfrastructureManifestPlanService } from "./infrastructure/v1-infrastructure-manifest-plan.service";
import { V1InfrastructurePlanReviewService } from "./infrastructure/v1-infrastructure-plan-review.service";
import { InfracostService } from "../finops/infracost.service";
import { InactiveV1WorkerRuntimeService } from "./worker-runtime/inactive-v1-worker-runtime.service";
import { InactiveV1FencedInvocationService } from "./worker-runtime/inactive-v1-fenced-invocation.service";
import { InactiveV1ExecutionLeaseHeartbeatService } from "./worker-runtime/inactive-v1-execution-lease-heartbeat.service";
import { InactiveV1HandlerSideEffectSafetyService } from "./worker-runtime/inactive-v1-handler-side-effect-safety.service";
import { InactiveV1SideEffectReconciliationService } from "./worker-runtime/inactive-v1-side-effect-reconciliation.service";
import { InactiveV1SideEffectReconciliationCoordinatorService } from "./worker-runtime/inactive-v1-side-effect-reconciliation-coordinator.service";
import { InactiveV1PreExecutionOwnershipService } from "./worker-runtime/inactive-v1-pre-execution-ownership.service";
import { InactiveV1BullMqConsumerService } from "./worker-runtime/inactive-v1-bullmq-consumer.service";
import { V1_FENCED_PLACEHOLDER_HANDLER_REGISTRY } from "./worker-runtime/v1-fenced-invocation.types";
import { buildV1FencedPlaceholderHandlerRegistry } from "./worker-runtime/v1-placeholder-handlers";
import { V1WorkerCapabilityService } from "./worker-runtime/v1-worker-capability.service";

const entities = [
  InfrastructureManifest,
  ReleaseManifest,
  DeploymentIntent,
  OrchestrationOutbox,
  ProjectOperationLease,
  ProjectStateRevision,
  WorkerCapability,
  DeploymentSideEffect,
  DeploymentSideEffectReconciliation,
  DeploymentSideEffectReconciliationLease,
  ProjectReleaseLaneOwnership,
  ProjectReleaseLaneShadowObservation,
];

@Module({
  imports: [TypeOrmModule.forFeature(entities)],
  providers: [
    TransactionalDeploymentPlannerService,
    BullMqOutboxPublisher,
    {
      provide: OUTBOX_JOB_PUBLISHER,
      useExisting: BullMqOutboxPublisher,
    },
    DurableOutboxDispatcherService,
    V1WorkerCapabilityService,
    InactiveV1WorkerRuntimeService,
    InactiveV1PreExecutionOwnershipService,
    InactiveV1ExecutionLeaseHeartbeatService,
    InactiveV1HandlerSideEffectSafetyService,
    InactiveV1SideEffectReconciliationService,
    InactiveV1SideEffectReconciliationCoordinatorService,
    {
      provide: V1_FENCED_PLACEHOLDER_HANDLER_REGISTRY,
      useFactory: buildV1FencedPlaceholderHandlerRegistry,
    },
    InactiveV1FencedInvocationService,
    InactiveV1BullMqConsumerService,
    ProductionV1ReleaseCanaryAdapterFactory,
    {
      provide: V1_RELEASE_LANE_PRODUCTION_CANARY_ADAPTER_FACTORY,
      inject: [ProductionV1ReleaseCanaryAdapterFactory],
      useFactory: (factory: ProductionV1ReleaseCanaryAdapterFactory) =>
        factory.create.bind(factory),
    },
    InactiveV1ReleaseLaneCompositionService,
    ProductionV1ReleaseCanaryPreflightService,
    InactiveReleaseLaneOwnershipService,
    InactiveReleaseLaneCorrelationService,
    InactiveReleaseLaneShadowObserverService,
    InactiveV1ShadowInsertionAdapter,
    InactiveLegacyShadowInsertionAdapter,
    CrossLaneOwnershipEnforcementService,
    TerraformRunnerService,
    V1InfrastructureManifestPlanService,
    InfracostService,
    V1InfrastructurePlanReviewService,
  ],
  exports: [
    TypeOrmModule,
    TransactionalDeploymentPlannerService,
    DurableOutboxDispatcherService,
    V1WorkerCapabilityService,
    InactiveV1WorkerRuntimeService,
    InactiveV1PreExecutionOwnershipService,
    InactiveV1ExecutionLeaseHeartbeatService,
    InactiveV1HandlerSideEffectSafetyService,
    InactiveV1SideEffectReconciliationService,
    InactiveV1SideEffectReconciliationCoordinatorService,
    InactiveV1FencedInvocationService,
    InactiveV1BullMqConsumerService,
    V1InfrastructureManifestPlanService,
    V1InfrastructurePlanReviewService,
    ProductionV1ReleaseCanaryPreflightService,
    InactiveV1ReleaseLaneCompositionService,
    InactiveReleaseLaneOwnershipService,
    InactiveReleaseLaneCorrelationService,
    InactiveReleaseLaneShadowObserverService,
    InactiveV1ShadowInsertionAdapter,
    InactiveLegacyShadowInsertionAdapter,
    CrossLaneOwnershipEnforcementService,
  ],
})
export class OrchestrationContractsModule {}
