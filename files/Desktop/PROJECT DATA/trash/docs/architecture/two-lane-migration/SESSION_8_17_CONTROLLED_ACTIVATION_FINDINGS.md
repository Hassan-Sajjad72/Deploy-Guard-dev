# Session 8.17 — Controlled Cross-Lane Ownership Activation

## Status

**PASS in the isolated verification environment.**

The Session 8.16 gate was enabled only through an in-process test
`ConfigService` fixture. It was not added to `backend/.env`,
`backend/.env.example`, the normal Nest bootstrap, or any consumer startup
path. The v1 consumer was explicitly started only against isolated Redis
prefixes and stopped by the harness.

No AWS, Terraform, Docker, ECR, ECS, frontend, deletion, destroy, or central
cleanup operation was invoked. This is not evidence of live-cloud or
production mutual exclusion.

## Isolated activation harness

`verify-cross-lane-controlled-activation-postgres-redis.ts` creates:

- a unique PostgreSQL schema named `session8_17_activation_<suffix>`;
- only the minimum legacy/v1 tables plus migrations 1760000043000,
  1760000044000, and 1760000046000;
- unique Redis/BullMQ prefixes for every queue case;
- an actual `PipelineService` instance for legacy run and approval entry;
- the actual explicitly started `InactiveV1BullMqConsumerService`;
- the production ownership, correlation, and finality services; and
- typed non-cloud invocation fixtures.

Every consumer and queue is closed, every Redis prefix is obliterated, and the
temporary PostgreSQL schema is dropped in `finally`.

## Controlled activation evidence

| Requirement | Result | Evidence |
| --- | --- | --- |
| Legacy/v1 same project/dev race | Passed | Serializable concurrent acquisition produced exactly one fulfilled owner and one sanitized cross-lane rejection. |
| Legacy blocked before publication | Passed | With v1 ownership active, real `PipelineService.startRun()` rejected before run persistence and before its real isolated Redis queue received a job. |
| V1 blocked before execution | Passed | With legacy ownership active, the real inactive v1 consumer failed the frozen job before invocation; invocation count remained zero. The job was already published, as required by the frozen outbox-before-consumer architecture. |
| V1 lock ordering | Passed | Runtime evidence found active v1 cross-lane ownership before invocation. Source and the isolated v1 ownership/invocation regressions prove cross-lane acquisition precedes operation-lease claim and attachment follows claim. |
| Legacy duplicate/replay | Passed | Repeating the same real legacy start returned the existing run and left exactly one Redis job. |
| Missing/stale fences | Passed | Missing persisted legacy correlation threw `CROSS_LANE_OWNERSHIP_LOST`; wrong fencing tokens could not renew or release. |
| Exact renew/release | Passed | Exact lease ID, actor, lane, environment, and token renewed and released; stale identities failed closed. |
| Approval and state-lock waits | Passed | Real Terraform-approval resume reacquired/correlated before Redis enqueue. State-lock wait released and reacquired the same logical run with a strictly higher token. |
| Retryable attempt | Passed after narrow fix | A failed attempt with a remaining BullMQ retry retained ownership. |
| Durable terminal outcomes | Passed after narrow fix | Durable completed finality and retry-exhausted failed finality released and cleared the exact correlated ownership. |
| Cancellation | Passed | Cancelled run evidence was ineligible for finality and retained ownership; it did not claim that active cloud work stopped. |
| Rollback | Passed | Fenced successful rollback release cleared correlation. Simulated uncertain rollback failure retained ownership. Existing shared rollback fixture/PostgreSQL tests also passed. |
| Heartbeat loss/crash | Passed | Forced expiry made heartbeat trust false; stale release failed. A replacement acquired a strictly higher token only where no underlying active work existed. |
| Disabled behavior | Passed | Missing gate value produced `{ enabled: false }` and did not change ownership-row count. |
| Deletion/destroy exclusion | Passed | Deletion envelopes return a disabled claim; infrastructure-lifecycle deletion/destroy source has no enforcement dependency. |

