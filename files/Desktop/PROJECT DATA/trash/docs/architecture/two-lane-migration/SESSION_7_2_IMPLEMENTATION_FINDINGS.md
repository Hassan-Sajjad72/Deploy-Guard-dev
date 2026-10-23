# Session 7.2 Implementation Findings

## Outcome

Session 7.2 is complete as an inactive, fixture-only reconciliation boundary.
It can classify uncertain ECS task-definition registration and existing-service
update effects from sanitized read evidence. It cannot register a task
definition, update a service, call AWS, promote or roll back a release, or start
the v1 orchestrator.

## Implementation

### Read-only contract

`inactive-v1-ecs-release-reconciliation.types.ts` defines a deliberately
fixture-only client policy:

`deployguard.ecs-release-reconciliation/fixture-read-only-v1`

The client exposes only:

- `findTaskDefinitionEvidence`
- `findServiceUpdateEvidence`

There is no production AWS client and no ECS mutation method. Task-definition
evidence carries the exact project, environment, release revision,
infrastructure revision, input fingerprint, immutable image digest, and task
definition ARN. Service evidence additionally carries the exact cluster ARN,
service ARN, service-update fingerprint, and rollout state.

### Exact manifest and side-effect identity

`prepareInactiveV1EcsReleaseReconciliationAdapter()` loads one exact release and
infrastructure revision through the Session 7.1 manifest store and rebuilds the
same deterministic mutation plan. It rejects:

- missing or invalid manifests;
- non-applied or identity-mismatched infrastructure;
- mutable/non-digest image references;
- task-definition fingerprint conflicts;
- service reconciliation without an exact recorded task-definition reference;
- clients without the fixture-only policy.

Before any fixture inspection, the adapter recomputes the Session 6.6
side-effect request fingerprint and matches it to the uncertain journal row.
This binds the evidence inspection to the exact intent, project, environment,
operation, idempotency key, effect type, and manifest-derived input.

### Classification

`inactive-v1-ecs-release-reconciliation.pure.ts` performs exact-key and format
validation before classification:

| Evidence | Result |
|---|---|
| One exact active task definition | `succeeded` |
| Task definition not visible | `pending` |
| Exact task definition inactive | `failed` |
| Multiple, malformed, or identity-mismatched task definitions | `manual_review` |
| One exact active service with completed rollout | `succeeded` |
| Exact service rollout in progress or draining | `pending` |
| Exact service inactive or rollout failed | `failed` |
| Multiple, malformed, or identity-mismatched services | `manual_review` |

Only safe machine codes and SHA-256 fingerprints leave the adapter. Fixture
errors and ambiguous evidence are not persisted verbatim.

### Fencing and persistence

The adapter checks cancellation and lease trust before and after every read.
It returns evidence to the existing Session 6.7 boundary; it never writes the
side-effect or reconciliation journals itself. The existing boundary performs
the final active-lease/fencing-token check in the serializable transaction.
The isolated PostgreSQL regressions proved that replacement ownership prevents
stale success evidence from changing the side effect.

## Inactive Boundary Proof

- The adapter is absent from `orchestration-contracts.module.ts`.
- It has no Nest lifecycle hook, controller, endpoint, scheduler, BullMQ
  consumer, or worker registration.
- It imports no AWS SDK.
- Its fixture client has no registration or service-update method.
- It does not call the Session 7.1 mutation adapter or manifest write method.
- No Terraform, frontend, legacy pipeline, health verification, promotion, or
  rollback code was changed.

## Files Changed

- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-reconciliation.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-reconciliation.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-reconciliation.adapter.ts`
- `backend/scripts/verify-inactive-v1-ecs-release-reconciliation.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_7_2_IMPLEMENTATION_FINDINGS.md`

All other dirty-worktree content was preserved.

## Verification

| Command | Result |
|---|---|
| `npm run test:inactive-v1-ecs-release-reconciliation` | PASS |
| `npm run test:inactive-v1-ecs-release-mutation` | PASS |
| `npm run test:inactive-v1-side-effect-safety` | PASS |
| `npm run test:inactive-v1-side-effect-reconciliation` | PASS |
| `npm run test:inactive-v1-reconciliation-coordinator` | PASS |
| `npm run test:inactive-v1-side-effect-safety:postgres` | PASS |
| `npm run test:inactive-v1-side-effect-reconciliation:postgres` | PASS |
| `npm run test:inactive-v1-reconciliation-coordinator:postgres` | PASS |
| `npm run test:inactive-v1-ecs-release-mutation:postgres` | PASS |
| `npx tsc --noEmit --incremental false` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

The PostgreSQL tests used their existing isolated schemas and cleanup. The first
sandboxed connection attempt was denied locally; the same focused tests passed
after permission to connect to the isolated PostgreSQL instance on port 5433.
No normal application schema was used.

The fixture suite covers successful, failed, pending, and manual-review
classification; absent, duplicate, malformed, and mismatched evidence;
sanitized client failure; side-effect fingerprint mismatch; missing service
task reference; and ownership loss during inspection.

## Remaining Risks and Next Boundary

- There is intentionally no production ECS read adapter. A future session must
  define how real ECS task-definition tags and service/task-definition reads
  prove the exact identities required here without weakening this contract.
- When task registration returned uncertain before its ARN was recorded, a
  future real read adapter must return exactly one task definition carrying the
  exact release/infrastructure identity, input hash, and immutable image digest.
  Multiple candidates remain manual review.
- This session does not perform health verification, stable promotion,
  rollback, or wire reconciliation into a running consumer.

The two-lane orchestrator remains inactive.
