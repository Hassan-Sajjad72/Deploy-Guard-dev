# DeployGuard Final Verified Result

Date: 2026-08-01  
Scope: `CODEX_RAILWAY_TRANSFORMATION_PROGRAM.md`, Iterations 0–9.

## Verdict

**GO — the Railway-like DeployGuard product transformation satisfies its
defined local-launch contract.**

This verdict means the normal-v1 product, authorization, durable lifecycle,
shared-worker and developer-experience contracts are ready for controlled
testing. It is not a live AWS deployment certification. The transformation
program deliberately stops before live AWS mutation.

There is no unresolved P0 or P1 launch blocker in the program scope.

This verdict was revalidated after a post-closure browser acceptance defect was
found on project `7ff60e82-e166-4d3b-9ea7-78203370e59f`. The earlier evidence
missed a real developer-action projection case: a global/project inventory read
error was treated as positive project resource evidence, while a terminal
`REMOTE_CANARY_PLAN_NOT_ALLOWED` attempt was collapsed to a generic malformed
first-release state. Together they produced `platform_attention / none` for a
supported, configured Express project whose only historical attempt had stopped
before Terraform initialization.

The correction is intentionally narrow. Inventory transport failures no longer
constitute existing provider-state evidence by themselves; known resources,
residue, ownership conflicts, active operations and other ambiguous evidence
still fail closed. A new Deploy action is allowed only for the exact durable
pre-execution signature: one failed infrastructure-plan intent and manifest,
one historical published delivery, one failed non-reconciling plan journal, no
saved plan/state/output/apply evidence, and an unchanged immutable draft. A
future click creates a new deterministic retry intent/outbox and preserves the
failed history; it does not revive or redispatch the historical delivery.

A second browser acceptance pass found a frontend-only lifetime defect after
that backend correction. The queue was reopened when the alert was reported
again after a frontend restart because the first correction had only tested a
JavaScript object-identity helper, not the real mounted component lifecycle.
Runtime inspection found one source: `CanonicalDeploymentView`'s local command-
failure hook. The parent error props were empty; route state contained only the
React Router index; local storage contained only the theme; session storage was
empty; there was no service worker or query cache; and the historical attempt
did not map to an alert. The API correctly returned `applicationError=null`,
`canRetry=false`, no attention/banner field and no existing-state
classification.

Command errors are now tied to an explicit successful canonical-fetch version
owned by each page, rather than object identity. A newly rejected command stays
visible for the fetch version on which it occurred. The next successful
canonical fetch invalidates and removes that local failure even when its
`ready / deploy` payload is semantically unchanged. Fresh mounts start without
a command failure, while current backend-owned `applicationError` and
`platform_attention` presentation remain intact.

## Implementation evidence

- Overview and Deployments use one authenticated canonical Deploy/Redeploy
  command and one closed developer current-state projection. They render
  Analyze, Build, Prepare, Deploy and Verify, with separate latest-attempt and
  verified-stable evidence. A live URL is emitted only from verified stable
  evidence.
- The durable normal-v1 planner preserves immutable configuration identity,
  unchanged-source `NO_OP`, source-only `release_only`, exact deterministic
  outbox/BullMQ identity, ownership, leases, fencing, journals and bounded
  reconciliation. Duplicate requests reuse one operation.
- First deployment composes the existing plan, policy, apply and release
  boundaries. Infrastructure execution remains separately gated; ordinary
  source redeployment never invokes infrastructure work.
- Shared worker activation is project-unbound in `shared` mode, restricted to
  `dev`, and revalidates actor/workspace/project/environment authorization from
  durable intent evidence before ownership. Canary mode retains exact one-
  project scope.
- Existing deployments are classified and reconciled fail-closed. Ambiguous or
  unsafe provider state becomes neutral platform attention; developer actions
  cannot perform cleanup, recovery or internal stage execution.
- Environment values are workspace/project/environment isolated, encrypted at
  rest, masked in responses, and excluded from developer projections. Operator
  diagnostics and legacy mutation routes are backend-authorized and absent from
  ordinary navigation.
- Developer pages expose the six contractual surfaces and none of the forbidden
  cloud, queue, lease, outbox, recovery or raw lifecycle terminology.

## Isolated verification evidence

The focused acceptance set passed:

- three authenticated users/workspaces with two private projects each,
  cross-workspace `403`, encrypted secret storage and masked HTTP responses;
- clean Express, clean Python and configuration-required detection;
- serializable eight-way identical planning, one canonical result, independent
  different-project progress and same-project configuration locking;
- unchanged source `NO_OP`, changed source `release_only`, canonical Deploy
  identity, current-state sanitization and operator authorization;
