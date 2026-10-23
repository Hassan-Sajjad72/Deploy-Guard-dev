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

## Later-release one-shot preparation — 2026-07-26

**Result: implementation complete; dry readiness blocked safely before any AWS
mutation.**

The earlier statement that `main` had no new source was superseded by the
approved direct-child commit. DeployGuard refreshed its normal repository
detection and pre-flight evidence for the exact requested commit. The planner
therefore has fresh, pinned source evidence; no deployment contract or
pre-flight shortcut was used.

The later-release path is intentionally separate from the first-release runner:

- `LaterReleaseOneShotRunnerService` validates the exact candidate intent,
  current stable release, applied foundation, and read-only ECS service/task
  definition identity before it can claim anything.
- It acquires cross-lane v1 ownership before the independent operation lease,
  then uses the existing fenced invocation, side-effect journal, rollout
  verifier, outcome coordinator, and rollback target.
- Its pre-handler creates durable immutable ECR provenance and binds it to the
  candidate ReleaseManifest before the existing task-definition/service-update
  handler is allowed to run. Replays resolve evidence rather than blindly
  pushing a second image.
- The production runtime-reference resolver only supports an empty reference
  set for this canary. It fails closed if environment or service-binding
  references are present; it never reads or invents secret values.

All gates remain false by default. The only explicit commands are:

```bash
npm run prepare:later-release-one-shot
npm run check:later-release-one-shot-readiness
npm run run:later-release-one-shot
```

The final command additionally requires
`TWO_LANE_LATER_RELEASE_EXECUTE_APPROVED=true`; it was not run.

During preparation, an earlier invocation without the canary foundation
configuration created one truthful pending **infrastructure** intent. It is
still `planned` and remains preserved as evidence; it was not cancelled,
rewritten, dispatched, or applied. The normal planner correctly refuses to
create the release-only candidate while that intent is active. The explicit
readiness command returned only:

```json
{"state":"blocked","safeCodes":["LATER_RELEASE_INTENT_NOT_CLAIMABLE"]}
```

No AWS API request, Docker build, ECR push, task-definition registration, ECS
update, rollback, Terraform operation, queue publication, consumer start, or
ownership acquisition occurred for this later-release preparation. The stable
release remains revision `1` at the previous commit.

Verification passed: the default-off runner test, release-lane composition,
ECS mutation/handler contracts, transactional planner contract, TypeScript
check, backend build, and `git diff --check`.

Before one live revision-2 release can be approved, the pending infrastructure
intent must be resolved through its own explicit, auditable lifecycle (cancel
or complete it only after an operator decides whether its foundation change is
wanted). Once no active infrastructure intent remains, rerun the normal
prepare command and require `LATER_RELEASE_ONE_SHOT_READY` before separately
approving the exact one-shot mutation scope: one pinned build/push, one
provenance record, one candidate task-definition revision, one update of the
existing service, health verification, and bounded rollback/reconciliation.

## Inspection of the blocking infrastructure intent — 2026-07-26

**Inspection-only result: cancel as unintended. No Terraform or cloud action
occurred.**

The exact blocking record is deployment intent
`47d109bf-08db-43a3-a42c-2bee7a66b2dd`. It is a `planned`
`infrastructure_change`, created at `2026-07-26T15:02:05.508Z`, with one
pending `intent.infrastructure.plan` outbox row. The outbox has zero attempts,
no claim, no published job ID, no error, and no publication timestamp.

It created desired InfrastructureManifest revision `5`
(`7945437c-6b00-4cd5-9964-8d0268149056`) and a corresponding
`blocked_on_infrastructure` ReleaseManifest revision `2` for the approved
source commit. Revision 5 is
not planned, approved, applying, or applied. It has no plan artifact/hash,
no plan-input fingerprint, no workspace reference, no resource count, no state
version, and no failure evidence. The expected local workspace is absent.
There are no operation-lease rows, cross-lane ownership rows, or
post-creation infrastructure events for this intent.

The parent applied revision `4` remains the sole applied foundation. Its
verified plan had 25 creates and zero updates/replacements/deletes, and it is
the only revision with a persisted state/plan artifact and applied evidence.
The blocking revision has **no Terraform plan**, so exact Terraform
create/update/replace/delete counts do not exist and must not be fabricated.
Likewise, it has no estimate, cost review, or cost-deferred acknowledgement.

The requested specification delta is nevertheless material and explains the
classification:

