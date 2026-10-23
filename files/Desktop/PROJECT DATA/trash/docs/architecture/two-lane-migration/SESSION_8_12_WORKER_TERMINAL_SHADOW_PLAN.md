# Session 8.12 — Legacy Worker-Terminal Shadow-Observation Plan

## Scope and verdict

This is a design-only contract. No runtime, test, queue, cloud, status, or
ownership-enforcement code changed in this session.

`PipelineWorkerService.process()` has durable pipeline-run and event writes for
some terminal-looking outcomes, but it does **not** have durable BullMQ final-
attempt or cloud-outcome evidence. In particular, it persists `FAILED` before
the worker rethrows, while full-deploy jobs may be configured with more than
one BullMQ attempt. A worker-terminal observation must therefore describe only
the persisted worker/pipeline state, never a verified cloud result, and cannot
be implemented safely for success and failure together until retry finality is
made durable.

The existing Session 8.8 pickup and pre-mutation observations remain the only
worker observations. They use a route plus BullMQ job ID where available and a
test-only run/route fallback. This plan does not add terminal observations.

## Direct-source inventory

| Route or condition | Existing durable evidence | Classification | Terminal observation decision |
| --- | --- | --- | --- |
| Run already `CANCELLED` at worker entry | The earlier cancellation write in `PipelineService.cancelRun()` | cancelled before pickup | No worker-terminal observation. Session 8.11 owns the accepted cancellation request. |
| `PipelineCancelledError` in `process()` | `updateRun(... CANCELLED ...)` in the catch path | cancellation detected by worker | No worker-terminal observation. The write proves a requested/cancelled run, not that prior cloud work stopped. |
| Common full-deploy / pipeline-build happy path | `updateRun(... COMPLETED ...)`, then a completed `ProjectPipelineEvent` and audit entry | candidate completed worker run | Eligible only after the run status and completed event are durable; it is not proof that the application is live. |
| Stage-selective resume happy path | Its own `COMPLETED` run update, completion event, audit entry | candidate completed worker run | Same rule; use the existing stage-selective route. |
| Infrastructure plan/apply helper happy path | `COMPLETED` run update and completion event | candidate completed worker run | Same rule, but only when the helper actually reaches `COMPLETED`. A `planReady`/`applyReady` early return is non-terminal. |
| Cost-approval and apply-approval resume happy paths | Their own `COMPLETED` run updates and events | candidate completed worker run | Same rule. Waiting for a later approval is non-terminal. |
| State-lock resume helper | `COMPLETED` update and event; caller also settles the state-lock queue item | candidate completed worker run | Candidate only after both the run/event evidence and the existing queue settlement succeed; otherwise leave it unobserved for later reconciliation. |
| Storage provisioning helper | `STORAGE_PROVISIONED` plus event/audit | successful sub-operation, active pipeline status | No worker-terminal observation: `STORAGE_PROVISIONED` is in the active-status set, not a terminal pipeline outcome. |
| Generic non-cancellation catch | `updateRun(... FAILED | STORAGE_FAILED ...)`, failure event, audit; then rethrow | failed *attempt* unless finality is proved | Do not emit a terminal-failure observation yet. A retry can redeliver the same job after this write. |
| Worker `failed` listener | Log call only | non-durable queue notification | Never use as terminal evidence. |
| `finally` workspace removal | Local best-effort filesystem cleanup | cleanup only | No observation. |
| Process termination, stall, orphan, or lost worker | No guaranteed worker write | uncertain effect / crash | No worker-terminal observation. A future reconciler must first persist a sanitized decision from durable evidence. |

Source locations: `backend/src/projects/pipeline/pipeline-worker.service.ts`
`process()` (worker routes and catch/finally), helper success paths, and
`observeWorkerPickup` / `observeWorkerPreMutation`; `backend/src/projects/pipeline/pipeline.service.ts`
for job attempts and the Session 8.11 durable cancellation request; and
`backend/src/projects/pipeline/pipeline-status.ts` for active versus terminal
status definitions.

## Durable-evidence rules

An observation may be written only after the indicated source-of-truth writes
have completed successfully. It is detached and best effort, so failure to
write an observation must never change worker processing, a return value,
retry, exception, queue state, cleanup, or run status.

1. **Completed worker run (future candidate):** require the exact run's saved
   `COMPLETED` status and its completed pipeline event. Existing audit records
   may add corroboration but are not a substitute for the run/event pair.
   The observation wording must be “worker recorded pipeline completion”, not
   “deployment succeeded”, “stable release”, or “cloud healthy”.
2. **Failed worker run (future candidate):** require the exact saved terminal
   failure status and its failure event **plus a durable proof that BullMQ will
   not retry that logical job**. The current source has the first two but not
   the third; rethrowing after persistence intentionally allows BullMQ retry.
3. **Cancelled:** only the accepted request observation remains allowed. It is
   emitted after `PipelineService.cancelRun()` saves the cancelled/requested
   status (Session 8.11). A worker seeing cancellation, returning early, or
   throwing `PipelineCancelledError` must emit nothing. None of those facts
   proves an in-flight Docker, Terraform, ECS, or other cloud operation stopped.
4. **Retryable and redelivered work:** no terminal observation. Pickup and
   pre-mutation observations remain valid lifecycle evidence only.
5. **Stalled, shutdown, crash, and orphan cases:** no direct worker observation.
   A later reconciler may emit a separate lifecycle-only observation only after
   it saves a decision backed by durable run, queue, and target evidence. It
   must use an orphan/reconciliation identity, never invent a worker terminal.

