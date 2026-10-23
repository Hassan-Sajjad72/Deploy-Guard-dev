# Session 6.2 Inactive Pre-execution Ownership Findings

## 1. Outcome

Session 6.2 adds an explicitly callable, inactive ownership boundary between the
Session 6.1 v1 validation runtime and any future execution handler.

The boundary:

1. reuses the unchanged Session 6.1 envelope, queue, capability, intent,
   supersession, and deletion-fence validation;
2. requires `fencingTokenRequired=true`;
3. rechecks envelope expiry, capability compatibility, intent identity,
   terminal/superseded state, and deletion ownership inside the claim path;
4. locks the project row to serialize one project/environment ownership
   decision;
5. expires stale operation leases;
6. applies the frozen lane conflict matrix;
7. assigns the next project/environment fencing token;
8. inserts the lease and conditionally transitions `enqueued -> running` in one
   serializable PostgreSQL transaction.

No BullMQ consumer, scheduler, lifecycle hook, endpoint, frontend path,
Terraform, ECS, AWS, Docker, deletion executor, or legacy pipeline was added or
activated. No migration or frozen contract was changed. The orchestrator remains
inactive.

## 2. Ownership model

`InactiveV1PreExecutionOwnershipService.claim()` accepts only:

- a worker ID;
- the queue name;
- the frozen v1 envelope; and
- a bounded lease TTL.

The logical job ID is recomputed from the envelope. It is never accepted from
the caller. Lease metadata contains only the protocol identifier, deterministic
job ID, payload hash, and message type.

The project row is locked before operation-lease mutation. This serializes
fencing allocation and conflict decisions without holding a transaction during
external work. Fencing tokens are allocated with
`MAX(fencing_token)+1` across every lane and scope for the exact
project/environment.

The existing partial unique index still guarantees one active row per
project/environment/lane/scope. The service additionally enforces the frozen
cross-scope conflict matrix:

| Requested / active | Release execute | Infrastructure plan | Infrastructure apply | Deletion |
| --- | ---: | ---: | ---: | ---: |
| Release execute | conflict | allowed | conflict | conflict |
| Infrastructure plan | allowed | conflict | conflict | conflict |
| Infrastructure apply | conflict | conflict | conflict | conflict |
| Deletion | conflict | conflict | conflict | conflict |

Serializable/deadlock failures are retried at most three times. Other failures
are not hidden or reclassified.

## 3. Duplicate and recovery behavior

- Same logical job, same active owner: returns `already_owned` with the existing
  lease and token.
- Same logical job, different active owner: returns an idempotent no-op without
  disclosing a usable fencing token to the second worker.
- Expired logical claim with an intent still `running`: the old row becomes
  `expired`, a new owner receives a higher fencing token, and the intent remains
  `running`.
- `completed`, `failed`, `cancelled`, `no_op`, or `rejected` intent: idempotent
  terminal no-op.
- Newer same-lane/deletion intent or superseded manifest: idempotent superseded
  no-op.
- Any other non-`enqueued` state: fail closed.

Infrastructure planning may coexist with release execution as frozen. A later
intent in that allowed separate lane does not falsely supersede the release.

## 4. Fenced lifecycle operations

The boundary exposes explicit methods only:

- `renew`: changes an owned, live lease to `heartbeat_active` and extends it
  only while the worker capability still supports the stored message type.
- `complete`: atomically releases the current lease and changes
  `running -> completed`.
- `fail`: atomically fails the current lease and changes `running -> failed`
  using only a sanitized machine failure code.
- `release`: atomically releases the current lease and changes
  `running -> enqueued`.

Every method requires the exact lease ID, owner worker ID, and fencing token.
Renewal and terminal/release operations require an unexpired active lease.
Expired or replaced owners therefore cannot renew, complete, fail, or release a
newer claim.

## 5. Atomicity proof

Focused PostgreSQL tests install temporary triggers that reject:

1. the initial `enqueued -> running` intent transition after lease insertion;
2. the `running -> completed` transition after lease release mutation.

Both failures roll back the preceding lease mutation. The first leaves no lease
and keeps the intent `enqueued`; the second keeps the lease `acquired` and the
intent `running`.

Two concurrent workers claiming the same logical job produce exactly one
`claimed` result, one `duplicate_delivery_owned_elsewhere` no-op, one active
lease, and one `running` intent.

## 6. Verification

| Check | Result |
| --- | --- |
| Session 6.2 ownership unit/architecture test | Passed |
| Session 6.2 isolated PostgreSQL concurrency test | Passed |
| One active lease for a protected operation | Passed |
| Increasing project/environment fencing tokens | Passed |
| Same-owner duplicate delivery | Passed, existing ownership reused |
| Different-worker concurrent duplicate | Passed, one owner only |
| Expired-owner takeover | Passed with higher token |
| Stale renew/complete/fail/release | Passed fail-closed |
| Claim and completion rollback triggers | Passed with no partial transition |
| Terminal/cancelled/rejected/superseded no-op | Passed |
| Frozen cross-lane conflict matrix | Passed |
| Mandatory fencing flag | Passed fail-closed |
| Session 6.1 unit and PostgreSQL/Redis regression | Passed |
| Session 3 contracts/static migrations | Passed |
| Session 3 isolated PostgreSQL migrations | Passed |
| Session 4 planner unit/PostgreSQL regression | Passed |
| Session 5 dispatcher unit/PostgreSQL/Redis regression | Passed |
| Worker envelope and manifest secret safety | Passed |
| TypeScript type-check | Passed |
| Backend production build | Passed |
| `git diff --check` | Passed |

All PostgreSQL tests use unique schemas and remove them in `finally`. Session
6.1 and Session 5 Redis tests retain unique prefixes and cleanup. No normal
application database migration or external deployment operation was run.

## 7. Changed files

- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.service.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-pre-execution-ownership.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-pre-execution-ownership.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-pre-execution-ownership.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/scripts/verify-inactive-v1-pre-execution-ownership.ts`
- `backend/scripts/verify-inactive-v1-pre-execution-ownership-postgres.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_6_2_IMPLEMENTATION_FINDINGS.md`

## 8. Remaining risks

- The project row intentionally serializes every ownership decision for one
  project. This is safe but may become a contention point under high churn.
- There is no background lease-expiry sweeper. Expired active-status rows are
  normalized when the next claim is attempted.
- Lease renewal is explicit; no consumer or execution loop maintains it.
- Worker capability rows still have no independent registration-generation
  token because the frozen schema does not define one. Operation ownership is
  protected separately by its fencing token.
- Lifecycle methods are not invoked by any production handler.
- Ownership metrics, audit events, and dead-letter handling remain absent.

## 9. Next bounded task

A separate Session 6.3 may define an inactive lease-scoped invocation wrapper
that passes the exact fencing context to one typed placeholder and proves that
handler outcomes use the fenced lifecycle methods. It should still avoid queue
startup and every external or legacy deployment action.

Session 6.3 was not started.