| Field | Applied revision 4 | Desired revision 5 |
| --- | --- | --- |
| Network NAT mode | `none` | `single` |
| ECS foundation | dedicated project | shared project |
| Long-lived service name | canary-specific | generic project-derived |
| ALB health path | `/_stcore/health` | `/` |
| State key | isolated revision-4 canary key | generic project Terraform key |

This was caused by an earlier planner invocation that did not carry the
canary-foundation inputs. It is not attributable to the approved UI-only source
commit. If planned/applied, it could request a NAT gateway and foundation
identity changes, which are out of scope for a source-only second release and
could introduce recurring cost. No AWS resource changed: the plan worker was
never published or started, no Terraform workspace/artifact exists, and no
Terraform/infrastructure events were persisted after intent creation.

**Required operator decision:** approve cancellation of this exact un-dispatched
intent, its desired revision-5 infrastructure/release candidates, and its
pending outbox record using the normal fenced cancellation lifecycle only. The
approval must explicitly prohibit Terraform plan/apply/destroy and all AWS
mutation. After a durable cancellation is verified, prepare the later release
again using the applied revision-4 foundation; then require
`LATER_RELEASE_ONE_SHOT_READY` before a separate live release approval.

## Approved cancellation of the unintended infrastructure intent — 2026-07-26

**Result: cancelled before dispatch. No Terraform, queue publication, AWS call,
or release action occurred.**

The approved intent `47d109bf-08db-43a3-a42c-2bee7a66b2dd` was cancelled in a
serializable transaction guarded by the existing project/environment planner
advisory lock. The cancellation verified the exact project/dev scope, exact
revision-5/revision-2 links, one pristine pending outbox record, and absence of
both v1 operation leases and cross-lane ownership correlations before writing
the terminal evidence.

The durable final state is:

| Record | Final state | Evidence |
| --- | --- | --- |
| Deployment intent | `cancelled` | `INTENT_CANCELLED_BEFORE_DISPATCH` |
| InfrastructureManifest revision 5 | `superseded` | never planned or applied |
| ReleaseManifest revision 2 | `cancelled` | blocked on the cancelled infrastructure revision |
| Corresponding outbox | `dead_letter` | zero attempts, no claim, no published job |
| Audit log | recorded once | `deployment_intent.cancelled_before_dispatch` |
| Applied InfrastructureManifest revision 4 | unchanged | remains `applied` |

Post-transaction verification found zero v1 operation leases, zero cross-lane
ownership rows, and zero active (`planned`, `enqueued`, or `running`) intents
for this project/dev scope. The cancellation retained historical records rather
than deleting them. It did not inspect or modify Terraform state, invoke a
worker, create a workspace, contact AWS, or alter the revision-4 foundation.

**Remaining later-release readiness blocker:** no replacement release candidate
was created by this cancellation. A separately approved normal
`prepare:later-release-one-shot` invocation must create a fresh release-only
intent against the applied revision-4 foundation, after which the readiness
check must return `LATER_RELEASE_ONE_SHOT_READY` before any new live-release
approval can be considered.

## Approved Project-Tst later-release preparation — 2026-07-26

The approved normal preparation ran once for the pinned source commit
`1d1ab0dd6905bb0587d68364975f3d0fe1a92dc0`. It created deployment intent
`400f679c-aec5-445a-9841-cda0ebc9c713` as a `planned` `release_only` intent,
bound to the existing applied InfrastructureManifest revision `4`, and created
candidate ReleaseManifest revision `3` in `desired` state for that exact
commit. This is a new release candidate only; it neither replans infrastructure
nor changes the applied foundation.

Its transactional outbox record remains `pending` with zero attempts, no
claim, no published job, and no publication timestamp. No dispatcher, consumer,
Docker build, ECR push, task-definition registration, ECS update, rollback,
Terraform operation, deletion, or cleanup was invoked.

The first default-off readiness invocation correctly returned
`LATER_RELEASE_ONE_SHOT_DISABLED`. A second read-only invocation supplied the
exact temporary single-scope canary gates and stopped at:

```json
{"state":"blocked","safeCodes":["LATER_RELEASE_STABLE_SERVICE_IDENTITY_INVALID"]}
```

This is the remaining later-release blocker. The read-only resolver could not
prove that the stable release's recorded long-lived ECS service identity exactly
matches the applied revision-4 infrastructure output. No release execution is
permitted until that persisted identity discrepancy is reconciled through a
separate, read-only investigation and the readiness check returns
`LATER_RELEASE_ONE_SHOT_READY`.

