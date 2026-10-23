# Session 8.3 — Legacy/v1 Ownership Enforcement Plan

## Status and boundary

This document freezes the integration protocol for
`InactiveReleaseLaneOwnershipService`. It is design-only. No runtime source,
test, configuration, queue, worker, endpoint, or frontend file was changed in
this session.

The guard remains inactive. It is **not** correct to wire only the v1 consumer
or only the legacy worker: until both lanes use this protocol at every listed
mutation boundary, the application must continue to describe cross-lane mutual
exclusion as inactive.

## Scope and identities

### Canonical scope

The owner scope is exactly:

```
scope = (projectId, normalizeEnvironment(environmentName))
```

`normalizeEnvironment` is the current frozen lower-case, trimmed matcher
`^[a-z0-9][a-z0-9_-]{0,63}$`.

Legacy `ProjectPipelineRun` has no environment column. Existing legacy
infrastructure, deployment, rollback, ECR tagging, and stable-release code
all use `dev` (`infrastructure.service.ts:196-215`,
`orchestration.service.ts:192-196`, `rollback.service.ts:29-48`). Therefore:

- all existing legacy release mutations are `legacy/dev`;
- a v1 `dev` release conflicts with legacy;
- a non-`dev` v1 environment does not conflict with today’s legacy model; and
- production activation must initially be restricted to `dev`, unless a
  separately reviewed legacy environment link is added. No inferred mapping
  from a legacy run to `production` is allowed.

### Owner identity

| Field | Legacy value | v1 value |
| --- | --- | --- |
| `ownerLane` | `legacy` | `v1` |
| `leaseId` | New UUID per logical legacy run/recovery/rollback operation | The exact `project_operation_leases.id` created for the envelope |
| `actorId` | `user:<id>` for request-triggered work; `legacy-worker:<stable-worker-id>` after pickup | Exact `workerId` from a compatible v1 capability |
| `idempotencyKey` | SHA-256 of `legacy:<operation>:<project>:dev:<run-or-rollback-id>` | Existing canonical intent idempotency key, domain-separated as `v1:<intent-id>` before hashing |
| `requestFingerprint` | SHA-256 of immutable run/recovery/rollback input identity; no runtime values | Existing immutable request fingerprint plus exact manifest revision IDs |
| `fencingToken` | Returned guard token; stored with the legacy operation before mutation | Returned guard token; cross-checked with, but never substituted for, the operation-lease token |

The cross-lane token and v1 `project_operation_leases.fencing_token` are
different fences with different purposes. A future implementation must pass
both exact tokens to any v1 terminal transition. It must never reuse one token
as the other.

## Complete path inventory

### Legacy entry paths

