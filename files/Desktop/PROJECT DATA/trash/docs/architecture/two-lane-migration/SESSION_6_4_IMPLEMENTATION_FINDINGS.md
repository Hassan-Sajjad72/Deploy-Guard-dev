# Session 6.4 Inactive v1 BullMQ Consumer Findings

## 1. Outcome

Session 6.4 adds an explicitly started BullMQ adapter for the frozen
`deployguard.worker/v1` queues. The adapter is inert after dependency injection:
it creates no Redis connection and consumes no job until a caller supplies a
connection and calls `start()`.

An accepted job now follows:

```text
frozen BullMQ queue
  -> consumer job/ID/envelope validation
  -> Session 6.3 fenced invocation
  -> Session 6.2 ownership claim
  -> Session 6.1 runtime validation
  -> one typed non-executing placeholder
  -> fenced complete, release, or fail
```

No controller, endpoint, frontend path, scheduler, Nest lifecycle hook,
bootstrap call, production Redis default, Terraform, ECS, AWS, Docker, deletion
executor, or legacy-pipeline call was added. The two-lane orchestrator remains
inactive.

## 2. Explicit start boundary

`InactiveV1BullMqConsumerService.start()` requires:

- a complete frozen v1 worker capability;
- an explicitly supplied BullMQ connection;
- an explicitly supplied isolated prefix;
- optional bounded concurrency, lease TTL, retry delay, and heartbeat interval.

There is no `ConfigService` or `createRedisConnection()` import and no
`REDIS_HOST`/`REDIS_PORT` fallback. Queue names are derived from the frozen
worker role and cannot be supplied by the caller:

| Role | Required messages | Queue |
| --- | --- | --- |
| release | `intent.release.execute` | `deployguard-release-v1` |
| infrastructure | `intent.infrastructure.plan`, `intent.infrastructure.apply` | `deployguard-infrastructure-v1` |
| deletion | `intent.deletion.execute` | `deployguard-deletion-v1` |

The complete message set is mandatory because both infrastructure messages
share one physical queue; a plan-only worker could otherwise consume and reject
an apply job.

`start()` verifies the pinned BullMQ version, starts explicit capability
registration/heartbeat, constructs workers with `autorun:false`, waits for
their supplied connections, and only then calls `run()`.

The returned session exposes only worker ID, frozen queue names, active state,
sanitized failure state, and graceful `stop()`. Concurrent stop calls share one
stop promise. Graceful stop waits for active processors, closes workers, waits
for worker loops, and stops capability heartbeat.

## 3. Frozen job validation

Before Session 6.3 is called, every job must satisfy all of:

- valid and unexpired exact-shape `deployguard.worker/v1` envelope;
- valid payload SHA-256;
- executable message type;
- exact frozen queue/lane/operation relationship;
- BullMQ job name equals envelope message type;
- job ID matches the strict frozen regex;
- job ID equals the ID deterministically recomputed from the envelope;
- message is supported by the started worker capability.

Malformed jobs throw one `UnrecoverableError` containing only a sanitized
machine code. Unknown exceptions become `CONSUMER_JOB_REJECTED`; raw messages,
job data, connection errors, and credentials are not copied into failure
reasons.

## 4. Result and retry behavior

| Fenced invocation result | BullMQ result |
| --- | --- |
| `completed` | completed |
| `intent_terminal` | completed idempotent no-op |
| `intent_superseded` | completed idempotent no-op |
| terminal `failed` | failed unrecoverably with sanitized handler code |
| `released` | same physical job moved to delayed |
| duplicate active owner | same physical job moved to delayed |
| `ownership_lost` | same physical job moved to delayed |

Retry uses `Job.moveToDelayed()` with the active BullMQ lock token and throws
BullMQ's `DelayedError`. BullMQ retains the same deterministic job ID and skips
the attempt increment used for normal failure retries. Session 6.3 has already
fenced-released retryable ownership, so the next delivery obtains a new lease
and higher fencing token without creating another logical job.

