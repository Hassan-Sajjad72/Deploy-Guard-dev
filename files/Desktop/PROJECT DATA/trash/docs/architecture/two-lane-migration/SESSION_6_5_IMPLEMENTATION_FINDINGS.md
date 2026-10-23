# Session 6.5 Inactive Execution Lease Heartbeat Findings

## 1. Outcome

Session 6.5 adds an inactive, invocation-scoped heartbeat around the Session
6.3 placeholder handler. It reuses Session 6.2's existing fenced `renew`
operation and does not introduce a second lease system or persistence model.

The inactive execution path is now:

```text
frozen BullMQ job
  -> Session 6.4 envelope and route validation
  -> Session 6.2 fenced ownership claim
  -> Session 6.3 context and manifest validation
  -> start execution lease heartbeat
  -> invoke one typed non-executing placeholder
  -> stop and await heartbeat cleanup
  -> fenced complete, release, fail, or ownership-lost no-op
```

No real release, infrastructure, deletion, Terraform, ECS, AWS, Docker,
frontend, endpoint, legacy-pipeline, scheduler, lifecycle hook, or automatic
consumer behavior was added. The two-lane orchestrator remains inactive.

## 2. Heartbeat boundary

`InactiveV1ExecutionLeaseHeartbeatService.start()` requires:

- exact lease ID;
- exact worker ID;
- exact fencing token;
- the bounded Session 6.2 lease TTL;
- an optional bounded renewal interval; and
- an optional cancellation signal.

The default interval is one third of the lease TTL. An interval must be at
least 100 milliseconds and less than half the lease TTL, leaving more than one
renewal opportunity before normal expiry.

The service schedules the next renewal only after the current renewal settles.
There is no overlapping interval callback, so concurrent renewal attempts for
one execution session are serialized.

Each renewal calls the unchanged Session 6.2 `renew()` predicate. That
predicate requires an unexpired active lease, the exact lease/worker/fencing
tuple, and a current compatible worker capability. A stale or replaced owner
therefore receives no renewed snapshot.

## 3. Trusted execution signal

The handler context now contains:

```text
execution.signal
execution.isLeaseTrusted()
```

The signal aborts and trusted state becomes false when:

- fenced renewal returns no owned lease;
- renewal throws;
- the caller cancels execution.

The invocation wrapper starts the heartbeat only after ownership is newly
claimed, the active context is reloaded, manifests are validated, and the
exact handler is resolved. Terminal, superseded, duplicate, malformed, and
context-lost jobs never start an execution heartbeat.

Future real handlers must treat the signal and fencing token as cooperative
side-effect boundaries. This session intentionally keeps all handlers as
non-executing placeholders.

## 4. Finalization rules

| Heartbeat result | Invocation behavior |
| --- | --- |
| Healthy handler completion | stop heartbeat, then fenced complete |
| Retryable handler result | stop heartbeat, then fenced release |
| Terminal or thrown handler result | stop heartbeat, then fenced fail |
| Explicit cancellation | stop heartbeat, fenced release to `enqueued` |
| Ownership lost or lease replaced | no stale finalization; ownership-lost no-op |
| Renewal error | abort trust and fenced fail with `EXECUTION_HEARTBEAT_FAILED` when ownership still permits it |
| Lease expires before finalization | existing fenced predicate rejects finalization |

Heartbeat state is checked before interpreting a handler outcome. A handler
cannot return success after losing ownership and cause the old lease to
complete the intent.

Handler exceptions remain `PLACEHOLDER_HANDLER_THROWN`. Renewal exceptions are
reduced to `EXECUTION_HEARTBEAT_FAILED`. Raw database, connection, credential,
or transport error text is not stored in the intent or BullMQ failure reason.

## 5. Consumer shutdown and crash behavior

BullMQ graceful close waits for the active processor promise. The processor
waits for Session 6.3 invocation, and invocation waits for its heartbeat
session to stop. Therefore consumer shutdown cannot resolve before heartbeat
cleanup.

During graceful shutdown, an already running handler retains heartbeat
protection until it finishes; the heartbeat then stops before fenced
finalization. Explicit cancellation is a separate invocation signal and
releases the intent for retry.