| Entry | Current path | First mutation after entry | Required future cross-lane insertion |
| --- | --- | --- | --- |
| Automation start | `ProjectsController.startAutomation()` → `PipelineService.startRun()` → `runPipeline/full_deploy` (`projects.controller.ts:234-316`, `pipeline.service.ts:66-225`) | Legacy worker clone/build/ECR/Terraform/ECS in `PipelineWorkerService.process()` (`pipeline-worker.service.ts:250-407`) | Acquire before creating/queuing an executable run; revalidate on worker pickup before any mutation. |
| Direct pipeline start | `POST :projectId/pipeline/runs` → `PipelineService.startRun()` (`projects.controller.ts:337-351`) | Same `full_deploy` worker path | Same as automation start. |
| Retry | `POST .../retry` → `assertRetryableRun()` → `startAutomation()` (`projects.controller.ts:401-413`) | Creates a new full legacy run | New logical retry identity; acquire before queue. Never inherit a completed/failed owner lease. |
| Full recovery resume | `StageSelectiveResumeService.execute()` mode `full` → `PipelineService.startRun()` (`stage-selective-resume.service.ts:49-60`) | New full legacy run | Same as start, with recovery fingerprint as request fingerprint input. |
| Stage-selective resume | `execute()` → `createSelectiveRun()` → `runPipeline/stage_selective_resume` (`stage-selective-resume.service.ts:81-193`) | Docker/ECR/Terraform/ECS according to rerun stages (`pipeline-worker.service.ts:485-576`) | Acquire before queue only when rerun stages contain a deployment mutation; worker rechecks before first such stage. Cleanup-only remains outside release ownership. |
| Cost approval resume | `FinopsService.resumePipelineAfterCostApproval()` queues `resume_after_cost_approval` (`finops.service.ts:250-293`) | Terraform apply/ECS in `processCostApprovalResumeJob()` | Must reacquire/revalidate the same logical run owner before applying or ECS mutation. |
| Apply approval resume | `PipelineService.approveTerraformApply()` queues `resume_after_apply_approval` (`pipeline.service.ts:318-392`) | Terraform apply/ECS in `processApplyApprovalResumeJob()` | Must hold/reacquire the same owner before the queue insert and revalidate before mutation. |
| State-lock resume | `InfrastructureService.releaseStateLock()` queues `resume_after_state_lock` (`infrastructure.service.ts:1368-1423`) | Plan/apply/ECS in `processStateLockResumeJob()` | Retain ownership while queued for state lock; renew only while worker executes. Reclaim only after both state queue and run are inactive. |
| Direct infrastructure deploy | `OrchestrationService.deploy()` → `InfrastructureService.deploy()` (`orchestration.service.ts:51-53`, `infrastructure.service.ts:148-165`) | Creates and queues `full_deploy` | Acquire as legacy before `createInfrastructureRun` and queue. |
| Direct plan/apply | `InfrastructureService.queuePlan()/queueApply()` (`infrastructure.service.ts:167-194`) | Terraform plan/apply worker branch | These are infrastructure-lane operations, not release-only. They must be assessed with the same project/environment cross-lane fence before a Terraform mutation, but Session 8 release-only activation must not silently claim they are covered. |
| Storage provisioning | `StorageService.provision()` queues `storage_provision` (`storage.service.ts:95-143`) | EFS/Terraform provisioning | Infrastructure mutation, explicitly out of the release-only guard’s first activation scope; must be blocked or separately integrated before any same-scope v1 release activation. |
| Manual rollback | `POST orchestration/rollback` → `OrchestrationService.rollback()` → `RollbackService.rollbackToPreviousStable()` (`orchestration.controller.ts:39-49`, `orchestration.service.ts:118-136`, `rollback.service.ts:78-191`) | ECS `updateServiceToTaskDefinition` | Acquire `legacy/dev` before the first rollback record or ECS update, retain through stability/ALB verification, then release only after terminal outcome. |
| Automatic rollback | Deployment health failure → `OrchestrationService.attemptAutoRollback()` → same rollback service (`orchestration.service.ts:341-371`) | Same ECS update | It must reuse the active legacy run owner only if exact run identity/fence is still trusted; otherwise acquire a new rollback owner before mutation. |
| Cancellation | `PipelineService.cancelRun()` marks run cancelled and removes waiting jobs (`pipeline.service.ts:228-294,524-534`) | No AWS mutation itself | Request cancellation, stop trusted work at stage checks, then release only after no active worker mutation remains. A queued-only run can release in the cancellation transaction. |
| Failure/crash cleanup | Worker catch marks failed; `finally` removes workspace (`pipeline-worker.service.ts:408-470`) | No general lease release exists today | Future `finally` must attempt fenced release after terminal persistence. Crash recovery may reclaim only after expiry plus inactive underlying run/job evidence. |

### Legacy bypasses that must be closed

1. `PipelineWorkerService.process()` accepts every legacy job type from the
   shared queue. Guarding HTTP controllers alone does not cover delayed jobs,
   cost/apply/state-lock resumes, or a direct queue writer.
2. `RollbackService.rollbackToPreviousStable()` is called both manually and
   automatically, so wrapping only `OrchestrationController` is insufficient.
3. `InfrastructureService` creates direct full-deploy, plan, and apply runs;
   it bypasses `PipelineService.startRun()`.
4. Storage provisioning and destroy/cleanup are infrastructure/deletion paths.
   They are deliberately not release-only paths, but they become an activation
   blocker for a shared `dev` scope until the broader lane protocol covers
   them.

### v1 entry and exit paths

