import { Injectable } from "@nestjs/common";
import { DeploymentClassification, ExecutionLane } from "../contracts/deployment-intent.types";
import {
  ReleaseLaneShadowInsertionSource,
  ReleaseLaneShadowObservationInput,
  ReleaseLaneShadowOperationClass,
} from "./inactive-release-lane-shadow-observer.types";
import { InactiveReleaseLaneShadowObserverService } from "./inactive-release-lane-shadow-observer.service";

/**
 * The only v1 shadow insertion surface. Calls are deliberately detached and
 * swallowed: observation cannot alter planner, dispatch, or consumer results.
 */
@Injectable()
export class InactiveV1ShadowInsertionAdapter {
  constructor(
    private readonly observer: InactiveReleaseLaneShadowObserverService,
  ) {}

  observePlanner(input: {
    projectId: string;
    environmentName: string;
    intentId: string;
    classification: DeploymentClassification;
  }): void {
    this.submit({
      projectId: input.projectId,
      environmentName: input.environmentName,
      proposedLane: "v1",
      operationClass: plannerClass(input.classification),
      logicalOperationIdentity: `planner:${input.intentId}`,
      insertionSource: "transactional_deployment_planner.plan",
    });
  }

  observeDispatch(input: {
    projectId: string;
    environmentName: string;
    intentId: string;
    deterministicJobId: string;
    lane: ExecutionLane;
  }): void {
    this.submit({
      projectId: input.projectId,
      environmentName: input.environmentName,
      proposedLane: "v1",
      operationClass: dispatchClass(input.lane),
      logicalOperationIdentity: `dispatch:${input.intentId}:${input.deterministicJobId}`,
      insertionSource: "durable_outbox_dispatcher.dispatch_one",
    });
  }

  observeConsumerClaim(input: {
    projectId: string;
    environmentName: string;
    intentId: string;
    deterministicJobId: string;
    lane: ExecutionLane;
  }): void {
    this.submit({
      projectId: input.projectId,
      environmentName: input.environmentName,
      proposedLane: "v1",
      operationClass: consumerClass(input.lane),
      logicalOperationIdentity: `consumer:${input.intentId}:${input.deterministicJobId}`,
      insertionSource: "inactive_v1_bullmq_consumer.process_job",
    });
  }

  private submit(input: ReleaseLaneShadowObservationInput): void {
    try {
      void Promise.resolve(this.observer.observe(input)).catch(() => undefined);
    } catch {
      // Observation is deliberately unable to change the v1 caller outcome.
    }
  }
}

function plannerClass(classification: DeploymentClassification): ReleaseLaneShadowOperationClass {
  if (classification === "release_only") return "v1_plan_release";
  if (classification === "infrastructure_change") return "v1_plan_infrastructure";
  if (classification === "no_op") return "v1_plan_no_op";
  return "v1_plan_unsafe_or_unknown";
}

function dispatchClass(lane: ExecutionLane): ReleaseLaneShadowOperationClass {
  return lane === "release"
    ? "v1_dispatch_release"
    : lane === "infrastructure"
      ? "v1_dispatch_infrastructure"
      : "v1_dispatch_deletion";
}

function consumerClass(lane: ExecutionLane): ReleaseLaneShadowOperationClass {
  return lane === "release"
    ? "v1_consumer_claim_release"
    : lane === "infrastructure"
      ? "v1_consumer_claim_infrastructure"
      : "v1_consumer_claim_deletion";
}
