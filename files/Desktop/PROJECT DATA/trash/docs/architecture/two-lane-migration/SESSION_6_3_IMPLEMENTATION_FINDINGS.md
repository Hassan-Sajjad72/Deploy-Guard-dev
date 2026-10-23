# Session 6.3 Inactive Fenced Invocation Findings

## 1. Outcome

Session 6.3 adds an explicitly callable, inactive wrapper between the Session
6.2 ownership boundary and the Session 6.1 typed placeholders.

The wrapper:

1. snapshots and validates the frozen v1 envelope;
2. obtains Session 6.2 ownership before resolving or invoking a handler;
3. reloads the exact active lease, running intent, and immutable manifest
   revisions under the lease ID, worker ID, and fencing token;
4. validates both manifest shapes and secret-safety rules;
5. invokes exactly one typed placeholder;
6. maps success, retryable, and terminal outcomes to the existing fenced
   `complete`, `release`, and `fail` methods.

No BullMQ consumer, scheduler, bootstrap hook, controller, frontend path,
Terraform, ECS, AWS, Docker, deletion executor, or legacy-pipeline call was
added. The wrapper is registered as a side-effect-free Nest provider but has no
production caller. The two-lane orchestrator remains inactive.

## 2. Invocation contract

`InactiveV1FencedInvocationService.invoke()` accepts only:

- worker ID;
- frozen queue name;
- frozen v1 envelope; and
- optional bounded Session 6.2 lease TTL.

The caller cannot supply a lease ID or fencing token. Those values come only
from `InactiveV1PreExecutionOwnershipService.claim()`.

After a new claim, the wrapper reloads the context with a query requiring:

- exact lease ID, worker ID, fencing token, intent ID, project, and
  environment;
- active, unexpired lease status;
- exact deterministic logical job ID from lease metadata;
- running intent status; and
- exact infrastructure/release manifest references.

The handler context contains:

- `leaseId`, `workerId`, `fencingToken`, and deterministic `logicalJobId`;
- the complete lease snapshot;
- the running intent identity;
- the referenced immutable infrastructure and release manifest snapshots;
- typed message, queue, lane, and operation route context; and
- a detached validated v1 envelope.

Manifest snapshots are recursively frozen. Before invocation, their immutable
create contracts, hashes, source identity, project/environment ownership,
release-to-infrastructure link, and no-plaintext-secret rules are revalidated.
A malformed manifest is fenced-failed with only
`INVOCATION_MANIFEST_INVALID`.

## 3. Typed placeholder routing

The frozen registry contains exactly:

| Message | Placeholder outcome |
| --- | --- |
| `intent.release.execute` | success |
| `intent.infrastructure.plan` | success |
| `intent.infrastructure.apply` | success |
| `intent.deletion.execute` | success |

Registry construction rejects duplicates, missing handlers, and unexpected
message types. The default handlers are frozen, zero-dependency objects. They
only return a typed outcome and contain no database, queue, subprocess,
Terraform, ECS, AWS, Docker, deletion, or legacy-pipeline access.

The wrapper additionally checks that the resolved handler's declared message
type equals the validated message type before calling it.

## 4. Fenced outcome lifecycle

| Handler result | Fenced lifecycle action | Intent result | Lease result |
| --- | --- | --- | --- |
| `success` | `complete` | `completed` | `released` |
| `retryable` | `release` | `enqueued` | `released` |
| `terminal_failure` | `fail` | `failed` | `failed` |
| handler throws | `fail` with `PLACEHOLDER_HANDLER_THROWN` | `failed` | `failed` |

Terminal failure codes are accepted only through the existing uppercase
machine-code validator. Raw exceptions and messages are never persisted.
Malformed outcomes are reduced to a sanitized placeholder failure code.

If the lease expires or is replaced while a handler is running, the existing
fenced lifecycle predicate rejects the stale completion. The wrapper returns
`ownership_lost` and does not alter the newer claim.

Failure during an intent finalization rolls the lease mutation back in the same
Session 6.2 transaction. A PostgreSQL trigger test proves that a thrown handler
followed by a rejected failure transition leaves the consistent pre-final state:
intent `running`, lease `acquired`.

## 5. Duplicate and terminal behavior

- Same logical delivery while the same worker already owns the active lease:
  `duplicate_delivery_already_owned`; no second handler invocation.
- Same logical delivery while another worker owns the active lease:
  `duplicate_delivery_owned_elsewhere`; no handler invocation and no usable
  fencing token disclosure.
- Terminal intent: `intent_terminal`; no claim and no handler.
- Superseded intent or manifest: `intent_superseded`; no claim and no handler.
- Ownership lost before context load or finalization: `ownership_lost`; the
  stale wrapper cannot change current ownership.

Expired ownership remains reclaimable through Session 6.2 and receives a
higher fencing token.

## 6. Verification evidence

| Check | Result |
| --- | --- |
| Session 6.3 pure registry/architecture test | Passed |
| Session 6.3 isolated PostgreSQL test | Passed |
| Four frozen messages route to their one matching placeholder | Passed |
| Exact lease/worker/token/intent/manifests/route context | Passed |
| Recursively frozen manifest snapshots | Passed |
| Success completes through fenced lifecycle | Passed |
| Retryable outcome releases to `enqueued` | Passed |
| Terminal failure stores sanitized code only | Passed |
| Thrown handler stores no raw error | Passed |
| Same-owner and other-owner duplicate delivery | Passed, handler count remained one |
| Stale handler after higher-token reclaim | Passed fail-closed |
| Terminal and superseded intent | Passed idempotent no-op |
| Malformed manifest | Passed fail-closed before handler |
| Finalization rollback trigger | Passed with no partial lease/intent state |
| Session 3 contract/static migration tests | Passed |
| Session 3 isolated legacy-shaped PostgreSQL migrations | Passed |
| Worker envelope and manifest secret-safety tests | Passed |
| Session 4 planner unit/PostgreSQL tests | Passed |
| Session 5 dispatcher unit/PostgreSQL/Redis tests | Passed |
| Session 6.1 runtime unit/PostgreSQL/Redis tests | Passed |
| Session 6.2 ownership unit/PostgreSQL tests | Passed |
| TypeScript type-check | Passed |
| Backend production build | Passed |
| `git diff --check` | Passed |

All PostgreSQL tests use unique schemas and remove them in `finally`. Redis
regressions retain their isolated queue prefixes and cleanup. No normal
application migration or external deployment operation was run.

## 7. Changed files

- `backend/src/orchestration-contracts/worker-runtime/v1-fenced-invocation.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-placeholder-handlers.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/scripts/verify-inactive-v1-fenced-invocation.ts`
- `backend/scripts/verify-inactive-v1-fenced-invocation-postgres.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_6_3_IMPLEMENTATION_FINDINGS.md`

## 8. Remaining risks

- The wrapper has no automatic lease heartbeat. This is safe for the current
  immediate placeholders; any future long-running executor must renew
  explicitly without weakening fencing.
- Default placeholders intentionally return `success` to prove the lifecycle
  contract. They perform no real work, so this provider must remain unwired
  until real lane handlers and their side-effect fencing are separately
  designed and verified.
- Manifest rows are revalidated immediately before invocation, but mutable
  lifecycle status columns are not locked throughout handler execution.
  Fencing protects intent/lease finalization; future real side effects will
  also need target-system idempotency and token propagation.
- There is still no BullMQ consumer, dead-letter policy, execution audit
  stream, or runtime metrics for this wrapper.

## 9. Boundary confirmation

Session 6.4 was not started. No consumer or automatic startup exists, and the
two-lane orchestrator is not active.