| Phase | Current exact source | Future ownership rule |
| --- | --- | --- |
| Planning | `TransactionalDeploymentPlannerService.plan()` uses a serializable planner lock and creates immutable intent/outbox rows (`transactional-deployment-planner.service.ts:158-424`) | **Do not acquire cross-lane ownership during planning.** Planning is immutable/pure with no release mutation. Record a shadow decision only. |
| Dispatch | `DurableOutboxDispatcherService.dispatchOne()/claimNext()/completeDelivery()` (`durable-outbox-dispatcher.service.ts:57-240`) | Do not acquire during dispatch. Delivery remains retryable and should only publish a frozen job. Ownership begins at execution claim. |
| Consumer | Explicit `InactiveV1BullMqConsumerService.start()` and `processJob()` (`inactive-v1-bullmq-consumer.service.ts:75-196`) | Before calling v1 pre-execution ownership, acquire cross-lane owner in the same execution boundary. Consumer remains default-off. |
| V1 operation claim | `InactiveV1PreExecutionOwnershipService.claim()` (`inactive-v1-pre-execution-ownership.service.ts:80-230`) | Frozen order: cross-lane guard first, then exact v1 intent/operation lease claim. If operation claim fails, release the newly acquired cross-lane owner in the same failure path. |
| Invocation/heartbeat | `InactiveV1FencedInvocationService.invoke()` claims, starts heartbeat, calls one handler, then complete/release/fail (`inactive-v1-fenced-invocation.service.ts:80-240`) | Cross-lane heartbeat renewal is required alongside operation-lease heartbeat. Lost trust in either fence aborts further side effects and terminal writes. |
| Retryable result | Invocation calls operation `release()` and consumer delays job (`inactive-v1-fenced-invocation.service.ts:224-233`; `inactive-v1-bullmq-consumer.service.ts:177-195`) | Release cross-lane owner after the v1 operation lease returns to `enqueued`; it must not remain held while a delayed job is unowned. The deterministic intent/key remains the re-acquisition identity. |
| Success/failure | Invocation calls fenced operation `complete()` or `fail()` | Fenced terminal intent update first, then cross-lane release with the exact cross-lane fence. If release fails, retain a terminal ownership record for reconciler cleanup; never reopen intent. |
| Side-effect reconciliation | `InactiveV1SideEffectReconciliationCoordinatorService` claims only read-only reconciliation leases (`...coordinator.service.ts:289-458`) | Reconciliation must not take a release owner or repeat a side effect. It may inspect terminal/uncertain evidence only. If it changes an intent back to executable in a future session, that new execution must acquire a new cross-lane owner. |
| Cancellation/crash recovery | No v1 cancellation endpoint, scheduler, or active consumer exists. Existing runtime returns terminal/idempotent no-ops for terminal/superseded intents. | This is a design gap. A future v1 control facade must define fenced cancellation and terminal owner release before v1 activation. Lease expiry alone is not a cancellation protocol. |

## Frozen ordering and transitions

### v1 ordering

For an executable v1 release intent only:

1. Validate frozen envelope, route, capability, intent identity, and allowlist.
2. Normalize `(projectId, environmentName)`.
3. Start one serializable transaction and acquire the cross-lane ownership
   advisory lock/row as `v1`.
4. In the same request boundary, claim the v1 `project_operation_lease` and
   transition `deployment_intents.enqueued → running` using its existing
   fenced transaction.
5. If step 4 does not claim exactly one lease/intent, fenced-release the
   cross-lane owner and return the existing idempotent/no-op result.
6. Start both lease heartbeats only after both claims exist.
7. Before every side effect, require both fences, cancellation state, exact
   intent/manifests, and side-effect idempotency proof.
8. On success/failure/retry, finalize the v1 intent with the operation fence;
   only then release the cross-lane owner using its independent token.

The first two locks must never be held while calling Redis, ECS, Docker,
Terraform, ECR, an external API, or a handler. PostgreSQL transaction locks are
used only for state transitions. Long-running work is protected by leases and
heartbeats.

### Legacy ordering

Before **any** legacy release mutation (including ECS rollback), create/reuse a
legacy owner for `(project, dev)` with a deterministic operation identity:

1. Validate project access and derive the immutable logical operation key.
2. Acquire the cross-lane owner in a serializable transaction before creating
   a mutating job/run or before a direct ECS rollback update.
