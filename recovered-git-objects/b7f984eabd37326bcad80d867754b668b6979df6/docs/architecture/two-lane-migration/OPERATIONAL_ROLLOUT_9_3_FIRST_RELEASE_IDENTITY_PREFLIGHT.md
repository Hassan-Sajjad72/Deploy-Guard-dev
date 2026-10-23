# Operational Rollout 9.3 — First-Release Identity Preflight

## Implemented boundary

`ProductionV1FirstReleaseIdentityPreflightService` is an explicit one-shot, read-only inspection for the exact Project-Tst `dev` foundation. It is gated by the existing default-off production-canary composition plus all of:

- `TWO_LANE_FIRST_RELEASE_BOOTSTRAP_ENABLED=true`
- `TWO_LANE_FIRST_RELEASE_PREFLIGHT_ENABLED=true`
- `TWO_LANE_FIRST_RELEASE_PREFLIGHT_MODE=read_only`
- one exact project allowlist, `dev`, applied InfrastructureManifest ID, and revision.

The default environment template keeps every new first-release setting disabled or empty.

The composition now exposes the bootstrap only in this exact production-canary gate. Its composition-time client is a mutation-disabled sentinel: build/push, task registration and service creation always fail closed. No consumer, route, planner, job publication, or handler invocation was added.

## Routing and checks

- The bootstrap probes the exact cluster and deterministic long-lived service identity before the image side effect. `present` or `ambiguous` evidence blocks before image provenance, ReleaseManifest, task definition, or service work.
- A replay with a persisted initial-service reference is idempotent; it does not reinterpret the existing service as a new conflict.
- The read-only verifier resolves only the exact applied manifest revision, recomputes its output hash, checks that no ReleaseManifest or image provenance exists, then verifies the ECR repository, ECS cluster, target group, roles, public subnets, application security group and log group.
- It also verifies that the exact service and deterministic first-release task-definition family are absent. It returns only sanitized state/codes.

## Corrected initial-release lifecycle

For an initial release, planning persists a `DeploymentIntent` and immutable
`InitialReleaseDraft`, linked to one applied infrastructure revision. It does
not create a `ReleaseManifest` and does not write a normal release outbox
delivery. The explicit, default-off one-shot runner is the only path permitted
to claim this manifest-less intent. It acquires cross-lane ownership before the
independent operation lease, then creates the manifest only after a fenced ECR
side effect has persisted immutable provenance. The store links the created
manifest to the exact intent in the same fenced transaction. Later releases
retain the existing manifest-first queued lifecycle.

## Controlled runtime result

The normal migration runner applied the pending ordered additive migrations and
records `CreateReleaseImageProvenances1760000047000` as applied. The controlled
local database verification confirmed the provenance table, both nullable
first-service columns on `release_manifests`, the three provenance indexes, and
the three expected check constraints.

The first preflight retry exposed one implementation defect: the provenance
entity was absent from the normal Nest TypeORM entity registry even though it
was present in the migration data source and feature module. Adding that entity
to the registry fixed the metadata lookup; it did not alter any cloud path.

The exact one-shot invocation for the allowlisted fresh project, `dev`, and
applied revision 4 then returned:

```json
{"state":"ready","safeCodes":["FIRST_RELEASE_IDENTITY_READY"]}
```

Only the preflight's permitted read-only foundation checks were performed. It
confirmed the exact applied-manifest identity and the absence of release
evidence, an application task definition, and an ECS service. No image build
or push, ReleaseManifest creation, task-definition registration, service
creation/update, Terraform operation, queue publication, consumer start, or
cloud mutation occurred.

## Passed verification

- `npm run test:inactive-v1-first-release-bootstrap`
- `npm run test:inactive-v1-release-lane-composition`
- `npm run test:production-v1-first-release-identity-preflight`
- `npm run test:operational-production-canary-preflight`
- `npm run test:two-lane-contracts`
- `npm run test:two-lane-migrations`
- `npm run test:inactive-v1-side-effect-safety:postgres`
- `npm run test:inactive-v1-ecs-release-mutation:postgres`
- `npx tsc --noEmit --incremental false`
- `npm run build`
- `git diff --check`

## Required next approval

