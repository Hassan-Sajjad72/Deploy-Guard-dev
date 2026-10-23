# Session 8.8 — Legacy Worker Shadow Insertion Findings

## Status

Session 8.8 adds default-off, best-effort shadow observation inside the legacy
pipeline worker only. It does not acquire, renew, release, correlate, or
enforce ownership. It changes no queue data, retry policy, cancellation,
worker status transition, Terraform, Docker, ECR, ECS, EFS, AWS, rollback, or
finalization behavior.

Cross-lane mutual exclusion remains inactive.

## Worker routes covered

`PipelineWorkerService.process()` records one worker-pickup observation after
the existing cancelled-run early return and before route dispatch for:

| Worker job route | Operation class | Pickup source |
| --- | --- | --- |
| `full_deploy` and legacy `pipeline_build` | `legacy_full_deployment_run` | `pipeline_worker.full_deploy_pickup` |
| `stage_selective_resume` | `legacy_stage_selective_resume` | `pipeline_worker.stage_selective_resume_pickup` |
| `resume_after_cost_approval` | `legacy_cost_approval_resume` | `pipeline_worker.cost_approval_resume_pickup` |
| `resume_after_apply_approval` | `legacy_apply_approval_resume` | `pipeline_worker.apply_approval_resume_pickup` |
| `resume_after_state_lock` | `legacy_state_lock_resume` | `pipeline_worker.state_lock_resume_pickup` |
| `infrastructure_plan` | `legacy_infrastructure_plan` | `pipeline_worker.infrastructure_plan_pickup` |
| `infrastructure_apply` | `legacy_infrastructure_apply` | `pipeline_worker.infrastructure_apply_pickup` |
| `storage_provision` | `legacy_storage_provision` | `pipeline_worker.storage_provision_pickup` |

`InactiveLegacyShadowInsertionAdapter` remains the only insertion surface. The
worker supplies only project ID, a bounded route, and a deterministic logical
job identity. The adapter fixes `legacy/dev`, derives the bounded operation
class/source, and sends no job payload, repository, actor, variable,
credential, cloud, lease, error, or runtime-output data to the observer.

## Enqueue versus pickup identity

Session 8.7 enqueue observations are keyed by the durable legacy run identity.
Session 8.8 uses the existing BullMQ job ID when present:

```
enqueue: legacy:<enqueue-domain>:<pipeline-run-id>
pickup:  legacy:worker-pickup:<route>:job:<bullmq-job-id>
mutation: legacy:worker-pre-mutation:<route>:job:<bullmq-job-id>
```

The Session 8.5 observer hashes those identities before persistence. Thus an
enqueue and pickup are intentionally distinct lifecycle observations, but a
retry, delayed execution, or redelivery with the same job ID replays the same
pickup observation. A fallback uses only the pipeline run ID and bounded route
when an in-memory/fake job has no ID.

## Pre-mutation boundary

Exactly one pre-mutation call is placed before the first mutation-capable path
for each logical job:

- standard full deployment: after deployability validation and before optional
  external CI/Docker work;
- selective resume: only when rerun stages can reach Docker, registry,
  Terraform, database, or ECS work;
- direct plan/apply: after project validation and immediately before the
  existing infrastructure operation;
- cost/apply/state-lock resumes: immediately before the existing Terraform
  continuation when one can run;
- storage provisioning: immediately before EFS provisioning; and
- cleanup-only/read-only recovery: no pre-mutation call.

The `pre-mutation` source is separate from the pickup source. Multiple
mutation-capable stages within one job do not create further calls; durable
observer idempotency additionally collapses duplicate delivery. Observer calls
are detached and contain synchronous and asynchronous error handling, so an
observer timeout, database error, or idempotency conflict cannot alter worker
processing, retries, exceptions, cleanup, or status.

## Verification evidence

Passed:

| Command | Result |
| --- | --- |
| `npx tsc --noEmit --incremental false` | passed |
| `npm run build` | passed |
| `npm run test:inactive-legacy-worker-shadow-insertion` | passed; all route mappings, identity replay, pickup/pre-mutation separation, sanitization, failure isolation, and static route checks |
| `npm run test:inactive-legacy-shadow-insertion` | passed |
| `npm run test:inactive-release-lane-shadow-observer` | passed |
| `npm run test:inactive-v1-shadow-insertion` | passed |
| `npm run test:inactive-release-lane-ownership` | passed |
| `npm run test:inactive-release-lane-correlation` | passed |
| `npm run test:inactive-v1-release-lane-composition` | passed |
| `npm run test:automation` | passed |
| `npm run test:stage-selective-resume` | passed |
| `npm run test:terraform-approval-lifecycle` | passed |
| `npm run test:deployment-recovery` | passed |
| `npm run test:two-lane-migrations` | passed |
| `git diff --check` | passed |

Not executed:

| Command group | Reason |
| --- | --- |
| isolated PostgreSQL shadow-observer, ownership, correlation, and migration suites | local port `5433` is sandbox-restricted; the previous escalation request failed due to an external approval-service HTTP 503. No application database was touched. |

## Intentionally uncovered paths

Manual rollback, automatic rollback, cancellation finalization, worker crash
finalization, and cleanup workers remain uninstrumented. They are outside this
session and must not be described as protected by shadow observation.

## Exact Session 8.9 task

Design-only: freeze the remaining legacy rollback, cancellation, and crash
observation protocol. Map their exact operation identities and decide whether
each is a release, infrastructure, deletion, or no-observation path. Do not
wire workers, rollbacks, or enforcement in that session.
