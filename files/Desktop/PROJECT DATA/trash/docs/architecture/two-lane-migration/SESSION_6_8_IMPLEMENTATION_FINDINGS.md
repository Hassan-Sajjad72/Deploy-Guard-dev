# Session 6.8 Inactive Reconciliation Coordinator Findings

## 1. Outcome

Session 6.8 adds an explicitly callable, inactive coordinator for the Session
6.7 read-only side-effect reconciliation boundary.

The coordinator:

1. validates the fixture/read-only inspection request;
2. locks the side-effect row in a serializable PostgreSQL transaction;
3. expires stale reconciliation ownership;
4. closes abandoned inspection rows as sanitized `pending` evidence;
5. replays an existing identical completed classification;
6. rejects conflicting idempotency reuse;
7. grants one dedicated per-side-effect lease with a higher fencing token;
8. invokes the existing read-only reconciliation boundary; and
9. releases or fails only the exact fenced lease it owns.

It never invokes the original side-effect executor.

No real evidence adapter, deployment handler, endpoint, scheduler, consumer
activation, automatic startup, ECS, Terraform, AWS, Docker, database-service,
deletion, frontend, or legacy-pipeline behavior was added. The two-lane
orchestrator remains inactive.

## 2. Dedicated ownership model

Reconciliation does not reuse `project_operation_leases`. Reusing that table
would require adding a reconciliation lane or scope to the frozen
release/infrastructure/deletion protocol.

Migration `1760000041000` therefore adds:

```text
deployment_side_effect_reconciliation_leases
```

Each lease contains:

- side-effect, intent, project, and environment identity;
- exact owner worker ID;
- monotonically increasing per-side-effect fencing token;
- acquired, heartbeat, expiry, and release timestamps;
- status; and
- `coordinator` or `legacy_backfill` origin.

A partial unique index permits one `acquired` or `heartbeat_active` lease per
side effect. A second unique index prevents fencing-token reuse for that side
effect.

The coordinator serializes claims by locking the side-effect row and allocates:

```text
MAX(fencing_token) + 1
```

Serializable, deadlock, and uniqueness conflicts are retried at most three
times. No transaction is held while a read-only adapter runs.

## 3. Session 6.7 migration compatibility

Session 6.7 reconciliation rows originally referenced
`project_operation_leases`.

Migration `1760000041000` preserves those rows by:

1. creating expired `legacy_backfill` reconciliation leases;
2. recording the original operation-lease ID;
3. moving each reconciliation row to its dedicated historical lease; and
4. replacing the foreign key only after the historical mapping exists.

Empty and legacy-only rollback restores the original operation-lease references.
Rollback refuses once coordinator-origin history exists, because removing the
dedicated leases would destroy fencing and abandoned-inspection evidence.

No legacy result, idempotency key, evidence hash, or classification is changed.

## 4. Claim eligibility and idempotency

A new lease is issued only when:

- the side effect is `started` or `uncertain`;
- its intent is `running` or `failed`;
- no unexpired reconciliation owner exists; and
- no matching completed reconciliation can be replayed.

`prepared`, `succeeded`, `failed`, and `reconciled` effects are not claimable.

Behavior:

| Existing state | Coordinator result |
| --- | --- |
| Identical completed evidence | Sanitized terminal evidence replay |
| Identical active inspection | `inspection_in_progress` |
| Different request under same key/operation | Fail-closed conflict |
| Another active lease | `inspection_in_progress` |
| Eligible side effect, no active owner | New fenced claim |
| Ineligible side effect | `effect_not_eligible` |

Replay does not acquire a new lease and never calls the adapter.

## 5. Abandoned inspection recovery

On the next explicit claim, the coordinator expires active-status leases whose
database expiry has passed. It then finds incomplete inspection rows whose
lease is expired, released, or failed.

Each abandoned inspection is atomically completed as:

```text
classification = pending
safeEvidenceCode = RECONCILIATION_PREVIOUS_INSPECTION_ABANDONED
```

The evidence fingerprint is deterministic and contains only safe identities
and hashes. The side effect remains `uncertain` with reconciliation required.
The original effect is never retried.

A replacement request with a new reconciliation idempotency identity can then
receive the next fencing token. Reusing the abandoned request returns its
durable pending result instead.

If the replacement claim fails, the abandoned-row updates and lease expiry
normalization roll back with the claim transaction.

## 6. Stale-owner protection

The Session 6.7 service now verifies
`deployment_side_effect_reconciliation_leases` before:

- creating an inspection row; and
- committing succeeded, failed, pending, or manual-review evidence.

Every check requires the exact lease ID, worker ID, fencing token, side effect,
intent, project, environment, active status, and unexpired timestamp.

