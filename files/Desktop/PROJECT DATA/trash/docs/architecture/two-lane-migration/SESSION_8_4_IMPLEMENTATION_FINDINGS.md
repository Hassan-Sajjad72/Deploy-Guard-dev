# Session 8.4 — Inactive Cross-Lane Ownership Correlation Findings

## Status

Session 8.4 adds an additive, explicitly callable correlation boundary. It
does not acquire cross-lane ownership, enforce either lane, start a consumer,
plan work, publish a queue job, or alter legacy execution. The release lane
remains default-off and inactive.

## Final correlation schema

Migration `1760000044000-AddReleaseLaneOwnershipCorrelation` adds only nullable
columns. Existing rows are neither updated nor assigned ownership.

`project_release_lane_ownerships` now has nullable links to one exact v1
`deployment_intents.id` and, after a successful operation claim, one exact
`project_operation_leases.id`. Both links have restrictive foreign keys and
partial lookup indexes.

Legacy `project_pipeline_runs` and `project_rollback_records` now each carry a
nullable correlation snapshot:

```
cross_lane_ownership_id
cross_lane_owner_lane
cross_lane_owner_environment_name
cross_lane_owner_lease_id
cross_lane_owner_actor_id
cross_lane_owner_fencing_token
```

The snapshot makes future legacy mutations prove their exact owner rather than
using a project-only lookup. It contains no payload, repository URL, secret,
credential, cloud value, or raw database error.

## Independent fence identities

The cross-lane fence and v1 operation fence remain separate:

| Purpose | Identity |
| --- | --- |
| Cross-lane ownership | `project_release_lane_ownerships.lease_id` and `fencing_token` |
| V1 execution operation | `project_operation_leases.id`, `owner_worker_id`, and `fencing_token` |

`InactiveReleaseLaneCorrelationService` never substitutes one identifier or
token for the other. It first links an active v1 ownership row to the exact
intent, then accepts an operation-lease link only when the operation row is
active, unexpired, and matches project, normalized environment, intent,
worker, and its separate fencing token.

## Inactive adapter methods

`backend/src/orchestration-contracts/release-lane/inactive-release-lane-correlation.service.ts`
provides no scheduling or execution method. Its typed methods are:

- `linkLegacyRun` and `linkLegacyRollback` for the future `legacy/dev` link;
- `linkV1IntentOwnership` for an exact v1 intent;
- `attachClaimedV1OperationLease` after the operation lease claim;
- `validateBothIndependentFences` for future mutation boundaries; and
- fenced post-release clear methods for legacy links and the v1 operation link.

Every mutation runs in a serializable transaction under the same normalized
project/environment advisory transaction lock as the ownership guard. It
requires project, normalized environment, lane, ownership lease ID, actor ID,
and cross-lane fencing token. Stale owners return sanitized ownership-loss
results and cannot attach, replace, or clear a newer correlation.

Legacy correlation is deliberately restricted to `dev`, matching the current
legacy model frozen in Session 8.3. Any other legacy environment is rejected;
there is no inferred mapping.

## Migration behavior

The migration is idempotent through `ADD COLUMN IF NOT EXISTS`, constraint
existence guards, and `CREATE INDEX IF NOT EXISTS`. Its rollback is safe on an
empty correlation set. It refuses to remove columns when a deployment-intent
or operation-lease link, legacy-run link, or rollback link would be destroyed.
The prior ownership migration continues to protect its own row history.

## Verification evidence

Passed commands:

| Command | Result |
| --- | --- |
| `npm run test:inactive-release-lane-correlation` | passed |
| `npm run test:inactive-release-lane-correlation:postgres` | passed; isolated schema, idempotency, stale fence, concurrent attachment, cross-environment rejection, rollback safety |
| `npm run test:two-lane-migrations` | passed |
| `npm run test:two-lane-migrations:postgres` | passed; migrations apply twice and roll back in an isolated legacy-shaped schema |
| `npm run test:inactive-release-lane-ownership` | passed |
| `npm run test:inactive-release-lane-ownership:postgres` | passed |
| `npm run test:inactive-v1-ownership` and `:postgres` | passed |
| `npm run test:inactive-v1-invocation` and `:postgres` | passed |
| `npm run test:inactive-v1-release-lane-composition` | passed |
| `npx tsc --noEmit --incremental false` | passed |
| `npm run build` | passed |
| `git diff --check` | passed |

PostgreSQL tests used unique temporary schemas and dropped them after each
test. They did not touch the application schema.

## Files changed

- `backend/src/migrations/1760000044000-AddReleaseLaneOwnershipCorrelation.ts`
- `backend/src/orchestration-contracts/entities/release-lane-ownership.entity.ts`
- `backend/src/projects/project-pipeline-run.entity.ts`
- `backend/src/orchestration/project-rollback-record.entity.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-release-lane-correlation.*`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/scripts/verify-inactive-release-lane-correlation*`
- existing two-lane migration verification scripts and `backend/package.json`

## Remaining risks

- Neither legacy nor v1 execution path calls this adapter or enforces the
  ownership guard. Mutual exclusion is therefore not operational.
- The legacy environment remains `dev` until a separately reviewed legacy
  environment model exists.
- The operation lease is correlated only after its existing claim succeeds;
  Session 8.3's future dual-heartbeat and dual-fence mutation protocol still
  requires an explicit enforcement session.

## Exact Session 8.5 task

Implement the **default-off shadow observer only**. It must read the inactive
ownership/correlation state at the Session 8.3 insertion points, emit one
sanitized, idempotent observation per logical operation, and never acquire,
block, queue, cancel, or mutate either lane. It must not be treated as
ownership enforcement.
