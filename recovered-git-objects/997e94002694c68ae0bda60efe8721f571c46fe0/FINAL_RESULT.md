# DeployGuard Verified Result

Date: 2026-08-01  
Scope: Railway transformation through Iteration 3 — one automatic Deploy command and cost policy.

## Verdict

**NO-GO — Iteration 3 is implemented and locally verified, but existing-state
adoption and the remaining launch iterations are not complete.**

This result is not a live AWS deployment claim. The new capability remains
default-off, and verification did not dispatch an operational project job or
invoke Terraform, Docker, ECR, ECS, ALB, Stripe, or SNS.

## Iteration 3 completed result

- Developer Overview and Deployments now call one authenticated
  `POST /api/projects/:projectId/deploy` command. The browser no longer composes
  prepare, infrastructure-plan dispatch, infrastructure-apply dispatch, or
  release dispatch.
- The command prepares or reuses the canonical first- or later-release intent,
  binds one durable `developerCommand` marker to its immutable idempotency and
  request fingerprints, and publishes only through the existing exact dispatch
  services. HTTP never starts or supervises a worker.
- A default-off API scheduler observes only command-marked first-release roots.
  It resumes after restart from PostgreSQL, reviews the exact saved Terraform
  plan, persists one evidence-hashed policy decision, dispatches the exact apply
  continuation when authorized, and prepares/dispatches the first release only
  after the manifest is durably applied.
- Real Infracost evidence is mandatory. Missing, deferred, stale, or mismatched
  cost evidence pauses as platform attention. Safe non-destructive changes at or
  below the configured project/default threshold are internally approved;
  above-threshold changes require the project owner; replacement, deletion, or
  unusually broad plans require an administrator/operator.
- `POST /api/projects/:projectId/deploy/approve-cost` is owner-only and
  revalidates the exact policy evidence before dispatch. The sanitized current
  state exposes Approve Cost only to that owner. Direct prepare and exact
  plan/apply/release dispatch routes are now admin-only operator boundaries.
- Later/source-only release planning remains release-only and never enters the
  Terraform lane. Existing planner, dispatcher, fenced ownership, worker, and
  terminal behavior remain unchanged.

## Verification evidence

Passed focused backend checks:

- `test:normal-deployment-command` — deterministic cost-policy table, default-off
  gate, one-command composition, admin-only internal route guards, and absence of
  worker/cloud handler dependencies;
- `test:normal-deployment-command:postgres` — twelve concurrent serializable
  command bindings converge on one immutable marker, replay is stable, changed
  identity fails closed, eight concurrent policy writes converge, a replacement
  coordinator resumes one effective apply and release continuation, and the
  disposable database is removed;
- real PostgreSQL/Redis `test:outbox-dispatcher:integration` and
  `test:inactive-v1-consumer:integration` — deterministic exact publication and
  one BullMQ consumer delivery with isolated cleanup;
- first-release planning/plan dispatch/apply dispatch, later-release
  planning/execution/status/current-state, developer projection, outbox protocol,
  release ownership, and cross-lane ownership regressions;
- Nest production build.

Passed focused frontend checks:

- sanitized normal release-lane UI and canonical current-state UI contracts;
- Vite production build.

The running backend hot-reloaded the new dependency graph and continued serving
authenticated routes (`401` for an unauthenticated projects request). Read-only
operational inspection after verification reported zero active operation leases,
zero active cross-lane owners, zero outbox claims, zero publishing outboxes, and
zero waiting/active/paused/delayed jobs on both normal-v1 queues. All three
repository Compose workers remained healthy. The automatic Deploy gate remained
disabled; billing and notification provider gates remained disabled.

`git diff --check` passes.

## Evidence classification

- **Isolated:** cost-policy fixtures, command/authorization guards, sanitized
  projection fixtures, disposable PostgreSQL serializable/restart proof, and
  disposable PostgreSQL/Redis exact dispatcher/consumer proofs.
- **Local:** backend hot reload/HTTP reachability, backend/frontend builds,
  worker health, operational queue/lease/owner/claim read-only checks, and diff
  verification. No operational deployment command was submitted.
- **Live AWS:** not used. No cloud mutation or live deployment was attempted.

## Genuine limitations

Iteration 4 is the exact next package: classify existing project/cloud state as
valid, adoptable, recoverable, conclusively safe residue, or ambiguous; keep that
detail operator-only; and project only a stable Redeploy action or neutral
platform attention to developers. Overview consolidation, full operator route
segregation, environment/log/metric cleanup, local launch acceptance, stack
certification, and final controlled AWS acceptance remain after it.