After replacement:

- the old adapter cannot record succeeded or failed evidence;
- the old coordinator cannot release or fail the replacement lease;
- its incomplete inspection is retained as sanitized pending evidence; and
- only the new fenced owner can update the side-effect outcome.

The process cannot forcibly terminate a non-cooperative stale read-only
function. Such a function has no trusted database ownership and its late result
is ignored.

## 7. No-repeat and sanitization guarantees

The coordinator accepts only adapters declaring:

```text
deployguard.side-effect-reconciliation/read-only-v1
```

It passes the adapter only through the existing Session 6.7 exact-shape
validation. Raw payloads, SDK responses, credentials, errors, and external
references are not persisted.

Pending and manual-review results leave the original side effect uncertain.
There is no import or call path to Session 6.6 `perform()`, an external SDK,
Terraform, Docker, ECS, deletion, or the legacy pipeline.

## 8. Verification evidence

Focused verification:

| Check | Result |
| --- | --- |
| Coordinator identity and TTL validation | Passed |
| Dedicated lease migration applies repeatedly | Passed |
| Legacy Session 6.7 lease mapping | Passed |
| Legacy-only rollback restores old FK | Passed |
| Coordinator-history rollback | Passed fail-closed |
| One active owner per side effect | Passed |
| Concurrent identical coordinators | Passed; inspector count remained one |
| Per-side-effect fencing tokens increase | Passed |
| Eligible `started`/`uncertain` claims | Passed |
| All other side-effect statuses rejected | Passed |
| Identical terminal evidence replay | Passed; no adapter call or new lease |
| Changed request under same key | Passed fail-closed |
| Abandoned inspection closure | Passed with sanitized pending evidence |
| Replacement owner receives next token | Passed |
| Stale success after replacement | Passed; evidence rejected |
| Pending/manual-review paths | Passed without original effect execution |
| Raw thrown adapter error | Passed; raw value absent from journal |
| Intent status remains unchanged | Passed |

Regression verification:

- Session 3 contract and migration suites passed.
- Session 4 planner unit and PostgreSQL suites passed.
- Session 5 dispatcher unit and PostgreSQL/Redis suites passed.
- Session 6.1 runtime unit and PostgreSQL/Redis suites passed.
- Session 6.2 ownership unit and PostgreSQL suites passed.
- Session 6.3 invocation unit and PostgreSQL suites passed.
- Session 6.4 consumer unit and PostgreSQL/Redis suites passed.
- Session 6.5 heartbeat unit/integration coverage passed.
- Session 6.6 side-effect safety unit and PostgreSQL suites passed.
- Session 6.7 reconciliation unit and PostgreSQL suites passed.
- TypeScript type-check passed.
- Backend production build passed.
- `git diff --check` passed.

All focused PostgreSQL tests use isolated temporary schemas and remove them in
`finally`. Existing Redis tests retain isolated prefixes and cleanup. No normal
application migration or external operation was run.

## 9. Changed files

- `backend/src/migrations/1760000041000-CreateSideEffectReconciliationLeases.ts`
- `backend/src/orchestration-contracts/entities/deployment-side-effect-reconciliation-lease.entity.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-side-effect-reconciliation-coordinator.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-side-effect-reconciliation-coordinator.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-side-effect-reconciliation-coordinator.service.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-side-effect-reconciliation.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-side-effect-reconciliation.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-side-effect-reconciliation.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/src/data-source.ts`
- `backend/scripts/verify-inactive-v1-side-effect-reconciliation-coordinator.ts`
- `backend/scripts/verify-inactive-v1-side-effect-reconciliation-coordinator-postgres.ts`
- `backend/scripts/verify-inactive-v1-side-effect-reconciliation-postgres.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_6_8_IMPLEMENTATION_FINDINGS.md`

## 10. Remaining risks

- A policy marker cannot prove future adapter source is read-only. Real adapters
  still require an import allowlist, review, and target-specific tests.
- There is no reconciliation lease heartbeat. The coordinator requires lease
  TTL to exceed inspection timeout by at least 250 milliseconds; database
  fencing fails closed if the lease nevertheless expires.
- A stale non-cooperative read-only function may continue in its old process
  after lease expiry. It cannot persist evidence, mutate the replacement lease,
  or invoke the original side effect.
- There is no scheduler, endpoint, consumer, operator UI, audit event, retention
  policy, or production adapter.
- Migration `1760000041000` must be applied before the inactive coordinator can
  be exercised outside isolated tests.

## 11. Next bounded task

A future bounded task may add inactive reconciliation-lease heartbeat and
shutdown handling for long read-only inspections. It must remain fixture-only
and must not introduce a real adapter or activate the orchestrator.

