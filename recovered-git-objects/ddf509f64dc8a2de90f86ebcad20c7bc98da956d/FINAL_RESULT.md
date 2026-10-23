# DeployGuard Verified Result

Date: 2026-08-01  
Scope: Railway transformation through Iteration 2 — canonical sanitized developer projection.

## Verdict

**NO-GO — the canonical developer read boundary is now implemented and verified,
but automatic first-deployment orchestration and the remaining launch iterations
are not complete.**

The result is intentionally narrower than a deployment or AWS-success claim.
Iteration 2 changed read projections, authorization, frontend consumers, and
focused contract tests only; it did not publish a job or mutate cloud state.

## Iteration 2 completed result

- `GET /api/projects/:projectId/current-state` now returns one closed,
  sanitized `DeveloperProjectCurrentState` contract. Its only top-level fields
  are `developerState`, `developerAction`, `developerMessage`, `progress`,
  `repository`, `branch`, `commit`, `latestAttempt`, `stableRelease`,
  `stableUrl`, `estimatedCost`, `missingConfiguration`, `applicationError`, and
  `canRetry`.
- The internal evidence resolution remains available through the separately
  named `GET /api/projects/:projectId/current-state/details` route, guarded for
  admins. Raw release-lane status is also admin-only. Both views reuse the same
  resolver; the ordinary response does not issue a parallel lifecycle fetch.
- The pure projector maps only developer-owned configuration, repository,
  application build/runtime/health, and cost decisions to actionable states.
  Platform conflicts, internal uncertainty, disabled platform capability, and
  cancelled/blocked internal lifecycle evidence fail closed as neutral
  `platform_attention`.
- Stable/latest identity conflict is independently detected. A live URL is
  emitted only from complete verified stable-release evidence and only for an
  HTTP(S) URL. A newer attempt remains distinct from the prior stable release.
- Workspace summaries, active counts, and bounded terminal history now consume
  the same sanitized project projection. Internal lifecycle codes and recovery
  evidence are absent from those developer responses.
- Developer frontend consumers use the sanitized projection. Admin technical
  modules use the admin-only detailed helper. Overview, Deployments, Dashboard,
  Projects, recovery, logs, metrics, and billing projection helpers no longer
  depend on raw release-lane/current-state internals.
- Direct infrastructure-apply confirmation was removed from developer action
  code. Iteration 3 still owns the server-side automatic continuation contract;
  this result does not claim that first deployment is yet one automatic command.

## Verification evidence

Passed backend checks:

- `test:developer-current-state` — closed output keys, exhaustive state mapping,
  stable/latest conflict, stale URL rejection, raw-field leak guards, admin-role
  enforcement, and real project-view substitution denial;
- `test:workspace-release-summary` — authoritative counts/history, conflict
  handling, bounded keyset pagination, and lifecycle-code exclusion;
- `test:auth`, `test:current-state-consistency`,
  `test:normal-release-lane-current-state`, `test:normal-release-lane-status`,
  `test:normal-release-lane-planning`,
  `test:normal-first-release-lane-planning`, and `test:project-usage`;
- backend TypeScript no-emit and Nest production build.

Passed frontend checks:

- sanitized current-state UI, release view, release action/UI, recovery boundary,
  and time/recency fixtures;
- Vite production build.

Post-change read-only runtime checks found all three repository Compose workers
(`intent.release.execute`, `intent.infrastructure.plan`, and
`intent.infrastructure.apply`) still running with Docker health `healthy`.
PostgreSQL reported three unexpired capability rows and `0 / 0 / 0` active
operation leases, cross-lane owners, and outbox claims. Both production BullMQ
queues reported zero active, waiting, paused, waiting-child, delayed, and
prioritized jobs. Backend/frontend listeners and local PostgreSQL/Redis remained
present; Iteration 2 did not restart or reconfigure them.

`git diff --check` passes. A mistyped verification command
(`test:current-state`) and an undeclared legacy-retirement command failed as
missing npm scripts; the declared `test:current-state-consistency` passed. These
were command-inventory errors, not application failures and are not recorded as
test passes.

## Evidence classification

- **Isolated:** pure developer projection, authorization/project-isolation
  fixtures, workspace aggregation/pagination, and frontend contract fixtures.
- **Local:** existing PostgreSQL-backed project-usage regression, backend and
  frontend builds, and source/diff verification. No queue publication or worker
  execution was initiated by Iteration 2.
- **Live AWS:** not used. No Terraform, Docker publication, ECR, ECS, ALB,
  rollback, cleanup, or cloud mutation occurred.

## Genuine limitations

Iteration 3 is the exact next package: one authenticated, idempotent automatic
Deploy command spanning the existing exact preparation/plan/apply/release
boundaries with the product cost-approval policy. Existing-state adoption,
remaining developer page consolidation, operator-route segregation, local launch
acceptance, stack certification, and final AWS acceptance remain unverified.
