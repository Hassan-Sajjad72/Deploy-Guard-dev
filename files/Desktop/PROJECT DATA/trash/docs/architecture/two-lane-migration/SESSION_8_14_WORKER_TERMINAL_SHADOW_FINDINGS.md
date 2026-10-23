# Session 8.14 — Inactive Legacy Worker-Terminal Shadow Findings

## Result

Implemented default-off, detached legacy worker-terminal shadow observations.
They are submitted only by `PipelineJobFinalityService`, after its
serializable transaction has created or replayed a durable finality row.
`PipelineWorkerService` does not call the shadow adapter directly for terminal
events.

Both gates must be enabled independently:

```text
LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED=true
TWO_LANE_OWNERSHIP_SHADOW_MODE=true
```

With either gate absent, false, malformed, or unknown, no terminal shadow row
is written. Finality remains independently default-off.

## Finality-to-observation boundary

| Durable finality decision | Shadow class | Source | Raw logical identity |
| --- | --- | --- | --- |
| `completed` | `legacy_worker_terminal_success` | `pipeline_worker.completed_persisted` | `worker-terminal:<runId>:<jobId>:completed` |
| `failed_after_retries_exhausted` | `legacy_worker_terminal_failure` | `pipeline_worker.failed_persisted` | `worker-terminal:<runId>:<jobId>:failed` |

The adapter hashes the logical identity before persistence. Shadow rows contain
only the pre-existing sanitized observer fields and a deterministic evidence
hash; they do not retain pipeline run IDs, BullMQ job IDs, payloads, repository
data, credentials, cloud identifiers, error text, or runtime output.

Duplicate BullMQ lifecycle events replay the existing finality record and the
existing shadow observation. A contradictory finality decision remains a
fail-closed finality conflict and therefore cannot emit a new observation.

The observer call is detached after finality persistence. Its timeout,
exception, transaction error, or idempotency conflict cannot alter finality,
worker execution, attempts, backoff, queue state, run status, pipeline event,
exception, or cloud behaviour.

## Explicit exclusions

No terminal shadow observation is created for retrying/delayed jobs, active or
waiting work, paused approval paths, cancelled runs, storage-provisioning
active status, worker shutdown, stalls, crashes, orphaned jobs, or uncertain
external effects. This session does not claim a deployment succeeded, an app
is healthy, a release is stable, or cloud work stopped.

## Files changed

- `backend/src/projects/pipeline/pipeline-job-finality.service.ts`
- `backend/src/projects/pipeline/pipeline-worker.service.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.types.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-release-lane-shadow-observer.service.ts`
- `backend/scripts/verify-inactive-legacy-worker-terminal-shadow.ts`
- `backend/scripts/verify-inactive-legacy-worker-terminal-shadow-postgres.ts`
- `backend/scripts/verify-inactive-legacy-worker-shadow-insertion.ts`
- `backend/scripts/verify-pipeline-job-finality-evidence.ts`
- `backend/package.json`

## Verification

| Check | Result |
| --- | --- |
| Terminal adapter fixture: exact classes, sources, identities, duplicate input, sanitization | Passed |
| Finality fixture: default-off, finality preconditions, retry exclusion, conflicts | Passed |
| Isolated PostgreSQL finality → shadow persistence/replay/disabled shadow | Passed |
| Isolated PostgreSQL finality migration/concurrency test | Passed |
| Isolated Redis/BullMQ retry semantics (`bullmq@5.79.2`) | Passed |
| Existing shadow observer fixture and PostgreSQL regressions | Passed |
| Existing legacy worker shadow insertion regression | Passed |
| Two-lane migration static and isolated PostgreSQL regressions | Passed |
| Automation regression | Passed |
| TypeScript type-check and backend build | Passed |
| `git diff --check` | Passed |

All PostgreSQL verification used generated temporary schemas which were dropped
afterward. The BullMQ test used a generated queue name and obliterated it.
No normal application data, public endpoint, frontend, worker activation,
Terraform, ECS, AWS, Docker, ECR, or deployment execution was invoked.

## Remaining limitations

Crash, stalled, shutdown, orphan, and uncertain-effect finality still require
a separately designed reconciliation path with durable target evidence. Shadow
observation remains observation-only; it does not provide cross-lane mutual
exclusion or ownership enforcement.