3. Persist the returned cross-lane lease ID/token on the legacy run or rollback
   record in a dedicated nullable link added in the implementation session.
4. Queue work only after that persistence succeeds.
5. On worker pickup and before every Terraform/ECR/ECS/Docker side effect,
   require exact active legacy owner identity and fence.
6. Renew during active work. Pause/requeue states retain the owner only if the
   same logical run remains safely active; otherwise release and reacquire on
   resume.
7. Fenced terminal status/write first; fenced owner release second.

There is no valid legacy path that may acquire an operation or cloud mutation
lock before the cross-lane owner. Existing Terraform state lock ordering is
therefore:

```
cross-lane release owner → legacy run identity → Terraform state queue/lock
```

The cross-lane guard is never acquired while holding an existing Terraform
state lock, to avoid inversion with queued state-lock resumes.

### Hold/release matrix

| Condition | Owner state |
| --- | --- |
| Queued but no worker has started a side effect | Hold only if queue/run has a durable owner link; cancellation releases immediately after removing waiting job. |
| Waiting for cost or Terraform approval | Release cross-lane owner after durable paused state. Approval resume reacquires before mutation. |
| Waiting for Terraform state lock | Retain only through a short bounded lease while the queue item is active; after expiry, reclaim requires no active legacy run/job and no active v1 intent/operation. |
| Active build/ECR/Terraform/ECS/rollback | Hold and heartbeat. |
| Retryable v1 result / delayed redelivery | Release after fenced operation lease release; reacquire at next claim. |
| Success, terminal failure, cancellation, verified rollback | Persist terminal result, then fenced release. |
| Uncertain side effect | Retain only until the active execution lease stops; mark uncertain, release, and require read-only reconciliation. Never silently repeat. |
| Process crash | No release write occurs. Expiry replacement requires a higher token and proof that underlying run/job/operation is not active. |

## Stale ownership proof

The existing guard requires exact owner lane, lease ID, actor ID, and fencing
token for renewal/release. Replacement overwrites the scope only with a higher
token. Consequently a stale worker cannot renew, release, or overwrite the
replacement. Future legacy persistence must carry all four values; a
project-only release call is prohibited.

No terminal finalizer may use a best-effort unconditional `UPDATE` by
`project_id`. Both lanes must use predicates including scope, lane, lease,
actor, token, active status, and expiry.

## Shadow-only observation phase

Before enforcement, add a default-off `TWO_LANE_OWNERSHIP_SHADOW_MODE=true`
observer that performs no acquisition and never blocks/queues/cancels work.
At each future insertion point it will read the ownership row plus safe
underlying legacy/v1 activity and emit a sanitized audit/activity record:

```
projectId, normalizedEnvironment, proposedLane, operationClass,
decision(acquirable|would_block_legacy|would_block_v1|unsafe_stale),
currentOwnerLane?, currentFencingToken?, source, timestamp
```

It must exclude lease IDs, actor IDs, repository URLs, manifests, payloads,
cloud identifiers, environment values, credentials, SDK errors, and user
secrets. It must be sampled/idempotent per logical operation to avoid event
flooding. No frontend surface is needed; Activity Log remains the only future
reader.

Shadow exit criteria: a representative legacy full deploy/retry/resume/manual
rollback and a v1 fixture intent/dispatch/claim sequence show no unexplained
simultaneous claimable scope. Any non-`dev` legacy observation is a release
blocker, not an auto-normalization opportunity.

## Exact implementation surface

