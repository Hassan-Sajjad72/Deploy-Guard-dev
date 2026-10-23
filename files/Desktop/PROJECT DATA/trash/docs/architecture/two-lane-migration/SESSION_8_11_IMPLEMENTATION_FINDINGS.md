# Session 8.11 — Inactive Legacy Cancellation Shadow Observation Findings

## Status

Session 8.11 adds one default-off, detached legacy shadow observation to the
accepted cancellation path in `PipelineService.cancelRun()`. It is diagnostic
only and does not acquire, renew, release, correlate, or enforce ownership.
Cross-lane mutual exclusion remains inactive.

No worker cancellation handling, rollback, cleanup, deletion, reconciliation,
queue behavior, endpoint, frontend, v1, or cloud behavior changed.

## Insertion and identity

The only production call is at
`backend/src/projects/pipeline/pipeline.service.ts:266-270`: immediately after
the existing durable `runRepository.save(run)` and before the pre-existing
event write and queued-job removal. This means invalid/missing/terminal runs
emit nothing because their existing validation exits before a save.

`InactiveLegacyShadowInsertionAdapter.observeCancellationPersisted()` accepts
only project ID and pipeline run ID. It fixes these fields:

| Field | Value |
| --- | --- |
| Lane | `legacy` |
| Environment | `dev` |
| Operation class | `legacy_cancel` |
| Source | `pipeline_service.cancel_persisted` |
| Logical identity | `cancel:<pipelineRunId>:cancelled` |

The Session 8.5 observer hashes that logical identity before persistence. No
actor, cancellation reason, run metadata, job payload, queue data, variables,
credentials, cloud data, or raw error reaches it. Waiting/delayed queue jobs,
paused approval runs, and active runs all use the same saved run ID identity.

The adapter contains synchronous and asynchronous failure isolation. A shadow
exception, timeout, database failure, or idempotency conflict cannot change
the saved cancellation, event, queue removal, return value, or exception.
When `TWO_LANE_OWNERSHIP_SHADOW_MODE` is absent or not exactly `true`, the
observer returns before any database access.

## Files changed

- `backend/src/projects/pipeline/pipeline.service.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.types.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service.ts`
- `backend/scripts/verify-inactive-legacy-cancellation-shadow-insertion.ts`
- `backend/scripts/verify-inactive-legacy-cancellation-shadow-insertion-postgres.ts`
- `backend/package.json`

## Verification evidence

### Passed

| Command | Result |
| --- | --- |
| `npm run test:inactive-legacy-cancellation-shadow-insertion` | Fixture verifies queued, paused cost/apply approval, active, rejected terminal, detached failure/timeout, disabled mode, exact source/identity, queue-removal preservation, and no worker wiring. |
| `npm run test:inactive-legacy-cancellation-shadow-insertion:postgres` | Isolated temporary-schema test verifies durable idempotent replay, sanitization, and disabled non-persistence. |
| `npm run test:automation` | Existing cancellation validation, queued-job removal, and worker checkpoint regression passed. |
| `npm run test:inactive-legacy-shadow-insertion` | Existing legacy enqueue insertion regression passed. |
| `npm run test:inactive-release-lane-shadow-observer` and `:postgres` | Existing default-off observer and isolated PostgreSQL regression passed. |
| `npm run test:two-lane-migrations` and `:postgres` | Static and isolated legacy-shaped migration regressions passed. |
| `npx tsc --noEmit --incremental false`; `npm run build` | Passed. |
| `git diff --check` | Passed. |

### Failed

The first isolated PostgreSQL run exposed a test-only SQL alias error in the
new fixture (`to_jsonb(t)` without `FROM ... t`). It was corrected immediately;
the rerun passed. No production behavior failed.

### Not executed

None of the requested focused checks remain unexecuted. Isolated PostgreSQL
tests used unique temporary schemas; the normal application database was not
used. No Terraform, ECS, AWS, Docker, ECR, or production queue action ran.

## Remaining scope

Worker-terminal cancellation, worker failure/success terminal observation,
stale-job recovery, rollback callers, cleanup, deletion, and ownership
enforcement remain intentionally unchanged.

## Exact next bounded task

Freeze and review the worker-terminal observation contract before adding any
worker cancellation/failure/success observation. It must use durable terminal
evidence only and must not claim that an active cloud mutation stopped merely
because cancellation was requested.
