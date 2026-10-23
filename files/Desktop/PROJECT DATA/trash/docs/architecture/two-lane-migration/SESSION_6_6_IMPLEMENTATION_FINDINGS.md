# Session 6.6 Inactive Handler Side-effect Safety Findings

## 1. Outcome

Session 6.6 adds an explicitly inactive safety contract and durable journal for
future handler side effects. No real side-effect implementation was added.

The safety boundary is exposed to a fenced handler as:

```text
context.sideEffects.execute(...)
context.sideEffects.finalizationStatus()
```

Every registered fenced handler must declare:

```text
sideEffectPolicy = "deployguard.side-effect/v1"
```

The registry rejects handlers without that exact policy. The invocation wrapper
also checks the boundary's finalization gate before completing an intent. An
uncertain, failed, in-progress, unawaited, or contract-invalid effect therefore
cannot be followed by a successful fenced intent completion.

No ECS, Terraform, AWS, Docker, database-service, deletion, frontend, endpoint,
consumer activation, automatic startup, or legacy-pipeline behavior was added.
The default handlers remain non-executing placeholders.

## 2. Mandatory side-effect identity

The handler cannot supply or replace ownership identity. The invocation wrapper
captures it from the validated running intent and active lease.

Each effect request contains:

- exact intent ID;
- exact project and environment;
- caller-provided immutable operation UUID;
- 64-character side-effect idempotency key;
- safe effect-type slug;
- input fingerprint rather than input payload;
- exact lease ID;
- exact worker ID;
- exact fencing token; and
- a bounded execution timeout.

The executor receives these exact values plus an abort signal, deadline, and
`isLeaseTrusted()` check. Before journal preparation, immediately before
execution, and immediately before successful/failed finalization, the boundary
checks cancellation and lease trust.

The database transition independently verifies the active, unexpired lease,
running intent, lease ID, worker ID, and fencing token. Process-local trust
cannot substitute for the database fence.

## 3. Durable effect journal

Migration `1760000039000` adds `deployment_side_effects`.

The journal stores only:

- identity and fencing fields;
- request, result, and external-reference hashes;
- sanitized effect and machine-result codes;
- status and reconciliation state; and
- bounded timestamps.

It has no payload, credentials, secret values, raw external reference, SDK
response, or raw error column.

Statuses are:

```text
prepared -> started -> succeeded | failed | uncertain
                                      |
                                      -> reconciled
```

Unique indexes enforce:

- `(intent_id, operation_id)`; and
- `(intent_id, idempotency_key)`.

An index on reconciliation status supports a future inactive reconciler.

The migration is additive and idempotent. Empty rollback succeeds. Rollback
refuses to remove the table after any effect evidence exists because doing so
would destroy idempotency and reconciliation history.

## 4. Idempotency and replay

The canonical request fingerprint includes:

```text
schemaVersion
intentId
projectId
environmentName
operationId
idempotencyKey
effectType
inputFingerprint
```

Behavior:

| Existing logical effect | Result |
| --- | --- |
| Same key and same fingerprint, succeeded | Existing sanitized result replayed |
| Same key and same fingerprint, failed | Existing failure returned |
| Same request currently running | `in_progress`; executor is not called twice |
| Same request uncertain | Reconciliation required; executor is not called |
| Expired `started` deadline | Atomically changed to uncertain |
| Same operation/key with different fingerprint | Fail closed with idempotency conflict |
| Different current lease for a still-`prepared` effect | May adopt only before execution |

Concurrent identical calls invoke the supplied executor once. A `started`
effect is never silently repeated.

## 5. Execution and uncertainty rules

The external executor callback is the only effect-capable function accepted by
the boundary. It receives no persisted payload from the journal.

| Outcome | Journal behavior |
| --- | --- |
| Sanitized success | Record result hashes and machine code before intent completion |
| Sanitized known failure | Record failed result before intent finalization |
| Explicit uncertain result | Mark reconciliation required |
| Executor throws | Discard raw error and mark `SIDE_EFFECT_OUTCOME_UNKNOWN` |
| Cancellation | Abort trust and mark uncertain |
| Timeout | Abort trust and mark uncertain |
| Ownership replacement | Old attempt cannot record success; mark its own journal row uncertain |
| Fence lost during final write | Success is rejected and uncertainty is retained |

Journal success requires the effect row's original fence plus a still-active
matching operation lease and running intent.

A stale worker may conservatively mark only its own started journal attempt as
uncertain. It cannot record success, create a new effect, alter the replacement
lease, or complete the intent.

## 6. Bounded non-cooperative work

