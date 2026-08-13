import { Injectable } from "@nestjs/common";
import {
  ReleaseLaneShadowInsertionSource,
  ReleaseLaneShadowObservationInput,
  ReleaseLaneShadowOperationClass,
} from "./inactive-release-lane-shadow-observer.types";
import { InactiveReleaseLaneShadowObserverService } from "./inactive-release-lane-shadow-observer.service";

type LegacyObservation = {
  projectId: string;
  logicalOperationId: string;
};

type LegacyRollbackObservation = {
  projectId: string;
  rollbackRecordId: string;
};

type LegacyCancellationObservation = {
  projectId: string;
  pipelineRunId: string;
};

type LegacyWorkerTerminalObservation = {
  projectId: string;
  pipelineRunId: string;
  bullmqJobId: string;
};

export type LegacyWorkerShadowRoute =
  | "full_deploy"
  | "stage_selective_resume"
  | "cost_approval_resume"
  | "apply_approval_resume"
  | "state_lock_resume"
  | "infrastructure_plan"
  | "infrastructure_apply"
  | "storage_provision";

type LegacyWorkerObservation = LegacyObservation & { route: LegacyWorkerShadowRoute };

/**
 * The only legacy shadow insertion surface. It is deliberately detached from
 * legacy execution so observation cannot affect queueing or request outcomes.
 */
@Injectable()
export class InactiveLegacyShadowInsertionAdapter {
  constructor(
    private readonly observer: InactiveReleaseLaneShadowObserverService,
  ) {}

  observeFullDeploymentRun(input: LegacyObservation): void {
    this.submit(input, "legacy_full_deployment_run", "pipeline_service.start_run", "full-deploy");
  }

  observeRetryCreatedRun(input: LegacyObservation): void {
    this.submit(input, "legacy_retry", "pipeline_service.start_run", "retry");
  }

  observeFullRecoveryResume(input: LegacyObservation): void {
    this.submit(input, "legacy_full_recovery_resume", "stage_selective_resume.execute", "full-recovery");
  }

  observeStageSelectiveResume(input: LegacyObservation): void {
    this.submit(input, "legacy_stage_selective_resume", "stage_selective_resume.execute", "stage-resume");
  }

  observeCostApprovalResume(input: LegacyObservation): void {
    this.submit(input, "legacy_cost_approval_resume", "finops_service.resume_after_cost_approval", "cost-approval");
  }

  observeApplyApprovalResume(input: LegacyObservation): void {
    this.submit(input, "legacy_apply_approval_resume", "pipeline_service.approve_terraform_apply", "apply-approval");
  }

  observeStateLockResume(input: LegacyObservation): void {
    this.submit(input, "legacy_state_lock_resume", "infrastructure_service.release_state_lock", "state-lock");
  }

  observeInfrastructureDeploy(input: LegacyObservation): void {
    this.submit(input, "legacy_infrastructure_deploy", "infrastructure_service.deploy", "infrastructure-deploy");
  }

  observeInfrastructurePlan(input: LegacyObservation): void {
    this.submit(input, "legacy_infrastructure_plan", "infrastructure_service.queue_plan", "infrastructure-plan");
  }

  observeInfrastructureApply(input: LegacyObservation): void {
    this.submit(input, "legacy_infrastructure_apply", "infrastructure_service.queue_apply", "infrastructure-apply");
  }

  observeStorageProvision(input: LegacyObservation): void {
    this.submit(input, "legacy_storage_provision", "storage_service.provision", "storage-provision");
  }

  observeRollbackRecordCreated(input: LegacyRollbackObservation): void {
    this.submitRollback(input, "rollback_service.record_created", `rollback-request:${input.rollbackRecordId}`);
  }

  observeRollbackBeforeEcsUpdate(input: LegacyRollbackObservation): void {
    this.submitRollback(input, "rollback_service.before_ecs_update", `rollback-mutation:${input.rollbackRecordId}`);
  }

  observeRollbackSucceeded(input: LegacyRollbackObservation): void {
    this.submitRollback(input, "rollback_service.terminal_succeeded", `rollback-terminal:${input.rollbackRecordId}:succeeded`);
  }

  observeRollbackFailed(input: LegacyRollbackObservation): void {
    this.submitRollback(input, "rollback_service.terminal_failed", `rollback-terminal:${input.rollbackRecordId}:failed`);
  }

  observeCancellationPersisted(input: LegacyCancellationObservation): void {
    this.submitCancellation(input, `cancel:${input.pipelineRunId}:cancelled`);
  }

  observeWorkerPickup(input: LegacyWorkerObservation): void {
    const route = workerRoute(input.route);
    this.submit(input, route.operationClass, route.pickupSource, `worker-pickup:${input.route}`);
  }