| Purpose | Files/methods to change in the implementation session |
| --- | --- |
| Legacy acquisition before new run | `projects/pipeline/pipeline.service.ts: startRun, cancelRun, approveTerraformApply`; `infrastructure/infrastructure.service.ts: deploy, queuePlan, queueApply, enqueue`; `projects/recovery/stage-selective-resume.service.ts: execute, createSelectiveRun`; `finops/finops.service.ts: resumePipelineAfterCostApproval`; `storage/storage.service.ts: provision` |
| Legacy worker trust/heartbeat/finalization | `projects/pipeline/pipeline-worker.service.ts: process, processStageSelectiveResumeJob, processCostApprovalResumeJob, processApplyApprovalResumeJob, processStateLockResumeJob, tryRollback`; add a dedicated legacy ownership adapter rather than copying raw SQL |
| Legacy rollback | `orchestration/orchestration.service.ts: rollback, attemptAutoRollback`; `orchestration/rollback.service.ts: rollbackToPreviousStable` |
| v1 execute ordering | `orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service.ts: processJob`; `inactive-v1-fenced-invocation.service.ts: invoke`; `inactive-v1-pre-execution-ownership.service.ts: claim, renew, complete, fail, release` |
| v1 planning/dispatch observation only | `planner/transactional-deployment-planner.service.ts: plan`; `outbox/durable-outbox-dispatcher.service.ts: dispatchOne, claimNext, completeDelivery` |
| Reconciliation isolation | `worker-runtime/inactive-v1-side-effect-reconciliation*.service.ts`; do not invoke execution ownership from read-only reconciliation |
| Guard/persistence contracts | `release-lane/inactive-release-lane-ownership.service.ts` and its entity/migration; add nullable legacy run/rollback ownership links only in that future implementation session |
| Composition | `release-lane/inactive-v1-release-lane-composition.ts` may receive the adapter factory, but must not acquire during construction |

## Required implementation tests

### Isolated PostgreSQL tests

1. Concurrent legacy start and v1 consumer claim for the same `dev` scope:
   exactly one owner and exactly one higher fencing sequence.
2. Legacy retry, selective resume, cost approval, apply approval, and
   state-lock resume each reacquire or reuse only the matching logical owner.
3. Manual and automatic rollback conflict with a v1 release and cannot call
   the ECS mutation stub.
4. v1 operation-lease transition failure rolls back/release-cleans the newly
   acquired cross-lane owner.
5. v1 retryable result releases both the execution lease and cross-lane owner;
   redelivery reacquires with higher cross-lane fence.
6. Legacy cancellation removes queued work and releases only a queue-only
   owner; active worker cancellation waits for fenced finalization.
7. Expired owner with live legacy run, active v1 intent, or active v1 operation
   lease returns `expired_not_recoverable`.
8. Replacement fence rejects stale legacy and v1 renew/release/finalize calls.
9. `dev` conflicts; `staging`/`production` isolation works; any legacy
   non-`dev` attempt fails closed until a legacy environment link exists.
10. Transaction rollback leaves no owner link, run status change, intent
    transition, or queue-outbox state partially committed.

### Runtime/fixture tests

1. Disabled composition and normal backend boot construct no observer,
   consumer, or active guard acquisition.
2. Fixture v1 consumer validates envelope/capability, acquires cross-lane then
   operation lease, and invokes one non-executing handler only.
3. Lost cross-lane heartbeat aborts handler finalization even when the v1
   operation lease remains valid; the inverse also aborts.
4. Queue/Redis failure before v1 claim creates no owner; failure after legacy
   persistence does not permit mutation without owner trust.
5. Shadow mode emits sanitized, idempotent decisions and never blocks a legacy
   or fixture v1 path.
6. Static tests reject direct `RollbackService`, `PipelineWorkerService`, and
   `InfrastructureService` cloud mutation calls that bypass the future adapter.

## Unresolved blockers

1. **Legacy environment is only provably `dev`.** Non-`dev` v1 activation must
   stay prohibited until legacy environment provenance is persisted and all
   legacy state readers/writers are migrated deliberately.
2. **No v1 cancellation/control facade exists.** There is no active v1
   planner/dispatcher/consumer caller and no canonical v1 cancellation or
   retry API. The enforcement implementation must add an internal, default-off
   control boundary before any v1 activation; it must not repurpose legacy
   controller endpoints.
3. **Infrastructure/deletion paths are not release-only.** Direct plan/apply,
   storage provisioning, and destroy need a broader lane policy before a
   shared project/environment production rollout. They must not be silently
   treated as legacy release work.

## Exact next bounded task

**Session 8.4: implement only the default-off shared ownership adapter and
shadow observer, with no legacy/v1 enforcement and no activation.** It should
persist nullable legacy owner links, expose a sanitized no-block observation
API for internal callers, and add the test harness above. A later, separately
authorized session must wire both lanes atomically after the shadow criteria
and unresolved blockers are cleared.
