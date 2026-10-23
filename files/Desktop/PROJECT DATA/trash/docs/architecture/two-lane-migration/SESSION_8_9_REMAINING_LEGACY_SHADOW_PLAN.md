# Session 8.9 — Remaining Legacy Shadow-Observation Plan

## Status and boundary

This is a design-only protocol. No runtime, test, dependency, configuration,
queue, cloud, or frontend code changed in Session 8.9. The legacy/v1 ownership
guard remains inactive; a shadow observation is never an ownership claim.

The baseline remains the frozen `(projectId, normalizedEnvironment)` scope from
Session 8.3. Existing legacy release behavior is `legacy/dev`. Deletion and
central cleanup have their own durable operation models and must not be
silently presented as release-lane ownership.

## Remaining-path inventory and classification

| Path | Source evidence | Classification | Future shadow disposition |
| --- | --- | --- | --- |
| Manual rollback request | `OrchestrationService.rollback()` verifies access then calls the shared rollback service (`orchestration.service.ts:118-135`) | legacy release | Observe only after `ProjectRollbackRecord` is durable; do not use the HTTP request as an idempotency identity. |
| Automatic rollback after ECS stability/ALB failure | `recordDeploymentFromInfrastructure()` calls `attemptAutoRollback()` (`orchestration.service.ts:268-306`), then shared rollback service (`341-371`) | legacy release | Observe after the durable rollback record; use the originating deployment/run identity. |
| Shared rollback mutation | `RollbackService.rollbackToPreviousStable()` persists a rollback record (`rollback.service.ts:78-129`) then calls `EcsService.updateServiceToTaskDefinition()` (`131-132`) | legacy release | One request observation after record creation; one pre-mutation observation immediately before the ECS update; terminal observation after record is saved. |
| Legacy worker `tryRollback` | private method calls public `OrchestrationService.rollback()` (`pipeline-worker.service.ts:2137-2175`) | no observation until reachable | Repository search finds no caller. If made reachable, it must call the shared rollback protocol with an explicit automatic source, not the public/manual route. |
| Pipeline cancellation, queued/delayed | `PipelineService.cancelRun()` persists cancellation then removes wait/delayed/prioritized jobs (`pipeline.service.ts:237-300`, `541-550`) | lifecycle-only observation | Observe after durable `cancelled` status; no pre-mutation observation. |
| Pipeline cancellation, active worker | cancellation persists `cancelRequested`; worker checks it through `ensureNotCancelled()` and catches `PipelineCancelledError` (`pipeline-worker.service.ts:194-208`, `405-470`) | lifecycle-only observation | Request and durable terminal observations only; do not add an observation inside every checkpoint. |
| Paused cost/apply/state-lock run cancellation | same `cancelRun()` path, regardless of pause reason | lifecycle-only observation | Same run-based cancellation identity; no special approval identity. |
| Already-terminal run cancellation | `isPipelineCancelable()` rejects it before state write (`pipeline.service.ts:252-254`) | no observation | Rejected request has no durable operation and must not create a shadow row. |
| Worker terminal failure | worker catch persists failed state/event/audit then rethrows (`pipeline-worker.service.ts:405-463`) | lifecycle-only observation | Post-terminal observation only after the failed run write succeeds. |
| Worker retry/redelivery | BullMQ retries the same job; worker currently has no separate retry record | lifecycle-only observation | Reuse the Session 8.8 job-ID pickup/pre-mutation identities; terminal identity is `(run, job, terminal outcome)` and must not create per-attempt rows. |
| Worker `finally` workspace cleanup | local `rm(..., { force: true })` runs only for the cloned local workspace (`pipeline-worker.service.ts:465-469`) | no observation | Local ephemeral filesystem cleanup has no project/environment cloud scope. |
| Process termination/crash | `OnModuleDestroy` closes the worker; no durable crash-finalizer exists (`pipeline-worker.service.ts:190-192`) | lifecycle-only observation only after reconciler proof | Never infer terminal state from process death. A future reconciler may observe a durable stale/orphan decision, not the crash itself. |
| State-lock orphan/recovery | `OrphanedLockMonitorService` marks/releases locks and processes next queue item (`orphaned-lock-monitor.service.ts:7-30`) | legacy infrastructure | State safety recovery is not a release mutation. Observe only a durable recovered/orphaned lock transition, using lock/recovery identity. |
| Project-scoped Terraform destroy request/worker | `InfrastructureLifecycleService.execute()` creates `DestroyOperation` and queues it (`infrastructure-lifecycle.service.ts:106-156`); worker invokes Terraform destroy (`infrastructure-lifecycle-worker.service.ts:33-111`) | deletion | Outside release-lane ownership. Requires a future deletion-lane protocol. |
| Destroy cancellation/retry/TTL/emergency | queued destroy cancellation (`infrastructure-lifecycle.service.ts:160-161`); TTL/emergency enqueue (`186-217`); emergency worker coordinates destroys (`emergency-cleanup-worker.service.ts:27-65`) | deletion | Outside release lane; use `DestroyOperation.id` / `EmergencyCleanupOperation.id`, never a pipeline run alone. |
| Project residue cleanup after destroy | `InfrastructureLifecycleService.executeCleanup()` invokes cloud inventory cleanup after destroy (`260-290`) | deletion | Outside release lane; has a durable destroy operation but may perform direct SDK deletion. |
| Central selected/safe-orphan cleanup | `CentralCloudCleanupService.cleanup()` directly dispatches AWS CLI deletes (`central-cloud-cleanup.service.ts:92-131`) | deletion | Central resource identity can span no project or many projects; it must remain outside cross-lane release ownership. |
| Emergency residue cleanup | `EmergencyCleanupWorkerService.reconcile()` calls central cleanup after destroy (`42-65`) | deletion | Outside release lane; only a future deletion observer may report this workflow. |
| Cloud inventory/reconciliation/read-only diagnostics | inventory, reconciliation, state validation, and status readers | no observation | No mutation and no durable operation claim. |

