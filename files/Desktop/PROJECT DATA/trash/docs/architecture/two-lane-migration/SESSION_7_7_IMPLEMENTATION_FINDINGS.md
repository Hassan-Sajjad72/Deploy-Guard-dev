# Session 7.7 Implementation Findings

## Status

Session 7.7 is implemented and verified as an **inactive, unregistered**
release-only composition. It is not reachable from a Nest module, endpoint,
scheduler, automatic consumer, frontend action, or the legacy pipeline. No
Terraform command, AWS call, infrastructure mutation, image build, or ECR push
was performed.

## Inactive release-handler sequence

`InactiveV1EcsReleaseHandler` is the one typed
`intent.release.execute` handler. It is marked with both the frozen side-effect
policy and the inactive ECS release policy
(`inactive-v1-ecs-release-handler.ts:28-33`).

The sequence is:

1. Require the exact running `release_only` intent, release manifest, applied
   infrastructure manifest, project, environment, and manifest revisions
   loaded by the Session 6.3 invocation boundary
   (`inactive-v1-ecs-release-handler.ts:166-199`).
2. Derive one deterministic root idempotency key and deterministic operation
   IDs from the intent and exact revisions
   (`inactive-v1-ecs-release-handler.ts:67-85,217-225`).
3. Invoke the Session 7.1 mutation adapter through the Session 6.6 side-effect
   boundary. That adapter requires the frozen immutable image digest,
   registers one task-definition revision, and updates only the existing ECS
   service (`inactive-v1-ecs-release-handler.ts:76-89`).
4. Recheck cancellation and lease trust, then invoke the Session 7.5 verifier
   and Session 7.6 outcome coordinator with the exact lease ID, worker ID, and
   fencing token (`inactive-v1-ecs-release-handler.ts:90-113`).
5. Return success only for verified candidate promotion or verified rollback.
   Progress remains retryable. Ambiguous, missing-target, failed rollback, and
   reconciliation-required outcomes fail closed with sanitized codes
   (`inactive-v1-ecs-release-handler.ts:114-162`).
6. Session 6.3 remains the only owner of intent finalization. Therefore a
   handler success is the only path to fenced `running -> completed`; retryable
   results release ownership, and sanitized failures use fenced failure.

`buildV1InactiveReleaseHandlerRegistry` replaces exactly the release
placeholder and preserves the other three non-executing placeholders. It
requires both policy markers and is only an explicit factory; the production
Nest module still registers no real release handler
(`v1-placeholder-handlers.ts:119-139`).

## Canonical stable-release decision

`release_manifests` is the canonical stable-release source for the v1 lane.
`project_stable_releases` is retained as a transactional compatibility
projection because existing production pages and the legacy pipeline still
read it.

Candidate promotion and verified rollback now update the compatibility
projection inside the same serializable promotion transaction. A projection
failure throws and rolls back the canonical status transitions
(`inactive-v1-ecs-release-outcome.store.ts:61-175,400-490`).

The projection:

- derives its value only from an exact stable release manifest joined to its
  exact applied infrastructure revision;
- exposes an immutable `repository@sha256:digest` image;
- supersedes the previous compatibility row;
- inserts or updates the row linked by `release_manifest_id`;
- verifies exactly one linked stable row before commit; and
- repairs a missing projection on idempotent promotion/rollback replay
  (`inactive-v1-stable-release-projection.store.ts:33-166,169-290`).

Migration `1760000042000` deterministically supersedes duplicate legacy stable
rows, clears duplicate manifest links, and adds partial unique indexes for one
stable row per project/environment and one projection row per release manifest
(`1760000042000-CanonicalStableReleaseProjection.ts:7-53`). Its down migration
drops only those indexes; it intentionally does not recreate contradictory
duplicates.

The matching entity indexes are declared on
`ProjectStableRelease` (`project-stable-release.entity.ts:11-36`).

### Existing `project_stable_releases` readers and writers

| Production file | Use |
|---|---|
| `orchestration/orchestration.service.ts:84,111` | legacy stable/latest and release-history reads |
| `orchestration/orchestration.service.ts:317` | enriches a legacy row returned by `RollbackService` |
| `orchestration/rollback.service.ts:29-50,173-178` | legacy stable save, previous-release read, and legacy rollback write |
| `projects/current-state/project-current-state.service.ts:182` | latest legacy-compatible stable projection |
| `infrastructure-lifecycle/cloud-state-reconciliation.service.ts:111` | latest legacy-compatible release evidence |

These production readers were not behaviorally changed. V1 promotion writes
their compatibility view transactionally. The still-active legacy writers use
the legacy `dev` environment and remain unchanged; before any v1 activation,
mutual exclusion with legacy deployment for the same project/environment must
be proven.