## Frozen identities, classes, and sources

The following values are reserved for a future implementation. They are not
registered in runtime code in this session.

| Outcome | Proposed operation class | Proposed source | Logical identity | Preconditions |
| --- | --- | --- | --- | --- |
| final completed worker job | `legacy_worker_terminal_success` | `pipeline_worker.completed_persisted` | `worker-terminal:<runId>:<jobId>:completed` | Exact run/event pair persisted; job ID available. |
| final failed worker job | `legacy_worker_terminal_failure` | `pipeline_worker.failed_persisted` | `worker-terminal:<runId>:<jobId>:failed` | Exact run/event pair persisted **and** durable final-attempt proof. |
| reconciled orphan outcome | `legacy_worker_orphan_recovery` | `legacy_worker_reconciler.terminalized` | `worker-orphan:<runId>:<jobId>:<decisionRevision>` | Future reconciler saved its evidence-backed decision. |

All values use lane `legacy` and environment `dev`. A production job must have
a BullMQ job ID. The existing `workerObservationIdentity()` run/route fallback
is retained only for fixture tests; it is not sufficient to merge real retry
attempts or separate two production jobs. Success and failure have distinct
identities and sources, so one cannot overwrite the other.

The existing Session 8.8 identities remain frozen:

- pickup: `legacy:worker-pickup:<route>:job:<bullmqJobId>`;
- pre-mutation: `legacy:worker-pre-mutation:<route>:job:<bullmqJobId>`.

They may coexist with a later terminal observation for the same job because
their bounded insertion sources differ. A BullMQ retry/redelivery with the
same job ID replays the same pickup, pre-mutation, and (only if final) terminal
identity; it must not create per-attempt records. A separately created legacy
retry creates a new pipeline run and is therefore a new logical operation.

No terminal-observation input may include actor IDs, repository details,
variables, credentials, cloud identifiers, task definitions, queue payloads,
job error text, raw exception messages, or runtime output. Only the existing
sanitized observer fields and a deterministic evidence hash may be persisted.

## Retry, redelivery, and false-terminal protections

`PipelineService.startRun()` configures full-deploy jobs with
`PIPELINE_JOB_ATTEMPTS` (default `1`), while approval resume jobs explicitly
use one attempt. Configuration is not durable final-attempt evidence for an
already running job, and the generic worker catch saves a failed status before
it rethrows. Therefore:

- a persisted `FAILED`/`STORAGE_FAILED` record is not by itself final;
- a completed run is pipeline bookkeeping, not verified cloud health;
- a retry must not produce a failure observation followed by a success
  observation for the same logical job;
- job-local attempt counters alone are insufficient unless their exact relation
  to the durable queue state is frozen and tested against the installed BullMQ
  version;
- a stale job, worker shutdown, or lost process cannot be labelled failed,
  cancelled, or stopped without a separate reconciler's durable evidence.

The current `worker.on("failed")` handler is logging-only. It must not become a
terminal observer because it has neither a pipeline transaction nor a durable
final-attempt decision.

## Cancellation and uncertain-effect exclusions

The following remain excluded from worker-terminal shadow observation:

- cancelled before worker pickup;
- cancellation detected by `ensureNotCancelled()`;
- `PipelineCancelledError` catch handling;
- paused approval, cost, plan, apply, or state-lock return paths;
- `STORAGE_PROVISIONED` and other active/non-terminal statuses;
- local workspace cleanup in `finally`;
- worker failure before a pipeline run is loaded;
- stalls, shutdown, process crash, orphaned work, and target-side uncertainty;
- any cloud result inferred only from a run status or error message.

These exclusions preserve the distinction between a database lifecycle record
and a verified external effect. Cloud health, release promotion, rollback, and
uncertain side effects remain subjects for their own durable target evidence
and reconciliation contracts.

## Required future test matrix

Fixture tests must cover each worker route listed above, including early
returns, one-attempt success, configured retry, same-job redelivery, separately
created retry run, cancellation before pickup, cancellation during execution,
storage-provision completion, state-lock queue settlement failure, generic
failure before/after terminal event persistence, and observer-failure
isolation. They must assert no raw payload/error data reaches the observer.

Isolated PostgreSQL tests must prove idempotent terminal identities, distinct
success/failure records, run/event precondition enforcement, transaction
rollback, and that a cancelled or retryable run creates no terminal record.
Redis/BullMQ integration tests must prove the installed version's exact retry,
redelivery, and terminal-failure semantics for the configured `attempts` values.
Crash/stall tests require a future reconciler fixture and must prove it never
repeats an uncertain effect.

## Implementation readiness and next bounded task

Worker success and failure **cannot safely be implemented together next**.
Success has a durable run/event pair but still requires route-specific placement;
failure lacks the mandatory durable proof that the queue exhausted retries.
Implementing both now would create false final records.

The exact next bounded task is: **freeze and add durable legacy job-attempt
terminality evidence, without adding a shadow observation.** It must define the
authoritative final-attempt record/transition for a BullMQ job, cover retries,
redelivery, stalled jobs, worker crash, and retry exhaustion in isolated
Redis/PostgreSQL tests, and expose only a sanitized finality decision. Once
that evidence exists, a later small session can add the two terminal observer
calls after the completed/final-failed durable write paths. It must not change
cloud behavior, ownership enforcement, or cancellation semantics.

Session 8.12 does not implement worker-terminal observation or mutual
exclusion.