Active-owner duplicates and ownership-lost results are delayed rather than
completed. This closes the crash window where a restarted consumer sees the
previous process's still-live PostgreSQL lease: it waits until Session 6.2 can
expire and safely reclaim that lease instead of orphaning a `running` intent.

## 5. Crash and fencing evidence

The PostgreSQL/Redis test creates the exact state left by a process crash:

1. worker A owns the logical job and its intent is `running`;
2. the same physical BullMQ job is delivered to worker B;
3. worker B does not invoke the handler and moves the job to delayed;
4. worker A's lease is expired;
5. worker B receives the same job ID again;
6. Session 6.2 marks the old lease `expired`, allocates a higher token, and
   permits exactly one placeholder invocation;
7. the intent completes and the replacement lease releases.

Observed lease sequence: `expired -> released`, with replacement token greater
than the crashed owner's token. Thus BullMQ stall/redelivery cannot bypass the
PostgreSQL ownership or fencing boundary.

## 6. Verification evidence

| Check | Result |
| --- | --- |
| Session 6.4 pure/config/architecture test | Passed |
| Session 6.4 isolated PostgreSQL/Redis test | Passed |
| Job remains waiting before explicit start | Passed |
| Explicit start and capability heartbeat | Passed |
| Graceful stop waits for active placeholder | Passed |
| Job remains waiting after stop | Passed |
| Complete frozen queue surface per role | Passed |
| Exact queue/name/job-ID/envelope validation | Passed |
| Retryable outcome uses same physical job | Passed; two fenced leases, one BullMQ job |
| Post-crash active lease delays delivery | Passed |
| Expired crash lease reclaims with higher token | Passed |
| Terminal intent | Passed completed no-op |
| Superseded intent | Passed completed no-op |
| Terminal handler result | Passed sanitized failed job/intent |
| Malformed envelope | Passed fail-closed before ownership |
| No raw malformed data in failed reason/stack | Passed |
| Session 3 contract/static migration tests | Passed |
| Session 3 isolated legacy-shaped PostgreSQL migrations | Passed |
| Worker envelope and manifest secret-safety tests | Passed |
| Session 4 planner unit/PostgreSQL tests | Passed |
| Session 5 dispatcher unit/PostgreSQL/Redis tests | Passed |
| Session 6.1 runtime unit/PostgreSQL/Redis tests | Passed |
| Session 6.2 ownership unit/PostgreSQL tests | Passed |
| Session 6.3 invocation unit/PostgreSQL tests | Passed |
| Installed BullMQ | Passed; exact `5.79.2` |
| TypeScript type-check | Passed |
| Backend production build | Passed |
| `git diff --check` | Passed |

Every database test uses a unique PostgreSQL schema and removes it in
`finally`. Every Redis scenario uses a unique prefix, obliterates its isolated
queues, and closes connections in `finally`. No normal application migration
or external deployment operation was run.

## 7. Changed files

- `backend/src/orchestration-contracts/worker-runtime/v1-bullmq-consumer.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-bullmq-consumer.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/scripts/verify-inactive-v1-bullmq-consumer.ts`
- `backend/scripts/verify-inactive-v1-bullmq-consumer-postgres-redis.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_6_4_IMPLEMENTATION_FINDINGS.md`

## 8. Remaining risks

- Retryable or ownership-contended jobs can cycle until the immutable envelope
  expires. There is no v1 dead-letter/retry-budget policy yet.
- Capability rows are not deleted during stop; heartbeat stops and the row
  expires through its existing TTL.
- A service instance owns one explicitly started worker role. Multi-role
  operation would require separate explicitly managed instances/processes.
- Redis/heartbeat/loop failure states are sanitized but not connected to
  metrics, audit events, or operator alerts.
- Default typed placeholders return success without performing work. Starting
  this adapter manually therefore proves queue and fencing mechanics only; it
  must not be enabled for production until real side-effect handlers and their
  target-system idempotency are separately implemented and verified.
- The adapter relies on BullMQ delayed-job behavior verified against the exact
  pinned `bullmq@5.79.2`.

## 9. Boundary confirmation

Session 6.5 was not started. No automatic consumer exists after backend or
legacy-worker startup, and the two-lane orchestrator is not active.