A separate live-release approval is required for this exact scope only:
immutable image build and push to the revision-4 foundation ECR repository,
durable image-provenance persistence, matching ReleaseManifest creation,
initial task-definition registration, creation of the exact long-lived ECS
service, and rollout/health verification. It must retain the existing fencing,
idempotency, side-effect journal, and reconciliation controls. Terraform,
infrastructure changes, deletion, cleanup, and unrelated AWS mutations remain
outside that approval.

## Live first-release authorization readiness check — 2026-07-26

**Result: blocked before execution; no release mutation occurred.**

The operator authorized one live first release for the exact fresh Project-Tst
`dev` scope and applied InfrastructureManifest revision 4. The execution
readiness check stopped before acquiring ownership or invoking Docker/AWS
because the runtime is not yet executable:

- production composition still constructs
  `DisabledV1FirstReleaseBootstrapClient`; every build/push, task-definition,
  and service-creation method fails closed with
  `FIRST_RELEASE_BOOTSTRAP_MUTATION_DISABLED`;
- no production first-release mutation client or explicit live command exists;
- the controlled database has no initial-release `DeploymentIntent` or
  `InitialReleaseDraft` for revision 4;
- `CreateInitialReleaseDrafts1760000048000` is not recorded in TypeORM
  migration history, even though the empty table exists. This schema-history
  inconsistency must be reconciled through the normal migration procedure,
  not by manually inserting release evidence.

Sanitized post-check evidence was: zero active cross-lane ownership rows, zero
initial-release drafts, zero claimable release intents, zero image-provenance
rows, and zero ReleaseManifests. The applied foundation was not changed. No
Docker build, ECR push, task-definition registration, ECS service creation,
Terraform operation, queue publication, consumer start, deletion, destroy, or
cleanup occurred.

Final deployment status is **not started / blocked by execution-path
readiness**. The next bounded implementation must supply and verify a real
default-off production client and one-shot command, reconcile migration 4800
through the normal runner, and create the initial intent/draft through the
normal planner before a new live invocation is authorized.

## First-release execution path implemented — 2026-07-26

The previously missing execution prerequisites are now implemented without
starting a release:

- TypeORM applied and recorded `CreateInitialReleaseDrafts1760000048000` using
  the normal migration runner. The existing table was retained; its expected
  nine columns, constraints, and indexes were verified.
- The planner gained a strict initial-foundation pin. It may be supplied only
  for an initial `deploy` against the exact applied project/`dev` foundation;
  it rejects a stable release, a different project/environment, or any other
  intent kind. This prevents current inferred infrastructure defaults from
  creating a new foundation revision while preparing the first release.
- The normal planner created exactly one `release_only`, manifest-less intent
  and one immutable `InitialReleaseDraft` for revision 4. It created no outbox
  event, ReleaseManifest, image provenance, operation lease, or ownership row.
- Production-canary composition can now construct a real first-release client
  only when `TWO_LANE_FIRST_RELEASE_LIVE_CLIENT_ENABLED=true` in addition to
  the existing exact one-project/`dev` gates. Otherwise it continues to use
  the mutation-disabled client.
- The real client is fenced by the caller and is written to use a pinned Git
  commit, the deployment contract's generated Dockerfile, immutable ECR digest
  evidence, exact task-definition registration, and exact initial service
  creation. It is not called by construction, a controller, a scheduler, or a
  consumer.
- The explicit one-shot runner validates the preflight, draft, intent, gate,
  cross-lane fence, and independent operation lease before a side effect. An
  uncertain post-claim outcome retains ownership for reconciliation rather
  than releasing it speculatively.

The exact gated dry-readiness invocation returned:

```json
{"state":"ready","safeCodes":["FIRST_RELEASE_ONE_SHOT_READY"]}
```

No Docker build/push, task-definition registration, ECS service creation,
Terraform operation, queue publication, consumer start, deletion, cleanup, or
destroy occurred during this work.

## Verification

- `npm run test:two-lane-migrations`
- `npm run test:two-lane-migrations:postgres`
- `npm run test:transactional-planner`
- `npm run test:transactional-planner:postgres`
- `npm run test:inactive-v1-first-release-bootstrap`
- `npm run test:inactive-v1-ownership`
- `npm run test:inactive-v1-ownership:postgres`
- `npm run test:inactive-v1-side-effect-safety`
- `npm run test:inactive-v1-side-effect-safety:postgres`
- `npm run test:inactive-v1-release-lane-composition`
- `npx tsc --noEmit --incremental false`
- `npm run build`
- `git diff --check`

## Exact next command and approval boundary