## Rollback protocol

### One shared mutation owner

The canonical rollback chokepoint is
`RollbackService.rollbackToPreviousStable()`, not either orchestration caller.
It creates a `ProjectRollbackRecord` before ECS mutation. Future observation
must be inserted there, so manual and automatic callers cannot duplicate a
request or pre-mutation observation when they share the service.

The active automatic route carries a non-null `pipelineRunId`; manual rollback
passes `null`. A rollback is allowed to reuse the originating active run
identity **only** when all are true:

1. the invocation came from `attemptAutoRollback`;
2. its `pipelineRunId` matches the failed deployment's exact run; and
3. the durable rollback record is tied to that same run and deployment.

Otherwise it receives a separate rollback identity. In particular, a manual
rollback never inherits an active/failed pipeline run merely because the
project is the same.

### Frozen rollback identities and sources

Raw identities are hashed by the existing Session 8.5 observer; they are not
persisted in the shadow observation.

| Observation | Bounded operation class | Bounded source | Raw logical identity before hashing |
| --- | --- | --- | --- |
| shared rollback request | `legacy_rollback` | `rollback_service.record_created` | `rollback-request:<rollbackRecordId>` |
| ECS rollback mutation | `legacy_rollback` | `rollback_service.before_ecs_update` | `rollback-mutation:<rollbackRecordId>` |
| rollback terminal success | `legacy_rollback` | `rollback_service.terminal_succeeded` | `rollback-terminal:<rollbackRecordId>:succeeded` |
| rollback terminal failure | `legacy_rollback` | `rollback_service.terminal_failed` | `rollback-terminal:<rollbackRecordId>:failed` |

There are intentionally no caller-context rows. The existing observer's
idempotency identity represents one insertion point, so using the same request
identity with a different caller source would be an invalid conflicting replay.
The frozen first implementation observes exclusively inside `RollbackService`.

