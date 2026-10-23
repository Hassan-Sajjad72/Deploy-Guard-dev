# Session 8.10 — Shared Legacy Rollback Shadow Insertion Findings

## Status

Session 8.10 adds only default-off, best-effort legacy shadow observation in
`RollbackService.rollbackToPreviousStable()`. It does not acquire, renew,
release, correlate, or enforce ownership. Cross-lane mutual exclusion remains
inactive.

No `OrchestrationService` caller, `PipelineWorkerService.tryRollback()`,
cancellation, worker-terminal, cleanup, deletion, queue, endpoint, frontend,
AWS configuration, v1, or ECS rollback behavior was changed. The existing ECS
calls and rollback persistence order are unchanged.

## Exact insertion points

`RollbackService` optionally receives the existing
`InactiveLegacyShadowInsertionAdapter`; `OrchestrationModule` imports the
already-inactive `OrchestrationContractsModule` to make that dependency
available. Construction performs no observation or database write.

| Durable boundary | Service location | Observation |
| --- | --- | --- |
| Rollback record created | `rollback.service.ts:106-121` | request after `ProjectRollbackRecord` save |
| ECS rollback mutation | `rollback.service.ts:135-137` | immediately before the existing `updateServiceToTaskDefinition` call |
| Successful terminal persistence | `rollback.service.ts:171-185` | after deployment, rollback record, stable-release supersession, and target stable-release writes |
| Failed terminal persistence | `rollback.service.ts:199-211` | after failed deployment and rollback-record writes |

The no-record paths (no deployment, no previous stable target, or rollback
record save failure) emit nothing. The failure path rethrows the original
error after the existing durable rollback failure state; observation cannot
replace it.

## Identity and duplicate behavior

The adapter accepts only `projectId` and durable `rollbackRecordId`, fixes the
lane to `legacy`, environment to `dev`, and operation class to
`legacy_rollback`. It passes no deployment ID, reason, actor, pipeline run,
task definition, image, commit, AWS response, credential, queue payload, or
raw error.

| Boundary | Source | Logical identity |
| --- | --- | --- |
| Request | `rollback_service.record_created` | `rollback-request:<rollbackRecordId>` |
| Pre-mutation | `rollback_service.before_ecs_update` | `rollback-mutation:<rollbackRecordId>` |
| Success | `rollback_service.terminal_succeeded` | `rollback-terminal:<rollbackRecordId>:succeeded` |
| Failure | `rollback_service.terminal_failed` | `rollback-terminal:<rollbackRecordId>:failed` |

The Session 8.5 observer hashes each identity before persistence. Replaying a
given rollback record and source returns its existing observation; different
rollback records remain distinct even in the same project. Manual and
automatic rollback both enter the same shared service, so neither caller can
create a duplicate caller-level observation.

The adapter contains synchronous and asynchronous failure containment. A
disabled observer returns before a database read/write; a timeout, database
failure, or idempotency conflict is detached and cannot affect the ECS call,
rollback persistence, return value, exception, or retry behavior.

## Files changed

- `backend/src/orchestration/rollback.service.ts`
- `backend/src/orchestration/orchestration.module.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.types.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service.ts`
- `backend/scripts/verify-inactive-legacy-rollback-shadow-insertion.ts`
- `backend/scripts/verify-inactive-legacy-rollback-shadow-insertion-postgres.ts`
- `backend/package.json`

## Verification evidence

### Passed

| Command | Result |
| --- | --- |
| `npm run test:inactive-legacy-rollback-shadow-insertion` | Fixture covers manual/automatic shared paths, exact sources/identities, ECS failure, pre-record failure, detached observer failure/timeout, disabled mode, unchanged returns/errors, and static no-caller/no-worker wiring. |
| `npm run test:inactive-legacy-rollback-shadow-insertion:postgres` | Isolated temporary-schema test verifies one durable row per rollback source, concurrent duplicate replay, failed-terminal identity, sanitization, and disabled result. |
| `npm run test:inactive-legacy-shadow-insertion` | Existing legacy enqueue insertion regression passed. |
| `npm run test:inactive-legacy-worker-shadow-insertion` | Existing worker insertion regression passed. |
| `npm run test:inactive-release-lane-shadow-observer` and `:postgres` | Default-off, sanitization, idempotency, and isolated PostgreSQL observer checks passed. |
| `npm run test:inactive-release-lane-ownership` and `:postgres` | Existing inactive ownership contract/regression checks passed. |
| `npm run test:inactive-release-lane-correlation` and `:postgres` | Existing inactive correlation contract/regression checks passed. |
| `npm run test:two-lane-migrations` and `:postgres` | Static and isolated legacy-shaped migration checks passed. |
| `npm run test:automation`; `npm run test:deployment-recovery` | Existing legacy pipeline/recovery regression checks passed. |
| `npx tsc --noEmit --incremental false`; `npm run build` | Passed. |
| `git diff --check` | Passed. |

### Failed

None. Initial sandbox-only PostgreSQL attempts were blocked with `EPERM` on
local port 5433; each required suite was rerun with isolated temporary-schema
access and passed. The normal application database was not used.

### Not executed

None of the requested focused suites remain unexecuted. No Terraform, ECS,
AWS, Docker, ECR, or production queue action was invoked by the tests.

## Remaining paths and risks

- Cancellation, worker-terminal failure/success, stale-job reconciliation,
  `PipelineWorkerService.tryRollback()`, cleanup, and deletion remain outside
  this session exactly as frozen in Session 8.9.
- The legacy rollback record/ECS/terminal sequence is not one transaction. A
  process crash after the ECS mutation remains an uncertain-effect recovery
  problem and must not trigger an automatic repeat.
- Shadow observation is diagnostic only. It is not proof that rollback ran and
  does not provide mutual exclusion.

## Exact next bounded task

**Session 8.11:** insert one default-off, non-blocking cancellation shadow
observation only in `PipelineService.cancelRun()` after the durable cancelled
run write. Use `legacy_cancel`, source `pipeline_service.cancel_persisted`,
and identity `cancel:<pipelineRunId>:cancelled`; do not instrument worker
cancellation catch/finally, rollback, cleanup, or ownership enforcement.