## No-Terraform and no-infrastructure proof

The handler imports only the ECS release mutation and outcome boundaries. It
contains no Terraform, state, workspace, infrastructure-queue, deletion,
create-service, create-cluster, or load-balancer command.

The focused static test scans every directly reachable release dependency and
rejects Terraform runner/service imports and infrastructure/deletion message
routes. The runtime fixture exposes only task-definition registration and
`updateExistingService`; it proves exactly one existing-service update for a
healthy candidate and no create-service/cluster/networking/IAM/ALB/database/
storage operation.

The exact image is consumed from the release manifest and normalized to
`repository@sha256:digest`. No build or push component is reachable.

## Intent terminal and retry rules

| Evidence/result | Handler result | Intent behavior through Session 6.3 |
|---|---|---|
| Candidate verified healthy and promoted | `success` | fenced completion |
| Failed/timed-out candidate, rollback independently verified healthy | `success` | fenced completion |
| Candidate or rollback still progressing | `retryable` | fenced release; intent remains retryable |
| Ambiguous rollout | sanitized terminal failure | no completion |
| Missing previous stable release | sanitized terminal failure | no completion |
| Uncertain register/update/rollback side effect | reconciliation required | no repeat and no completion |
| Cancellation, heartbeat loss, stale fence | ownership-lost/cancel path | stale owner cannot finalize |

## Verification evidence

All commands completed with exit code 0.

| Verification | Result |
|---|---|
| `npm run test:inactive-v1-ecs-release-handler` | healthy, progressing, failure/timeout rollback, missing target, ambiguity, uncertain mutation, duplicate/concurrent execution, cancellation, stale trust, registry policy, static no-Terraform proof passed |
| `npm run test:inactive-v1-ecs-release-outcome:postgres` | isolated schema migration, concurrent promotion, concurrent rollback finalization, projection equality, replay repair, projection rollback, stale fence, and missing target passed |
| Session 7.1–7.6 focused unit suites | passed |
| `npm run test:inactive-v1-ecs-release-mutation:postgres` | passed |
| Session 6 side-effect/invocation PostgreSQL suites | passed |
| `npm run test:inactive-v1-consumer:integration` | isolated PostgreSQL/Redis explicit-start consumer regression passed |
| Session 5 outbox and Session 6 runtime PostgreSQL/Redis suites | passed |
| Session 3 contracts/migrations/secret safety | passed |
| Session 4 planner unit and PostgreSQL concurrency suites | passed |
| `npx tsc --noEmit --incremental false` | passed |
| `npm run build` | passed |
| `git diff --check` | passed |

PostgreSQL tests created uniquely named schemas and dropped them in `finally`.
Redis tests used unique prefixes and cleanup. No normal application database or
production queue was used.

## Files changed for Session 7.7

- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-handler.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-stable-release-projection.store.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-outcome.store.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-placeholder-handlers.ts`
- `backend/src/orchestration/project-stable-release.entity.ts`
- `backend/src/migrations/1760000042000-CanonicalStableReleaseProjection.ts`
- `backend/scripts/verify-inactive-v1-ecs-release-handler.ts`
- `backend/scripts/verify-inactive-v1-ecs-release-outcome-postgres.ts`
- `backend/package.json`
- this findings document

## Remaining activation risks

- The handler is deliberately absent from the Nest composition root. The
  production-shaped ECS clients remain disabled/unregistered.
- No public controller, planner call, outbox scheduling, or automatic consumer
  starts the release lane.
- The existing legacy pipeline can still write legacy stable-release rows.
  Before activation, a project/environment ownership gate must prevent legacy
  and v1 release writers from operating concurrently.
- Existing project-level legacy readers do not all make environment selection
  explicit. V1 activation must expose canonical state by exact environment.
- Side-effect reconciliation still requires an explicitly owned coordinator;
  uncertain effects are never automatically repeated.
- Runtime AWS permissions, throttling, quotas, and rollout durations were not
  exercised because real AWS calls were forbidden.

## Exact next Stage 8 task

**Session 8.1: implement an inactive release-lane composition and activation
readiness gate.** Wire the existing planner, outbox, explicit consumer,
production-shaped ECS adapters, Session 7.7 handler, and canonical
project/environment state behind a default-off feature gate. Add a hard
legacy/v1 mutual-exclusion check, worker/readiness diagnostics, and shadow-only
tests. Do not expose an endpoint, start a consumer automatically, call AWS, or
route a real deployment until a separate controlled activation session.

Session 8.1 was not started. The two-lane release orchestrator is not active.