The pre-mutation observation is immediately before
`updateServiceToTaskDefinition`. Success is observed only after both durable
rollback-record and deployment/stable-release writes complete. Failure is
observed only after the failed record write completes. It must never include
task definition ARNs, commit IDs, reasons, ECS response data, or caller data.

## Cancellation, failure, and crash protocol

| Event | Class | Source | Logical identity | Timing |
| --- | --- | --- | --- | --- |
| accepted cancellation | `legacy_cancel` | `pipeline_service.cancel_persisted` | `cancel:<runId>:cancelled` | after `ProjectPipelineRun` cancellation save, before/independent of job removal |
| worker sees persisted cancellation | no observation | — | — | The durable request already records the cancellation intent; a second source with the same identity would conflict, while a second identity would duplicate lifecycle meaning. |
| worker terminal failure | `legacy_worker_terminal_failure` | `pipeline_worker.failed_persisted` | `worker-terminal:<runId>:<jobId>:failed` | after run/event persistence |
| worker successful terminal cleanup | `legacy_worker_terminal_success` | `pipeline_worker.completed_persisted` | `worker-terminal:<runId>:<jobId>:completed` | after durable completed status |
| stale worker/job reconciled | `legacy_worker_orphan_recovery` | `legacy_worker_reconciler.terminalized` | `worker-orphan:<runId>:<jobId>:<decisionRevision>` | only after a future reconciler proves no active job/process and persists its decision |
| state-lock recovered | `legacy_state_recovery` | `state_management.recovery_persisted` | `state-recovery:<recoveryRequestId>` | after durable state recovery/release result |

`jobId` is the existing BullMQ ID where available; the existing run-based
fallback is allowed only for legacy in-memory tests. There is no current
durable worker-attempt number, so an attempt-specific observation must not be
invented. Re-delivery and retry replay the same pickup/pre-mutation/terminal
identities.

No observation is emitted for an invalid cancellation request, a terminal-run
rejection, ordinary local workspace removal, or a process shutdown without
durable reconciliation evidence.

## Duplicate-suppression rules

1. Session 8.7 enqueue, Session 8.8 pickup, and Session 8.8 pre-mutation use
   different source/domain identities and intentionally produce three bounded
   lifecycle rows for one job.
2. Repeated enqueue/pickup/pre-mutation delivery reuses the exact source and
   logical identity, so the Session 8.5 canonical-operation uniqueness returns
   the existing row.
3. A rollback uses only the rollback-record ID. Manual and automatic callers
   must not each emit an observation before entering the shared rollback
   service.
4. Cancellation has one frozen durable-source row:
   `pipeline_service.cancel_persisted` with `cancel:<runId>:cancelled`.
   The worker cancellation catch emits no second lifecycle row.
5. A terminal success/failure identity includes the immutable outcome to avoid
   merging contradictory states. A later explicit retry creates a new run/job
   identity; it does not reopen the old terminal observation.
6. Destroy and central-cleanup records are keyed by their own operation IDs,
   never by a release run, because one cleanup operation may target multiple
   resources or originate without a deployable project.

## Failure isolation

Every future call must use the existing detached insertion adapter contract:
catch synchronous throws, detach asynchronous observation, and ignore timeout,
idempotency conflict, database failure, and observer rejection. It must not
modify a rollback call, cancellation write/job removal, worker retry/throw,
status transition, state-lock cleanup, or local workspace cleanup.

The observer must receive only project ID, `dev`, a bounded operation class,
source, and deterministic logical identity. It must not receive rollback
reason, actor, queue payload, job data, deployment/release/task identifiers,
state key, resource list, credentials, cloud output, or raw error.

## Bypass and design risks

- `PipelineWorkerService.tryRollback()` is currently unreferenced but calls the
  manual orchestration API if activated. It is a future duplicate/mislabel risk
  and must be refactored to use the shared automatic rollback context before
  any instrumentation.
- `RollbackService` has no transaction spanning rollback record creation, ECS
  mutation, and terminal records. A post-crash outcome needs reconciliation;
  it must never rerun an uncertain ECS mutation automatically.
