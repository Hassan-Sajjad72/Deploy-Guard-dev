# Session 8.15 — Shadow Coverage and Enforcement Readiness Audit

## Verdict

**FAIL — not ready to implement or enable cross-lane ownership enforcement.**

The mapped v1 and legacy release/infrastructure mutation boundaries have
default-off shadow coverage or an explicit exclusion.  Isolated PostgreSQL and
Redis/BullMQ evidence is now available and passes.  However, the required
legacy enqueue regression currently fails, and neither execution lane enforces
the independent cross-lane ownership fence.  The latter is expected before the
next implementation session; the failed regression must be repaired before
claiming enforcement readiness.

This audit changed no runtime or test source.  It does not activate either
lane, acquire ownership, publish a job, or call cloud infrastructure.

## Coverage inventory

| Lane | Boundary / operation | Class | Shadow status | Future enforcement choke point | Audit status |
| --- | --- | --- | --- | --- | --- |
| Legacy | `PipelineService.startRun()` new full deployment | release | enqueue covered | before durable mutating run creation and queueing | covered, unenforced |
| Legacy | retry and full-recovery run creation | release | shared enqueue covered with distinct origin | same `startRun()` transaction | covered, unenforced |
| Legacy | selective resume | release or lifecycle-only | enqueue/pickup; pre-mutation only when rerun can mutate | selective-run creation, then worker before first mutation | covered conditionally |
| Legacy | cost/apply/state-lock resume | infrastructure/release continuation | enqueue, pickup, pre-mutation | resume enqueue and worker continuation | covered, unenforced |
| Legacy | direct deploy, plan, apply | infrastructure | enqueue, pickup, pre-mutation | each `InfrastructureService` enqueue transaction and worker route | covered, scope decision required |
| Legacy | storage provisioning | infrastructure | enqueue, pickup, pre-mutation | `StorageService.provision()` and storage worker route | covered, scope decision required |
| Legacy | normal full worker execution | release | pickup plus one pre-mutation observation | worker pickup and before Docker/ECR/Terraform/ECS mutation | covered, unenforced |
| Legacy | manual and automatic rollback | release | shared `RollbackService` record, mutation, and terminal observations | after durable rollback record and before ECS update | covered, unenforced |
| Legacy | accepted cancellation | lifecycle-only | after durable cancelled state | terminal ownership-release path, not request validation | covered, unenforced |
| Legacy | normal job completion / retry-exhausted failure | lifecycle-only | durable finality then terminal shadow | durable finality listener only | covered for the two proven finalities |
| Legacy | active, delayed, paused, cancelled, retrying, stalled, shutdown, orphaned worker paths | lifecycle-only / excluded | no terminal observation | requires durable final or reconciliation evidence | intentionally excluded |
| Legacy | cleanup-only selective resume and workspace-only cleanup | no observation | explicitly excluded | none; no release mutation | intentionally excluded |
| Legacy | destroy, orphan cleanup, and resource cleanup | deletion | outside release ownership scope | separate deletion protocol required | blocking scope boundary |
| v1 | planner classification | release / infrastructure / no-op / unsafe | planner observation | none until an executable intent reaches consumer | covered, inactive |
| v1 | durable outbox dispatch | release / infrastructure / deletion | dispatch observation | none; dispatcher must not own execution | covered, inactive |
| v1 | consumer validation and claim | release / infrastructure / deletion | consumer observation | acquire cross-lane owner **before** pre-execution operation lease | covered, unenforced |
| v1 | pre-execution lease and fenced placeholder invocation | release / infrastructure / deletion | no additional shadow required; consumer is its lifecycle boundary | cross-lane claim, then existing operation lease claim | inactive, unenforced |
| v1 | read-only side-effect/ECS reconciliation | lifecycle-only | no mutation observation | no release ownership acquisition | intentionally excluded |
| v1 | cancellation, crash, and real terminal outcome | unreachable while v1 remains inactive | no active route | define before lane activation | activation blocker |

The primary source evidence is: v1 shadow insertion adapter
[`backend/src/orchestration-contracts/release-lane/inactive-v1-shadow-insertion.adapter.ts:20`](../../../backend/src/orchestration-contracts/release-lane/inactive-v1-shadow-insertion.adapter.ts:20), consumer placement before invocation
[`backend/src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service.ts:160`](../../../backend/src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service.ts:160), existing v1 operation-lease claim
[`backend/src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service.ts:81`](../../../backend/src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service.ts:81), legacy queue observation
[`backend/src/projects/pipeline/pipeline.service.ts:179`](../../../backend/src/projects/pipeline/pipeline.service.ts:179), worker pickup/pre-mutation
[`backend/src/projects/pipeline/pipeline-worker.service.ts:231`](../../../backend/src/projects/pipeline/pipeline-worker.service.ts:231), shared rollback observations
[`backend/src/orchestration/rollback.service.ts:106`](../../../backend/src/orchestration/rollback.service.ts:106), cancellation placement
[`backend/src/projects/pipeline/pipeline.service.ts:237`](../../../backend/src/projects/pipeline/pipeline.service.ts:237), and finality-to-terminal observation
[`backend/src/projects/pipeline/pipeline-job-finality.service.ts:48`](../../../backend/src/projects/pipeline/pipeline-job-finality.service.ts:48).