  observeWorkerPreMutation(input: LegacyWorkerObservation): void {
    const route = workerRoute(input.route);
    this.submit(input, route.operationClass, route.preMutationSource, `worker-pre-mutation:${input.route}`);
  }

  observeWorkerTerminalCompleted(input: LegacyWorkerTerminalObservation): void {
    this.submitTerminal(input, "legacy_worker_terminal_success", "pipeline_worker.completed_persisted", "completed");
  }

  observeWorkerTerminalFailed(input: LegacyWorkerTerminalObservation): void {
    this.submitTerminal(input, "legacy_worker_terminal_failure", "pipeline_worker.failed_persisted", "failed");
  }

  private submit(
    input: LegacyObservation,
    operationClass: ReleaseLaneShadowOperationClass,
    insertionSource: ReleaseLaneShadowInsertionSource,
    domain: string,
  ): void {
    this.submitObservation({
      projectId: input.projectId,
      environmentName: "dev",
      proposedLane: "legacy",
      operationClass,
      logicalOperationIdentity: `legacy:${domain}:${input.logicalOperationId}`,
      insertionSource,
    });
  }

  private submitRollback(
    input: LegacyRollbackObservation,
    insertionSource: ReleaseLaneShadowInsertionSource,
    logicalOperationIdentity: string,
  ): void {
    this.submitObservation({
      projectId: input.projectId,
      environmentName: "dev",
      proposedLane: "legacy",
      operationClass: "legacy_rollback",
      logicalOperationIdentity,
      insertionSource,
    });
  }

  private submitCancellation(input: LegacyCancellationObservation, logicalOperationIdentity: string): void {
    this.submitObservation({
      projectId: input.projectId,
      environmentName: "dev",
      proposedLane: "legacy",
      operationClass: "legacy_cancel",
      logicalOperationIdentity,
      insertionSource: "pipeline_service.cancel_persisted",
    });
  }

  private submitTerminal(
    input: LegacyWorkerTerminalObservation,
    operationClass: ReleaseLaneShadowOperationClass,
    insertionSource: ReleaseLaneShadowInsertionSource,
    outcome: "completed" | "failed",
  ): void {
    this.submitObservation({
      projectId: input.projectId,
      environmentName: "dev",
      proposedLane: "legacy",
      operationClass,
      logicalOperationIdentity: `worker-terminal:${input.pipelineRunId}:${input.bullmqJobId}:${outcome}`,
      insertionSource,
    });
  }

  private submitObservation(observation: ReleaseLaneShadowObservationInput): void {
    try {
      void Promise.resolve(this.observer.observe(observation)).catch(() => undefined);
    } catch {
      // Shadow observation is never allowed to change legacy behavior.
    }
  }
}

function workerRoute(route: LegacyWorkerShadowRoute): {
  operationClass: ReleaseLaneShadowOperationClass;
  pickupSource: ReleaseLaneShadowInsertionSource;
  preMutationSource: ReleaseLaneShadowInsertionSource;
} {
  switch (route) {
    case "stage_selective_resume":
      return { operationClass: "legacy_stage_selective_resume", pickupSource: "pipeline_worker.stage_selective_resume_pickup", preMutationSource: "pipeline_worker.stage_selective_resume_pre_mutation" };
    case "cost_approval_resume":
      return { operationClass: "legacy_cost_approval_resume", pickupSource: "pipeline_worker.cost_approval_resume_pickup", preMutationSource: "pipeline_worker.cost_approval_resume_pre_mutation" };
    case "apply_approval_resume":
      return { operationClass: "legacy_apply_approval_resume", pickupSource: "pipeline_worker.apply_approval_resume_pickup", preMutationSource: "pipeline_worker.apply_approval_resume_pre_mutation" };
    case "state_lock_resume":
      return { operationClass: "legacy_state_lock_resume", pickupSource: "pipeline_worker.state_lock_resume_pickup", preMutationSource: "pipeline_worker.state_lock_resume_pre_mutation" };
    case "infrastructure_plan":
      return { operationClass: "legacy_infrastructure_plan", pickupSource: "pipeline_worker.infrastructure_plan_pickup", preMutationSource: "pipeline_worker.infrastructure_plan_pre_mutation" };
    case "infrastructure_apply":
      return { operationClass: "legacy_infrastructure_apply", pickupSource: "pipeline_worker.infrastructure_apply_pickup", preMutationSource: "pipeline_worker.infrastructure_apply_pre_mutation" };
    case "storage_provision":
      return { operationClass: "legacy_storage_provision", pickupSource: "pipeline_worker.storage_provision_pickup", preMutationSource: "pipeline_worker.storage_provision_pre_mutation" };
    case "full_deploy":
      return { operationClass: "legacy_full_deployment_run", pickupSource: "pipeline_worker.full_deploy_pickup", preMutationSource: "pipeline_worker.full_deploy_pre_mutation" };
  }
}