The future command is `npm run run:first-release-one-shot`. It remains blocked
unless the existing production-canary gate values, the exact revision-4
project/manifest allowlists, `TWO_LANE_FIRST_RELEASE_INTENT_ID`,
`TWO_LANE_FIRST_RELEASE_ONE_SHOT_ENABLED=true`,
`TWO_LANE_FIRST_RELEASE_LIVE_CLIENT_ENABLED=true`, and the separate explicit
`TWO_LANE_FIRST_RELEASE_EXECUTE_APPROVED=true` are all present.

It still requires a new operator approval covering one pinned source build,
one immutable ECR push, provenance persistence, ReleaseManifest creation,
initial task definition, initial ECS service, and post-create rollout/health
verification for this exact project/`dev` scope only. Terraform, deletion,
destroy, cleanup, and unrelated cloud mutation remain excluded.

## Approved live first-release recovery — 2026-07-26

**Result: completed and verified healthy.**

The approved one-shot first release was interrupted after the journaled image
build/push boundary. Recovery began by restoring only local PostgreSQL and
Redis, then inspecting the exact initial intent/draft, applied revision-4
foundation, ownership rows, operation leases, side-effect journal, provenance,
ReleaseManifest records, and the exact read-only AWS identity evidence.

The journal contained one earlier, confirmed-absent image attempt and one
reconciled successful image record. Read-only ECR evidence confirmed the exact
pinned image digest, while the task-definition family and long-lived service
were still absent. No image was rebuilt or pushed during recovery.

The first resume stopped safely with `FIRST_RELEASE_FENCE_MISMATCH`: the
bootstrap incorrectly treated the historical side-effect lease as the current
write fence. The focused correction preserves the historical effect as durable
evidence and authorizes provenance/manifest writes only with the new active
operation lease and its higher fencing token. The store still validates that
current fence transactionally. The focused bootstrap fixture and TypeScript
check passed before the intent was resumed.

The resumed exact intent then performed only the approved downstream work:

- persisted one immutable image-provenance record from the already verified
  ECR digest;
- created one matching ReleaseManifest;
- registered one initial task definition and created one long-lived ECS
  service;
- verified ECS service state (desired/running/pending `1/1/0`), healthy target
  status, and HTTP `200` from the application endpoint;
- persisted health evidence, promoted the ReleaseManifest to `stable`, marked
  the intent `completed`, and released the active cross-lane ownership and
  operation lease.

Final application URL: <http://dg-fc0d5f538b6d401ab532-dev-alb-703508799.us-east-1.elb.amazonaws.com/>.

Sanitized durable evidence: exactly one provenance operation, one linked
ReleaseManifest (revision `1`), task-definition and initial-service references
present, and health/promotion timestamps present. Historical expired leases
remain as audit evidence; the final active operation lease and the cross-lane
ownership are both released. No Terraform, infrastructure mutation, deletion,
destroy, cleanup, queue publication, consumer start, or release for another
project occurred during recovery.

## Controlled second-release readiness — 2026-07-26

**Result: blocked before planning or mutation.**

The operator approved one controlled second release and bounded rollback for
the exact Project-Tst `dev` service. Read-only qualification found that the
remote `main` branch still resolves to the exact commit recorded by the current
stable ReleaseManifest and its persisted deployment contract. There is no new
source or configuration evidence from which the transactional planner can
truthfully create a distinct immutable release revision; the current scope is
a deterministic no-op.

The runtime inspection also confirmed that the production later-release
composition has no explicit one-shot command and still supplies the
`PreflightOnlyRuntimeReferenceResolver`, which intentionally rejects mutation.
The existing first-release runner cannot be reused: it is restricted to a
manifest-less initial intent and service-absence evidence. Bypassing these
contracts would lose the planner, provenance, ownership, fencing, journal, and
reconciliation guarantees.

No second intent, image build/push, ReleaseManifest, task-definition revision,
service update, rollback, Terraform operation, or other AWS mutation was
performed. The existing revision-1 release remains the sole stable release,
there are zero active deployment intents, and the previously verified service
remains the rollback target.

The next required input is a new approved source commit or an explicit,
persisted release-owned configuration change. A bounded implementation session
must then add a default-off later-release one-shot runner and production runtime
reference resolver, preserving the existing cross-lane ownership, independent
operation lease, side-effect journal, rollout verifier, and outcome coordinator
before a fresh live-release approval is used.
