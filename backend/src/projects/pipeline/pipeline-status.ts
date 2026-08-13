import { PipelineRunStatus } from "../project-pipeline-run.entity";

export const ACTIVE_PIPELINE_STATUSES: readonly PipelineRunStatus[] = [
  PipelineRunStatus.QUEUED,
  PipelineRunStatus.RUNNING,
  PipelineRunStatus.COST_ANALYSIS_RUNNING,
  PipelineRunStatus.STATE_LOCK_ACQUIRING,
  PipelineRunStatus.WAITING_FOR_STATE_LOCK,
  PipelineRunStatus.STATE_LOCK_ACQUIRED,
  PipelineRunStatus.STATE_HEARTBEAT_ACTIVE,
  PipelineRunStatus.STATE_VALIDATION_RUNNING,
  PipelineRunStatus.STATE_LOCK_RELEASED,
  PipelineRunStatus.STORAGE_EVALUATION_RUNNING,
  PipelineRunStatus.STORAGE_NOT_REQUIRED,
  PipelineRunStatus.STORAGE_PROVISIONING,
  PipelineRunStatus.STORAGE_PROVISIONED,
  PipelineRunStatus.BACKUP_CONFIGURING,
  PipelineRunStatus.BACKUP_CONFIGURED,
  PipelineRunStatus.ECS_DEPLOYMENT_QUEUED,
  PipelineRunStatus.ECS_TASK_DEFINITION_REGISTERING,
  PipelineRunStatus.ECS_SERVICE_UPDATING,
  PipelineRunStatus.ECS_WAITING_FOR_STABILITY,
  PipelineRunStatus.ECS_SERVICE_HEALTHY,
  PipelineRunStatus.ROLLBACK_STARTED,
  PipelineRunStatus.SPOT_INTERRUPTION_HANDLED,
];

export const PAUSED_PIPELINE_STATUSES: readonly PipelineRunStatus[] = [
  PipelineRunStatus.WAITING_FOR_COST_APPROVAL,
  PipelineRunStatus.APPLY_DISABLED,
];

export const FAILED_PIPELINE_STATUSES: readonly PipelineRunStatus[] = [
  PipelineRunStatus.FAILED,
  PipelineRunStatus.BLOCKED_BY_COST_LIMIT,
  PipelineRunStatus.COST_REJECTED,
  PipelineRunStatus.COST_ANALYSIS_FAILED,
  PipelineRunStatus.STATE_RECOVERY_REQUIRED,
  PipelineRunStatus.STATE_LOCK_FAILED,
  PipelineRunStatus.STORAGE_FAILED,
  PipelineRunStatus.BACKUP_FAILED,
  PipelineRunStatus.ECS_SERVICE_UNHEALTHY,
  PipelineRunStatus.ECS_DEPLOYMENT_FAILED,
  PipelineRunStatus.ROLLBACK_FAILED,
];

export const TERMINAL_PIPELINE_STATUSES: readonly PipelineRunStatus[] = [
  PipelineRunStatus.COMPLETED,
  PipelineRunStatus.CANCELLED,
  PipelineRunStatus.ROLLBACK_SUCCEEDED,
  ...FAILED_PIPELINE_STATUSES,
];

export const CANCELABLE_PIPELINE_STATUSES: readonly PipelineRunStatus[] = [
  ...ACTIVE_PIPELINE_STATUSES,
  ...PAUSED_PIPELINE_STATUSES,
];

export const RETRYABLE_PIPELINE_STATUSES: readonly PipelineRunStatus[] = [
  PipelineRunStatus.CANCELLED,
  ...FAILED_PIPELINE_STATUSES,
];

export const PIPELINE_IN_PROGRESS_STATUSES: readonly PipelineRunStatus[] = [
  ...ACTIVE_PIPELINE_STATUSES,
  ...PAUSED_PIPELINE_STATUSES,
];

export function isPipelineActive(status: PipelineRunStatus | string) {
  return ACTIVE_PIPELINE_STATUSES.includes(status as PipelineRunStatus);
}

export function isPipelinePaused(status: PipelineRunStatus | string) {
  return PAUSED_PIPELINE_STATUSES.includes(status as PipelineRunStatus);
}

export function isPipelineFailed(status: PipelineRunStatus | string) {
  return FAILED_PIPELINE_STATUSES.includes(status as PipelineRunStatus);
}

export function isPipelineTerminal(status: PipelineRunStatus | string) {
  return TERMINAL_PIPELINE_STATUSES.includes(status as PipelineRunStatus);
}

export function isPipelineCancelable(status: PipelineRunStatus | string) {
  return CANCELABLE_PIPELINE_STATUSES.includes(status as PipelineRunStatus);
}

export function isPipelineRetryable(status: PipelineRunStatus | string) {
  return RETRYABLE_PIPELINE_STATUSES.includes(status as PipelineRunStatus);
}

export function isPipelineInProgress(status: PipelineRunStatus | string) {
  return PIPELINE_IN_PROGRESS_STATUSES.includes(status as PipelineRunStatus);
}
