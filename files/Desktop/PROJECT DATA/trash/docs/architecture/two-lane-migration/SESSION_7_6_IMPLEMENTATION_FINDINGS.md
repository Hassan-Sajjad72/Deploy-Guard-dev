# Session 7.6 — Inactive ECS Release Outcome Coordinator

## Scope and activation status

Session 7.6 adds an explicitly constructed, inactive release-outcome boundary.
It is not registered in a Nest module, started by a lifecycle hook, reachable
from a controller, used by a BullMQ consumer, or connected to the legacy
pipeline. Tests use fixture clients only. No AWS, Terraform, Docker, ECS,
frontend, scheduler, endpoint, or deployment-intent completion path was
activated.

The coordinator consumes the exact release and infrastructure revision
identity already frozen by Sessions 2 and 7.1. It delegates read-only rollout
classification to the Session 7.5 verifier and delegates the only rollback
mutation to the Session 6.6 idempotent side-effect boundary.

## Exact promotion transaction

`InactiveV1EcsReleaseOutcomeStore.promoteCandidate()` runs at PostgreSQL
`SERIALIZABLE` isolation and:

1. Acquires the transaction advisory lock derived from
   `deployguard:release-promote:<projectId>:<environmentName>`.
2. Locks and validates the exact unexpired operation lease, worker owner,
   fencing token, running intent, project, and environment.
3. Locks the exact candidate release and exact applied infrastructure revision.
4. Validates the persisted promotion idempotency key and input fingerprint.
5. Locks the current stable release and requires it to equal the candidate's
   `previousStableManifestId`.
6. Supersedes that exact previous stable row and checks that exactly one row
   changed.
7. Promotes only the verified candidate, storing only the sanitized safe code
   and evidence hash, and checks that exactly one row changed.

The existing partial unique index on `(project_id, environment_name) WHERE
status = 'stable'` remains the final database invariant. A concurrent identical
request becomes one promotion and one replay. A reused idempotency key with a
different fingerprint fails closed and rolls back the transaction.

## Rollback mutation and verification sequence

For `failed` or `timed_out` candidate evidence:

1. A serializable preparation transaction takes the same promotion advisory
   lock and validates the exact fence.
2. It requires the exact previous stable release to still be the current
   stable release and to reference the candidate's exact applied
   infrastructure revision. A different infrastructure revision is rejected;
   no infrastructure identity is guessed.
3. It creates or reuses one immutable `origin=rollback`,
   `status=rollback_started` release manifest. The row copies the previous
   stable release artifacts and points to the candidate as its parent.
4. The previous stable release remains `stable`; preparation does not replace
   it.
5. `ecs.rollback_existing_service` runs through the Session 6.6 journal with a
   derived idempotency key and deterministic input fingerprint. The injected
   mutation client may update only the exact existing cluster/service to the
   exact previous task-definition ARN.
6. A succeeded or replayed mutation is followed by an independent Session 7.5
   read-only verification of the previous stable release revision.
7. `progressing` returns without persistence changes. `ambiguous` and timed-out
   verification require review. Failed mutation/evidence is reported with a
   sanitized code. An uncertain mutation remains reconcilable and is not
   repeated.
8. Only `healthy` evidence enters a second serializable, fenced promotion
   transaction. That transaction supersedes the old stable row, marks the
   failed candidate `rolled_back`, and promotes the rollback-origin manifest.
   Each transition must affect exactly one row.

A missing or infrastructure-incompatible previous stable release records a
sanitized terminal candidate outcome and performs no ECS mutation.

## Idempotency and fencing

- Promotion and rollback request identity is persisted in `health_evidence`
  using only schema version, idempotency key, deterministic input fingerprint,
  safe code, and evidence hash.
- Rollback mutation identity additionally covers the candidate revision,
  rollback manifest, previous stable manifest and task definition, and exact
  cluster/service identities.
- Same identity and input replay safely; changed input under the same identity
  raises `ECS_RELEASE_OUTCOME_IDEMPOTENCY_CONFLICT`.
- Every persistence transaction rechecks the active lease and exact fencing
  token. Every side-effect executor context must match the same intent, lease,
  worker, token, project, and environment.
- Cancellation, lease loss, expiry, or owner replacement blocks additional
  mutation and finalization.
- Raw AWS responses, SDK errors, credentials, runtime values, task reasons, and
  secrets are not written by this boundary.

## Files changed

- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.store.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.coordinator.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-rollout-health.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/disabled-v1-ecs-rollout-health.verifier.ts`
- `backend/scripts/verify-inactive-v1-ecs-release-outcome.ts`
- `backend/scripts/verify-inactive-v1-ecs-release-outcome-postgres.ts`
- `backend/package.json`
- This findings document

No entity or migration change was required. The frozen release manifest already
contains the lifecycle and sanitized JSON evidence fields, and the existing
stable-release partial unique index enforces one canonical stable manifest.

## Verification evidence

| Check | Result |
|---|---|
| Session 7.6 fixture coordinator test | PASS |
| Session 7.6 isolated PostgreSQL concurrency test | PASS |
| Session 6.6 side-effect safety unit/PostgreSQL | PASS |
| Session 6.8 reconciliation coordinator unit/PostgreSQL | PASS |
| Session 7.1 release mutation unit/PostgreSQL | PASS |
| Session 7.2 release reconciliation fixtures | PASS |
| Session 7.3 disabled read-only evidence adapter | PASS |
| Session 7.4 disabled mutation client | PASS |
| Session 7.5 rollout/health verifier | PASS |
| `npx tsc --noEmit --incremental false` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

The PostgreSQL test creates a unique isolated schema and drops it in `finally`.
It proves concurrent promotion deduplication, concurrent rollback-manifest
deduplication, stable-marker uniqueness, changed-input conflicts, preservation
of the previous stable release before health proof, stale-fence rejection,
successful verified rollback, and missing-target behavior.

## Remaining risks

- The coordinator is intentionally one-shot. `progressing` rollout evidence
  needs a later bounded retry owner; no scheduler was added here.
- Rollback across a changed infrastructure revision fails closed. A future
  design must prove infrastructure compatibility before permitting that case.
- The canonical stable marker is `release_manifests`. Legacy
  `project_stable_releases` synchronization must be addressed before activation
  if any production reader still treats the legacy table as authoritative.
- Uncertain side effects require the existing Session 6.7/6.8 reconciliation
  path before another outcome attempt.
- No real AWS client, runtime handler, complete release handler, or public state
  projection has been assembled or activated.

## Next bounded task

The next bounded task should define and test the inactive release-handler
composition that sequences existing build/release mutation, Session 7.5
verification, and this outcome coordinator without exposing an endpoint or
starting a consumer. It must first resolve the legacy stable-release projection
boundary. Session 7.7 was not started.
