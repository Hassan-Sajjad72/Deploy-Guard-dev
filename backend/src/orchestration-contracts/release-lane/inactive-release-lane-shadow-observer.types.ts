import { ReleaseLaneShadowDecision } from "../entities/release-lane-shadow-observation.entity";

export type ReleaseLaneShadowOperationClass =
  | "legacy_full_deployment_run"
  | "legacy_retry"
  | "legacy_full_recovery_resume"
  | "legacy_stage_selective_resume"
  | "legacy_cost_approval_resume"
  | "legacy_apply_approval_resume"
  | "legacy_state_lock_resume"
  | "legacy_infrastructure_deploy"
  | "legacy_infrastructure_plan"
  | "legacy_infrastructure_apply"
  | "legacy_storage_provision"
  | "legacy_rollback"
  | "legacy_cancel"
  | "legacy_worker_terminal_success"
  | "legacy_worker_terminal_failure"
  | "v1_plan_release"
  | "v1_plan_infrastructure"
  | "v1_plan_unsafe_or_unknown"
  | "v1_plan_no_op"
  | "v1_dispatch_release"
  | "v1_dispatch_infrastructure"
  | "v1_dispatch_deletion"
  | "v1_consumer_claim_release"
  | "v1_consumer_claim_infrastructure"
  | "v1_consumer_claim_deletion";

export type ReleaseLaneShadowInsertionSource =
  | "pipeline_service.start_run"
  | "stage_selective_resume.execute"
  | "finops_service.resume_after_cost_approval"
  | "pipeline_service.approve_terraform_apply"
  | "infrastructure_service.release_state_lock"
  | "infrastructure_service.deploy"
  | "infrastructure_service.queue_plan"
  | "infrastructure_service.queue_apply"
  | "storage_service.provision"
  | "pipeline_worker.full_deploy_pickup"
  | "pipeline_worker.stage_selective_resume_pickup"
  | "pipeline_worker.cost_approval_resume_pickup"
  | "pipeline_worker.apply_approval_resume_pickup"
  | "pipeline_worker.state_lock_resume_pickup"
  | "pipeline_worker.infrastructure_plan_pickup"
  | "pipeline_worker.infrastructure_apply_pickup"
  | "pipeline_worker.storage_provision_pickup"
  | "pipeline_worker.full_deploy_pre_mutation"
  | "pipeline_worker.stage_selective_resume_pre_mutation"
  | "pipeline_worker.cost_approval_resume_pre_mutation"
  | "pipeline_worker.apply_approval_resume_pre_mutation"
  | "pipeline_worker.state_lock_resume_pre_mutation"
  | "pipeline_worker.infrastructure_plan_pre_mutation"
  | "pipeline_worker.infrastructure_apply_pre_mutation"
  | "pipeline_worker.storage_provision_pre_mutation"
  | "rollback_service.rollback_to_previous_stable"
  | "rollback_service.record_created"
  | "rollback_service.before_ecs_update"
  | "rollback_service.terminal_succeeded"
  | "rollback_service.terminal_failed"
  | "pipeline_service.cancel_persisted"
  | "pipeline_worker.completed_persisted"
  | "pipeline_worker.failed_persisted"
  | "transactional_deployment_planner.plan"
  | "durable_outbox_dispatcher.dispatch_one"
  | "inactive_v1_bullmq_consumer.process_job";

export type ReleaseLaneShadowObservationInput = {
  projectId: string;
  environmentName: string;
  proposedLane: "legacy" | "v1";
  operationClass: ReleaseLaneShadowOperationClass;
  logicalOperationIdentity: string;
  insertionSource: ReleaseLaneShadowInsertionSource;
};

export type ReleaseLaneShadowObservation = {
  projectId: string;
  environmentName: string;
  proposedLane: "legacy" | "v1";
  operationClass: ReleaseLaneShadowOperationClass;
  insertionSource: ReleaseLaneShadowInsertionSource;
  decision: ReleaseLaneShadowDecision;
  currentOwnerLane: "legacy" | "v1" | null;
  currentFencingToken: string | null;
  evidenceHash: string;
  observedAt: Date;
};

export type ReleaseLaneShadowResult =
  | { enabled: false }
  | { enabled: true; disposition: "observed" | "already_observed"; observation: ReleaseLaneShadowObservation }
  | { enabled: true; disposition: "idempotency_conflict" };

export class ReleaseLaneShadowObservationError extends Error {
  constructor(readonly code: "SHADOW_OBSERVATION_INPUT_INVALID" | "SHADOW_OBSERVATION_TRANSACTION_CONFLICT") {
    super(code);
    this.name = "ReleaseLaneShadowObservationError";
  }
}