- Existing pipeline cancellation marks an active run cancelled before a worker
  necessarily reaches a checkpoint. A terminal cancellation observer cannot
  claim that cloud work stopped; it may only report the persisted intent.
- No legacy pipeline orphan-job reconciler currently proves worker death or
  terminalizes stuck runs. Session 8.9 defines its identity only; it does not
  authorize implementation.
- Terraform destroy, direct cloud residue cleanup, emergency cleanup, stale
  lock removal, and workspace deletion have different resource scope and
  locking. They remain outside release ownership and require a separate
  deletion/infrastructure-lane design.
- Direct `CentralCloudCleanupService` cleanup can operate on orphan resources
  with no project ID; project/environment identity is insufficient.

## Future implementation surface

| Concern | Exact files/methods |
| --- | --- |
| shared rollback observation | `backend/src/orchestration/rollback.service.ts: rollbackToPreviousStable` |
| manual/automatic caller context only if needed | `backend/src/orchestration/orchestration.service.ts: rollback, attemptAutoRollback` |
| remove or correct dormant worker rollback bypass before use | `backend/src/projects/pipeline/pipeline-worker.service.ts: tryRollback` |
| cancellation and worker terminal lifecycle observation | `backend/src/projects/pipeline/pipeline.service.ts: cancelRun`; `pipeline-worker.service.ts: process catch/finally` |
| state recovery observation, separately classified | `backend/src/state-management/state-management.service.ts: recover, forceRelease, clearStaleLockfile`; `orphaned-lock-monitor.service.ts` |
| deletion-lane design, not release shadow wiring | `backend/src/infrastructure-lifecycle/infrastructure-lifecycle.service.ts`; `infrastructure-lifecycle-worker.service.ts`; `central-cloud-cleanup.service.ts`; `emergency-cleanup*.ts` |
| bounded type expansion and adapter | `backend/src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.types.ts`; `inactive-legacy-shadow-insertion.adapter.ts` |

## Required test matrix before implementation

### Fixture/static tests

1. Manual and automatic rollback through the same rollback service create one
   request, one pre-mutation, and one terminal identity per rollback record.
2. Repeated rollback record processing replays observation identities without
   invoking ECS or changing rollback results.
3. Cancelled waiting, delayed, paused, active, and terminal runs follow the
   table above; rejected terminal cancellation creates no observation.
4. Worker throw/retry/re-delivery preserves the original result and creates no
   second pickup/pre-mutation/terminal identity.
5. Workspace-only cleanup and read-only inventory emit no release observation.
6. Every adapter path is detached and rejects raw reason/actor/deployment/job
   payload input.
7. Static tests prove no observer call in central cleanup, deletion worker, or
   rollback mutation before the frozen implementation session.

### Isolated PostgreSQL tests

1. Concurrent manual and automatic rollback attempts on one project create
   separate rollback records but no duplicate observation for either record.
2. Concurrent replays of one rollback record produce one row per source.
3. Cancellation and terminal worker writes replay their canonical identities.
4. Terminal failure/success identities cannot overwrite each other.
5. A stale/orphan recovery observation cannot be written without its durable
   recovery record.
6. Cross-environment evidence cannot affect legacy `dev` observations.
7. Rollback/cancellation observer failure does not roll back the underlying
   durable legacy state transition.

The blocked isolated PostgreSQL suites from Sessions 8.5–8.8 (shadow observer,
ownership, correlation, and migration safety) are a prerequisite before any
ownership-enforcement session. They must be re-run against their temporary
schemas before enforcement is considered.

## Exact Session 8.10 task

Implement **only the default-off, non-blocking shared rollback shadow adapter
insertion** inside `RollbackService.rollbackToPreviousStable()`: observe the
durable rollback-record request, immediately-before-ECS mutation, and durable
terminal outcome. Do not wire `PipelineWorkerService.tryRollback`,
`OrchestrationService` caller-level observations, cancellation, cleanup,
destroy, or ownership enforcement in Session 8.10.