### Queue-publication qualification

The frozen protocol publishes v1 outbox jobs before the explicitly started v1
consumer acquires execution ownership. Therefore a v1 conflict cannot prevent
the already-durable outbox publication; it prevents operation-lease claim,
handler invocation, and mutation. Legacy entry conflicts are prevented before
legacy queue publication. Moving v1 acquisition into the dispatcher would
violate the frozen Session 2/8.3 ordering and was not attempted.

## Narrow lifecycle fix

The controlled audit found one real activation bug:

`PipelineWorkerService` treated a persisted legacy `failed` status as sufficient
to release cross-lane ownership in `finally`, even though BullMQ might still
have another attempt. It also treated cancelled and uncertain ECS/rollback
failure statuses as safe release proof.

The fix:

1. removes `FAILED`, `STORAGE_FAILED`, `CANCELLED`,
   `ECS_SERVICE_UNHEALTHY`, `ECS_DEPLOYMENT_FAILED`, and `ROLLBACK_FAILED`
   from worker-local release eligibility;
2. makes `PipelineJobFinalityService` release the exact correlated ownership
   only after durable `completed` or `failed_after_retries_exhausted` evidence
   exists; and
3. keeps release best-effort and sanitized so finality recording and BullMQ
   behavior are unchanged if ownership release is unavailable.

Approval/state waits and deterministic safe terminal states retain the frozen
Session 8.16 release behavior. Cancelled, retrying, crashed, and uncertain work
does not release on status alone.

## Verification results

### Passed

- `npm run test:cross-lane-controlled-activation`
- ownership and correlation fixture/PostgreSQL suites
- cross-lane enforcement fixture/PostgreSQL suites
- v1 ownership, fenced invocation, and consumer fixture/PostgreSQL/Redis suites
- shadow observer, legacy enqueue/worker/rollback/cancellation, and
  worker-terminal shadow fixture/PostgreSQL suites
- pipeline finality fixture/PostgreSQL/BullMQ 5.79.2 suites
- two-lane migration static and isolated PostgreSQL suites
- automation controls
- stage-selective resume
- Terraform approval lifecycle
- `npx tsc --noEmit --incremental false`
- `npm run build`
- `git diff --check`

### Failed

None in the final run. The first harness run found a fixture count assertion
that reused a project with released history; the assertion was corrected to
compare total row count before and after disabled acquisition. No production
change resulted from that fixture correction.

### Not executed

- normal backend startup with the enforcement gate enabled;
- normal application database or normal Redis namespace;
- live AWS, Terraform, Docker, ECR, ECS, deployment, rollback, destroy, or
  cleanup operations;
- frontend or public endpoint flows.

These are intentionally outside Session 8.17.

## Files changed

- `backend/src/projects/pipeline/pipeline-job-finality.service.ts`
- `backend/src/projects/pipeline/pipeline-worker.service.ts`
- `backend/scripts/verify-cross-lane-controlled-activation-postgres-redis.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_8_17_CONTROLLED_ACTIVATION_FINDINGS.md`

## Remaining risks

1. The gate remains default-off; no production activation is claimed.
2. V1 publication happens before execution ownership by frozen design. A
   conflict leaves a failed frozen job as durable queue evidence rather than
   suppressing outbox publication.
3. Cancellation, process crash, stalled jobs, and uncertain rollback/cloud
   effects retain ownership until fenced recovery or safe expiry evidence;
   this session did not add a reconciler.
4. Legacy ownership remains exactly project plus environment `dev`.
5. Deletion, destroy, and central cleanup remain intentionally outside this
   release/infrastructure fence.

## Next bounded task

Before any non-test activation, define and execute a separate operational
rollout session for one allowlisted non-cloud fixture scope. It should include
observability, rollback of the feature gate, and recovery of retained
ownership, while still keeping cloud mutation disabled. Session 8.17 does not
enable that rollout.