Effect execution accepts a timeout between 100 milliseconds and five minutes.
The executor receives a combined abort signal for timeout or Session 6.5 lease
trust cancellation.

The safety call returns when the bound is reached even if an executor promise
ignores cancellation. Its journal remains uncertain, and its late result is
ignored. The invocation finalization gate prevents the containing intent from
being completed successfully.

JavaScript cannot forcibly terminate arbitrary code. Future effect adapters
must still cooperate with the signal and must propagate the fencing token or
equivalent conditional-write identity to the target system.

## 7. Verification evidence

| Check | Result |
| --- | --- |
| Pure identity, timeout, result-shape validation | Passed |
| Unsafe fields and raw references rejected | Passed |
| Exact intent/operation/key/lease/token persisted | Passed |
| Cancellation/trust checked before execution | Passed |
| Database fence checked before journal start/finalization | Passed |
| Successful effect persisted while intent still `running` | Passed |
| Identical replay returns same logical result | Passed; executor count remained one |
| Concurrent identical requests | Passed; second result was `in_progress` |
| Same key with different input | Passed fail-closed |
| Thrown raw SDK-style error | Passed; only `SIDE_EFFECT_OUTCOME_UNKNOWN` stored |
| Timeout of non-cooperative work | Passed within bound and remained reconcilable |
| Cancellation | Passed and remained reconcilable |
| Ownership replacement | Passed; stale success rejected |
| Reconciliation query returns uncertain evidence | Passed |
| Known sanitized failure | Passed without reconciliation flag |
| Handler policy marker required by registry | Passed |
| Handler returning success after uncertain effect | Passed; intent failed with `SIDE_EFFECT_RECONCILIATION_REQUIRED` |
| Migration applies repeatedly | Passed |
| Empty migration rollback | Passed |
| Migration rollback with history | Passed fail-closed |
| Session 3 contract/migration regressions | Passed |
| Session 4 planner unit/PostgreSQL regressions | Passed |
| Session 5 dispatcher unit/PostgreSQL/Redis regressions | Passed |
| Session 6.1 runtime unit/PostgreSQL/Redis regressions | Passed |
| Session 6.2 ownership unit/PostgreSQL regressions | Passed |
| Session 6.3 invocation unit/PostgreSQL regressions | Passed |
| Session 6.4 consumer unit/PostgreSQL/Redis regressions | Passed |
| Session 6.5 heartbeat unit/PostgreSQL/Redis regressions | Passed |
| TypeScript type-check | Passed |
| Backend production build | Passed |
| `git diff --check` | Passed |

Focused PostgreSQL tests use temporary schemas and remove them in `finally`.
Redis regressions retain isolated prefixes and cleanup. Migration
`1760000039000` was not applied to the normal application database.

## 8. Changed files

- `backend/src/migrations/1760000039000-CreateDeploymentSideEffectJournal.ts`
- `backend/src/orchestration-contracts/entities/deployment-side-effect.entity.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-handler-side-effect.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-handler-side-effect.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-handler-side-effect-safety.service.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-fenced-invocation.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-placeholder-handlers.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/src/data-source.ts`
- `backend/scripts/verify-inactive-v1-handler-side-effect-safety.ts`
- `backend/scripts/verify-inactive-v1-handler-side-effect-safety-postgres.ts`
- `backend/scripts/verify-inactive-v1-fenced-invocation.ts`
- `backend/scripts/verify-inactive-v1-fenced-invocation-postgres.ts`
- `backend/scripts/verify-inactive-v1-bullmq-consumer-postgres-redis.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_6_6_IMPLEMENTATION_FINDINGS.md`

## 9. Remaining risks

- The policy marker and invocation boundary cannot stop a future source file
  from directly importing an SDK. Real-handler review and static import rules
  remain necessary.
- A non-cooperative promise may continue running after timeout. It cannot record
  trusted success, but the target system may still have changed; reconciliation
  is mandatory before any new idempotency key is allowed.
- No reconciler exists yet. This session only creates safe evidence and an
  inactive reconciliation query.
- External systems differ in their support for idempotency keys and fencing.
  Each future adapter needs a target-specific proof before activation.
- There are no metrics, audit events, retention policy, or operator UI for the
  journal.
- The migration must be applied before this explicitly inactive boundary can be
  exercised in a real environment.

## 10. Next bounded task

A separate inactive task should define reconciliation decisions for
`started`/`uncertain` journal rows and target-specific proof adapters. It must
remain read-only against external systems or use fixtures only, and must not
activate a real deployment handler.

No real deployment handler was implemented, and the orchestrator remains
inactive.
