# Session 8.6 — Inactive v1 Shadow Insertion Findings

## Status

Session 8.6 wires default-off shadow observation into the inactive v1 path
only. It does not acquire, renew, release, or enforce cross-lane ownership.
Legacy paths are untouched. The v1 composition and consumer remain stopped and
default-off.

## Shared insertion adapter

`InactiveV1ShadowInsertionAdapter` is the sole v1 insertion surface. It accepts
only flattened, bounded fields: project ID, normalized environment, intent ID,
classification or execution lane, and a deterministic v1 job ID. It never
accepts an envelope, manifest, repository, worker/lease identity, credential,
or cloud value.

It derives and passes to Session 8.5 only:

- proposed lane `v1`;
- bounded operation class;
- bounded insertion source; and
- a domain-separated logical identity derived from the intent/job identity.

The adapter invokes the observer asynchronously and contains both synchronous
and asynchronous observer failures. An observer rejection, hang, idempotency
conflict, or database failure cannot change the caller’s result, retry, queue,
intent, or operation-lease behavior.

## Exact v1 insertion points

| Boundary | Source | Operation class |
| --- | --- | --- |
| Planner result after committed classification | `TransactionalDeploymentPlannerService.plan()` | `v1_plan_release`, `v1_plan_infrastructure`, `v1_plan_unsafe_or_unknown`, or `v1_plan_no_op` |
| Valid outbox claim, before existing publish | `DurableOutboxDispatcherService.dispatchOne()` | `v1_dispatch_release`, `v1_dispatch_infrastructure`, or `v1_dispatch_deletion` |
| Valid consumer job, before existing fenced invocation/pre-execution claim | `InactiveV1BullMqConsumerService.processJob()` | `v1_consumer_claim_release`, `v1_consumer_claim_infrastructure`, or `v1_consumer_claim_deletion` |

Planner replay uses `planner:<intentId>`. Dispatch and consumer replay use the
exact deterministic frozen job ID, domain-separated with the intent ID. Thus a
duplicate planner call, outbox dispatch, or consumer delivery replays a single
shadow observation instead of flooding records.

## Default-off and unchanged behavior

The Session 8.5 observer still performs no database read or write unless
`TWO_LANE_OWNERSHIP_SHADOW_MODE` is exactly `true`. Calls are detached from the
existing result paths. No planner status, deployment intent, outbox row,
operation lease, consumer lifecycle, queue publication, or retry decision is
changed by this session.

## Verification evidence

| Command | Result |
| --- | --- |
| `npm run test:inactive-v1-shadow-insertion` | passed; classification/lane mapping, source identity, observer failure/timeout isolation, and static boundary checks |
| `npm run test:inactive-release-lane-shadow-observer` | passed |
| `npm run test:transactional-planner` | passed |
| `npm run test:outbox-dispatcher` | passed |
| `npm run test:inactive-v1-consumer` | passed |
| `npm run test:inactive-v1-release-lane-composition` | passed |
| `npx tsc --noEmit --incremental false` | passed |

## Remaining risks

- This is not mutual exclusion. Observation does not block either lane.
- The observer is called only by the inactive v1 path; legacy shadow insertion
  remains intentionally absent.
- The detached observation is best-effort by design. It must not be used as a
  durable execution precondition.
- No consumer is started and no public activation path exists.

## Exact Session 8.7 task

Implement the **default-off legacy shadow-insertion adapter only** at the
Session 8.3 legacy start/retry/resume/rollback boundaries. It may record
sanitized observations but must not acquire ownership, block or queue work,
or claim that cross-lane mutual exclusion is active.