- legacy deployment retirement without run creation or queue publication;
- real disposable PostgreSQL/Redis advisory-lock, BullMQ duplicate identity and
  worker-restart delivery;
- managed first-release supervised execution through the non-cloud production-
  shaped boundary without fabricating a provider URL;
- isolated Compose infrastructure-plan/apply supervision, including disabled,
  invalid, ready, SIGUSR1, graceful restart, crash restart and stopped states;
- backend TypeScript `--noEmit` and Nest production build;
- frontend terminology, application surfaces, operator segregation, canonical
  Overview/Deployments, current-state UI and Vite production build.
- exact post-closure Express acceptance: the authenticated current-state API
  returned `developerState=ready`, `developerAction=deploy`, no missing
  configuration, one blocked historical attempt and no stable release; both
  Overview and Deployments rendered one Deploy button after refresh. The same
  fixture with genuine ambiguous provider evidence remained
  `platform_attention / none`.
- the restarted real Vite/Nest application passed a fresh authenticated browser
  context, Overview → Deployments → Overview navigation, cache-bypassing hard
  refresh, tab close/reopen, a second frontend restart and reload. Every project
  view contained exactly one Deploy button and zero current alerts; the blocked
  earlier attempt remained in Latest attempt. The mounted component's command-
  failure hook was `null` on each fresh/remounted view.
- an isolated in-browser React runtime intercepted the command at `fetch`
  before any backend request: the newly failed command rendered its sanitized
  alert, canonical fetch version `10 → 11` removed it, and a backend-owned
  application failure still rendered separately. Focused source regressions
  cover fresh mount, navigation remount, hard refresh and newer-fetch
  invalidation. The broader normal-release UI guard was also corrected to
  enforce the retired cleanup/recovery control's absence from developer
  Settings instead of expecting that legacy control to remain.

The infrastructure supervision fixture itself exposed and corrected one final
test-safety defect: it previously reused the operational Compose project and
ports, inherited shared mode while testing canary rejection, and could stop the
operational PostgreSQL/Redis services during cleanup. It now uses a unique
Compose project, containers, published PostgreSQL port, volumes and network;
pins the exact canary contract; waits for host-visible PostgreSQL readiness; and
removes only its own resources. The corrected regression passes with no leaked
container, database, volume, Redis key or temporary directory.

## Local-runtime evidence

- Real local PostgreSQL reports 7 users, 18 active projects and 2 owners with at
  least two projects.
- Smart Retail Pro First Release retains one release and one stable release.
  Project-Tst Canary retains eight historical releases and one stable release.
- The signed browser/durable demonstration completed operation
  `6469e564-c4bc-4efd-8f86-5aa25b9a8bd2` and deterministic job
  `dg:v1:release:6469e564-c4bc-4efd-8f86-5aa25b9a8bd2:execute:1` exactly once.
  Analyze/Build/Prepare/Deploy/Verify reached Live and restored identical
  latest/stable state across Overview, Deployments, Dashboard and Plan & Usage
  after refresh. Evidence: [signed local demo](docs/architecture/two-lane-migration/evidence/fyp-local-demo/latest.md).
- The release and infrastructure Compose consumers are running with healthy
  liveness, `ready=true` and fresh durable capability heartbeats. The dedicated
  isolated supervision test proves each infrastructure consumer reaches ready
  and survives graceful and unexpected restart.
- Release and infrastructure queues have zero waiting, active or delayed jobs.
  PostgreSQL has zero active operation leases, cross-lane owners or outbox
  claims. No disposable acceptance database, container, volume, Redis key or
  temporary process remains.
- Frontend health is `200`; unauthenticated project API access is `401`.
- The Express acceptance refresh left its durable counts at one historical
  intent, one historical outbox, zero release manifests and zero active lease,
  owner or claim. No job was published by verification.
- The signed evidence checksum and `git diff --check` pass.

## Live-AWS evidence

No AWS mutation was performed in this transformation program. Existing Smart
Retail and Project-Tst durable release evidence was inspected read-only only.
Local fixture success is not represented as Docker, Terraform, ECR, ECS, ALB or
live deployment success.

## Deferred non-blocking scope

- A controlled live AWS deployment remains a separate operator-authorized
  validation package.
- Stripe billing and SNS delivery are productization work outside the current
  project scope. `BILLING_PROVIDER_ENABLED=false` and
  `NOTIFICATION_DELIVERY_ENABLED=false` remain authoritative.
- Optional provider/security integrations and clean provider-specific
  operational history are not prerequisites for this local-launch verdict.

## Closure

All nine program iterations are complete. No further iteration remains in
`CODEX_RAILWAY_TRANSFORMATION_PROGRAM.md`; future work is separately authorized
provider validation or deferred productization, not an unresolved launch
package in this program.
