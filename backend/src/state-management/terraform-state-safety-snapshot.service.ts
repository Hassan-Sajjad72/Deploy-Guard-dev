import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { In, Repository } from "typeorm";
import { PipelineActivityService, PipelineActivitySnapshot } from "../projects/pipeline/pipeline-activity.service";
import { ProjectPipelineRun } from "../projects/project-pipeline-run.entity";
import { CurrentStateInvalidationService } from "./current-state-invalidation.service";
import { DeploymentQueueStatus, ProjectDeploymentQueueItem } from "./project-deployment-queue-item.entity";
import { ProjectStateRecoveryRequest, StateRecoveryStatus } from "./project-state-recovery-request.entity";
import { ProjectStateValidationResult, StateValidationStatus } from "./project-state-validation-result.entity";
import { ProjectTerraformLock, TerraformLockStatus } from "./project-terraform-lock.entity";
import { ProjectTerraformState, TerraformStateStatus } from "./project-terraform-state.entity";

type SourceValue = {
  value: unknown;
  source: string;
  sourceTimestamp: string | null;
  winningValue: unknown;
};

export type TerraformStateSafetySnapshot = {
  stateStatus: string;
  lockStatus: string;
  lockId: string | null;
  heartbeatAt: string | null;
  releasedAt: string | null;
  validationStatus: string;
  validatedAt: string | null;
  stateVersionId: string | null;
  resourceCount: number | null;
  queueActive: boolean;
  activePipelineRunId: string | null;
  recoveryRequired: boolean;
  recoveryActive: boolean;
  recoveryStatus: string | null;
  recoveryStartedAt: string | null;
  authoritativeTimestamp: string | null;
  supersedesHistoricalFailuresAt: string | null;
  sources: Record<string, SourceValue>;
  currentStateInvalidation: ReturnType<CurrentStateInvalidationService["current"]>;
};

export type TerraformStateSafetyInput = {
  projectId: string;
  state: ProjectTerraformState | null;
  lock: ProjectTerraformLock | null;
  validation: ProjectStateValidationResult | null;
  recovery: ProjectStateRecoveryRequest | null;
  activeQueue: ProjectDeploymentQueueItem[];
  activity: PipelineActivitySnapshot;
  invalidation: ReturnType<CurrentStateInvalidationService["current"]>;
  nowMs?: number;
};

const ACTIVE_LOCKS = [TerraformLockStatus.ACQUIRED, TerraformLockStatus.HEARTBEAT_ACTIVE, TerraformLockStatus.QUEUED];

