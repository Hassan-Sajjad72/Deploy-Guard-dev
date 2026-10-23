# Session 5 Implementation Findings

## 1. Scope and activation status

Session 5 implements only the durable v1 outbox delivery boundary:

```text
eligible outbox row
  -> validate frozen envelope and queue routing
  -> verify a live compatible worker capability
  -> claim a delivery lease and increment its fencing token
  -> publish the exact deterministic BullMQ job ID
  -> conditionally finalize the outbox and intent in PostgreSQL
```

There is no controller, public route, timer, worker consumer, Terraform/ECS/AWS
call, frontend change, or legacy-pipeline replacement. The dispatcher is an
internal injectable service and is not automatically scheduled. The two-lane
orchestrator is **not active**, and Session 6 has not started.

## 2. Durable claim protocol

`DurableOutboxDispatcherService` selects one eligible `pending`/`failed` row, or
one `publishing` row whose lease has expired, using database time and
`FOR UPDATE SKIP LOCKED`.

Before ownership is granted it:

1. validates worker-envelope v1, expiry, hash, IDs, and secret-like keys;
2. verifies the frozen lane/message/queue relationship;
3. finds a `worker_capabilities` row whose role and message type match, whose
   protocol range contains v1, and whose `expires_at` is later than PostgreSQL
   `clock_timestamp()`.

An unavailable, incompatible, or stale capability keeps the row pending with
the sanitized code `WORKER_PROTOCOL_UNAVAILABLE`. An invalid envelope is moved
to `dead_letter` with `INVALID_WORKER_ENVELOPE`.

An accepted claim changes the row to `publishing`, records a unique dispatcher
owner, increments `attempt_count`, increments `claim_fencing_token`, and sets a
lease expiry. Publishing occurs outside the database transaction so no database
lock is held across Redis I/O.

## 3. BullMQ identity and duplicate delivery

The publisher uses the v1 lane queues:

- `deployguard-release-v1`
- `deployguard-infrastructure-v1`
- `deployguard-deletion-v1`

The physical BullMQ job ID remains the frozen value:

```text
dg:v1:<lane>:<intentId>:<operation>:<attempt>
```

BullMQ 5.12 normally rejects this frozen multi-colon form. A narrowly scoped
queue/job adapter applies BullMQ's option checks to an internal validation-only
alias and restores the exact frozen ID before the Redis command. It accepts only
IDs matching the frozen v1 grammar. No dependency or `node_modules` file was
changed.

Concurrent dispatchers cannot own the same unexpired row. If a publish succeeds
but the dispatcher crashes before PostgreSQL finalization, a later owner
re-publishes the same deterministic ID after lease expiry; BullMQ therefore
returns the same logical job rather than creating a second one.

## 4. Fencing and finalization

Migration `1760000038000-AddOutboxDeliveryFencing.ts` adds:

- `orchestration_outbox.claim_fencing_token bigint NOT NULL DEFAULT 0`;
- a non-negative check constraint;
- an index over status, claim expiry, and availability.

The migration is additive and idempotent. Its down path refuses to remove
fencing after delivery history or an active publishing row exists.

Success and failure updates require all of:

- matching outbox ID;
- `publishing` status;
- matching owner ID;
- matching fencing token;
- an unexpired lease.

Consequently, a timed-out owner cannot mark a newer owner's claim delivered or
failed. Successful finalization atomically marks the outbox `published`, records
the exact job ID and publish time, clears lease ownership, and moves a still
`planned` intent to `enqueued` in one PostgreSQL transaction.

## 5. Retry behavior

Redis/publisher failure stores only `REDIS_DELIVERY_UNAVAILABLE`, clears the
claim, and returns the row to retryable `failed` state with capped exponential
backoff based on the durable delivery-attempt counter. Raw transport exceptions
are not persisted.

The protocol is deliberately at-least-once between PostgreSQL and Redis and
exactly-once at the logical-job level through the immutable deterministic job
ID, row ownership, and fencing token.

## 6. Tests

### Pure/static proof

`verify-durable-outbox-dispatcher.ts` verifies:

- message-to-worker-role mapping;
- frozen queue routing;
- exact deterministic job ID grammar;
- rejection of legacy queue routing;
- capped retry backoff.

### Isolated PostgreSQL and Redis proof

`verify-durable-outbox-dispatcher-postgres-redis.ts` creates a unique PostgreSQL
schema and Redis prefix, then removes both test namespaces. It proves:

- the additive fencing migration can be applied repeatedly;
- stale and incompatible capabilities block publication;
- two concurrent dispatcher instances create one logical job and one delivered
  outbox result;
- the exact frozen job ID exists in Redis;
- a crash after publish is recovered after lease expiry;
- the reclaimed claim receives a higher fencing token;
- the stale owner cannot finalize;
- replay after recovery does not create a duplicate logical job;
- temporary publisher failure leaves the row retryable and does not persist the
  raw exception;
- retry later succeeds and updates the intent to `enqueued`.

The Session 4 PostgreSQL fixture was updated to apply the new additive fencing
migration because its entity metadata now includes that column. Production
planner behavior was not changed.

## 7. Verification results

| Verification | Result |
| --- | --- |
| TypeScript type-check (`tsc --noEmit --incremental false`) | Passed |
| Backend production build | Passed |
| Outbox dispatcher pure protocol test | Passed |
| Outbox dispatcher PostgreSQL/Redis integration test | Passed |
| Two-lane immutable contract shapes | Passed |
| Two-lane migration static safety | Passed |
| Two-lane legacy-shaped PostgreSQL migration apply/rollback | Passed |
| Worker-envelope v1 validation | Passed |
| Manifest secret-safety | Passed |
| Transactional planner pure test | Passed |
| Transactional planner PostgreSQL concurrency/rollback | Passed |

No frontend build was required because no frontend file changed. No external
cloud service, Terraform operation, ECS operation, AWS mutation, public
deployment endpoint, v1 consumer, or legacy pipeline execution was used.

## 8. Changed files

- `backend/src/orchestration-contracts/outbox/outbox-dispatcher.types.ts`
- `backend/src/orchestration-contracts/outbox/outbox-dispatcher.pure.ts`
- `backend/src/orchestration-contracts/outbox/bullmq-outbox.publisher.ts`
- `backend/src/orchestration-contracts/outbox/durable-outbox-dispatcher.service.ts`
- `backend/src/orchestration-contracts/entities/orchestration-outbox.entity.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/src/migrations/1760000038000-AddOutboxDeliveryFencing.ts`
- `backend/scripts/verify-durable-outbox-dispatcher.ts`
- `backend/scripts/verify-durable-outbox-dispatcher-postgres-redis.ts`
- `backend/scripts/verify-transactional-deployment-planner-postgres.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_5_IMPLEMENTATION_FINDINGS.md`

## 9. Deferred boundary

Session 5 does not decide dispatcher process scheduling, create or register v1
workers, consume v1 jobs, execute release/infrastructure/deletion work, expose a
planner endpoint, or switch canonical product state. Those boundaries remain
deferred; this document does not authorize Session 6.
