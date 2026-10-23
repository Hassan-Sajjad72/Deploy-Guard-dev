# Session 6.7 Inactive Side-effect Reconciliation Findings

## 1. Outcome

Session 6.7 adds an explicitly inactive, read-only reconciliation boundary for
side effects that stopped in `started` or `uncertain`.

The boundary can classify existing target evidence as:

```text
succeeded | failed | pending | manual_review
```

It never calls the original side-effect executor. It accepts only a
policy-marked read-only evidence adapter:

```text
deployguard.side-effect-reconciliation/read-only-v1
```

No real adapter, deployment handler, endpoint, scheduler, consumer activation,
automatic startup, ECS, Terraform, AWS, Docker, database-service, deletion,
frontend, or legacy-pipeline behavior was added. The two-lane orchestrator
remains inactive.

## 2. Boundary and ownership

`InactiveV1SideEffectReconciliationService.forOwnership()` captures:

- intent, project, and environment;
- reconciliation operation and idempotency identities;
- exact operation lease ID;
- exact worker ID;
- exact fencing token;
- cancellation signal; and
- process-local lease trust.

Before an inspection record is created, PostgreSQL independently verifies that:

- the exact lease, worker, and token still match;
- the lease belongs to the exact intent, project, and environment;
- the lease is `acquired` or `heartbeat_active`;
- the lease has not expired; and
- the intent is `running` or `failed`.

The same checks run again before evidence can update the side-effect row.
A stale owner may close only its own inspection as `pending`; it cannot record
success or failure against the side effect.

## 3. Durable reconciliation journal

Migration `1760000040000` adds
`deployment_side_effect_reconciliations`.

Each row stores:

- side-effect, intent, project, and environment identity;
- reconciliation operation and idempotency keys;
- adapter ID and canonical request fingerprint;
- lease, worker, and fencing identity;
- one sanitized classification;
- sanitized machine codes and hashes; and
- bounded timestamps.

It contains no request payload, SDK response, raw external reference,
credential, secret, or raw error column.

Unique indexes on `(side_effect_id, operation_id)` and
`(side_effect_id, idempotency_key)` prevent duplicate logical inspections.
The original side-effect journal remains the durable record of the attempted
external mutation; reconciliation evidence is appended separately and never
rewrites the original ownership identity.

The migration is additive and idempotent. Empty rollback succeeds. Rollback
refuses to remove recorded reconciliation evidence.

## 4. Eligibility and classifications

Only a new inspection of a `started` or `uncertain` side-effect row is allowed.
`prepared`, `succeeded`, `failed`, and `reconciled` rows fail closed.
A previously completed identical reconciliation can still be replayed after
the side-effect status changes; replay does not call the adapter.

| Read-only evidence | Side-effect result |
| --- | --- |
| `succeeded` | `succeeded`, sanitized result hashes recorded |
| `failed` | `failed`, sanitized failure code recorded |
| `pending` | `uncertain`, reconciliation remains required |
| `manual_review` | `uncertain`, manual-review code retained |
| Adapter throw or malformed response | `manual_review`; raw value discarded |
| Timeout | `pending`; late adapter result ignored |
| Cancellation or ownership loss | `pending`; side-effect outcome unchanged |

Success and known failure are recorded atomically with their reconciliation
row. The service does not complete or otherwise transition the deployment
intent.

## 5. Idempotency and no-repeat rule

The canonical reconciliation request fingerprint includes:

```text
sideEffectId
intentId
projectId
environmentName
operationId
idempotencyKey
adapterId
inspectionFingerprint
effectRequestFingerprint
```

Lease, worker, and fencing values are recorded but are not part of the logical
request fingerprint. This allows a valid replacement owner to observe the
same durable result without changing its identity.

Behavior:

| Existing reconciliation | Result |
| --- | --- |
| Same operation/key/fingerprint, complete | Replay sanitized classification |
| Same operation/key/fingerprint, inspecting | `inspection_in_progress` |
| Same key or operation with different request | Fail-closed conflict |
| No existing record and effect eligible | Run one read-only inspection |
| Original side effect uncertain | Never invoke the original effect |

## 6. Sanitization and bounded inspection

Evidence objects use exact-key validation. Extra properties, including a raw
SDK response or payload, are rejected. All persisted codes use the existing
safe machine-code grammar. Evidence, result, and external references must be
SHA-256 hashes.

Thrown adapter values are discarded and converted to
`RECONCILIATION_INSPECTION_FAILED`. Timeout, cancellation, and ownership-loss
records also use fixed machine codes and deterministic evidence fingerprints.

Inspections are bounded between 100 milliseconds and five minutes. A
non-cooperative fixture may continue after timeout, but its late value is
ignored and cannot update the side-effect outcome.

## 7. Verification evidence

Focused verification:

| Check | Result |
| --- | --- |
| Pure identity and fingerprint validation | Passed |
| Exact sanitized evidence shapes | Passed |
| Raw/extra SDK response rejection | Passed |
| Additive migration apply twice | Passed |
| Empty rollback | Passed |
| Rollback with evidence | Passed fail-closed |
| `started` and `uncertain` eligibility | Passed |
| All other side-effect statuses rejected | Passed |
| Sanitized success and failure classification | Passed |
| Pending and manual-review classification | Passed |
| Identical replay invokes inspector once | Passed |
| Same key with changed input | Passed fail-closed |
| Concurrent identical inspection | Passed; second saw in-progress |
| Stale worker before inspection | Passed; adapter not called |
| Ownership replacement during inspection | Passed; stale success rejected |
| Timeout and late result suppression | Passed |
| Raw thrown error not persisted | Passed |
| Intent remains unchanged | Passed |

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
- TypeScript type-check passed.
- Backend production build passed.
- `git diff --check` passed.

All focused PostgreSQL tests create an isolated temporary schema and remove it
in `finally`. Existing Redis regressions use isolated prefixes and cleanup.
Neither migration was applied to the normal application database.

## 8. Changed files

- `backend/src/migrations/1760000040000-CreateSideEffectReconciliationJournal.ts`
- `backend/src/orchestration-contracts/entities/deployment-side-effect-reconciliation.entity.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-side-effect-reconciliation.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-side-effect-reconciliation.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-side-effect-reconciliation.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/src/data-source.ts`
- `backend/scripts/verify-inactive-v1-side-effect-reconciliation.ts`
- `backend/scripts/verify-inactive-v1-side-effect-reconciliation-postgres.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_6_7_IMPLEMENTATION_FINDINGS.md`

## 9. Remaining risks

- A TypeScript policy marker cannot prove that future adapter source is truly
  read-only. Real adapters still require an import allowlist, code review, and
  target-specific tests before activation.
- This session does not acquire a new reconciliation lease. A future inactive
  coordinator must define how a failed intent receives a fenced reconciliation
  owner without weakening the Session 6.2 lock protocol.
- A process crash after creating an inspection row can leave that inspection
  incomplete. An explicit abandoned-inspection policy is required; it must not
  repeat an uncertain side effect.
- There is no scheduler, endpoint, operator UI, audit event, retention policy,
  or production adapter.
- Migration `1760000040000` must be applied before this inactive boundary can be
  exercised outside isolated tests.

## 10. Next bounded task

The next bounded task should define an inactive reconciliation coordinator that
claims a dedicated fenced owner and safely classifies abandoned read-only
inspection attempts. It should continue using fixtures only and must not add a
real target adapter or activate the orchestrator.