A process crash naturally stops renewal. The operation lease expires, and the
existing Session 6.2 recovery path:

1. marks the old lease expired;
2. gives a replacement claim a higher fencing token; and
3. prevents the crashed owner from renewing or finalizing.

No background sweeper or automatic recovery worker was added.

## 6. Verification evidence

| Check | Result |
| --- | --- |
| Heartbeat interval validation | Passed |
| Heartbeat starts after valid claim/context only | Passed |
| Exact lease/worker/fencing renewal tuple | Passed |
| Long-running handler remains leased beyond original TTL | Passed |
| Heartbeat timestamp advances and expiry stays in the future | Passed |
| Concurrent renewal attempts | Passed; maximum observed concurrency was one |
| Normal completion stops heartbeat | Passed |
| Retryable release stops heartbeat | Passed |
| Terminal/handler failure stops heartbeat | Passed |
| Explicit cancellation aborts trust and releases intent | Passed |
| Ownership replacement aborts handler trust | Passed |
| Stale owner cannot finalize replacement claim | Passed |
| Renewal error stores only `EXECUTION_HEARTBEAT_FAILED` | Passed |
| Raw renewal error absent from intent and BullMQ stack | Passed |
| Consumer graceful stop waits for handler and heartbeat cleanup | Passed |
| Crash lease expires and replacement token increases | Passed |
| Session 3 contract/static migration regressions | Passed |
| Session 3 isolated legacy-shaped PostgreSQL migrations | Passed |
| Worker envelope and manifest secret-safety regressions | Passed |
| Session 4 planner unit/PostgreSQL regressions | Passed |
| Session 5 dispatcher unit/PostgreSQL/Redis regressions | Passed |
| Session 6.1 runtime unit/PostgreSQL/Redis regressions | Passed |
| Session 6.2 ownership unit/PostgreSQL regressions | Passed |
| Session 6.3 invocation unit/PostgreSQL regressions | Passed |
| Session 6.4 consumer unit/PostgreSQL/Redis regressions | Passed |
| TypeScript type-check | Passed |
| Backend production build | Passed |
| `git diff --check` | Passed |

The focused service test uses controlled fake renewal outcomes. The integration
test uses a unique PostgreSQL schema and unique Redis prefixes, then removes
them in `finally`. No normal application database or production queue was
touched.

## 7. Changed files

- `backend/src/orchestration-contracts/worker-runtime/v1-execution-lease-heartbeat.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-execution-lease-heartbeat.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-execution-lease-heartbeat.service.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-fenced-invocation.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-bullmq-consumer.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-bullmq-consumer.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/scripts/verify-inactive-v1-execution-lease-heartbeat.ts`
- `backend/scripts/verify-inactive-v1-bullmq-consumer.ts`
- `backend/scripts/verify-inactive-v1-bullmq-consumer-postgres-redis.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_6_5_IMPLEMENTATION_FINDINGS.md`

No entity, migration, frontend, controller, endpoint, production bootstrap, or
legacy worker file changed for Session 6.5.

## 8. Remaining risks

- JavaScript cannot forcibly terminate an arbitrary promise. A future real
  handler must cooperatively honor `execution.signal`, recheck
  `isLeaseTrusted()`, and propagate the fencing token to every side-effect
  boundary. This session prevents trusted finalization but intentionally
  cannot make a non-cooperative handler safe.
- Graceful worker close waits indefinitely for a non-cooperative handler.
  A separately designed shutdown deadline policy is still needed before real
  handlers exist.
- Any renewal exception is treated conservatively as lost trust rather than
  retried within the same heartbeat session.
- Heartbeat state currently has no metrics, audit stream, or operator alert.
- Interval bounds are process-local policy. Production sizing must account for
  measured PostgreSQL latency and event-loop delay before activation.
- The default placeholders still return success without doing work.

## 9. Next bounded task

Before any real handler is implemented, a separate inactive contract task
should define mandatory handler-side cancellation checks, target-system
idempotency, and fencing-token propagation at side-effect boundaries. It
should remain static/non-executing and must not activate the consumer.

No real deployment handler was implemented, and the orchestrator is not
active.