export function resolveTerraformStateSafety(input: TerraformStateSafetyInput): TerraformStateSafetySnapshot {
  const timestamp = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
  const time = (value: Date | string | null | undefined) => value ? new Date(value).getTime() : 0;
  const lockHeartbeat = input.lock?.heartbeatAt || input.lock?.acquiredAt || null;
  const releaseAt = input.lock?.forceReleasedAt || input.lock?.releasedAt || null;
  const lockIsActive = Boolean(input.lock && ACTIVE_LOCKS.includes(input.lock.status as TerraformLockStatus));
  const heartbeatStale = Boolean(
    lockIsActive &&
    lockHeartbeat &&
    (input.nowMs ?? Date.now()) - time(lockHeartbeat) > (input.lock?.staleAfterSeconds || 300) * 1000
  );
  const lockStatus = !input.lock
    ? "none"
    : [TerraformLockStatus.RELEASED, TerraformLockStatus.FORCE_RELEASED].includes(input.lock.status as TerraformLockStatus)
      ? input.lock.status
      : heartbeatStale
        ? "stale"
        : input.lock.status;
  const stateStatus = input.state?.status || TerraformStateStatus.MISSING;
  const recoveredValidationAt = stateStatus === TerraformStateStatus.RECOVERED ? input.state?.lastValidatedAt : null;
  const recoveredValidationWins = Boolean(
    recoveredValidationAt && time(recoveredValidationAt) > time(input.validation?.createdAt)
  );
  const validationStatus = recoveredValidationWins
    ? StateValidationStatus.VALID
    : input.validation?.status || "not_validated";
  const validationTimestamp = recoveredValidationWins ? recoveredValidationAt : input.validation?.createdAt || input.state?.lastValidatedAt;
  const resourceCount = recoveredValidationWins
    ? input.state?.resourceCount ?? input.validation?.resourceCount ?? null
    : input.validation?.resourceCount ?? input.state?.resourceCount ?? null;
  const validValidation = validationStatus === StateValidationStatus.VALID;
  const completedRecoveryAt = input.recovery?.status === StateRecoveryStatus.COMPLETED
    ? input.recovery.completedAt || input.recovery.updatedAt
    : null;
  const recoveryActive = Boolean(input.recovery && [StateRecoveryStatus.PENDING, StateRecoveryStatus.APPROVED].includes(input.recovery.status as StateRecoveryStatus));
  const recoveredStateAt = stateStatus === TerraformStateStatus.RECOVERED ? input.state?.updatedAt : null;
  const successfulReleaseAt = [TerraformLockStatus.RELEASED, TerraformLockStatus.FORCE_RELEASED].includes(input.lock?.status as TerraformLockStatus)
    ? releaseAt || input.lock?.updatedAt
    : null;
  const successfulValidationAt = validValidation ? validationTimestamp : null;
  const successTimes = [successfulReleaseAt, recoveredStateAt, completedRecoveryAt, successfulValidationAt].filter(Boolean) as Date[];
  const supersedesHistoricalFailuresAt = successTimes.length
    ? timestamp(new Date(Math.max(...successTimes.map(time))))
    : null;
  const lockProblem = ["stale", TerraformLockStatus.ORPHANED, TerraformLockStatus.FAILED].includes(lockStatus);
  const stateProblem = [TerraformStateStatus.CORRUPTED, TerraformStateStatus.RECOVERY_REQUIRED, TerraformStateStatus.FAILED].includes(stateStatus as TerraformStateStatus);
  const validationProblem = [StateValidationStatus.CORRUPTED, StateValidationStatus.FAILED].includes(validationStatus as StateValidationStatus);
  const healthyState = [TerraformStateStatus.ACTIVE, TerraformStateStatus.RECOVERED].includes(stateStatus as TerraformStateStatus);
  const queueActive = input.activeQueue.length > 0 || input.activity.isDeploymentJobActive;
  const activePipelineRunId = input.activity.activePipelineRunId || input.activeQueue[0]?.pipelineRunId || null;
  const recoveryRequired = Boolean(lockProblem || stateProblem || validationProblem || (!healthyState && stateStatus !== TerraformStateStatus.MISSING));
  const authoritativeTimes = [
    input.state?.updatedAt,
    input.lock?.updatedAt,
    input.validation?.createdAt,
    input.recovery?.updatedAt,
    ...input.activeQueue.map((item) => item.updatedAt),
    input.invalidation.invalidatedAt,
  ].filter(Boolean) as Array<Date | string>;
  const authoritativeTimestamp = authoritativeTimes.length
    ? timestamp(new Date(Math.max(...authoritativeTimes.map(time))))
    : null;
  const source = (value: unknown, table: string, sourceTimestamp: Date | string | null | undefined): SourceValue => ({
    value,
    source: table,
    sourceTimestamp: timestamp(sourceTimestamp),
    winningValue: value,
  });

  return {
    stateStatus,
    lockStatus,
    lockId: input.lock?.lockId || null,
    heartbeatAt: timestamp(lockHeartbeat),
    releasedAt: timestamp(releaseAt),
    validationStatus,
    validatedAt: timestamp(validationTimestamp),
    stateVersionId: input.state?.currentVersionId || input.validation?.stateVersionId || null,
    resourceCount,
    queueActive,
    activePipelineRunId,
    recoveryRequired,
    recoveryActive,
    recoveryStatus: input.recovery?.status || null,
    recoveryStartedAt: timestamp(input.recovery?.createdAt),
    authoritativeTimestamp,
    supersedesHistoricalFailuresAt: recoveryRequired ? null : supersedesHistoricalFailuresAt,
    sources: {
      stateStatus: source(stateStatus, "project_terraform_states.status", input.state?.updatedAt),
      lockStatus: source(lockStatus, "project_terraform_locks.status + heartbeat/release precedence", input.lock?.updatedAt),
      lockId: source(input.lock?.lockId || null, "project_terraform_locks.lock_id", input.lock?.updatedAt),
      heartbeatAt: source(timestamp(lockHeartbeat), "project_terraform_locks.heartbeat_at", lockHeartbeat),
      releasedAt: source(timestamp(releaseAt), "project_terraform_locks.released_at/force_released_at", releaseAt),
      validationStatus: source(
        validationStatus,
        recoveredValidationWins
          ? "project_terraform_states.last_validated_at (completed recovery)"
          : "project_state_validation_results.status",
        validationTimestamp,
      ),
      validatedAt: source(timestamp(validationTimestamp), "winning state validation timestamp", validationTimestamp),
      stateVersionId: source(input.state?.currentVersionId || null, "project_terraform_states.current_version_id", input.state?.updatedAt),
      resourceCount: source(resourceCount, recoveredValidationWins ? "project_terraform_states.resource_count (completed recovery)" : "latest validation/state metadata", recoveredValidationWins ? input.state?.updatedAt : input.validation?.createdAt || input.state?.updatedAt),
      queueActive: source(queueActive, "project_deployment_queue_items + BullMQ", authoritativeTimestamp),
      activePipelineRunId: source(activePipelineRunId, "BullMQ + project_deployment_queue_items", authoritativeTimestamp),
      recoveryRequired: source(recoveryRequired, "TerraformStateSafetySnapshot precedence resolver", authoritativeTimestamp),
      recoveryStatus: source(input.recovery?.status || null, "project_state_recovery_requests.status", input.recovery?.updatedAt),
      authoritativeTimestamp: source(authoritativeTimestamp, "latest winning state-safety evidence", authoritativeTimestamp),
    },
    currentStateInvalidation: input.invalidation,
  };
}

