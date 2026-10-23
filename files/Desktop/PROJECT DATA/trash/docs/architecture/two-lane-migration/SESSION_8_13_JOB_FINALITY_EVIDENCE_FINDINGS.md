# Session 8.13 — Inactive Durable BullMQ Job-Finality Evidence Findings

## Result

Implemented default-off, additive evidence for exact legacy BullMQ jobs. This
session does **not** add worker-terminal shadow observations, ownership
enforcement, cancellation handling, crash/stall recovery, or any cloud action.

The feature is enabled only when:

```text
LEGACY_PIPELINE_JOB_FINALITY_EVIDENCE_ENABLED=true
```

Missing, false, malformed, or non-string values are disabled. Disabled mode
returns before opening a transaction or writing a row.

## Evidence model

`project_pipeline_job_finalities` is an additive table with one immutable
decision per `(pipeline_run_id, bullmq_job_id)`:

- `completed`
- `failed_after_retries_exhausted`

It stores only project/run IDs, the exact queue job ID, the bounded decision,
a SHA-256 evidence hash, and timestamp. It stores no queue payload,
repository information, credentials, cloud identifiers, exception text, or
runtime output. The unique index makes duplicate lifecycle events idempotent;
a contradictory completed/failed decision for the same run/job fails closed.

Migration `1760000046000-CreatePipelineJobFinalities.ts` is additive and
idempotent. It refuses rollback once evidence exists, because deleting finality
history would remove a durable retry/fencing audit boundary. Empty-history
rollback is supported and tested.

## Installed BullMQ semantics and integration

The installed package is pinned to `bullmq@5.79.2`.

Direct inspection and an isolated Redis test established that its worker emits
`failed` after each failed processor attempt. Retrying jobs are moved to
`delayed`/waiting; only the exhausted job is moved to state `failed`, with
`attemptsMade >= opts.attempts`. `completed` is emitted after
`moveToCompleted`.

`PipelineWorkerService` therefore adds only detached, best-effort listeners:

- `completed`: asks the recorder to verify the exact run is `COMPLETED` and a
  durable successful pipeline event exists before recording `completed`.
- `failed`: queries the exact job state after BullMQ has moved it. It records
  failure only when state is `failed`, attempts are exhausted, the run is
  `FAILED`/`STORAGE_FAILED`, and a durable failed pipeline event exists.

Finality recorder failures are caught and reduced to a bounded log code. They
cannot change job attempts, backoff, redelivery, cancellation, status,
exceptions, queue state, or cloud behaviour. A cancelled job, active/delayed/
waiting/paused job, storage-provisioning active status, stalled job, shutdown,
and orphan are ineligible.

The finality model states only a queue/pipeline lifecycle fact. It is not a
claim that ECS, Terraform, Docker, or another external side effect completed
or stopped.

## Files changed

- `backend/src/projects/pipeline/project-pipeline-job-finality.entity.ts`
- `backend/src/projects/pipeline/pipeline-job-finality.service.ts`
- `backend/src/projects/pipeline/pipeline-worker.service.ts`
- `backend/src/projects/projects.module.ts`
- `backend/src/app.module.ts`
- `backend/src/data-source.ts`
- `backend/src/migrations/1760000046000-CreatePipelineJobFinalities.ts`
- `backend/scripts/verify-pipeline-job-finality-evidence.ts`
- `backend/scripts/verify-pipeline-job-finality-evidence-postgres.ts`
- `backend/scripts/verify-pipeline-job-finality-evidence-bullmq.ts`
- `backend/package.json`

## Verification

| Check | Result |
| --- | --- |
| Fixture recorder, disabled mode, idempotency, conflict, retry exclusion, cancellation exclusion, sanitization | Passed |
| Isolated PostgreSQL migration apply-twice, empty rollback, restricted rollback, concurrent duplicate recording | Passed |
| Isolated Redis/BullMQ one-attempt success, retry-then-success, retry exhaustion | Passed |
| Installed BullMQ semantics inspected | Passed (`5.79.2`) |
| TypeScript type-check | Passed |
| Backend build | Passed |
| Existing worker shadow-insertion regression | Passed |
| Existing two-lane migration static regression | Passed |
| Existing isolated two-lane migration regression | Passed |
| Existing automation regression | Passed |
| `git diff --check` | Passed |

The PostgreSQL tests use a generated temporary schema and drop it afterward.
The BullMQ test uses a generated queue name and obliterates it afterward. No
normal application data, running worker, deployment job, Terraform, ECS, AWS,
or frontend was used.

## Remaining risks and next bounded task

This does not cover stalls, process death, lock loss, orphaned jobs, or
uncertain cloud effects; those require a future reconciliation contract with
its own durable target evidence. It also deliberately does not turn finality
evidence into a shadow observation.

The next bounded task may add the previously frozen worker-terminal shadow
observer calls only after these finality records, preserving the same
run/job/decision identity and keeping cloud-outcome wording out of the
observation. Cross-lane mutual exclusion remains inactive.
