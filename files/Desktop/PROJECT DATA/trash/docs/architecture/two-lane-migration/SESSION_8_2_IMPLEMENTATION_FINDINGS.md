# Session 8.2 Implementation Findings

## Status

Session 8.2 adds an **inactive, explicitly callable** PostgreSQL ownership
guard for future legacy/v1 release-lane mutual exclusion. It is registered as
a dependency only. Neither the legacy pipeline nor the v1 runtime/consumer
calls it, so mutual exclusion is **not operational** yet.

No consumer was started and no planner, outbox dispatcher, endpoint, frontend,
Terraform, AWS, Docker, ECR, or legacy execution path was changed or invoked.

## Ownership table and invariants

`project_release_lane_ownerships` is a dedicated cross-lane fence, separate
from `project_operation_leases`; it does not create a second general operation
lease system.

Each scope has one row, uniquely identified by:

```
project_id + normalized environment_name
```

The row records only the safe ownership data required for fencing:

- `owner_lane`: exactly `legacy` or `v1`;
- `lease_id`, bounded actor identity, idempotency key, and request fingerprint;
- strictly increasing `fencing_token` per project/environment;
- acquired, heartbeat, expiry, release, and status timestamps; and
- `acquired`, `heartbeat_active`, `released`, or `expired` status.

The schema has strict lane/status/hash checks plus unique scope and fencing
indexes (`release-lane-ownership.entity.ts:20-36`,
`1760000043000-CreateReleaseLaneOwnerships.ts:9-54`). It stores neither
credentials, connection strings, secrets, request payloads, nor raw database
errors.

## Acquisition and stale recovery

`InactiveReleaseLaneOwnershipService.acquire()` canonicalizes environment
names, validates UUID/hash/actor/TTL inputs, and retries only serializable
transaction conflicts (`inactive-release-lane-ownership.service.ts:37-68`).
Inside each serializable transaction it obtains a PostgreSQL advisory lock
derived from the exact project/environment, locks the project and ownership
row, and then decides ownership (`:136-179`).

An active row grants idempotent replay only when lane, lease ID, actor, key,
and fingerprint are all exact. Reusing the same key with different identity or
request returns a sanitized `idempotency_conflict` (`:156-169`).

Expired rows can be replaced only after checking underlying active work. The
replacement reuses the same scope row and increments its fencing token. An
expired row with live legacy or v1 work returns
`expired_not_recoverable`, never a takeover (`:171-207`). Expiry comparison
uses PostgreSQL transaction time, avoiding a Node/database clock discrepancy.

Renewal and release require exact project/environment, lane, lease ID, actor,
and fencing token; every stale or expired mismatch returns
`ownership_lost` without changing the row (`:71-133`).

## Legacy/v1 conflict rules

Legacy pipeline runs have no environment column in the existing model. The
current platform convention maps those runs to normalized `dev`; therefore a
legacy run blocks only that exact environment, never another environment.
The guard casts the legacy enum status to text and checks the production active
pipeline status set (`:21-31,220-235`).

- A v1 claim fails with `blocked_by_legacy` if a live legacy run or active
  legacy ownership exists.
- A legacy claim fails with `blocked_by_v1` if an active v1 intent, operation
  lease, or v1 ownership exists.
- A v1 owner may claim its own active v1 intent. The guard is intended to be
  acquired before the operation lease when it is eventually wired, so blocking
  that intent would make correct future wiring impossible.
- The scope row itself ensures a simultaneous legacy/v1 claim produces one
  winner; the other receives the lane-specific blocked disposition.

## Migration safety

Migration `1760000043000` is additive and idempotent: it uses `CREATE TABLE
IF NOT EXISTS`, guarded constraints, and `CREATE INDEX IF NOT EXISTS`. It
does not update, seed, or modify legacy rows. Its down migration refuses to
discard nonempty ownership history, then drops only its dedicated table. The
existing two-lane isolated legacy-schema migration test applies it twice and
rolls it back cleanly while preserving old rows.

## Verification evidence

All commands completed successfully.

| Command | Result |
| --- | --- |
| `npm run test:inactive-release-lane-ownership` | input canonicalization, validation, explicit inactivity/static safety passed |
| `npm run test:inactive-release-lane-ownership:postgres` | isolated PostgreSQL acquisition/replay/conflict, renewal/release, stale fencing, expiry recovery, underlying legacy/v1 blockers, concurrency, and environment isolation passed |
| `npm run test:two-lane-migrations` | static migration safety passed |
| `npm run test:two-lane-migrations:postgres` | isolated legacy-shaped migration apply-twice/rollback passed |
| `npm run test:inactive-v1-ownership:postgres` | existing isolated v1 ownership concurrency regression passed |
| `npm run test:inactive-v1-invocation:postgres` | existing fenced invocation regression passed |
| Session 6.1–6.8 focused unit regressions | passed |
| `npm run test:inactive-v1-release-lane-composition` | default-off composition regression passed |
| `npm run test:inactive-v1-ecs-release-handler` | inactive handler regression passed |
| `npx tsc --noEmit --incremental false` | passed |
| `npm run build` | passed |
| `git diff --check` | passed |

The PostgreSQL tests use a unique schema and drop it in `finally`; they do not
use the normal application schema. No Redis, AWS, Terraform, Docker, ECR, or
external deployment system was contacted.

## Files changed

- `backend/src/orchestration-contracts/entities/release-lane-ownership.entity.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-release-lane-ownership.{pure,types,service}.ts`
- `backend/src/migrations/1760000043000-CreateReleaseLaneOwnerships.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/src/app.module.ts`
- `backend/src/data-source.ts`
- `backend/scripts/verify-inactive-release-lane-ownership.ts`
- `backend/scripts/verify-inactive-release-lane-ownership-postgres.ts`
- `backend/scripts/verify-two-lane-migration-safety.ts`
- `backend/scripts/verify-two-lane-migrations-postgres.ts`
- `backend/package.json`

## Remaining integration risks

- This guard is not yet enforced by either entry path. Wiring it into only one
  lane would create a false sense of safety, so no path was activated here.
- Legacy runs are scoped to `dev` because the existing legacy run entity has no
  environment field. A future activation must either retain that explicit
  compatibility rule or add a controlled legacy environment link before
  enabling non-`dev` legacy releases.
- A later integration session must define acquisition/release ordering with
  the existing v1 operation lease and prove that cancellation, crash recovery,
  and each legacy retry/resume path release the cross-lane fence.

## Exact next bounded task

**Session 8.3: design-only entry-path enforcement plan.** Map every legacy
start/retry/resume and v1 dispatch/consumer path to the guard, freeze
acquisition/release ordering with operation leases, and specify a shadow-only
observation phase. Do not activate either lane until both entry paths enforce
the same contract in a separately authorized implementation session.