@Injectable()
export class TerraformStateSafetySnapshotService {
  constructor(
    @InjectRepository(ProjectTerraformState) private readonly states: Repository<ProjectTerraformState>,
    @InjectRepository(ProjectTerraformLock) private readonly locks: Repository<ProjectTerraformLock>,
    @InjectRepository(ProjectStateValidationResult) private readonly validations: Repository<ProjectStateValidationResult>,
    @InjectRepository(ProjectStateRecoveryRequest) private readonly recoveries: Repository<ProjectStateRecoveryRequest>,
    @InjectRepository(ProjectDeploymentQueueItem) private readonly queue: Repository<ProjectDeploymentQueueItem>,
    @InjectRepository(ProjectPipelineRun) private readonly runs: Repository<ProjectPipelineRun>,
    private readonly pipelineActivity: PipelineActivityService,
    private readonly invalidation: CurrentStateInvalidationService,
  ) {}

  async get(projectId: string, activityOverride?: PipelineActivitySnapshot): Promise<TerraformStateSafetySnapshot> {
    const [state, lock, validation, recovery, activeQueue, latestRun] = await Promise.all([
      this.states.findOne({ where: { projectId, environmentName: "dev" }, order: { updatedAt: "DESC" } }),
      this.locks.findOne({ where: { projectId, environmentName: "dev" }, order: { updatedAt: "DESC" } }),
      this.validations.findOne({ where: { projectId, environmentName: "dev" }, order: { createdAt: "DESC" } }),
      this.recoveries.findOne({ where: { projectId, environmentName: "dev" }, order: { updatedAt: "DESC" } }),
      this.queue.find({ where: { projectId, environmentName: "dev", status: In([DeploymentQueueStatus.QUEUED, DeploymentQueueStatus.WAITING_FOR_LOCK, DeploymentQueueStatus.PROCESSING]) }, order: { updatedAt: "DESC" } }),
      activityOverride ? Promise.resolve(null) : this.runs.findOne({ where: { projectId }, order: { createdAt: "DESC" } }),
    ]);
    const activity = activityOverride || await this.pipelineActivity.inspect(projectId, latestRun);
    return resolveTerraformStateSafety({ projectId, state, lock, validation, recovery, activeQueue, activity, invalidation: this.invalidation.current(projectId) });
  }
}