## Later-release identity reconciliation — 2026-07-26

**Result: `LATER_RELEASE_ONE_SHOT_READY` (read-only).**

The prepared intent and candidate were inspected without changing their state.
Applied revision 4 has a verified output hash and an ECS cluster output, but it
intentionally has no `ecs_service_arn`: the first-release foundation creates
the cluster, ALB, target group, roles, and log group, while the first release
creates the long-lived ECS service. Stable ReleaseManifest revision 1 correctly
contains the exact initial-service and task-definition references.

The mismatch was therefore a resolver comparison defect, not incorrect
persisted evidence: readiness required the stable service ARN to equal a
nonexistent infrastructure-owned service output. The resolver now accepts the
stable release service reference when that output is absent, while retaining an
exact-ARN comparison whenever infrastructure does own a service. The read-only
ECS `DescribeServices` verification then confirmed the exact cluster, active
service, service ARN, and current stable task-definition identity.

Focused first-release-foundation and infrastructure-owned-service mismatch tests
pass, as do TypeScript checking and the backend build. Intent
`400f679c-aec5-445a-9841-cda0ebc9c713` remains `planned`; its release-only
candidate remains unchanged, and its outbox remains unpublished. No ownership
claim, queue publication, image build/push, task-definition registration, ECS
update, rollback, Terraform, or other cloud mutation occurred.

**Next approval required:** one explicitly scoped later-release invocation for
this prepared intent only—one pinned source build, immutable ECR push, durable
provenance, one candidate task-definition revision, one update of the existing
service, read-only rollout/health verification, and bounded reconciliation or
rollback. It must continue to exclude Terraform and all unrelated resources.

## Live later release and reconciliation — 2026-07-26

**Final result: completed and healthy. No rollback was required.**

The approved intent `400f679c-aec5-445a-9841-cda0ebc9c713` executed only for
Project-Tst `dev`, source commit
`1d1ab0dd6905bb0587d68364975f3d0fe1a92dc0`, applied InfrastructureManifest
revision 4, and candidate ReleaseManifest revision 3. The side-effect journal
contains exactly three records and all three are succeeded:

| Durable effect | Count | Safe result |
| --- | ---: | --- |
| Immutable image build/push | 1 | `ECR_IMMUTABLE_IMAGE_PUSHED` |
| Task-definition registration | 1 | `ECS_TASK_DEFINITION_REGISTERED` |
| Existing service update | 1 | `ECS_SERVICE_UPDATE_REQUESTED` |

One immutable provenance row is linked to the intent. There is no rollback
side-effect record. Infrastructure revision 4 remained unchanged; no Terraform,
service creation/replacement, deletion, destroy, or cleanup path ran.

The first mutation pass exposed three safe recovery defects after the external
effects had already succeeded: the release-independent foundation stores the
service/task identity in the stable release rather than Terraform outputs; a
replayed side effect carried its historical operation-lease fence rather than
the current fence; and rollout verification incorrectly required the absent
infrastructure-owned container-port output. The recovery path was narrowed to
the exact failed intent, exact three succeeded journal records, exact immutable
provenance, and absence of an active lease. Replays used the journal and did not
repeat any external mutation. The current operation fence now protects the
task reference/lifecycle transition, and the verifier accepts a missing
foundation port while still rejecting a conflicting port.

Final read-only evidence is:

- ECS service `ACTIVE`, candidate rollout `COMPLETED`, desired/running `1/1`,
  pending `0`;
- exact candidate target healthy `1/1`;
- Streamlit health endpoint HTTP `200`;
- application root HTTP `200`;
- application URL:
  `http://dg-fc0d5f538b6d401ab532-dev-alb-703508799.us-east-1.elb.amazonaws.com/`.

The deployment intent is `completed`; ReleaseManifest revision 3 is `stable`
with durable health and promotion evidence; revision 1 is `superseded` and
remains the preserved rollback lineage. The canonical stable-release projection
was reconciled from that lineage so the unchanged long-lived service identity
remains available to future releases. All operation leases and cross-lane
ownership claims are released. Final safe state: `LATER_RELEASE_ONE_SHOT_RESULT`
with completed disposition.

## Post-crash durable-state verification — 2026-07-26

**Result: unchanged, terminal, and healthy.**

After the interrupted verification process, the release runner was not invoked
again. Read-only database and AWS checks confirmed the same terminal state:

- intent `400f679c-aec5-445a-9841-cda0ebc9c713` is `completed`;
- ReleaseManifest revision 3 is the sole `stable` release, has promotion and
  health-verification timestamps, and revision 1 is `superseded` rollback
  lineage;
- exactly one provenance row, one successful immutable push, one successful
  task-definition registration, and one successful ECS service update exist;
- no other side-effect record exists for the intent; no active operation lease
  or cross-lane ownership claim remains;
- the exact immutable ECR digest exists once; ECS is `ACTIVE` and `COMPLETED`
  at `1/1`; the exact target is healthy; and the Streamlit health endpoint
  returned HTTP `200`.

Focused later-release, mutation, isolated PostgreSQL, rollout-health, handler,
outcome, and composition checks passed. TypeScript checking and the backend
build also passed. No remaining release blocker was found, and this verification
performed no AWS mutation, rollback, Terraform operation, queue operation, or
cleanup.

## Phase 9 closeout — 2026-07-26

**Final Phase 9 status: complete for the explicitly approved Project-Tst `dev`
canary scope.** This is a bounded canary conclusion, not a claim that the
default-off release lane is generally enabled for other projects or
environments.

| Phase 9 acceptance area | Status | Durable evidence / boundary |
| --- | --- | --- |
| Exact applied foundation | Proven | InfrastructureManifest revision 4 is `applied`; its 25 managed foundation resources, exact versioned state object, and released native lock were reconciled read-only. No application task definition or ECS service was part of the foundation apply. |
| First-release service foundation | Proven | The original release established the one long-lived Project-Tst `dev` ECS service and stable revision 1 without changing revision-4 infrastructure. |
| Exact later-release preparation | Proven | Completed intent `400f679c-aec5-445a-9841-cda0ebc9c713` is bound to the approved source commit, applied infrastructure revision 4, and candidate ReleaseManifest revision 3. |
| Fenced, idempotent release mutations | Proven | The journal has exactly one successful immutable image push, task-definition registration, and existing-service update, with one durable provenance record and no extra effect for the intent. |
| Promotion and live health | Proven | Revision 3 is the sole `stable` release with durable promotion/health timestamps; read-only evidence confirmed ECS `ACTIVE`/`COMPLETED` at `1/1`, a healthy exact target, and Streamlit HTTP `200`. |
| Crash and uncertain-effect reconciliation | Proven for the observed successful-release case | Post-crash reconciliation used the existing journal and immutable image evidence, did not repeat an external mutation, and reached the same terminal state. Unit and isolated PostgreSQL coverage also proves fenced replay, ambiguity, and reconciliation paths. |
| Ownership and operation closure | Proven | The completed intent has no active operation lease or cross-lane ownership claim after durable terminal evidence. |
| Rollback lineage | Proven | Revision 1 is retained as the exact superseded rollback lineage for revision 3; the outcome contract and isolated PostgreSQL tests cover verified rollback, stale-fence rejection, and uncertain rollback reconciliation. |
| Live failed/timed-out rollback drill | Outside Phase 9 successful-canary acceptance; not executed | The candidate was healthy, so the approved conditional rollback path was not entered. A live drill would be evidence for a separate operational-readiness claim, not a missing requirement for this successful Phase 9 release. |
| General production activation, other environments, deletion, and Terraform changes | Outside Phase 9 | The release composition and gates remain deliberately scoped/default-off; no broader activation or destructive lifecycle claim follows from this canary. |

### Acceptance conclusion

There is **no remaining Phase 9 acceptance gap** for the approved successful
canary. Preserved rollback lineage plus the exercised journal-based
reconciliation are sufficient because a rollback was only authorized if the
candidate failed or became uncertain, neither of which occurred.

An explicit live rollback drill remains an optional, separately approved
operational exercise if the product needs to claim live rollback readiness. Its
approval must be limited to this Project-Tst `dev` service, an ECS update from
current stable revision 3 to the verified revision-1 task definition, fenced
journal/reconciliation handling, and read-only rollout/target/application
health verification. It must exclude source build/push, task-definition
registration, Terraform, infrastructure mutation, deletion, and cleanup.

Backend completion is therefore evidenced only as **release-lane complete for
this proven canary workflow**: exact-scope planning, one-shot execution,
idempotent side effects, reconciliation, promotion, and health have all been
observed. It is not evidence of unrestricted platform-wide deployment or of a
live rollback drill.
