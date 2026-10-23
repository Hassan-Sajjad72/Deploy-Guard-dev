# Session 5.1 Hardening Findings

## 1. Outcome

Session 5.1 closes the dispatcher risks identified by
`SESSION_5_VERIFICATION_AUDIT.md` without activating any runtime entry point.

The hardened boundary now requires:

- an exact `planned -> enqueued` intent transition before outbox finalization
  may commit;
- a strict message/lane/operation/queue relationship;
- a valid frozen v1 job ID at the BullMQ adapter itself;
- the installed BullMQ version to equal the verified version;
- an exact BullMQ dependency pin.

The dispatcher remains an internal, manually callable provider. There is still
no scheduler, controller, public endpoint, v1 worker consumer, Terraform/ECS/AWS
path, frontend path, or legacy-pipeline replacement.

## 2. Atomic intent finalization

`DurableOutboxDispatcherService.completeDelivery()` still performs outbox and
intent updates in one PostgreSQL transaction. The intent update now uses
`RETURNING id` and requires exactly one returned row.

If the intent is missing or is no longer `planned`:

1. `OutboxIntentTransitionConflictError` is raised;
2. PostgreSQL rolls back the preceding outbox `published` update;
3. the fenced owner moves the outbox to retryable `failed`;
4. only the sanitized code `INTENT_TRANSITION_CONFLICT` is persisted;
5. the intent status and `enqueued_at` remain unchanged.

Publisher errors and finalization errors are handled separately. Only failures
from the publisher are classified as `REDIS_DELIVERY_UNAVAILABLE`; unexpected
database/programming errors are no longer mislabeled as Redis failures.

The Redis job can already exist when the database transition conflicts. This is
an expected outbox crash-window condition: retry uses the same deterministic
job ID, and a future v1 consumer must treat a terminal/superseded intent as an
idempotent no-op. No consumer was introduced in this session.

## 3. Frozen BullMQ adapter

The protected-API workaround was isolated in:

`backend/src/orchestration-contracts/outbox/frozen-bullmq-job.adapter.ts`.

The adapter:

- declares `VERIFIED_BULLMQ_VERSION = "5.79.2"`;
- checks the actually installed `bullmq/package.json` version before creating a
  queue;
- refuses missing, arbitrary, or malformed job IDs itself;
- temporarily substitutes only a validation alias;
- delegates all other validation to BullMQ;
- restores the exact frozen ID in `finally` before BullMQ's Redis script.

Both `package.json` and the root package-lock dependency now pin BullMQ to exact
version `5.79.2`, replacing `^5.12.8`. `npm ls bullmq --depth=0` resolves exactly
`bullmq@5.79.2`.

No `node_modules` file, global prototype, module loader, postinstall hook, or
patch-package configuration was changed.

## 4. Route and ID validation

The dispatcher now recognizes only these executable Session 5 routes:

| Message | Lane | Operation | Queue |
| --- | --- | --- | --- |
| `intent.release.execute` | `release` | `execute` | `deployguard-release-v1` |
| `intent.infrastructure.plan` | `infrastructure` | `plan` | `deployguard-infrastructure-v1` |
| `intent.infrastructure.apply` | `infrastructure` | `apply` | `deployguard-infrastructure-v1` |
| `intent.deletion.execute` | `deletion` | `destroy` | `deployguard-deletion-v1` |

`outbox.reconcile` is fail-closed because the frozen Session 5 contract does not
assign it an execution lane/queue and no reconciliation consumer exists.

## 5. Added negative tests

The focused pure test now directly verifies:

- wrong queue rejection;
- wrong message/operation route rejection;
- `outbox.reconcile` rejection;
- invalid UUID, version, lane, operation, attempt, and extra ID segments;
- installed BullMQ version compatibility.

The isolated PostgreSQL/Redis test now directly verifies:

- the isolated adapter stores the exact physical frozen ID;
- the adapter rejects malformed and missing IDs;
- stale capability expiry blocks;
- incompatible protocol blocks;
- wrong worker role blocks;
- wrong supported message type blocks;
- concurrent dispatch remains one logical job;
- lease reclaim and stale fencing remain safe;
- raw Redis errors remain sanitized and retryable;
- a non-`planned` intent rolls back outbox publication finalization;
- the conflict stores only `INTENT_TRANSITION_CONFLICT`;
- migration `1760000038000` supports a clean down/up before delivery history;
- the migration refuses down after fencing history and retains its column.

All database tests use unique schemas. The dispatcher integration also uses a
unique Redis prefix and removes both namespaces in `finally`.

## 6. Verification results

| Verification | Result |
| --- | --- |
| TypeScript type-check (`npx tsc --noEmit --incremental false`) | Passed |
| Backend production build | Passed |
| Dispatcher pure/version/route test | Passed |
| Dispatcher isolated PostgreSQL/Redis hardening test | Passed |
| Session 3 contract shapes | Passed |
| Session 3 migration static safety | Passed |
| Session 3 isolated PostgreSQL migration apply/rollback | Passed |
| Worker-envelope v1 validation | Passed |
| Manifest secret-safety | Passed |
| Session 4 planner pure regression | Passed |
| Session 4 isolated PostgreSQL concurrency/rollback | Passed |
| `npm ls bullmq --depth=0` | Passed; `bullmq@5.79.2` |
| `git diff --check` | Passed |

No normal application migration, Terraform command, ECS/AWS operation, external
deployment, frontend build, or legacy pipeline execution was run.

## 7. Changed files

- `backend/src/orchestration-contracts/outbox/frozen-bullmq-job.adapter.ts`
- `backend/src/orchestration-contracts/outbox/bullmq-outbox.publisher.ts`
- `backend/src/orchestration-contracts/outbox/outbox-dispatcher.pure.ts`
- `backend/src/orchestration-contracts/outbox/outbox-dispatcher.types.ts`
- `backend/src/orchestration-contracts/outbox/durable-outbox-dispatcher.service.ts`
- `backend/scripts/verify-durable-outbox-dispatcher.ts`
- `backend/scripts/verify-durable-outbox-dispatcher-postgres-redis.ts`
- `backend/package.json`
- `backend/package-lock.json`
- `docs/architecture/two-lane-migration/SESSION_5_1_HARDENING_FINDINGS.md`

## 8. Remaining boundary

The implementation still relies on a protected BullMQ extension hook, but that
risk is now bounded by an exact dependency pin, a runtime version assertion,
and a real Redis compatibility test. Session 3–5 work remains untracked in the
current dirty worktree; Session 5.1 did not stage or commit user work.

Session 6 was not started, and the two-lane orchestrator is not active.