## Duplicate-identity review

The identities are deliberately lifecycle-separated and domain-separated:

| Lifecycle | Identity basis | Duplicate rule |
| --- | --- | --- |
| Legacy enqueue | durable pipeline run ID | retry/full-recovery origin selects one enqueue class; repeats replay it |
| Legacy worker pickup / pre-mutation | exact BullMQ job ID and bounded route | pickup and pre-mutation are intentionally separate; redelivery replays each source |
| Legacy rollback | durable rollback-record ID | request, mutation, succeeded, and failed have separate source identities per record |
| Legacy cancellation | pipeline run ID plus `cancelled` | only accepted durable cancellation observes; invalid/terminal requests do not |
| Legacy terminal | pipeline run ID, BullMQ job ID, and final decision | completed and failed cannot overwrite one another because finality is conflict-checked |
| v1 planning | deployment intent ID | one planner observation per intent |
| v1 dispatch / consumer | intent ID plus frozen deterministic job ID | separate lifecycle sources; duplicate delivery replays rather than floods |

The observer hashes these identities and persists only sanitized fields.  No
raw queue payload, actor, repository, environment value, lease ID, credential,
or cloud identifier is passed by either insertion adapter.

## Bypass and readiness analysis

No *unclassified* direct mutation path was found in the audited legacy and v1
release/infrastructure routes.  This is not proof that the guard is currently
enforced: all active legacy mutations bypass it today because enforcement is
deliberately inactive.  The v1 consumer is also inactive.

The frozen order remains valid and must not change:

1. v1 validates its envelope and acquires cross-lane ownership for the exact
   project/environment.
2. Only then may it claim the existing v1 operation lease and invoke a handler.
3. A future real handler validates both independent fences before every side
   effect and releases ownership only after the fenced terminal transition.

Legacy must acquire the same cross-lane owner before any mutating run,
resume, direct infrastructure queue, or rollback mutation, then correlate the
durable run/rollback record.  The legacy compatibility environment is exactly
`dev`; it must not be silently generalized.

### Blocking items

1. `npm run test:inactive-legacy-shadow-insertion` fails.  Its static guard at
   [`backend/scripts/verify-inactive-legacy-shadow-insertion.ts:65`](../../../backend/scripts/verify-inactive-legacy-shadow-insertion.ts:65)
   forbids the text `bullmq`, but Session 8.14 correctly added the sanitized
   field `bullmqJobId` at
   [`backend/src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts:26`](../../../backend/src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts:26).
   This is a test-contract false positive, not evidence of an import, queue
   call, or activation; nevertheless the required regression is red.
2. `InactiveReleaseLaneOwnershipService` and correlation are not wired into
   either legacy or v1 execution path.  The v1 invocation currently claims its
   operation lease directly, at
   [`backend/src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service.ts:92`](../../../backend/src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service.ts:92).
   Therefore cross-lane exclusion is not operational.
3. Release, infrastructure, and deletion share legacy `dev` compatibility
   scope, but deletion/destroy has been intentionally excluded.  A release
   enforcement feature cannot be enabled for that scope until the deletion
   protocol either participates in the fence or is formally isolated.
4. Legacy crash/stall/orphan terminal evidence and v1 cancellation/terminal
   semantics remain intentionally unimplemented.  They do not justify an
   automatic retry or release; they are blockers to enabling production
   enforcement, not permission to infer a cloud outcome.

## Test evidence

| Verification | Result |
| --- | --- |
| two-lane contracts and static migration safety | passed |
| isolated legacy-shaped PostgreSQL migrations | passed |
| ownership, correlation, and observer static + isolated PostgreSQL suites | passed |
| rollback and cancellation shadow static + isolated PostgreSQL suites | passed |
| finality fixture, isolated PostgreSQL, and BullMQ 5.79.2 retry/finality suite | passed |
| v1 runtime and consumer isolated PostgreSQL/Redis suites | passed |
| worker shadow, terminal-shadow fixture, and automation suites | passed |
| `npm run test:inactive-legacy-shadow-insertion` | **failed**: static `bullmq` substring false positive described above |
| `npx tsc --noEmit --incremental false` | passed |
| `npm run build` | passed |
| repository-root `git diff --check` | passed |

The PostgreSQL and Redis tests were executed only after explicit local access
approval.  Their existing temporary schema and unique queue-prefix cleanup was
retained; no normal application database or external service was used.

## Smallest safe next implementation task

**Session 8.16: repair the legacy shadow-insertion static test so it tests for
an actual BullMQ import/call rather than the sanitized `bullmqJobId` field, then
implement one default-off cross-lane ownership lifecycle adapter and wire it
symmetrically at the frozen v1 consumer-before-operation-lease and legacy
mutating-run/rollback chokepoints.**

It must use the existing ownership and correlation services, preserve the
independent cross-lane and operation-lease IDs, fail closed only when the new
explicit enforcement gate is enabled, and leave deletion/destroy outside the
activation scope until its separate protocol is frozen.  It must not enable
the gate, start consumers, or change cloud behavior.
