# Phase 10 — Normal Workflow Integration Audit

**Status:** Phase 10.1–10.5 and the default-off normal v1 execution and
supervised-consumer boundaries are implemented. All activation remains
default-off; runtime proofs use isolated local state unless a section
explicitly records an approved canary.

This document cross-references the completed [Operational Rollout
9.3](OPERATIONAL_ROLLOUT_9_3_FIRST_RELEASE_IDENTITY_PREFLIGHT.md). Phase 9
proved the exact Project-Tst `dev` v1 release lane, but it did so through
explicit, allowlisted one-shot preparation and execution paths. It is not the
path invoked by the normal product Deploy controls.

## Current user-to-release path

```text
Project overview / Pipeline “Start deployment”
  -> frontend startProjectAutomation()
  -> POST /api/projects/:projectId/automation/start
  -> detection + pre-flight reuse/generation
  -> PipelineService.startRun()
  -> ProjectPipelineRun + legacy configuration snapshot + legacy queue job
  -> BullMQ runPipeline { jobType: full_deploy }
  -> PipelineWorkerService
  -> Docker build -> ECR push -> Terraform plan/apply gate -> ECS deployment
  -> ProjectPipelineEvent / ProjectDeployment / ProjectStableRelease
  -> current-state, Dashboard, Pipeline, and Orchestration UI
```

Verified entry points:

- [projectApi.js](/home/hassan-sajjad/Deploy-Guard-dev/frontend/src/api/projectApi.js:76)
  posts normal deployment start to `/automation/start`.
- [ProjectDetails.jsx](/home/hassan-sajjad/Deploy-Guard-dev/frontend/src/pages/ProjectDetails.jsx:48)
  and [ProjectPipeline.jsx](/home/hassan-sajjad/Deploy-Guard-dev/frontend/src/pages/ProjectPipeline.jsx:46)
  both use that API.
- [projects.controller.ts](/home/hassan-sajjad/Deploy-Guard-dev/backend/src/projects/projects.controller.ts:234)
  performs detection/pre-flight then calls the legacy pipeline service at line
  303.
- [pipeline.service.ts](/home/hassan-sajjad/Deploy-Guard-dev/backend/src/projects/pipeline/pipeline.service.ts:152)
  creates a `full_deploy` `ProjectPipelineRun`, then publishes the legacy
  `runPipeline` job at line 228.
- [pipeline-worker.service.ts](/home/hassan-sajjad/Deploy-Guard-dev/backend/src/projects/pipeline/pipeline-worker.service.ts:757)
  resumes `full_deploy` through Terraform apply and ECS deployment.

The separate Infrastructure and Orchestration pages also retain active legacy
paths: [ProjectDeployPanel.jsx](/home/hassan-sajjad/Deploy-Guard-dev/frontend/src/components/infrastructure/ProjectDeployPanel.jsx:81)
posts `/deploy`, while [orchestration.controller.ts](/home/hassan-sajjad/Deploy-Guard-dev/backend/src/orchestration/orchestration.controller.ts:11)
delegates to `InfrastructureService.deploy()`.

## Divergence from the proven v1 lane

| Boundary | Classification | Evidence and consequence |
| --- | --- | --- |
| Normal Deploy action | **Active legacy** | It always creates a legacy pipeline run and `full_deploy` BullMQ job; it never calls `TransactionalDeploymentPlannerService`. |
| Normal Docker/ECR/Terraform/ECS execution | **Active legacy** | `PipelineWorkerService` owns the combined lifecycle, including Terraform and ECS. This bypasses v1 immutable manifests, v1 outbox delivery, and v1 fenced invocation. |
| Phase 9 planner/outbox/consumer/handlers | **Disconnected** | `TransactionalDeploymentPlannerService` and `InactiveV1ReleaseLaneCompositionService` exist, but normal routes do not construct a planner request. The proven entry points are explicit scripts such as `prepare:later-release-one-shot` and `run:later-release-one-shot`. |
| First and later release runners | **Disconnected** | They are explicit/default-off services with exact canary gates; neither is reached by the normal UI, controller, legacy queue, or worker. |
| Dashboard active-run count | **Active legacy** | [Dashboard.jsx](/home/hassan-sajjad/Deploy-Guard-dev/frontend/src/pages/Dashboard.jsx:46) counts `currentState.activeRunCount`; current state obtains that from legacy pipeline activity. A v1 intent is not represented as an active run. |
| Pipeline timeline/history | **Active legacy** | [ProjectPipeline.jsx](/home/hassan-sajjad/Deploy-Guard-dev/frontend/src/pages/ProjectPipeline.jsx:42) loads `getPipelineRuns`; the API exposes `ProjectPipelineRun` records only. v1 intent/outbox/side-effect stages have no normal history projection. |
| Stable URL and stable release | **Partially connected** | Current state reads `ProjectDeployment` and `ProjectStableRelease` compatibility records ([project-current-state.service.ts](/home/hassan-sajjad/Deploy-Guard-dev/backend/src/projects/current-state/project-current-state.service.ts:181)); Phase 9 writes compatible stable-release projection evidence, so the stable lineage can be read, but the UI has no direct v1 release identity/status model. |
| Rollback visibility/control | **Partially connected** | Orchestration reads the compatibility stable release and invokes the legacy rollback service. It can see the projected lineage, but it does not use the v1 intent, side-effect journal, or outcome-coordinator lifecycle. |
| v1 user-facing authorization/request boundary | **Missing** | There is no normal authenticated controller/facade that validates an eligible project and maps its current deployability/configuration/source evidence into a frozen v1 planner request. |

## Selected Phase 10.1 slice: release-only planning bridge

Implement **only an authenticated, default-off normal-workflow bridge for an
already-provisioned project with an existing stable service**. It replaces
neither the legacy pipeline nor infrastructure workflow.

When its exact gate and allowlists are enabled, the existing “Start deployment”
branch for an eligible later release will:

1. validate ownership, `dev`, the current deployment contract/pre-flight, an
   applied InfrastructureManifest, and a pinned source commit;
2. invoke the existing `TransactionalDeploymentPlannerService` exactly once
   with a server-derived idempotency key;
3. accept only the `release_only` decision; return a sanitized
   `RELEASE_LANE_INTENT_PREPARED` result otherwise;
4. persist the normal v1 intent/release manifest/outbox records transactionally
   but **not** dispatch the outbox, start a consumer, claim ownership, build,
   push, register a task definition, update ECS, or call Terraform;
5. leave the UI at an explicit “Release prepared; execution is not enabled”
   state rather than pretending that a legacy pipeline run is active.

This is the smallest useful bridge because it connects the normal authenticated
user action to the proven immutable planner without activating any execution
boundary. It is limited to later releases because Phase 9 first-release setup
has a distinct applied-foundation/bootstrap contract.

### Exact implementation boundary

| Area | Planned files / boundary |
| --- | --- |
| Backend facade | Add `backend/src/orchestration-contracts/release-lane/normal-release-lane-planning.service.ts`. It owns eligibility, source pinning, server-side idempotency, planner invocation, and sanitized response mapping. It must reuse—not modify—the transactional planner. |
| Authenticated route | Add one guarded route in [projects.controller.ts](/home/hassan-sajjad/Deploy-Guard-dev/backend/src/projects/projects.controller.ts:234), for example `POST :projectId/release-lane/prepare`. It must be unavailable/blocked unless the exact default-off gate plus project and `dev` allowlists are valid. |
| Composition | Register the facade in `backend/src/orchestration-contracts/orchestration-contracts.module.ts` and inject it into `ProjectsModule`; construction must not acquire ownership, publish an outbox, or create a cloud client. |
| Frontend API | Add one request in `frontend/src/api/projectApi.js`; do not change the Infrastructure or Orchestration Deploy controls in this slice. |
| Frontend action/status | Change only the eligible “Start deployment” handling in `ProjectDetails.jsx` and `ProjectPipeline.jsx` to show the sanitized prepared/blocked result. Keep the legacy action unchanged when the gate is disabled or the project is ineligible. |
| Read-model boundary | Do **not** change dashboard counts, pipeline history, stable URL, release history, or rollback UI in 10.1. Their v1 projection is a separate, follow-on slice after execution activation is approved. |

### Required tests and acceptance criteria

- Unit tests for the facade: disabled/malformed gate, wrong project,
  non-`dev`, no applied infrastructure, no stable service, stale/missing source
  pin, non-`release_only` planner decision, and sanitized error mapping.
- Isolated PostgreSQL tests: concurrent identical prepare requests create one
  v1 intent and one outbox row; changed idempotency input conflicts; no
  `ProjectPipelineRun` is created.
- Controller tests: authenticated project owner/developer succeeds only inside
  the exact allowlist; read-only and cross-project callers fail closed.
- Frontend tests: enabled eligible response displays “prepared” without a fake
  active pipeline; disabled or blocked response preserves the existing legacy
  Start deployment path.
- Static regression: no call path from the facade reaches dispatcher `dispatch`,
  consumer `start`, one-shot `run`, legacy queue `add`, Docker, ECR, ECS, or
  Terraform services.
- `test:transactional-planner`, relevant outbox/ownership regressions,
  frontend build, backend type-check/build, and `git diff --check` pass.

## Explicitly deferred

1. Outbox dispatch/consumer activation and any live v1 execution.
2. First-release bootstrap integration into normal UI.
3. Infrastructure-change planning/apply integration.
4. A unified v1/legacy status projection for dashboard counts, pipeline history,
   release history, URL, and rollback control.
5. Replacing legacy recovery, cancellation, rollback, deletion, or cleanup.

Phase 10.1 therefore has one product outcome only: an eligible normal user can
prepare a release-only v1 intent safely and see that it is prepared, while all
actual execution remains explicitly controlled and default-off.

## Phase 10.1 implementation — 2026-07-26

**Result: implemented and verified; execution remains disabled.**

`NormalReleaseLanePlanningService` now provides the default-off authenticated
bridge. Its exact gate is `TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED=true`,
plus one UUID in `TWO_LANE_RELEASE_PROJECT_ALLOWLIST` and an exact `dev`
environment allowlist. Missing, malformed, false, or out-of-scope
configuration returns a sanitized disabled/blocked response and the frontend
continues with the existing legacy Start deployment action.

For an eligible owner/developer, the service verifies the current deployable
contract, matching detection commit, current passing pre-flight, applied v1
infrastructure revision, and stable v1 release with service/task-definition
identity. It derives a server-only idempotency key from the project, `dev`,
the applied infrastructure manifest, and the current stable release. It then
calls `TransactionalDeploymentPlannerService` with
`requiredClassification: "release_only"`.

The planner now rejects a non-release-only classification inside its existing
serializable transaction. That rejection rolls back the received intent and
any candidate manifest/outbox write, rather than leaving an infrastructure or
no-op record from this release-only bridge. A repeated matching request reuses
the existing intent/outbox; changed immutable evidence under the same current
foundation/stable lineage returns the sanitized idempotency conflict.

The guarded `POST /api/projects/:projectId/release-lane/prepare` route is
available only to project admins/developers. `ProjectDetails` and
`ProjectPipeline` first call it. A prepared response displays **“Release
prepared; execution is not enabled.”** and does not create a fake legacy run;
a disabled or eligible-fallback response calls the unchanged
`/automation/start` route.

This slice does not inject or call a dispatcher, consumer, runner, execution
ownership service, legacy queue, Docker, ECR, ECS, Terraform, or cloud client.
It creates no `ProjectPipelineRun` on the v1 branch.

### Files changed

- `backend/src/orchestration-contracts/release-lane/normal-release-lane-planning.service.ts`
- `backend/src/orchestration-contracts/planner/transactional-deployment-planner.{types,service}.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/src/projects/projects.controller.ts`
- `backend/.env.example`
- `frontend/src/api/projectApi.js`
- `frontend/src/pages/ProjectDetails.jsx`
- `frontend/src/pages/ProjectPipeline.jsx`
- `backend/scripts/verify-normal-release-lane-planning.ts`
- `frontend/scripts/verify-normal-release-lane-ui.mjs`
- backend and frontend package scripts

### Verification

| Check | Result |
| --- | --- |
| `npm run test:normal-release-lane-planning` | Passed: default-off, exact allowlist, release-only planner input, idempotency conflict, classification fallback, guarded route wiring, and no execution dependency. |
| `npm run test:transactional-planner` | Passed. |
| `npm run test:transactional-planner:postgres` | Passed in an isolated schema: concurrent identical planning remains one intent/outbox; the new classification guard rolls back without partial rows. |
| `npm run test:normal-release-lane-ui` | Passed: both normal pages show prepared state and retain legacy fallback. |
| Backend TypeScript / build | Passed. |
| Frontend build | Passed. |
| `git diff --check` | Passed. |

## Project-Tst normal planning-only preparation — 2026-07-27

**Result: prepared; execution remains disabled.**

The normal authenticated release-lane bridge prepared the refreshed pinned
Project-Tst `dev` source commit after confirming the current deployable
contract, matching preflight fingerprint, applied InfrastructureManifest
revision 4, and stable ReleaseManifest revision 3. Before the request, no
intent existed for this commit.

The preparation exposed and corrected one server-side idempotency defect: the
normal bridge key previously omitted the immutable source commit and contract
hash, which could replay a completed intent for an older source. The key now
includes both values, preserving replay for the same immutable request while
allowing a genuinely new source revision to prepare safely.

One `release_only` intent was created in `planned` state with one candidate
ReleaseManifest revision 4 and one `pending` zero-attempt outbox record. There
is no ProjectPipelineRun, no active run, no published job, and no release
execution state.

### Runtime evidence

| Check | Result |
| --- | --- |
| Authenticated normal prepare route | Passed: sanitized `RELEASE_LANE_INTENT_PREPARED`. |
| Current-state projection | Passed: `prepared`, with no active pipeline run. |
| Project Details browser refresh | Passed: prepared message persisted; only current-state was used for release-lane status. |
| Project Pipeline browser refresh | Passed: prepared message persisted; no standalone release-lane status request. |
| Durable intent / candidate / outbox check | Passed: one planned release-only intent, one candidate, pending zero-attempt outbox. |
| Legacy pipeline isolation | Passed: zero ProjectPipelineRun rows for this project. |
| `npm run test:normal-release-lane-planning` | Passed. |
| Backend TypeScript / build | Passed. |

No dispatcher, consumer, worker, ownership claim, runner, Docker build, ECR
push, ECS update, Terraform, AWS call, deployment, rollback, deletion, or
cleanup operation occurred. The outbox remains intentionally undispatched.

The next approval-gated slice is one explicit later-release execution for this
specific prepared intent, including its bounded rollback policy; it is not
part of normal planning-only preparation.

## Project-Tst stable service-identity remediation — 2026-07-27

**Result: remediated locally under a released v1 cross-lane fence.**

The stable Project-Tst dev ReleaseManifest revision 3 had a truthful stable
task-definition and health record but was missing only `initialServiceArn`.
Before persistence, durable evidence tied revision 3 to applied
InfrastructureManifest revision 4 and to the preserved revision-1 long-lived
service reference. A read-only ECS inspection then verified one active service
in the exact applied cluster, with the expected service name, revision-3 task
definition, and exact DeployGuard project/environment/infrastructure tags.

The remediation acquired the project/dev v1 ownership scope under a new fencing
token, re-read the same AWS evidence, and updated only the null
`initial_service_arn` field on revision 3. It did not alter status, task
definition, image provenance, health evidence, intent, outbox, or the legacy
initial-service input hash. Post-write database and ECS checks matched, then
the fence was released. No release preparation or execution occurred.

| Evidence | Result |
| --- | --- |
| Durable stable release / applied infrastructure identity | Passed. |
| Read-only ECS service, task-definition, and tag identity | Passed. |
| Fenced one-field persistence | Passed; revision 3 remains stable. |
| Post-write identity verification | Passed. |
| Ownership lifecycle | Passed; new fence released. |

No queue, outbox, worker, runner, Docker, ECR push, ECS update, Terraform,
rollback, deletion, or cloud mutation occurred. The remaining next step, if
approved separately, is normal planning-only preparation for the refreshed
source commit; it is not included in this remediation.

No normal project was prepared during verification, and no database lifecycle,
queue, execution ownership, or cloud mutation occurred.

### Next bounded approval-gated slice

Phase 10.2 should add a **read-only v1 intent status projection** for a
prepared release-only intent on Project Details and Pipeline. It must not
dispatch the outbox or activate a consumer; its sole purpose is to make a
prepared intent durable across page refreshes before any execution activation
is considered.

## Phase 10.2 implementation — 2026-07-27

**Result: implemented and verified; the release lane remains read-only and
default-off.**

`NormalReleaseLaneStatusService` is the authenticated, read-only projection
for the exact project and `dev` scope. It first applies the existing project
read authorization, then requires the same exact planning flag, one-project
allowlist, and `dev` environment allowlist as Phase 10.1. Disabled or
out-of-scope requests return `disabled`; no intent returns `missing`.

For an eligible scope it reads the latest `release_only` intent, its exact
candidate ReleaseManifest, its exact applied InfrastructureManifest, and the
intent outbox. The sanitized UI result maps prepared, queued, running,
completed, cancelled, blocked, and malformed evidence without exposing
fencing values, side-effect journals, cloud identifiers, or internal errors.
The new guarded route is:

`GET /api/projects/:projectId/release-lane/status`

`ProjectDetails` and `ProjectPipeline` load this projection with their normal
project data. A prepared intent now restores **“Release prepared; execution is
not enabled.”** after refresh, independently of legacy pipeline runs. No
dashboard counters, history, rollback controls, or stable-URL projection were
changed.

The status service has no dispatcher, consumer, runner, queue, ownership,
Docker, ECR, ECS, Terraform, or AWS dependency and performs no write.

### Files changed

- `backend/src/orchestration-contracts/release-lane/normal-release-lane-status.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/src/projects/projects.controller.ts`
- `backend/scripts/verify-normal-release-lane-status.ts`
- `backend/package.json`
- `frontend/src/api/projectApi.js`
- `frontend/src/pages/ProjectDetails.jsx`
- `frontend/src/pages/ProjectPipeline.jsx`
- `frontend/scripts/verify-normal-release-lane-ui.mjs`

### Verification

| Check | Result |
| --- | --- |
| `npm run test:normal-release-lane-status` | Passed: disabled, missing, prepared, cancelled, completed, malformed, authorization, and no-execution-dependency cases. |
| `npm run test:normal-release-lane-planning` | Passed. |
| `npm run test:transactional-planner` | Passed. |
| `npm run test:transactional-planner:postgres` | Passed using the isolated PostgreSQL concurrency/rollback harness. |
| Backend TypeScript / build | Passed. |
| `npm run test:normal-release-lane-ui` | Passed for both Project Details and Pipeline status restoration/fallback wiring. |
| Frontend build | Passed. |
| `git diff --check` | Passed. |

Only the local Compose PostgreSQL service was started to run the isolated
planner test; no application database lifecycle, queue delivery, or cloud
operation occurred.

### Next bounded Phase 10 slice

Phase 10.3 should fold this same sanitized projection into the existing
project current-state read model, without changing dashboard count predicates,
pipeline history, rollback controls, or execution. That removes the parallel
page fetch while retaining the exact default-off and read-only boundary.

## Phase 10.3 implementation — 2026-07-27

**Result: implemented and verified; this remains a read-only projection.**

`ProjectCurrentStateService` now reuses `NormalReleaseLaneStatusService` after
the normal project-view authorization and returns its result as the single
sanitized `releaseLane` current-state field. The existing standalone guarded
status endpoint remains unchanged and calls the same service, so direct
inspection and normal page refresh use identical lifecycle mapping.

`ProjectDetails` and `ProjectPipeline` no longer request
`/release-lane/status` separately. Each derives its release-lane message from
the current-state response. Disabled and missing v1 evidence therefore leave
legacy controls unchanged; a prepared v1 intent restores the existing
**“Release prepared; execution is not enabled.”** message without creating a
legacy pipeline run.

This change intentionally leaves `activeRunCount`, dashboard active-run
predicates, pipeline-run history, stable URL, release history, rollback
controls, and all legacy fallback predicates untouched. It adds no database
write, outbox dispatch, consumer, ownership claim, runner, or cloud/client
dependency.

### Files changed

- `backend/src/projects/current-state/project-current-state.service.ts`
- `backend/scripts/verify-normal-release-lane-current-state.ts`
- `backend/package.json`
- `frontend/src/pages/ProjectDetails.jsx`
- `frontend/src/pages/ProjectPipeline.jsx`
- `frontend/scripts/verify-normal-release-lane-ui.mjs`

### Verification

| Check | Result |
| --- | --- |
| `npm run test:normal-release-lane-status` | Passed: lifecycle mapping, authorization, exact default-off scope, and no execution dependencies. |
| `npm run test:normal-release-lane-current-state` | Passed: current state and compatibility endpoint reuse the same status service; static no-write/no-execution guard passed. |
| `npm run test:normal-release-lane-planning` | Passed. |
| `npm run test:current-state-consistency` | Passed; active queue/run, stale-state, health, and cleanup decisions remain unchanged. |
| `npm run test:transactional-planner` / `:postgres` | Passed, including isolated PostgreSQL concurrency and rollback checks. |
| `npm run test:normal-release-lane-ui` | Passed: both pages consume current-state `releaseLane`, retain prepare/fallback behavior, and no longer fetch the status endpoint directly. |
| `npm run test:current-state-ui` | Passed; Dashboard active-run predicate remains `activeRunCount`-based and pipeline history remains unchanged. |
| Backend TypeScript / build | Passed. |
| Frontend build | Passed. |
| `git diff --check` | Passed. |

### Next bounded Phase 10 slice

Phase 10.4 should add a read-only **v1 intent detail panel** behind the
existing current-state field: sanitized intent revision, outbox status, and
safe lifecycle code for developer inspection only. It must not alter counts,
history, controls, ownership, queue delivery, or execution.

## Phase 10.4 implementation — 2026-07-27

**Result: implemented and verified; details are read-only and developer-only.**

The existing `NormalReleaseLaneStatusService` now returns only the additional
sanitized detail fields needed by the UI: an eight-character intent reference,
candidate release revision, outbox lifecycle state, safe lifecycle code,
validated short source SHA, and latest meaningful evidence timestamp. Raw
intent UUIDs, fencing values, journal payloads, cloud identifiers, errors, and
database detail remain absent.

`ReleaseLaneDeveloperDetails` is rendered inside the existing Developer
details panel on both Project Details and Pipeline only for admin/developer
roles. It faithfully shows disabled, missing, prepared, queued, running,
completed, cancelled, and blocked states. Both pages still consume only the
current-state `releaseLane` field; no additional status request or endpoint
was added.

Dashboard active-run counts, pipeline history, stable URL, release history,
rollback controls, and legacy fallback behavior remain unchanged. The reused
projection service remains read-only and has no queue, ownership, runner,
Docker, ECR, ECS, Terraform, or AWS dependency.

### Files changed

- `backend/src/orchestration-contracts/release-lane/normal-release-lane-status.service.ts`
- `backend/scripts/verify-normal-release-lane-status.ts`
- `frontend/src/components/projects/ReleaseLaneDeveloperDetails.jsx`
- `frontend/src/pages/ProjectDetails.jsx`
- `frontend/src/pages/ProjectPipeline.jsx`
- `frontend/scripts/verify-normal-release-lane-ui.mjs`

### Verification

| Check | Result |
| --- | --- |
| `npm run test:normal-release-lane-status` | Passed: lifecycle values, short SHA, safe intent reference, timestamp, authorization, exact scope, and no execution dependencies. |
| `npm run test:normal-release-lane-current-state` | Passed: current-state and standalone endpoint use the same no-write projection. |
| `npm run test:current-state-consistency` | Passed; active-run and cloud/cleanup logic unchanged. |
| `npm run test:normal-release-lane-ui` | Passed: both developer panels consume sanitized fields, use role gating, and contain no raw intent ID. |
| `npm run test:current-state-ui` | Passed: Dashboard active-run predicate and pipeline history wiring unchanged. |
| Backend TypeScript / build | Passed. |
| Frontend build | Passed. |
| `git diff --check` | Passed. |

### Next bounded Phase 10 slice

Phase 10.5 should add a single read-only **release-lane event/history card**
for the same intent, using only sanitized existing outbox/intent timestamps.
It must remain developer-only and must not alter the legacy pipeline history,
counts, controls, queue delivery, or execution.

## Phase 10.2–10.4 local runtime verification — 2026-07-27

**Result: completed for the existing completed-intent evidence. No Phase 10.5
work was started.**

### Local scope and evidence

- Started only the local PostgreSQL service, Nest backend on port `5000`, and
  Vite frontend on `127.0.0.1:5173`; Redis was already available but no queue,
  worker, consumer, or dispatcher was started.
- The authenticated developer session successfully read Project-Tst Canary
  current state. Its sanitized `releaseLane` projection was `completed` with
  safe code `RELEASE_LANE_INTENT_COMPLETED`, safe intent reference `400f679c`,
  candidate release revision `3`, applied infrastructure revision `4`, short
  source SHA `1d1ab0dd6905`, and no active legacy run or cancel/retry control.
- The controlled local database has no eligible **prepared** release-only
  intent: the relevant release-only intents are completed. Prepared-state
  refresh therefore cannot be demonstrated truthfully without a normal,
  legitimate prepared intent; no evidence was inserted or changed.
- A headless local browser loaded Project Details, refreshed it, and loaded
  Project Pipeline using the same developer session. All three views rendered
  **“Release intent completed.”** Browser request capture showed the pages use
  `current-state` and made no `/release-lane/status` request.

### Defect, correction, and authenticated result

Using the same valid session cookie, `GET
 /api/projects/fc0d5f53-8b6d-401a-b532-966dd4f7eff8/current-state` returned
`200`, while `GET
 /api/projects/fc0d5f53-8b6d-401a-b532-966dd4f7eff8/release-lane/status`
returned `401 Authentication required`.

The status controller exists at
`backend/src/projects/projects.controller.ts` (`GET
:projectId/release-lane/status`), but `AppModule.configure()` only registers
the authenticated-user middleware for the explicit `current-state` route and
does not include the release-lane routes. Consequently the status endpoint
reached its role guard without `req.user`.

`AppModule.configure()` now registers exactly these two existing guarded paths
with `AuthenticatedUserMiddleware`:

- `api/projects/:projectId/release-lane/status`
- `api/projects/:projectId/release-lane/prepare`

With the exact one-project/dev gate enabled only in the local backend process,
the authenticated status request now returns `200` and exactly the same
sanitized completed projection as current-state. An unauthenticated status
request returns `401 Authentication required`; a developer-session request to
another project returns `403 Insufficient permissions`. The prepare endpoint
was not invoked, so no preparation, intent, outbox, or execution state was
created.

### Verification

| Check | Result |
| --- | --- |
| Existing completed intent through authenticated `current-state` | `200`; safe completed projection, no active pipeline run and no cancel/retry controls. |
| Same intent through authenticated standalone status | `200`; projection matched current-state field-for-field. |
| Unauthenticated standalone status | `401 Authentication required`. |
| Cross-project developer request | `403 Insufficient permissions`. |
| Browser details, refresh, and pipeline | Completed message rendered; observed page traffic used `current-state`, not standalone status. |
| `npm run test:auth` | Passed; now asserts both exact release-lane middleware paths. |
| `npm run test:normal-release-lane-status` | Passed. |
| `npm run test:normal-release-lane-current-state` | Passed. |
| Backend TypeScript / build | Passed. |
| `git diff --check` | Passed. |

### Safety and unchanged projections

No deployment action, queue delivery, ownership claim, runner invocation,
Docker build, ECR/ECS/Terraform/AWS action, or durable release-lane write was
performed by this verification. The browser exercised its pre-existing
activity-view telemetry route only; it did not change release lifecycle state.
The current-state evidence retained `activeRunCount: 0`, no pipeline-run
history change, no stable-URL change, and false cancel/retry controls.

### Remaining evidence gap

The local database contains no legitimate `prepared` release-only intent, so
prepared-state refresh cannot be demonstrated without normal product planning.
That is a test-data prerequisite, not an authentication or runtime defect; no
intent was fabricated to fill it.

## Phase 10.5 implementation — 2026-07-27

**Result: implemented; developer-only and read-only.**

`NormalReleaseLaneStatusService` now derives a bounded chronological event
list from only existing deployment-intent and outbox lifecycle timestamps. The
projection exposes at most four sanitized event objects with only a safe
lifecycle kind, fixed lifecycle code, and ISO timestamp:
`prepared`, `queued`, `running`, `completed`, `cancelled`, or `blocked`.

The mapper never invents a blocked event merely because a current projection
is malformed: it requires a durable failed or rejected intent outcome. It
uses no journal, lease, fencing, cloud, execution, or error-payload data.

`ReleaseLaneDeveloperDetails` now includes the shared **Latest intent events**
card. Project Details and Project Pipeline already render that component only
for admin/developer roles, so readonly users receive neither the existing
release-lane details nor this event card. Disabled or missing states truthfully
show no sanitized events; completed, cancelled, and evidence-backed blocked
states show only their bounded safe history.

No endpoint, projection service, database write, queue action, ownership
claim, runner, Docker/ECR/ECS/Terraform/AWS dependency, dashboard predicate,
legacy pipeline history, stable URL, rollback control, or legacy fallback was
changed.

### Files changed

- `backend/src/orchestration-contracts/release-lane/normal-release-lane-status.service.ts`
- `backend/scripts/verify-normal-release-lane-status.ts`
- `frontend/src/components/projects/ReleaseLaneDeveloperDetails.jsx`
- `frontend/src/styles.css`
- `frontend/scripts/verify-normal-release-lane-ui.mjs`

### Verification

| Check | Result |
| --- | --- |
| `npm run test:normal-release-lane-status` | Passed: ordered bounded events, terminal mapping, malformed-state truthfulness, authorization, and no execution dependencies. |
| `npm run test:normal-release-lane-current-state` | Passed. |
| `npm run test:current-state-consistency` | Passed; active-run, stale-state, infrastructure, health, and cleanup logic unchanged. |
| `npm run test:normal-release-lane-ui` | Passed: shared developer card, sanitized event fields, fixed maximum, and no raw intent ID. |
| `npm run test:current-state-ui` | Passed; dashboard counts and pipeline-history wiring unchanged. |
| Backend TypeScript / build | Passed. |
| Frontend build | Passed. |
| `git diff --check` | Passed. |

### Next smallest Phase 10 gap

There is no further read-only projection gap in this slice. The smallest
remaining validation gap is a legitimate normal-workflow `prepared` intent to
exercise the prepared event card and refresh behavior; it requires a separate,
explicit planning authorization and must not be fabricated by the UI.

## Project-Tst dev source refresh — 2026-07-27

**Result: detection, preflight, and deployment-contract refresh completed;
normal release-only planning remains blocked by persisted stable-service
identity evidence.**

The authoritative remote `Hassan-Sajjad72/Project-Tst` `main` head resolved to
`3e4efe4c8dccc10f92ac42c3040a605781f69557`. It differs from the stable release
revision 3 commit `1d1ab0dd6905bb0587d68364975f3d0fe1a92dc0`.

The normal authenticated detection endpoint cloned and scanned that exact
commit successfully as Python/Streamlit. The normal preflight endpoint then
persisted `passed_with_warnings` with zero blockers. Durable evidence confirms
that detection profile commit, deployment-contract `commitSha`, contract
`detectionSourceCommit`, and preflight report commit are all the same new SHA;
the preflight fingerprint equals the refreshed contract hash.

No release-lane prepare route was invoked. The project retains five historical
deployment intents, two historical outbox rows, three release manifests, and
zero pipeline runs; no new intent, manifest, outbox, or pipeline run was
created by this refresh. No dispatcher, consumer, worker, runner, Docker, ECR,
ECS, Terraform, or AWS path was invoked.

The latest stable manifest is revision 3 and has a task-definition reference,
but its persisted `initialServiceArn` remains absent. The normal release-lane
planning bridge correctly requires that exact stable-service identity, so a
new release-only preparation is not yet eligible. The next approval-gated
slice is a fenced, evidence-backed remediation of that persisted stable service
identity—not a direct database rewrite—followed by a separate planning-only
approval for the new source commit.

### Verification

| Check | Result |
| --- | --- |
| Remote `main` resolution | Passed: exact new SHA recorded. |
| Authenticated normal detection | Passed: persisted the new SHA. |
| Authenticated normal preflight | Passed with warnings and zero blockers. |
| Persisted commit/fingerprint consistency | Passed. |
| `npm run test:detection` | Passed. |
| `npm run test:deployability-preflight` | Passed. |
| `npm run test:normal-release-lane-planning` | Passed. |
| `git diff --check` | Passed. |

## Project-Tst normal-workflow release execution — 2026-07-27

**Result: completed after bounded reconciliation; no rollback was required.**

The single prepared Project-Tst `dev` release-only intent for source commit
`3e4efe4c8dccc10f92ac42c3040a605781f69557` was validated against candidate
ReleaseManifest revision 4, applied InfrastructureManifest revision 4, the
pending zero-attempt outbox, and stable ReleaseManifest revision 3. Before
execution there were no image-provenance rows, side-effect journal rows,
operation leases, active cross-lane owners, candidate task definition, or
pinned ECR image for this commit.

The exact default-off later-release one-shot runner acquired the cross-lane and
operation fences, built and pushed the pinned source image once, persisted one
immutable provenance record, registered one task-definition revision, and
updated only the existing long-lived ECS service. The first verification pass
returned sanitized `RELEASE_EVIDENCE_AMBIGUOUS` while ECS still had the
candidate rollout in progress and the previous task was draining. No mutation
was repeated. Read-only reconciliation verified that the candidate task was
running, targets were healthy, and HTTP returned 200. After ECS reported one
completed deployment, the same logical runner identity replayed all three
succeeded journal entries and promoted candidate revision 4.

Final durable state is:

- deployment intent: `completed`, with no failure code;
- ReleaseManifest revision 4: `stable`;
- ReleaseManifest revision 3: `superseded` and retained as rollback lineage;
- image provenance: exactly one row matching the immutable ECR digest;
- side effects: exactly three distinct succeeded rows (image push, task
  definition registration, existing-service update);
- active operation leases and cross-lane owners: zero.

Final read-only AWS verification showed one active ECS deployment on the
candidate task definition, desired/running/pending counts of 1/1/0, rollout
`COMPLETED`, one healthy candidate target, HTTP 200, and an ECR digest matching
the persisted provenance. A prior target remained in ALB `draining` state at
the final observation and was not treated as candidate failure.

No Terraform, infrastructure creation/replacement, second ECS service,
deletion, destroy, cleanup, unrelated intent, or another lane was invoked.
Rollback was not executed because the candidate became conclusively healthy.

### Verification and remaining integration limitation

| Check | Result |
| --- | --- |
| Pre-execution readiness | Passed: `LATER_RELEASE_ONE_SHOT_READY`. |
| Exact image-side-effect deduplication | Passed: one provenance row and one succeeded image-push journal row. |
| Task/service mutation deduplication | Passed: one succeeded task-registration row and one succeeded existing-service-update row. |
| ECS/ALB/HTTP verification | Passed: completed 1/1 rollout, healthy candidate target, HTTP 200. |
| Promotion and fencing | Passed: revision 4 stable; intent completed; no active leases/owners. |
| `npm run test:later-release-one-shot` | Passed. |
| `git diff --check` | Passed before this documentation append. |

The explicit one-shot runner transitions and executes the prepared intent
directly; it does not publish the planner outbox through BullMQ. Consequently,
the original outbox row remains `pending` with zero attempts even though the
intent is terminal. It must not be dispatched after completion. Closing that
terminal-outbox lifecycle gap is the next smallest Phase 10 integration slice;
this result does not claim that normal outbox/consumer execution was exercised.

## Terminal outbox closure policy — 2026-07-27

**Result: implemented and verified in isolated PostgreSQL/Redis; the existing
Project-Tst historical row was intentionally not changed.**

`TerminalOutboxPolicyService` is now the canonical transaction-local policy
for terminal deployment intents. When an intent reaches `completed`, `failed`,
or `cancelled`, it atomically moves every matching undispatched outbox row to
the existing `dead_letter` state with a sanitized terminal reason. It affects
only pending, retryable, or uncompleted publishing rows with no published job
evidence; published deliveries and their history are preserved.

The fenced ownership finalizer uses this policy for successful and failed
consumer/one-shot execution. The undispatched-intent cancellation service uses
the same policy after its durable cancellation transition. The dispatcher now
locks and re-reads the exact deployment intent before delivery and again before
the durable `planned` → `enqueued` transition. A terminal intent is
dead-lettered without queue publication; a nonterminal state other than
`planned` is not dispatchable. Consumer-side terminal no-ops also invoke the
same policy, closing historical terminal rows when a valid consumer observes
them.

The isolated race suite proves that either terminalization or delivery can win
the `planned`-intent race, never both. If terminalization wins, the outbox is
dead-lettered and no job is published. If delivery wins first, the intent is
durably enqueued rather than terminalized. A delivery claim that becomes
terminal before completion cannot mark its intent enqueued; it is closed as a
terminal outbox instead.

### Files changed

- `backend/src/orchestration-contracts/outbox/terminal-outbox-policy.service.ts`
- `backend/src/orchestration-contracts/outbox/durable-outbox-dispatcher.service.ts`
- `backend/src/orchestration-contracts/outbox/outbox-dispatcher.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-pre-execution-ownership.service.ts`
- `backend/src/orchestration-contracts/release-lane/v1-undispatched-intent-cancellation.service.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-v1-release-lane-composition.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/scripts/verify-durable-outbox-dispatcher-postgres-redis.ts`
- `backend/scripts/verify-inactive-v1-pre-execution-ownership-postgres.ts`

### Verification

| Check | Result |
| --- | --- |
| Outbox terminalization/idempotence and dispatcher race | Passed in isolated PostgreSQL and Redis. |
| Consumer/one-shot ownership completion and failure closure | Passed in isolated PostgreSQL. |
| Existing nonterminal dispatch behavior | Passed. |
| Planner pure and PostgreSQL concurrency regressions | Passed. |
| Later-release default-off regression | Passed. |
| TypeScript check and backend build | Passed. |
| `git diff --check` | Passed. |

The Project-Tst revision-4 intent and its historical outbox remain unchanged:
the intent is `completed`; the outbox remains pending, zero-attempt, and
unpublished. Reconciling that single historical row requires a separate,
explicit approval for a fenced, audit-preserving terminal-outbox remediation.
No dispatcher, consumer, runner, Docker, ECR, ECS, Terraform, AWS, or cloud
operation was started by this policy slice.

## Approved historical Project-Tst terminal-outbox reconciliation — 2026-07-27

**Result: reconciled once under the canonical terminal-outbox policy.**

The exact completed Project-Tst `dev` revision-4 release-only intent and its
single pending zero-attempt outbox were revalidated under a serializable
transaction. The reconciliation acquired the exact project/environment planner
advisory lock, locked the intent, outbox, applied infrastructure revision 4,
and stable ReleaseManifest revision 4, and verified that no operation lease or
cross-lane ownership remained active.

The canonical policy changed only that undispatched outbox to `dead_letter`
with `INTENT_COMPLETED_BEFORE_OUTBOX_DISPATCH`. It preserved zero delivery
attempts and recorded no job ID or publication timestamp. One sanitized
`deployment_intent.terminal_outbox_reconciled` audit entry was recorded. The
intent remains `completed`; the release remains `stable`; the infrastructure
remains `applied`.

No job was published, no consumer or runner was started, and no Docker, ECR,
ECS, Terraform, AWS, rollback, deployment, or manifest mutation occurred.

## Phase 10.6 — default-off normal outbox execution bridge — 2026-07-27

**Result: implemented and verified only with isolated PostgreSQL/Redis and a
non-mutating injected release handler. It is disabled by default and was not
used for Project-Tst or any cloud release.**

`NormalReleaseLaneExecutionService` adds the smallest authenticated boundary
after Phase 10 planning. `POST /api/projects/:projectId/release-lane/dispatch`
accepts only an owner/admin or owner/developer request when both
`TWO_LANE_NORMAL_RELEASE_PLANNING_ENABLED=true` and the new
`TWO_LANE_NORMAL_RELEASE_EXECUTION_ENABLED=true` gate are present, the project
and exact `dev` environment are each the configured single allowlisted scope,
and exactly one candidate is still valid.

The service proves a `planned` `release_only` intent, matching desired
candidate ReleaseManifest, matching applied infrastructure, and exactly one
unclaimed zero-attempt `pending` outbox with no publication evidence. It then
calls only `DurableOutboxDispatcherService.dispatchExact(...)`. The exact
dispatcher method locks and claims that immutable row; it cannot fall back to
the dispatcher-wide pending scan. It publishes the frozen deterministic job
through the existing dispatcher and transitions the intent to `enqueued` only
through the existing delivery finalization transaction.

The route does not start a consumer, acquire execution ownership, run either
one-shot runner, enqueue a legacy job, or construct Docker, ECR, ECS,
Terraform, or AWS clients. The existing consumer remains explicitly started
only by an operator/test harness. Disabled, malformed, terminal, already
published, cross-project, read-only, non-`dev`, and non-`release_only` evidence
returns a sanitized disabled/blocked response; the existing legacy fallback is
unchanged while this execution gate is disabled or scope is ineligible.

### Files changed

- `backend/src/orchestration-contracts/release-lane/normal-release-lane-execution.service.ts`
- `backend/src/orchestration-contracts/outbox/durable-outbox-dispatcher.service.ts`
- `backend/src/projects/projects.controller.ts`
- `backend/src/app.module.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/.env.example`
- `backend/scripts/verify-normal-release-lane-execution.ts`
- `backend/scripts/verify-durable-outbox-dispatcher-postgres-redis.ts`
- `backend/scripts/verify-inactive-v1-bullmq-consumer-postgres-redis.ts`

### Verification

| Check | Result |
| --- | --- |
| Normal execution facade unit/static checks | Passed: exact gates, owner/developer boundary, exact target, terminal refusal, route/middleware wiring, and no runner/consumer/cloud dependency. |
| Exact concurrent dispatcher activation | Passed in isolated PostgreSQL/Redis: two exact activation requests produced one deterministic BullMQ job and one `enqueued` intent. |
| Explicit consumer with injected release handler | Passed in isolated PostgreSQL/Redis: one frozen job reached the non-mutating mocked release handler once under the fenced consumer lifecycle. |
| Existing terminal-outbox races | Passed in the dispatcher integration suite; terminal intents never dispatch. |

No production route was called, no Project-Tst completed intent was used, and no
database, queue, deployment, Terraform, Docker, ECR, ECS, or AWS mutation was
performed outside disposable isolated test resources.

### Next approval-gated slice

Before one future live normal-workflow canary, an operator must explicitly
approve enabling both normal-release gates for one project/dev scope and
explicitly starting a compatible v1 consumer whose production handler/client
composition has independently passed its read-only identity preflight. That
approval must name one prepared intent and authorize its bounded release and
rollback scope; it is not granted by this implementation.

## Project-Tst dev source refresh and approved planning attempt — 2026-07-27

**Result: refresh completed; planning correctly blocked before creating an
intent.**

The approved normal authenticated application-service flow refreshed the fresh
Project-Tst Canary `dev` scope at remote `main` commit
`6b9e0c5c4bb38165180415c457a9cf1e98f75c0b`. This is newer than stable
ReleaseManifest revision 4’s commit `3e4efe4c8dccc10f92ac42c3040a605781f69557`.
Detection completed successfully and the normal pre-flight persisted
`passed_with_warnings`; the detection commit, deployment-contract commit,
contract detection commit, and pre-flight input fingerprint all match the same
new immutable contract.

The subsequently approved planning-only request invoked
`NormalReleaseLanePlanningService` with the exact temporary local planning gate
and project/dev allowlist. It returned
`NORMAL_RELEASE_LANE_PROJECT_INELIGIBLE` before invoking the transactional
planner. The persisted stable ReleaseManifest revision 4 still has no
`initialServiceArn`, which is required to prove the existing long-lived service
identity. This is a durable-evidence blocker, not a source, detection, or
pre-flight failure.

No new release-only intent, candidate ReleaseManifest, outbox row, or
ProjectPipelineRun was created: counts remain six historical intents, zero
planned intents, three historical outbox rows, and zero pipeline runs for this
project. No dispatcher, consumer, worker, runner, Docker, ECR, ECS, Terraform,
AWS, rollback, or deletion path ran.

While exercising the normal Nest composition, a verified dependency-injection
defect surfaced: defaulted `TerminalOutboxPolicyService` parameters were being
reflected as `Object`, preventing context construction. Explicit Nest injection
tokens were added only for those existing policy dependencies; no lifecycle or
execution behavior changed. The normal context then constructed successfully.

| Check | Result |
| --- | --- |
| Remote `main` source resolution | Passed: new 40-character commit recorded. |
| Authenticated detection refresh | Passed. |
| Authenticated pre-flight refresh | Passed with warnings; no blockers. |
| Commit/fingerprint consistency | Passed. |
| Normal release-only preparation | Blocked safely: `NORMAL_RELEASE_LANE_PROJECT_INELIGIBLE`. |
| Intent/outbox/pipeline isolation | Passed: no planning or execution record was created. |
| Focused planning/outbox checks, TypeScript, backend build, diff check | Passed. |

The exact remaining prerequisite is a separately approved fenced remediation
that persists the already-proven stable service identity only after durable and
read-only evidence agree. A new planning-only approval may then be retried for
this exact commit; no release execution is authorized by this refresh.

## Project-Tst stable ReleaseManifest revision 4 service-identity remediation — 2026-07-27

**Result: completed under a released fenced v1 ownership scope.**

The approved remediation validated the exact fresh Project-Tst Canary `dev`
scope, stable ReleaseManifest revision 4, and applied InfrastructureManifest
revision 4 before persistence. Durable lineage proved that the stable-release
projection, the release task definition, and the applied infrastructure output
hash all agree. A read-only ECS inspection then confirmed exactly one active
service in the exact applied cluster, using the stable task definition and the
required DeployGuard project, environment, release, infrastructure,
task-definition-input, and image-digest identity tags.

The repair acquired the existing project/dev cross-lane ownership scope with a
new v1 lease and fencing token, re-read the durable evidence and ECS identity,
then updated only the previously-null `release_manifests.initial_service_arn`
field on revision 4. It re-verified the stable manifest and ECS identity after
the commit, and released the exact ownership fence. The stable manifest remains
stable; InfrastructureManifest revision 4 remains the one applied foundation.

Two preliminary local invocations failed closed before the field update: the
standalone TypeORM data-source metadata path was unavailable, and an initial
PostgreSQL lock query attempted to lock the nullable side of a left join. Both
attempts left the field null and the ownership row released. The final
transaction used the existing serializable advisory-lock/fencing protocol with
a non-null stable-projection join and completed successfully.

| Evidence | Result |
| --- | --- |
| Stable release / applied infrastructure revision identity | Passed. |
| Durable service lineage and output-hash integrity | Passed. |
| Read-only ECS service, task definition, and exact identity tags | Passed. |
| Fenced single-field persistence and post-write verification | Passed. |
| Ownership lifecycle | Passed; final status is released. |
| Active intent / operation-lease isolation | Passed; both counts are zero. |
| Pipeline-run isolation | Passed; count remains zero. |

No intent or outbox was created or dispatched. No consumer, runner, Docker,
ECR push, task-definition registration, ECS update, Terraform, deployment,
rollback, deletion, or cleanup action occurred. The existing pending outbox is
historical evidence and was not modified by this remediation.

The remaining separate action, if approved, is a new planning-only invocation
for the refreshed eligible source commit. It must validate the now-complete
stable-service identity and must remain isolated from release execution.

## Project-Tst approved normal planning-only preparation — 2026-07-27

**Result: prepared; execution remains disabled.**

After the revision-4 stable-service identity was remediated, the approved
normal authenticated planning bridge accepted the current pinned Project-Tst
`dev` commit `6b9e0c5c4bb38165180415c457a9cf1e98f75c0b`. Detection, deployment
contract, and passing pre-flight evidence all reference that same commit. The
project has exactly one new `planned` `release_only` intent, exactly one
matching desired candidate ReleaseManifest, and exactly one pending,
zero-attempt, unclaimed outbox record.

The normal backend startup initially exposed metadata inference defects in
existing string-union entity properties. Explicit `varchar` mappings were
added for the canonical configuration owner and the relevant two-lane
intent/manifest/ownership/outbox/reconciliation capability string fields. This
matches the existing PostgreSQL varchar columns; it requires no migration and
does not change stored lifecycle data or execution behavior. The normal Nest
context then initialized and the planner was invoked once as the authorized
developer.

| Evidence | Result |
| --- | --- |
| Exact detection, contract, and pre-flight source identity | Passed. |
| Applied infrastructure revision 4 / stable release revision 4 | Passed. |
| Normal authenticated planner result | Passed: `RELEASE_LANE_INTENT_PREPARED`. |
| Candidate and outbox cardinality | Passed: one desired candidate and one clean pending outbox. |
| Publication, pipeline, and operation-lease isolation | Passed: zero published/publishing evidence, zero pipeline runs, zero active operation leases. |
| Focused normal-planning verification, TypeScript, backend build, diff check | Passed. |

No outbox was dispatched or claimed. No consumer, worker, runner, Docker build,
ECR push, task-definition registration, ECS update, Terraform, AWS call,
rollback, deletion, or cleanup action occurred.

The next action requires a separate execution approval that names this exact
prepared intent and candidate, explicitly enables the normal execution gate
for this single project/dev scope, and authorizes only its bounded release and
rollback behavior.

## Project-Tst normal dispatch/consumer canary — 2026-07-27

**Result: terminal pre-mutation failure; no rollback performed.**

The approved normal release-only canary first re-read the single planned intent,
its desired candidate, the pending zero-attempt outbox, applied infrastructure
revision 4, stable release revision 4, and released lease/ownership state. An
independent read-only production identity preflight confirmed the exact ECR
repository and the existing active ECS service/task-definition lineage before
publication.

The normal path exposed a real integration gap: its explicit BullMQ consumer
had no fenced image-preparation hook, while the production release handler
requires immutable image provenance. The hook was factored into a gated
later-release preparation boundary and injected only by the exact
production-canary composition. The normal consumer now runs that boundary only
after it has acquired v1 operation ownership and the independent cross-lane
fence; ordinary/default-off consumers receive no preparation callback.

One exact outbox was then published once and consumed by the compatible release
worker. The image side-effect entered the durable uncertain state and the
intent finalized with `INVOCATION_PREPARATION_FAILED`. Reconciliation inspected
the exact immutable ECR tag read-only and proved it absent. Consequently there
is no successful image provenance, task-definition registration, ECS update,
or candidate rollout to reconcile; no rollback was eligible or attempted. The
stable revision-4 service and its rollback lineage remain unchanged.

| Evidence | Result |
| --- | --- |
| Exact production identity preflight | Passed before publication. |
| Exact outbox publication / deterministic job | Passed once. |
| Cross-lane ownership and operation-lease cleanup | Passed; no active scope remains. |
| Candidate ECR provenance | Absent after read-only reconciliation. |
| Candidate task definition / service update | Not created. |
| Exact outbox terminal dispatchability | Closed: published audit evidence, no pending claim. |
| Stable revision 4 / applied infrastructure revision 4 | Preserved. |

The gates were process-scoped and returned to their default-off environment at
process exit. No legacy pipeline, one-shot runner, Terraform, infrastructure
replacement, second ECS service, deletion, destroy, or cleanup path was used.

The next approval-gated slice is not a retry of this terminal intent. It must
first add a truthful normal-path recovery decision for a conclusive
pre-mutation image-build failure (reconcile or create a new idempotent
candidate), then obtain a fresh release execution approval for that resulting
intent. It must not revive this terminal intent or repeat an uncertain side
effect blindly.

## Project-Tst canonical pre-mutation recovery — 2026-07-27

**Result: one replacement prepared; execution remains disabled.**

The failed normal-canary intent was inspected before any write. Its published
outbox, desired candidate, single uncertain image side-effect, absent
provenance, absent task/service effects, stable revision 4 lineage, applied
infrastructure revision 4, and released fencing state all matched the narrow
pre-mutation recovery policy. A read-only ECR inspection again proved that the
exact immutable tag is absent.

The concrete defect was error-phase loss in the image-preparation boundary:
pre-mutation Docker/template/login failures were converted into an opaque
uncertain effect, indistinguishable from an interrupted remote push. The
production client now classifies known pre-registry phases with safe machine
codes, while push/registry ambiguity remains uncertain and requires
reconciliation. The historical effect remains unchanged; its recovery is
permitted only because ECR absence and all downstream durable predicates were
proven.

The new planner recovery input is serializable and advisory-lock protected. It
binds a deterministic recovery idempotency key and immutable evidence hash to
the failed intent, then re-checks terminal state, published outbox, one allowed
image effect, no provenance, no downstream effects, exact stable/applied
lineage, and released operation/cross-lane ownership before creating a fresh
candidate. Replays return that same replacement; the original intent and
outbox can never be revived or dispatched again.

| Evidence | Result |
| --- | --- |
| Original failed intent, published outbox, and uncertain journal | Preserved unchanged. |
| Read-only exact ECR tag inspection | Absent; recovery condition proven. |
| Replacement intent / desired candidate / pending outbox | Exactly one of each. |
| Replacement publication, queue claim, consumer, pipeline run | None. |
| Active operation lease / cross-lane ownership | Zero. |
| Stable release 4 and applied infrastructure 4 | Unchanged. |
| Planner PostgreSQL concurrency/rollback and dispatcher PostgreSQL/Redis checks | Passed. |
| Isolated ownership PostgreSQL fixture | Blocked by its pre-existing fixture schema expecting a correlation column not present at that migration stage; not counted as passed. |

No Docker build, ECR push, ECS mutation, Terraform, rollback, deletion, or
cleanup ran during recovery. The next smallest approval-gated action is one
normal dispatch/consumer execution of the new replacement intent after a
separate read-only production identity preflight. It must not dispatch or
modify the historical failed intent.

## Project-Tst replacement normal dispatch/consumer canary — 2026-07-27

**Result: completed and promoted after bounded outcome reconciliation.**

Before publication, the focused ownership PostgreSQL fixture was corrected to
apply the additive ownership-correlation migration used by the current
ownership service. The fixture had stopped at the ownership-table migration
while exercising the later service shape that clears nullable intent and
operation-lease correlations on fenced takeover. The correction is fixture
only: it adds the minimal referenced rollback table and advances the isolated
schema through both migration stages. No production ownership semantics or
database schema changed.

The exact replacement was then resolved from durable state: one planned
`release_only` intent for commit
`6b9e0c5c4bb38165180415c457a9cf1e98f75c0b`, desired candidate revision 6,
one pending zero-attempt unclaimed outbox, applied infrastructure revision 4,
stable rollback revision 4, and no active ownership or operation lease. The
historical failed intent and its published outbox remained distinct and
unchanged. An independent read-only preflight confirmed the exact ECR
repository and the existing stable ECS service/task-definition identity.

One initial execution request failed closed before publication because the
exact ownership-enforcement gate was omitted from the process-local
configuration. The outbox remained pending and untouched. With the complete
single-project/dev gate set, `dispatchExact()` published the replacement
outbox once under its frozen deterministic BullMQ job ID, and one compatible
consumer acquired cross-lane ownership before the operation lease.

The first delivery built and pushed one immutable image, persisted one
provenance row, registered one task-definition revision, and updated only the
existing ECS service. All three journal rows completed successfully. Immediate
rollout inspection then exposed a production verifier defect: ECS may expose
the exact new PRIMARY deployment before its top-level service task-definition
projection converges. That bounded convergence state was incorrectly classified
as ambiguous rather than progressing, so the intent reached terminal
`RELEASE_EVIDENCE_AMBIGUOUS`.

Read-only reconciliation subsequently proved the ECR digest, candidate task
definition, existing service identity, one running candidate task, healthy ALB
target, HTTP 200 response, and a completed 1/1 ECS PRIMARY rollout. The
verifier now accepts only an `IN_PROGRESS` exact candidate PRIMARY deployment
while the top-level service projection lags; a completed mismatch remains
ambiguous and fails closed. Focused tests cover both cases.

The same deterministic failed BullMQ job was then replayed through the fenced
normal consumer under an explicit outcome-reconciliation gate. Eligibility
required the exact terminal failure, one provenance row, exactly the three
succeeded mutation journals, the published outbox, no active lease, and the
current candidate service identity. Existing journals replayed all mutation
results without another build, push, task registration, or service update.
Healthy evidence promoted candidate revision 6, superseded revision 4 while
preserving it as rollback lineage, completed the intent, and released both
fences. No rollback was warranted or executed.

| Evidence | Result |
| --- | --- |
| Ownership fixture at current correlation schema stage | Passed. |
| Replacement outbox publication | One publication; one frozen deterministic job. |
| Queue outcome | Same job completed after one bounded reconciliation replay. |
| Image provenance and mutation journals | One provenance; one succeeded row for image push, task registration, and existing-service update. |
| ECS / ALB / HTTP | PRIMARY completed 1/1, exact candidate task active, target healthy, HTTP 200. |
| Durable release state | Intent completed; candidate revision 6 stable and health verified; revision 4 preserved as superseded rollback lineage. |
| Terminal outbox safety | Published audit evidence, no pending or claimed outbox. |
| Ownership cleanup | No active operation lease or cross-lane owner. |
| Historical failed recovery source | Original failed intent and published outbox unchanged. |
| Terraform / infrastructure / deletion | Not invoked. |

The final consumer regression also exposed a test-only BullMQ observation
race: the failed-set transition could become visible before the previously
loaded `Job` object exposed its persisted sanitized `failedReason`. The
isolated test now polls a fresh job snapshot for that bounded assertion. No
consumer or heartbeat lifecycle behavior changed.

All activation values were process-scoped. The canary processes were stopped
after durable terminal verification, leaving the repository defaults off.
The command emitted its terminal result but the Nest application context did
not exit on its own because unrelated queue connections remained open; the
local canary processes were terminated only after the consumer session had
stopped and durable cleanup was verified. This is an operational shutdown gap,
not an incomplete release or fence.
No legacy pipeline, one-shot runner, Terraform, second ECS service,
infrastructure replacement, deletion, destroy, or cleanup path was used.

The smallest remaining Phase 10 gap is a default-off operational lifecycle for
starting and observing the compatible normal v1 consumer around the existing
authenticated execution bridge, including bounded convergence retries, without
requiring the canary command. That integration needs separate approval and
must retain the exact project/dev allowlist and all existing fencing gates.

## Default-off normal v1 consumer operational lifecycle — 2026-07-27

**Result: implemented and verified locally without release execution.**

The compatible normal release consumer now has a dedicated process boundary:

```text
npm run worker:normal-v1-release
```

The process uses a narrow Nest application context containing configuration,
TypeORM, and the existing orchestration-contract composition. It does not load
`AppModule`, HTTP controllers, legacy workers, schedulers, or the canary
runner. It never dispatches an outbox. Missing or non-exact
`TWO_LANE_NORMAL_RELEASE_CONSUMER_ENABLED=true` leaves it disabled; an enabled
runtime also requires the existing planning, execution, production-canary,
ownership, operational-rollout, single-project, and exact `dev` gates.
Malformed or broad scope is blocked before a BullMQ worker is created.

The exact allowlist is passed into the consumer as an execution scope. Frozen
jobs outside that single project/environment fail with
`CONSUMER_JOB_SCOPE_NOT_ALLOWED` before shadow insertion, ownership,
operation-lease claim, preparation, or handler invocation. The deterministic
job, cross-lane ownership, operation fencing, side-effect journal,
reconciliation, and terminal-outbox behavior are otherwise unchanged.

Operational observation remains internal and sanitized. Startup and bounded
state changes log only readiness state, the bounded release message type, safe
machine codes, and timestamps. States cover `idle`, `processing`,
`reconciling`, `terminal`, `stopping`, and `stopped`; `SIGUSR1` emits a
read-only snapshot. No intent ID, project ID, queue payload, fencing token,
journal payload, cloud identifier, credential, or SDK error is exposed.

`SIGTERM` and `SIGINT` stop intake with BullMQ `Worker.close()`, drain the
cooperative current handler, stop execution and capability heartbeats, close
worker Redis connections, close lazily created publisher queues during Nest
teardown, and then close TypeORM. Cross-lane ownership and operation leases
still release only through their existing fenced terminal/retryable rules.

| Verification | Result |
| --- | --- |
| Default-off, malformed and broad gate fixtures | Passed; no consumer start. |
| Exact scoped lifecycle fixture | Passed; one release queue, concurrency one, explicit stop. |
| Isolated PostgreSQL/Redis out-of-scope job | Rejected before handler/lease; intent unchanged. |
| Isolated long-running cooperative job shutdown | Stop waited; job completed; lease released. |
| Dedicated process start/status/SIGTERM cycle against a temporary current-entity schema | `idle` → `stopping` → `stopped`; natural exit status 0. |
| Process cleanup | Zero active operation leases/owners; no Node Redis connection or queue claim remained. |
| Normal execution, dispatcher PostgreSQL/Redis, ownership and reconciliation regressions | Passed. |
| Backend type-check/build and `git diff --check` | Passed. |
| Project-Tst durable read-only check | ReleaseManifest revision 6 remains stable; zero active Project-Tst lease/owner. |

The local process test used a temporary database and isolated Redis prefix and
delivered no job. Production-shaped clients were constructed behind the exact
gate but no AWS method was called. No Docker build, image push, ECS operation,
Terraform, rollback, queue publication, deployment, or durable Project-Tst
mutation occurred.

One bounded limitation remains: graceful drain is proven for the existing
cooperative fenced handler contract; an uncatchable process termination still
relies on lease expiry and the existing reconciliation path, as designed. The
temporary database used the current TypeORM entity schema: a clean-database
migration attempt stopped at the pre-existing observability migration because
the repository migration series assumes baseline `projects` tables already
exist. That unrelated bootstrap limitation did not affect the normal migrated
application database or the isolated consumer tests and was not repaired in
this slice. The
next smallest approval-gated Phase 10 slice is a non-cloud normal-runtime
exercise in which the authenticated execution bridge and this independently
managed consumer share isolated PostgreSQL/Redis and a mocked production
handler. That slice should prove process supervision and operator status
collection end to end without dispatching Project-Tst or changing cloud state.

## Authenticated bridge plus supervised consumer runtime proof — 2026-07-27

**Result: passed using disposable local state and a non-cloud handler.**

One isolated harness created a temporary PostgreSQL database and Redis prefix,
then used the real transactional planner to create exactly one `release_only`
intent, desired candidate, and clean pending outbox. A real local `AppModule`
HTTP server authenticated a signed developer session and invoked:

```text
POST /api/projects/:projectId/release-lane/dispatch
```

The route called `NormalReleaseLaneExecutionService`, which selected only that
exact pending outbox and published it through `dispatchExact()`. An independent
subprocess ran the dedicated normal v1 consumer with one exact project/`dev`
scope. Its injected production-shaped handler performed no external operation;
it exercised the existing validation, cross-lane ownership, operation lease,
heartbeat, fenced invocation, and terminal finalization boundaries.

| Evidence | Result |
| --- | --- |
| Authenticated dispatch | One eligible request returned `dispatched`; one frozen deterministic BullMQ job was published. |
| Consumer execution | One bounded handler invocation; the intent reached `completed`. |
| Outbox and job | One publication attempt, exact envelope-derived job ID, one completed delivery. |
| Runtime observation | `SIGUSR1` snapshots and lifecycle logs proved `idle`, `processing`, `terminal`, `stopping`, and `stopped`. |
| Out-of-scope HTTP request | Returned the sanitized blocked projection without publication. |
| Out-of-scope frozen job | Failed with the bounded scope code before ownership or handler invocation. |
| Durable cleanup | No active operation lease, cross-lane owner, outbox claim, or dispatchable terminal outbox remained. |
| Process cleanup | `SIGTERM` drained the consumer and produced natural exit status 0; the isolated Redis prefix was empty after queue cleanup. |
| Sanitization | Consumer output contained no project/intent identity or fencing token. Cross-lane acquisition logs now use a short scope hash rather than a raw project ID. |
| External effects | No Docker, ECR, ECS, Terraform, AWS, rollback, or legacy-pipeline path was reachable. |

The proof found a separate local-shutdown defect in the temporary authenticated
HTTP application: factory-provided pipeline and infrastructure-lifecycle
BullMQ queues lacked Nest destruction hooks, leaving Redis connections open
after `app.close()`. Those queues now use a lifecycle-managed Queue subclass
whose only added behavior is `close()` during module destruction. Queue names,
options, publication, workers, retries, and deployment semantics are unchanged.
The complete harness subsequently exited naturally.

Focused normal-execution, consumer-lifecycle, dispatcher unit and
PostgreSQL/Redis integration, operation-ownership PostgreSQL, reconciliation
PostgreSQL, TypeScript, and backend-build checks passed. The test deliberately
used the current entity schema rather than changing the unrelated
clean-database migration bootstrap series.

Project-Tst revision 6 and all cloud resources were outside the disposable
database and isolated Redis scope and were not read or changed. No normal gate
was enabled outside the child test processes.

The next smallest approval-gated gap is operational packaging for a supervised
deployment environment (for example, its service-manager definition and
sanitized health collection). A future live normal-workflow canary additionally
requires a genuinely new eligible prepared intent and separate explicit
approval; this proof creates no authorization to dispatch Project-Tst.

## Repository-supervised consumer packaging — 2026-07-27

**Result: implemented and proven locally without cloud or release mutation.**

Repository inspection found no PM2, systemd, Supervisor, Kubernetes, or
platform-specific worker framework. Long-lived local dependencies use the
root Docker Compose definition, while backend workers use separate npm
commands. The normal v1 release consumer is therefore packaged as the single
`normal-v1-release-consumer` service in the opt-in
`normal-v1-release` Compose profile. No competing supervisor was introduced.

The service remains absent from ordinary `docker compose up`. Explicit startup
uses the repository convention:

```text
docker compose --env-file backend/.env \
  --profile normal-v1-release up -d normal-v1-release-consumer
```

Even when its profile is selected, the worker creates no BullMQ consumer unless
all existing flags are exactly satisfied: consumer, planning, execution,
release composition, production-canary mode, later-release live client,
ownership enforcement and rollout, operational rollout, read-only preflight,
one project allowlist, and exactly environment `dev`. Disabled or invalid
configuration records a sanitized terminal health state and exits with status
zero, so the supervisor does not restart-loop. The service has one fixed
container identity and consumer concurrency remains one.

Unexpected non-zero exits use bounded `on-failure:3` restart behavior.
Supervisor SIGTERM has a 90-second grace period and follows the existing drain
contract: stop intake, finish or fenced-release bounded work, stop heartbeats,
close BullMQ/Redis/TypeORM, then exit naturally. The Compose service never
dispatches an outbox.

### Sanitized health contract

The worker atomically writes a versioned status record to its supervisor-owned
status volume. The record contains only:

- bounded state;
- readiness and liveness booleans;
- sanitized machine code;
- observation timestamp.

States cover `disabled`, `starting`, `ready`, `processing`, `reconciling`,
`terminal`, `stopping`, `stopped`, and `failed`. No project or intent ID,
message payload, fence, journal data, cloud identifier, credential, or raw
error is present. Compose checks liveness with the compiled read-only health
command; operators may collect the same sanitized record with:

```text
docker compose --profile normal-v1-release exec \
  normal-v1-release-consumer \
  node dist/src/normal-v1-release-consumer.health.js status
```

Missing, malformed, or stale records fail closed. Only an idle accepting
consumer reports ready; active processing remains live but not ready.

### Local operational evidence

| Check | Result |
| --- | --- |
| Default-off Compose profile | Passed; ordinary Compose startup does not select the service. |
| Disabled configuration | Exited once with status 0 and `disabled`; restart count stayed zero. |
| Broad project configuration | Failed closed with sanitized `failed` health; exit 0 and no restart loop. |
| Exact scope startup | Exactly one consumer container became ready against a disposable PostgreSQL database and isolated Redis prefix. |
| Status collection | Returned only the six documented sanitized fields. |
| Graceful supervisor restart | Logged `stopping` and `stopped`, then returned to ready. |
| Unexpected worker exit | Non-zero child exit incremented the bounded supervisor restart count and recovered to a fresh ready observation. |
| Final SIGTERM | Reached durable `stopped`; no active lease, cross-lane owner, outbox claim, Redis worker connection, or child process remained. |
| Non-cloud execution regression | The authenticated bridge/independent-consumer fixture again completed one deterministic job through its mocked handler. |
| Focused regressions | Consumer lifecycle, normal execution, dispatcher unit and PostgreSQL/Redis, ownership PostgreSQL, and reconciliation PostgreSQL passed. |

The compiled isolated fixture initially tried to discover source-form
migrations from inside the Node container. Its test-only data source now
explicitly disables migrations and uses the already-created disposable current
entity schema, as required; no production lifecycle or the unrelated
clean-database bootstrap series changed.

Project-Tst ReleaseManifest revision 6 and AWS were outside every test scope
and were not read or modified. No Docker application build, ECR/ECS operation,
Terraform action, queue dispatch for Project-Tst, rollback, or legacy worker
was invoked.

The next smallest approval-gated gap is one future live normal-workflow canary
using this Compose-supervised consumer, only after a genuinely new eligible
commit has been prepared. That requires separate approval for the exact intent,
outbox, project/`dev` scope, and bounded release/rollback mutations.

## Compose-supervised live normal-workflow canary — 2026-07-27

**Result: passed; one normal authenticated dispatch reached stable promotion
through the Compose-supervised production consumer.**

Exactly one harmless visible source change was committed and pushed to
`Hassan-Sajjad72/Project-Tst` `main`:

- immutable commit: `4ef8326a48c633999c0b3c06dac7bae671b72a67`;
- changed file: `app.py`;
- visible marker: a sidebar release-canary caption;
- the previous stable commit remains its ancestor.

The normal authenticated detection and preflight routes persisted that exact
commit. Preflight finished `passed_with_warnings`, and the detection profile,
preflight input, and deployment-contract hash agreed. The normal planning route
then created exactly one `release_only` intent, desired ReleaseManifest
revision 7, and pending zero-attempt outbox against applied
InfrastructureManifest revision 4. No legacy pipeline run was created.

### Defects found before publication

Three bounded integration defects were corrected without changing release
semantics:

1. Stable revision 6 lacked its canonical `initialServiceArn`, although its
   previous stable lineage retained the exact service identity. The planning
   service now uses the same one-generation, exact project/environment/
   infrastructure lineage fallback already enforced by the release manifest
   store. It still fails closed when that evidence is absent or conflicting.
2. The supervised service's slim Node image did not contain the `git` and
   Docker clients required by the production image-preparation client. A
   dedicated default-off worker image now supplies those tools and mounts only
   the Docker socket required for the approved build. AWS credentials were
   supplied by a temporary read-only runtime mount and were not committed.
3. During the brief ECS overlap, the first rollout read returned
   `RELEASE_EVIDENCE_AMBIGUOUS` after all three mutations had already succeeded.
   The prior safe convergence transition existed only inside the canary
   harness. It is now an exact, default-off
   `NormalReleaseLaneConvergenceService`: it requires the failed ambiguous
   intent, one published deterministic job, immutable provenance, exactly
   three succeeded mutation journals, no other effect, no active operation
   lease, and read-only ECR/ECS convergence before retrying that same failed
   job. It never publishes a new job.

### Live execution and reconciliation evidence

The Compose worker reported sanitized `ready` health before publication. The
authenticated project dispatch route selected the exact outbox and
`dispatchExact()` published one deterministic BullMQ job. The production
consumer acquired cross-lane ownership before its operation lease and
performed:

| Boundary | Durable/live result |
| --- | --- |
| Immutable image | One build/push effect, one succeeded journal, persisted provenance, and an exact ECR digest match. |
| Task definition | One registration effect and one succeeded journal. |
| Existing service | One update effect and one succeeded journal; no second ECS service was created. |
| First rollout read | Failed closed as ambiguous while the candidate and previous tasks briefly overlapped. |
| Convergence | Read-only ECS evidence later proved 1/1, zero pending, one candidate PRIMARY in `COMPLETED`; the same failed BullMQ job was retried. |
| Replay safety | Image, task-definition, and service-update journals replayed; none of the three mutations ran again. |
| Promotion | Intent completed and ReleaseManifest revision 7 became the sole stable release; revision 6 was retained as rollback lineage. |
| Rollback | Not required and not invoked; there is no rollback journal. |

Final read-only evidence proved the persisted digest matched ECR, ECS was
ACTIVE with the exact candidate task definition at 1/1 and a completed PRIMARY
deployment, the ALB had one healthy target and no draining target, and both the
Streamlit health path and root returned HTTP 200. A headless authenticated
browser runtime rendered the new release-canary caption, proving the visible
source change reached the service.

### Shutdown, cleanup, and verification

The worker received Compose SIGTERM, persisted sanitized `stopped` health,
exited 0, and its container was removed. Temporary runtime credential/gate
configuration was removed. The normal planning, execution, consumer, and
composition gates are again default-off.

Durable cleanup proved:

- the intent is `completed`;
- its outbox has one publication attempt, no claim, and no dispatchable pending
  state;
- the deterministic BullMQ job is `completed`;
- exactly three side effects exist and all three are `succeeded`;
- there is no active operation lease, cross-lane owner, outbox claim, consumer
  process, or consumer container;
- InfrastructureManifest revision 4 and unrelated projects were not changed;
- no Terraform, infrastructure replacement, second service, deletion,
  destroy, cleanup, legacy pipeline, or unrelated intent was invoked.

Focused planning, execution, convergence, consumer lifecycle, Compose
supervision, dispatcher unit and PostgreSQL/Redis, operation ownership,
cross-lane ownership, ECS reconciliation, and side-effect reconciliation tests
passed. TypeScript checking and the backend build passed. The supervision test
was tightened to count the exact Compose service key after the new worker image
name exposed its previous broad substring assertion.

The next smallest approval-gated integration gap is to let the supervised
runtime schedule this exact bounded convergence transition itself after a
terminal ambiguous rollout, rather than requiring the explicit default-off
reconciliation command. That slice must retain the current exact-job,
read-only-convergence, no-new-publication, and no-repeat-mutation predicates.

## Phase 10 unified v1 release read model — 2026-07-27

**Result: passed locally; read-only projection/UI only.**

The authoritative project current-state response now carries the existing
normal-v1 release-lane projection through Dashboard, Project Overview, and
Pipeline. It does not create a `ProjectPipelineRun` and it does not add a page
request or execution dependency.

- A nonterminal v1 intent contributes one active run only when no legacy
  deployment is active. A legacy/v1 overlap is surfaced as the sanitized
  `NORMAL_RELEASE_LANE_LEGACY_ACTIVITY_CONFLICT` rather than being counted
  twice.
- Terminal intent status now takes precedence over historical outbox delivery
  state. This corrected a real local defect where the completed revision-7
  intent was incorrectly rendered as `queued` because its audit-preserving
  outbox remained `published`.
- The same sanitized projection exposes the stable release revision, short
  source SHA, promoted timestamp, existing ALB URL, and read-only rollback
  lineage. The prior stable release is shown only as eligible lineage; no
  rollback control was added.
- The existing developer history card reads the same compact chronological v1
  lifecycle history. Legacy pipeline history, active-run predicates outside
  this projection, stable-URL legacy fallback, dashboard layout, and all
  deployment controls remain unchanged.

### Local Project-Tst evidence

With temporary process-only read gates scoped to the Project-Tst `dev` project,
the authenticated local API returned release intent state `completed`, candidate
and stable release revision `7`, short commit `4ef8326a48c6`, a present stable
URL, rollback lineage revision `6`, four ordered lifecycle events, and
`activeRunCount: 0`. The authenticated workspace-summary/Dashboard projection
also returned that project with `activeRunCount: 0` and release-lane state
`completed`. A browser refresh of both Project Overview and Pipeline
rendered the current stable-release card, revision 7, short SHA, and revision-6
lineage using `/current-state` only; no `/release-lane/status` page fetch was
observed. The gates were process-local and were not persisted. No database,
queue, Terraform, deployment, or cloud mutation occurred.

Focused release-lane status/current-state fixtures cover disabled, missing,
queued, running, completed, cancelled, failed/blocked, malformed, and
legacy-identity-conflict cases. Backend type-check/build, frontend projection
test/build, and `git diff --check` passed.

The next smallest integration gap is a separately approved, read-only
workspace-level v1 release summary that can replace legacy-only usage counters
without altering dashboard count semantics or release execution.

## Phase 10 workspace v1 release summary — 2026-07-27

**Result: passed; read-only aggregation/UI only.**

`GET /api/projects/workspace-summary` now aggregates the already-loaded,
sanitized project current states once. Its `releaseSummary` reports active v1
releases, completed v1 releases, blocked/failed releases, stable projects,
projects with rollback lineage, legacy-only projects, and sanitized conflict
counts. The returned `usage.activeRuns` now uses the exact same current-state
active-run total as the Dashboard list; it does not alter the active-run rule,
and cross-lane conflicts count once as blocked rather than as concurrent
legacy/v1 success.

Dashboard uses that single response for the existing active count plus concise
stable/review totals. It adds no project polling, release-status request,
execution control, or lifecycle write.

Local authenticated Project-Tst verification returned:

- `completedV1Releases: 1`, `stableProjects: 1`, and
  `rollbackLineageProjects: 1`;
- Project-Tst revision 7 completed/stable, revision 6 lineage, and
  `activeRunCount: 0`;
- workspace `usage.activeRuns: 0`, matching the dashboard current-state sum.

Pure multi-project fixtures cover active, terminal, legacy-only, blocked, and
legacy/v1 conflict states. Status/current-state regressions, TypeScript,
backend build, frontend projection test/build, and `git diff --check` passed.
No database lifecycle, queue, Terraform, deployment, or cloud mutation
occurred.

The next smallest integration gap is a separately approved read-only workspace
history drill-down that groups already-sanitized v1 terminal events without
changing the existing project pipeline-history model.

## Phase 10 Plan/Usage workspace release visibility — 2026-07-27

**Result: passed locally; read-only aggregation and UI only.**

`GET /api/projects/workspace-summary` now returns a bounded, terminal-only
`releaseHistory` beside its authoritative `releaseSummary`. Each item contains
only the project display name, terminal state, candidate release revision,
short source SHA, sanitized lifecycle code, and timestamp. It is built from
the existing sanitized project current-state evidence; it neither creates nor
merges `ProjectPipelineRun` history. A legacy/v1 identity conflict is emitted
once as blocked rather than as a successful terminal release.

Plan & Usage now reads that same workspace response alongside its existing
billing response. It displays the shared active, completed, blocked, stable,
and rollback-lineage totals plus the bounded terminal history card. The page
does not issue per-project current-state or standalone release-status requests.
Dashboard continues to use the same workspace summary and unchanged active-run
rules.

### Local evidence

The authenticated local API returned one history item for **Project-Tst
Canary**: `completed`, candidate revision `7`, short SHA `4ef8326a48c6`, and
`RELEASE_LANE_INTENT_COMPLETED`. Revision 6 was retained only in the rollback
lineage total and was not emitted as another successful history entry. The
same response reported zero active runs/releases, one completed stable release,
and one rollback-lineage project.

Authenticated browser refreshes of Dashboard and Plan & Usage rendered the
shared totals and the Plan & Usage history card. In Vite development mode,
React Strict Mode made two identical workspace-summary requests; this is not
per-project polling. Neither page made a per-project current-state or
standalone release-lane-status request. No database lifecycle, queue,
Terraform, deployment, rollback, or cloud action occurred.

Focused multi-project summary/history fixtures cover active, completed,
blocked/conflicting, and legacy-only evidence, including history ordering and
its fixed maximum. Workspace authorization, current-state status, frontend
projection, backend type-check/build, frontend build, and `git diff --check`
passed.

The next smallest integration gap is an approval-gated product decision on
workspace-history retention and filtering beyond the fixed sanitized terminal
window; it must remain a read-only projection and preserve the current
legacy/v1 conflict rule.

## Phase 10 workspace release-history filtering and pagination — 2026-07-27

**Result: passed locally; read-only projection/UI only.**

The authoritative workspace-summary request now accepts bounded release-history
filters for terminal state, project display name, and one inclusive UTC time
window. Terminal history is sorted by actual terminal instant descending, then
by sanitized display fields for deterministic ties. Page size is limited to
eight entries (five by default). Pagination uses an opaque cursor containing
only a normalized filter key and bounded page offset; changing filters while
reusing a cursor, malformed cursors, malformed timestamps, incomplete/overlong
time windows, invalid states, and excessive page sizes all return the
sanitized `Invalid workspace release-history filters.` response.

Plan & Usage continues to use only `GET /api/projects/workspace-summary` for
the v1 totals and filtered history. It has project, terminal-state, and time
window controls with previous/next cursor navigation. The projection contains
only the previously approved history fields. Conflict evidence continues to
produce a single blocked history item and is never counted or displayed as a
completed release.

### Local evidence

Against the authenticated local Project-Tst evidence, a completed +
`Project-Tst` + July-2026 query returned exactly one item: candidate revision
7, short SHA `4ef8326a48c6`, and the sanitized completed lifecycle code.
Revision 6 remained rollback lineage only. An invalid `running` terminal-state
filter returned HTTP 400 with only the sanitized validation response.

An authenticated browser refresh and project-filter submission rendered the
same revision-7 result, issued a parameterized workspace-summary request, and
made no per-project current-state or standalone release-status request. React
development Strict Mode may duplicate the identical workspace request; it does
not create per-project polling. No database lifecycle, queue, Terraform,
deployment, rollback, or cloud action occurred.

Pure multi-project fixtures cover terminal-state/project/time filtering,
ordering, two-page cursor traversal without duplicates, legacy-only omission,
and conflict-as-blocked behavior. They also reject malformed/excessive filters
and cursor/filter mismatches. The workspace-summary/status/current-state
checks, frontend projection check/build, backend type-check/build, and
`git diff --check` passed.

The next smallest integration gap is a separately approved, read-only UI
decision on exposing a user-selected larger history window or export. It must
retain the current fixed maximum page size, sanitized fields, and single
workspace-summary request boundary.

### Keyset correction — 2026-07-27

The workspace release-history cursor no longer uses a filter-key plus page
offset. It now stores a versioned keyset cursor built from the normalized
filter fingerprint and the last emitted full sort tuple:
terminal timestamp, project display name, terminal state, candidate revision,
short source SHA, lifecycle code, and a non-sensitive deterministic final
tie-breaker derived from the originating project identity.

This fixes page drift when a newer terminal item is inserted between requests.
After page one is read, a later insertion ahead of that cursor no longer
duplicates or skips older already-ordered results on page two. Equal-timestamp
fixtures also paginate deterministically without duplicates.

Malformed cursors, unsupported cursor versions, and filter-mismatched cursors
continue to fail with the existing sanitized workspace-history validation
response. The request boundary, response fields, page-size limits, conflict as
a single blocked item, and legacy-only omission remain unchanged. No
deployment, queue, Terraform, rollback, or cloud mutation was added.

Focused workspace-summary pagination fixtures, the existing workspace-summary
authorization/status/current-state checks, frontend projection check, backend
type-check/build, frontend build, and `git diff --check` passed.

## Phase 10 normal Start handoff — 2026-07-28

**Result: passed in an isolated local runtime; default-off execution remains
unchanged outside the exact test scope.**

The eligible existing **Start deployment** action now follows the canonical
normal v1 path: it prepares (or reuses) the server-idempotent `release_only`
intent, then requests dispatch only for that intent's exact clean outbox. It
does not construct, start, or supervise a consumer. The existing backend
execution bridge remains the only caller of `dispatchExact(...)` and retains
its planning/execution gates, exact project/dev allowlists, authorization,
candidate/infrastructure checks, and terminal/malformed fail-closed behavior.

Both Project Overview and Pipeline use a local in-flight guard as well as the
existing server idempotency. A second click, request retry, refresh, or React
Strict Mode cannot create a second intent, outbox publication, or job. Existing
queued, running, completed, cancelled, and blocked release-lane states are
restored from current-state without calling prepare, dispatch, or legacy
automation. While a release is queued or running, both pages poll only
current-state; the standalone release-lane status endpoint remains unused by
the pages. Disabled or ineligible preparation still takes the unchanged legacy
fallback.

### Isolated authenticated runtime evidence

The disposable PostgreSQL/Redis supervised-runtime harness used a fresh
project, isolated Redis prefix, authenticated developer session, separately
spawned `normal-v1-release` consumer, and a production-shaped non-cloud mock
handler. A headless local Chrome session opened Project Overview, double-clicked
**Start deployment**, and recorded exactly one `POST .../release-lane/prepare`
and one `POST .../release-lane/dispatch`; it made no standalone status request.
The worker processed one deterministic frozen job once, the intent reached
`completed`, and a browser refresh displayed the completed release-lane state
from current-state with no `ProjectPipelineRun`. The harness also proved an
out-of-scope HTTP dispatch and queue job were rejected before ownership or
handler invocation, then observed idle, processing, terminal, stopping, and
stopped worker states. After SIGTERM, no active operation lease, cross-lane
owner, queue claim, Redis-prefix key, or worker/browser/Vite child process
remained.

Verification passed:

- normal planning/execution/status/current-state checks;
- isolated authenticated browser + PostgreSQL/Redis dispatcher/consumer proof;
- outbox pure and PostgreSQL/Redis dispatcher checks;
- consumer lifecycle; transactional planner pure and PostgreSQL checks;
- frontend release-lane UI check and frontend build;
- backend TypeScript check and backend build; and `git diff --check`.

This slice made no Project-Tst, database lifecycle outside disposable test
data, queue, Docker, ECR, ECS, Terraform, rollback, AWS, or cloud mutation.

The next smallest approval-gated gap is a controlled, exact-scope normal UI
canary using the real production handler, with the consumer independently
supervised and the existing bounded reconciliation/rollback rules retained.

## Live normal Start handoff canary — 2026-07-28

**Result: passed on the exact Project-Tst `dev` scope. ReleaseManifest revision
8 is stable; all temporary execution gates and processes are off.**

One harmless visible source change was committed and pushed to
`Hassan-Sajjad72/Project-Tst` `main`:

- immutable commit: `c5378654398618c5a1bcea2561c951036e59832e`;
- changed file: `app.py`;
- visible marker: `normal-ui-v8-2026-07-28`;
- the prior stable revision-7 commit remains its direct ancestor.

The authenticated browser re-ran the normal detection and preflight actions.
Detection, passing-with-warnings preflight, and the persisted deployment
contract all reference the exact new commit. Before publication, read-only
database and AWS checks proved applied InfrastructureManifest revision 4,
stable revision 7, the exact long-lived ECS service and cluster, current task
definition and ECR digest, 1/1 ECS service health, healthy target evidence, and
HTTP 200.

### Browser-to-consumer execution

Exactly one authenticated browser **Start deployment** action was used; neither
the prepare nor dispatch endpoint was invoked as a command-line substitute.
The resulting durable request evidence is one new `release_only` intent, one
desired candidate revision 8, and one outbox with one publication attempt and
one deterministic BullMQ job. The transient CDP request buffer did not survive
the subsequent page navigations, so the request count is backed by these
transactional planner/outbox records rather than a retained HAR. No
`ProjectPipelineRun` was created.

One repository-supervised production consumer was healthy before that action.
It acquired cross-lane ownership before the operation lease and performed
exactly one of each journaled mutation:

| Boundary | Durable/live result |
| --- | --- |
| Immutable image | One build/push journal, one immutable provenance row, exact ECR digest match. |
| Task definition | One succeeded registration journal and exact active task-definition match. |
| Existing service | One succeeded update journal against the existing service; no second service. |
| Initial rollout read | Failed closed with `RELEASE_EVIDENCE_AMBIGUOUS` during normal target overlap. |
| Convergence | Read-only ECR/ECS evidence proved the three mutations; the same failed deterministic job was retried without a second publication. |
| Promotion | The replay reused all three journals, completed the intent, promoted revision 8, and preserved revision 7 as rollback lineage. |
| Rollback | Not required and not invoked. |

Final live evidence proved the saved digest equals ECR and the task-definition
image digest, the exact ECS service is ACTIVE with the candidate PRIMARY
deployment completed at desired/running/pending `1/1/0`, one healthy ALB
target, and health/root HTTP 200. One prior target was still draining during
the first post-promotion read and was correctly not treated as candidate
failure. A fresh headless browser rendered the exact new visible marker.

### Corrected defects

Three narrowly scoped defects were found and fixed:

1. Planning and release execution followed at most one prior stable manifest
   when resolving the long-lived service identity. A shared bounded,
   cycle-safe resolver now walks only exact project, `dev`, and applied
   infrastructure lineage without rewriting historical evidence.
2. Overview and Pipeline treated every completed/cancelled v1 intent as a
   permanent Start blocker. Their shared predicate now blocks a terminal intent
   only when it represents the current deployment-contract commit; a genuinely
   new pinned commit remains eligible. Queued, running, blocked, and
   same-commit terminal evidence still fail closed.
3. The exact convergence service had the same shallow service-lineage
   assumption. It now uses the bounded resolver before its read-only AWS proof.
   A multi-hop fixture covers stable revisions whose service identity is held
   by an older preserved ancestor.

### Terminal state, product projection, and cleanup

The final durable state is:

- intent `completed`; revision 8 is the sole `stable` release and revision 7 is
  rollback lineage;
- outbox `published`, exactly one publication attempt, no claim, and no
  dispatchable terminal work;
- deterministic BullMQ job `completed` after the one bounded retry;
- three side-effect rows, all succeeded, and one immutable provenance row;
- zero active operation leases and zero active cross-lane owners;
- zero new legacy pipeline runs.

Authenticated current-state returns `completed`, stable revision 8, short SHA
`c53786543986`, the existing stable URL, and `activeRunCount: 0`.
Project Overview and Pipeline render that same stable revision and commit;
Plan & Usage contains revision 8 once as completed; Dashboard reports zero
active runs, one v1 stable release, and zero releases needing review. Browser
refreshes preserved these results without a fake legacy run.

The supervised consumer stopped on SIGTERM with exit code 0 and its container
was removed. The temporary backend, frontend, browser, credential mount, and
gate configuration were stopped or removed. No consumer process or temporary
listening port remains. PostgreSQL and Redis were left in their pre-existing
local service state. No Terraform, infrastructure replacement, second ECS
service, legacy pipeline, deletion, destroy, or unrelated project mutation
occurred.

### Verification

Passed checks include:

- normal planning, execution, status, current-state, and bounded convergence;
- outbox dispatcher unit and isolated PostgreSQL/Redis integration;
- inactive consumer unit and isolated PostgreSQL/Redis integration;
- consumer lifecycle and Compose supervision;
- operation-lease and cross-lane ownership PostgreSQL concurrency;
- ECS release handler/reconciliation and side-effect reconciliation
  PostgreSQL;
- frontend normal release-lane UI handoff and production build;
- backend TypeScript checking and backend build.

Evidence is classified as isolated for PostgreSQL/Redis concurrency suites,
local for authenticated browser/current-state and process cleanup, and live
AWS for ECR/ECS/ALB/HTTP/visible-marker verification.

The next smallest integration gap is to let the independently supervised
consumer schedule the same exact, default-off bounded convergence transition
after `RELEASE_EVIDENCE_AMBIGUOUS`. It must retain the existing exact failed
job, read-only ECR/ECS convergence, no-new-publication, and no-repeat-mutation
predicates.

## Automatic bounded normal-consumer convergence — 2026-07-28

**Result: passed in isolated PostgreSQL/Redis and local supervised-runtime
verification. The capability remains default-off; no Project-Tst or live AWS
operation occurred.**

`NormalReleaseLaneAutoConvergenceScheduler` is owned by the independently
supervised normal-v1 consumer lifecycle. It starts only when all of the
following exact values are present: consumer/planning/execution composition
gates, one UUID project allowlist, environment `dev`,
`TWO_LANE_NORMAL_RELEASE_OUTCOME_RECONCILE_APPROVED=true`, and
`TWO_LANE_NORMAL_RELEASE_AUTO_CONVERGENCE_ENABLED=true`. Missing, malformed,
broad, or disabled configuration leaves the consumer unchanged and the
scheduler disabled.

The scheduler never publishes an outbox event or creates a new job. It finds
only an exact `failed` `RELEASE_EVIDENCE_AMBIGUOUS` release-only intent with
one published zero-claim outbox, then delegates to the existing convergence
boundary. That boundary repeats durable validation of the exact candidate,
immutable provenance, exactly three succeeded side-effect journals, inactive
operation/cross-lane ownership, deterministic failed job, and read-only
ECR/ECS identity before retrying the same frozen BullMQ job.

Automatic retries are bounded by durable BullMQ attempt count and elapsed time
from the original job timestamp (defaults: two total attempts and ten minutes;
both have strict safe ranges). Exhaustion atomically records the sanitized
`NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED` terminal code without changing
the original journals, provenance, outbox publication, or external state.
Non-converged read-only evidence remains `reconciling` until that bound; no
timer can create an infinite mutation loop. A scheduler has one in-flight tick
per process, convergence uses its existing scoped transaction/advisory lock,
and the frozen job identity remains the sole logical execution identity across
duplicate observations and restart.

Current-state now distinguishes `reconciling` from queued/running and exposes
only `NORMAL_RELEASE_CONVERGENCE_RECONCILING`; Start remains blocked while it
is reconciling. Exhaustion is projected as the sanitized blocked terminal
state. The worker health file also reports `reconciling`, and SIGTERM/SIGINT
first clears scheduling intake, waits for any bounded read-only tick, then
stops the existing consumer, heartbeat, queue, and Redis connections.

Verification passed:

- scheduler disabled, resume, pending-read-only, bounded-exhaustion,
  duplicate-start, and shutdown checks, plus a second observation of an
  already-waiting frozen job proving no duplicate retry;
- isolated PostgreSQL/Redis frozen-consumer, dispatcher, operation-lease, and
  cross-lane ownership regressions;
- the supervised production-shaped fixture with mocked ECR/ECS convergence:
  one provenance row and exactly three succeeded journals survive the initial
  ambiguous terminal result, then the same job completes on its bounded retry
  with no second publication;
- release-lane status/current-state and frontend Start-blocking projection
  checks.

The isolated supervised fixture uses the authenticated prepare/dispatch HTTP
boundaries in its no-browser mode, then starts the consumer as an independent
child process. It proved one published deterministic job, the transient
`reconciling` current-state projection, two bounded executions, one completed
intent, and no remaining claim, lease, owner, Redis key, or child process. A
focused correction also gives terminal `RELEASE_EVIDENCE_AMBIGUOUS` precedence
over its historical `published` outbox, so that audit-preserving publication
cannot falsely present an ambiguous outcome as queued.

This evidence is isolated/local only. No Docker build, ECR push, ECS update,
rollback, Terraform, or live AWS read/write was performed for this slice.

The next smallest gap is an approval-gated, non-cloud operational soak of the
default-off scheduler under a real supervised process restart. It should use a
disposable project/database and Redis prefix, retain the same mocked
read-only convergence adapter, and prove stale-timer and duplicate-scheduler
cleanup without widening any production gate.

## Supervised automatic-convergence restart soak — 2026-07-28

**Result: passed with disposable PostgreSQL, Redis, authenticated local HTTP,
and two independently supervised consumer processes. No Project-Tst, AWS, or
cloud mutation was involved.**

The isolated fixture now starts its first consumer with the scheduler’s valid
maximum 60-second interval. After one prepared intent is dispatched, its first
mocked execution creates exactly one immutable provenance row and the three
succeeded mutation journals, then returns `RELEASE_EVIDENCE_AMBIGUOUS`. The
fixture observes sanitized current-state `reconciling`, verifies the one
published deterministic job is failed at attempt one, and stops that first
process before its next scheduler interval.

After a bounded wait, the stopped process has not retried the job: the intent
remains failed, the frozen job remains failed at attempt one, and no second
publication, journal, provenance, claim, lease, or owner exists. A replacement
supervised process starts under the same exact disposable project/dev gates but
with a valid one-second interval. It alone proves the mocked ECR/ECS identity,
resumes the same frozen job, and completes it at attempt two. The completed
state retains one outbox publication, one provenance record, and exactly three
succeeded mutation journals.

The convergence service now also serializes each exact job retry with a scoped
PostgreSQL advisory lock. A second process observing a job already returned to
`waiting` treats it as the same resumed transition rather than retrying it
again. Bounds are evaluated before a new read-only retry proof, so permanently
inconclusive evidence with an exhausted timestamp records only
`NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED`; it cannot leave a supervised
timer reconciling indefinitely. Runtime health now reports the last terminal
consumer outcome until a subsequent job begins, rather than immediately
masking it as idle.

Verification passed:

- no-browser authenticated prepare/dispatch plus PostgreSQL/Redis restart soak;
- first-process stopped, replacement ready/processing/terminal/stopped health
  observations, and final no-worker/no-Redis-key/no-lease/no-owner cleanup;
- scheduler default-off, duplicate start, pending-evidence, bounded exhaustion,
  and shutdown checks;
- convergence exact-job, duplicate waiting-job, and elapsed-bound checks;
- consumer lifecycle, supervision, dispatcher, inactive-consumer,
  release-lane status/current-state, TypeScript, backend-build, frontend UI,
  frontend-build, and diff checks.

Evidence is isolated/local only. The next smallest gap is to add this same
restart-soak scenario to the repository-owned Compose supervisor using the
existing non-cloud handler and disposable state; it must not widen a production
gate or dispatch a real project.

## Compose-supervised bounded-convergence restart soak — 2026-07-28

**Result: passed with disposable PostgreSQL and Redis, authenticated local
HTTP, and the repository-owned `normal-v1-release` Compose profile. This is
isolated/local evidence only; no Project-Tst, AWS, Docker image publication,
ECR, ECS, Terraform, or rollback action occurred.**

The Compose consumer now receives the existing bounded-convergence settings as
explicit default-off environment mappings. The restart fixture enables those
settings only for one generated project/dev scope and uses the existing
production-shaped non-cloud handler. It creates one intent through the
authenticated prepare route and publishes its sole pending outbox through the
authenticated exact-dispatch route.

The first healthy Compose container recorded one immutable provenance row and
exactly three succeeded mutation journals, then returned
`RELEASE_EVIDENCE_AMBIGUOUS`. Its health correctly projected `reconciling`
while the bounded scheduler was armed. After a graceful stop, the frozen job
remained failed at attempt one during the stale-container wait. The replacement
container alone resumed the same deterministic job under the existing advisory
lock and completed it at attempt two. There remained one outbox publication,
one provenance row, and the same three journals; no additional claim, lease,
cross-lane owner, timer, Redis key, or consumer container remained after final
teardown.

A focused health correction maps an ambiguous terminal worker outcome to
`reconciling` only while the exact default-off convergence scheduler is armed.
It does not schedule or repeat work; it makes the pending bounded read-only
transition truthful to Compose health observers. The existing scheduler
fixture separately proves permanently non-converging evidence reaches
`NORMAL_RELEASE_CONVERGENCE_BOUND_EXHAUSTED` without a loop.

Verification passed:

- `npm run test:normal-v1-release-compose-convergence-restart` (disposable
  Compose restart, authenticated prepare/dispatch, mock convergence, and
  cleanup);
- focused lifecycle, scheduler, convergence, dispatcher/consumer, ownership,
  current-state, and Compose-supervision regressions;
- backend TypeScript checking, backend build, and `git diff --check`.

The next smallest remaining gap is a separately approved, read-only operational
observation soak of the default-off Compose service with real non-mutating
runtime configuration. It must not dispatch a project or contact cloud release
clients.

## Default-off local Compose operational-observation soak — 2026-07-28

**Result: passed as local read-only evidence. No isolated execution fixture,
Project-Tst lifecycle mutation, queue activity, or AWS operation occurred.**

The repository-owned `normal-v1-release` Compose profile was started against
the existing local PostgreSQL and Redis services with consumer, planning,
execution, production-client, ownership, reconciliation, and auto-convergence
gates explicitly disabled. The service followed its documented disabled
contract twice: it wrote the sanitized
`NORMAL_V1_RELEASE_CONSUMER_DISABLED` health record, exited with code zero,
and had restart count zero. A bounded observation interval and a Compose
restart produced the same truthful disabled status. The existing health status
and liveness commands, invoked with the service status-file path, returned only
the schema version, disabled state, liveness/readiness booleans, safe code, and
timestamp.

Because the disabled contract intentionally leaves no running worker, SIGUSR1
is not safely deliverable and was not used to force a process into existence.
Status collection is the applicable observation boundary for this mode.
The final Compose removal left no consumer container or Redis client. Before
and after snapshots matched: zero queue claims, active operation leases, and
cross-lane owners; no nonterminal intent; unchanged stable-release evidence;
and unchanged Redis key count. The worker logs contained only framework startup
messages and the sanitized disabled status—no project, intent, queue payload,
fencing, credential, or cloud identifier.

Verification passed:

- real local disabled-profile startup, bounded status soak, Compose restart,
  final removal, and database/Redis invariance checks;
- `npm run test:normal-v1-release-consumer-supervision`;
- `npm run test:normal-v1-release-consumer-lifecycle` and
  `npm run test:normal-release-auto-convergence`;
- backend TypeScript check, backend build, and `git diff --check`.

This closes the remaining Phase 10 operational-observation gap. No further
Phase 10 integration work is required for the proven default-off normal-v1
consumer lifecycle; any future live-scope activation remains separately
approval-gated.

## Default-off normal first-release planning bridge — 2026-07-28

**Result: passed with focused fixture and isolated PostgreSQL planner evidence.
This is local-only planning evidence; no queue publication, Terraform, Docker,
AWS, or release execution occurred.**

The authenticated normal `Start deployment` route now first evaluates
`NormalFirstReleaseLanePlanningService`. It applies only to a genuinely new
project in the single configured `dev` scope: there must be no applied
infrastructure manifest, stable release, active legacy run, or conflicting v1
intent. The bridge is default-off unless
`TWO_LANE_NORMAL_FIRST_RELEASE_PLANNING_ENABLED=true` and both existing
single-value project and `dev` allowlists match exactly. Any other project,
environment, actor, stale deployment contract/preflight, active legacy work,
or immutable-evidence conflict fails closed and preserves the legacy fallback.

The bridge calls the canonical `TransactionalDeploymentPlannerService` once
with the frozen source commit and server-derived idempotency identity. Its
normal first-release result remains the existing truthful contract: one desired
InfrastructureManifest, one immutable InitialReleaseDraft, one planned
infrastructure-change intent, and one clean pending outbox. It deliberately
does not create a ReleaseManifest before immutable image provenance exists. It
does not dispatch the outbox, acquire execution ownership, run Terraform, or
construct any execution/cloud client.

`NormalReleaseLaneStatusService` now projects that canonical draft through the
same current-state field as later releases. It reports
`FIRST_RELEASE_INTENT_PREPARED`, the desired infrastructure revision and the
short pinned source SHA, while intentionally showing no candidate
ReleaseManifest revision. Project Details and Pipeline restore this state on
refresh. A first-release prepare response stops before `dispatchExact()` and
shows “First release foundation prepared; infrastructure execution is not
enabled”; the existing later-release prepare-to-dispatch behavior is unchanged.

Files added or changed for this slice:

- `backend/src/orchestration-contracts/release-lane/normal-first-release-lane-planning.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/src/projects/projects.controller.ts`
- `backend/src/orchestration-contracts/release-lane/normal-release-lane-status.service.ts`
- `backend/scripts/verify-normal-first-release-lane-planning.ts`
- `frontend/src/pages/ProjectDetails.jsx`
- `frontend/src/pages/ProjectPipeline.jsx`
- `frontend/scripts/verify-normal-release-lane-ui.mjs`

Verification passed:

- `npm run test:normal-first-release-lane-planning` — disabled/default-off,
  exact gate, canonical planner input, replay, immutable conflict, existing
  foundation exclusion, and static no-execution dependency boundary.
- `npm run test:normal-release-lane-status` — first-release prepared
  current-state projection alongside existing later-release lifecycle cases.
- `npm run test:transactional-planner:postgres` — disposable PostgreSQL
  serializable initial-planning concurrency and rollback/atomicity coverage for
  the canonical planner contract.
- `npm run test:normal-release-lane-ui` and frontend build — both pages use the
  existing current-state projection and do not dispatch a first release.

The next smallest approval-gated gap is not normal release execution: it is a
separate, explicitly approved bridge from a planned first-release foundation to
the existing infrastructure planning/apply lifecycle. It must retain the
immutable draft, run no release action until applied infrastructure and durable
image provenance exist, and must not be enabled by this planning-only slice.

## First-release infrastructure execution assessment — 2026-07-28

**Result: blocked before dispatch; no runtime, database, queue, Terraform, or
cloud mutation occurred.**

The prepared normal first-release record is correctly an
`infrastructure_change` intent. For a `deploy` request the canonical planner
emits its one pending outbox as `intent.infrastructure.plan` on
`deployguard-infrastructure-v1`; it does not emit an apply message. This is
the correct existing planning contract and must not be reinterpreted by the UI
or a release consumer.

The repository currently has no compatible normal infrastructure consumer:

- `NormalV1ReleaseConsumerRuntimeService` registers only the `release` role
  and `intent.release.execute` message type.
- The inactive release composition substitutes a real handler only for
  `intent.release.execute`; both infrastructure message types remain fenced
  placeholders.
- `V1InfrastructureManifestApplyService` is an explicit one-shot canary
  apply service, gated to a saved remote 25-resource plan and its own canary
  ownership contract. It is not a generic fenced consumer handler and cannot
  safely consume the first-release planner outbox.

Consequently, exposing an authenticated `dispatchExact()` boundary now would
publish a deterministic infrastructure job that no production-compatible
worker can truthfully execute. Treating the placeholder's success outcome as
Terraform completion would violate the manifest, terminal-outbox, and
reconciliation contracts. The requested apply/reconcile and current-state
running/applied states are therefore intentionally not wired in this package.

The exact next bounded task is to implement an inactive, infrastructure-only
v1 worker composition and fenced handler for `intent.infrastructure.plan`,
then separately define its transition to an approved apply message. It must
adapt—not bypass—the existing manifest plan/apply, ownership, state-lock,
side-effect journal, terminal-outbox, and reconciliation services. Only after
isolated PostgreSQL/Redis proof of that handler may an authenticated exact
first-release infrastructure-dispatch boundary be added.

## Infrastructure-only planning worker contract audit — 2026-07-28

**Result: implementation blocked before a worker, outbox publication, or
Terraform operation was added. Evidence is source-only; there is no isolated,
local runtime, or live AWS execution evidence for this package.**

The required infrastructure-only worker cannot safely be assembled from the
current contracts yet:

1. `InactiveV1BullMqConsumerService` is structurally generic enough to validate
   an infrastructure envelope, but its operational state and normal supervised
   runtime are explicitly release-only (`activeMessageType` and capability are
   `intent.release.execute`). The normal composition only replaces the release
   placeholder handler; `intent.infrastructure.plan` and
   `intent.infrastructure.apply` remain placeholder-success handlers.
2. `V1InfrastructureManifestPlanService` correctly owns a serializable,
   advisory-locked plan lifecycle and saved-plan replay. It is an explicit
   service, however, not a fenced invocation handler. It has no bridge that
   validates the worker's operation/cross-lane fences before its plan write or
   records a handler-side plan journal under those fences.
3. More importantly, `InactiveV1FencedInvocationService` finalizes every
   handler `success` as terminal intent completion and applies the canonical
   terminal-outbox policy. There is no existing fenced nonterminal
   `plan_completed` outcome, child apply intent, or transactional apply-ready
   transition. Therefore a new `intent.infrastructure.apply` outbox written by
   a successful plan handler would either be closed by terminal finalization or
   leave the original intent falsely completed before apply approval.

Those facts make an implementation that merely registers a plan handler unsafe:
it could publish a job with a placeholder success, terminalize a foundation
before it is applied, or create an apply message whose durable lifecycle has no
owner. No such code was added.

The exact next bounded prerequisite is to freeze and implement one fenced
nonterminal infrastructure-plan completion contract. It must atomically retain
the original intent and immutable draft, persist a plan journal and saved-plan
identity, and create either (a) one linked, approval-required apply intent with
its own deterministic outbox or (b) a validated apply-ready record that cannot
be terminal-outbox-closed. Only then can an infrastructure-only consumer and
the authenticated exact-plan dispatch boundary be implemented and proven with
PostgreSQL/Redis fixtures.

## `plan_completed` status foundation — 2026-07-28

**Result: implemented and verified on disposable PostgreSQL. This package is
schema/domain-only; it produced no local runtime execution and no live AWS
evidence.**

Migration `1760000049000` additively expands only
`CHK_deployment_intent_status` to accept `plan_completed`. The TypeScript
`DeploymentIntentStatus` union and entity metadata use the same value. Existing
status values and rows are preserved. Rollback first refuses to narrow the
constraint while any `plan_completed` history exists; after that evidence is
absent it restores the exact prior status constraint.

Focused verification proved representative rows for every prior status remain
byte-for-byte unchanged across migration up/down, `plan_completed` is accepted
only after migration up, unrelated values remain rejected, and rollback
restores rejection of the new value. Backend type-check and build also pass.
Type-check also exposed and corrected an unmatched union delimiter left by the
previous reverted experiment; this was a syntax restoration only and did not
add a fenced outcome or change invocation behavior.

No service can transition to `plan_completed` yet. Ownership completion and
release, terminal-outbox policy, fenced invocation, planner, consumers,
dispatcher, handlers, status/current-state, and UI behavior were not changed.

The next smallest gap is the isolated serializable plan-completion continuation
service: it must validate the existing fences and saved-plan identity, move one
parent into `plan_completed`, and create one deterministic approval-required
apply continuation without publishing it.

## Isolated infrastructure plan-completion continuation — 2026-07-28

**Result: implemented and verified with disposable PostgreSQL. Evidence is
isolated/local only; no live AWS evidence exists and no Project-Tst state was
read or changed.**

`InfrastructurePlanCompletionContinuationService` is a new inactive,
serializable boundary dedicated to a delivered `intent.infrastructure.plan`
operation. It does not replace or alter the existing terminal
`ownership.complete()` or retry-oriented `ownership.release()` behavior.
Nothing calls the service from a worker, consumer, dispatcher, controller, or
Terraform path in this package.

In one transaction the service locks and revalidates the parent
`infrastructure_change` intent, immutable planner identity, exact desired
InfrastructureManifest, InitialReleaseDraft and its canonical hash, saved plan
hash/input identity, published deterministic plan outbox, active infrastructure
operation lease, and independently fenced v1 cross-lane ownership. A successful
transition:

- moves only the parent intent from `running` to nonterminal
  `plan_completed`, leaving `completed_at` empty;
- preserves the planned/unapplied InfrastructureManifest, saved plan, immutable
  InitialReleaseDraft, and original published plan outbox unchanged;
- creates or reuses one deterministic `apply` DeploymentIntent in `planned`
  state whose decision explicitly requires approval;
- creates or reuses one clean, zero-attempt, unclaimed and unpublished
  `intent.infrastructure.apply` outbox;
- releases the exact operation lease and the separate cross-lane ownership
  lease using their respective identities and fencing tokens.

The existing terminal-outbox policy remains unchanged. It reports the
`plan_completed` parent as non-dispatchable and the planned child as
dispatchable, so it does not dead-letter the apply continuation. Actual
approval and dispatch remain absent.

The read-only `NormalReleaseLaneStatusService` now distinguishes the original
first-release infrastructure planning preparation from completed planning. A
valid parent/child/outbox tuple remains a nonterminal prepared projection with
safe code `FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL` and sanitized
`infrastructurePlanning` evidence showing `planState: completed` and
`applyState: awaiting_approval`. Missing, duplicated, claimed, published, or
otherwise inconsistent continuation evidence is blocked. No execution control
or parallel endpoint was added.

Focused verification passed:

- `test:infrastructure-plan-continuation:postgres`: concurrent duplicate
  completion converged on one child and one apply outbox; replay returned the
  same identities; stale operation fencing, changed saved-plan hash, changed
  draft evidence, and a terminal parent failed without partial rows; exact
  leases were released; manifest/draft/published-outbox evidence remained
  unchanged.
- terminal-outbox assertions proved the parent cannot be dispatched again and
  the child remains pending rather than being terminalized.
- `test:inactive-v1-ownership` and
  `test:inactive-v1-ownership:postgres`, `test:outbox-dispatcher`,
  `test:normal-release-lane-status`,
  `test:normal-release-lane-current-state`,
  `test:plan-completed-status:postgres`, and
  `test:two-lane-migrations:postgres`.
- backend TypeScript checking and backend build.

Redis execution was not required because this package creates no queue
connection, publication, worker, or claim. Live AWS verification was not
executed and is not applicable. No Terraform plan/apply, Docker, ECR, ECS,
release record, rollback, deletion, or legacy deployment path was reachable.

No schema defect was discovered: the existing intent, outbox, lease,
ownership, manifest, draft, and saved-plan columns represent the continuation
without another migration or abstraction.

The next smallest gap is the inactive infrastructure-plan worker integration:
consume only `intent.infrastructure.plan`, execute or reconcile the canonical
plan once under both fences, and invoke this continuation only after durable
saved-plan evidence exists. Authenticated plan dispatch and infrastructure
apply remain later, separately approval-gated packages.

## Inactive infrastructure plan-only consumer — 2026-07-28

**Result: implemented and verified in focused isolated/local checks. No live
AWS evidence was collected or expected.**

`NormalV1InfrastructurePlanConsumerRuntimeService` and its dedicated worker
entry point (`npm run worker:normal-v1-infrastructure-plan`) form a separate,
default-off consumer role. It accepts exactly one configured project, the
`dev` environment, `deployguard-infrastructure-v1`, and the one frozen message
`intent.infrastructure.plan`. The existing release consumer, release handler,
and release composition were not broadened. A capability with an apply, release,
malformed, broad, or out-of-scope route is rejected before cross-lane ownership
or handler invocation.

The handler adapts `V1InfrastructureManifestPlanService`; it does not re-create
Terraform planning. It validates the running infrastructure parent, desired
unapplied manifest, immutable draft hash, frozen delivered plan outbox, and
envelope identity. It records `infrastructure_terraform_plan` through the
existing fenced side-effect journal, reuses saved planned evidence when it is
already durable, and treats missing/in-progress evidence as reconciliation or
failure instead of blindly regenerating a plan. On success it emits only the
typed `plan_completed` outcome. The generic fenced invocation then calls the
verified continuation service, which transitions the parent to
`plan_completed`, releases both exact fences, and creates one deterministic,
clean `intent.infrastructure.apply` continuation. The normal terminal success
finalizer is deliberately bypassed for this nonterminal boundary.

The runtime requires all existing exact ownership gates plus
`TWO_LANE_NORMAL_INFRASTRUCTURE_PLAN_CONSUMER_ENABLED=true`, the existing
single project/dev allowlists, and a valid
`TWO_LANE_INFRASTRUCTURE_WORKER_ID`. Its status is sanitized through the
dedicated health-file convention; it contains no project, intent, payload,
fence, journal, or cloud identifier. Disabled or malformed configuration starts
no worker.

Focused verification passed:

- `test:inactive-v1-infrastructure-plan-handler`: frozen successful plan route
  produced the typed continuation evidence once; an invalid operation failed
  before invoking the planner.
- `test:inactive-v1-consumer`: the sole partial consumer contract accepts only
  infrastructure plan and rejects a release partial role.
- `test:infrastructure-plan-continuation:postgres`: serializable duplicate,
  stale-fence, immutable-evidence, child/outbox and exact-release assertions
  passed on disposable PostgreSQL.
- `test:v1-infrastructure-plan:postgres`,
  `test:inactive-v1-invocation`, `test:inactive-v1-consumer:integration`, and
  `test:normal-release-lane-current-state` passed; the Redis integration is
  isolated and uses no cloud client.
- backend `tsc --noEmit`, backend build, and `git diff --check` passed.

No authenticated infrastructure dispatch route, apply consumer, Terraform
apply, release creation, Docker/ECR/ECS action, queue publication, Project-Tst
read/write, or AWS call occurred. The next smallest approval-gated package is
authenticated exact plan dispatch followed later by a separately gated,
supervised infrastructure-apply worker.

## Authenticated first-release infrastructure-plan dispatch — 2026-07-29

**Result: implemented as a default-off exact dispatch boundary. Verification is
isolated/local only; no Project-Tst or live AWS resource was read or changed.**

`POST /api/projects/:projectId/release-lane/infrastructure-plan/dispatch` is
the sole new authenticated boundary. It uses the existing authenticated-user
middleware and admin/developer guard, then independently verifies project
ownership. `NormalFirstReleaseInfrastructurePlanExecutionService` requires both
the normal first-release planning gate and the new exact infrastructure-plan
execution gate, one UUID allowlist entry, and `dev` only.

It selects no broad pending work. Before calling `dispatchExact()` it requires
exactly one planned `infrastructure_change` deploy parent, no ReleaseManifest,
a desired/unapplied matching InfrastructureManifest, one canonical immutable
InitialReleaseDraft, and one clean zero-attempt unclaimed
`intent.infrastructure.plan` outbox with a frozen matching envelope. Terminal,
malformed, already-published, cross-project, read-only, and out-of-scope input
returns a sanitized blocked result without publication. The endpoint neither
starts a consumer nor invokes Terraform directly.

The independently supervised plan-only consumer remains responsible for the
subsequent fenced ownership/lease acquisition, canonical plan lifecycle, saved
plan journal, and `plan_completed` continuation. Durable completion restores
the existing `FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL` current-state
projection; the child `intent.infrastructure.apply` outbox remains clean and
undispatched. No apply endpoint, worker, UI execution button, release record,
or legacy behavior was added.

Focused verification passed:

- `test:normal-first-release-infrastructure-plan-execution`: disabled gate,
  exact dispatch target, dispatcher block/replay, malformed evidence, route
  middleware registration, and static no-runner/no-Terraform guard.
- existing isolated `test:inactive-v1-consumer:integration`,
  `test:inactive-v1-infrastructure-plan-handler`,
  `test:v1-infrastructure-plan:postgres`, and
  `test:infrastructure-plan-continuation:postgres` retain the real generic
  consumer/Redis, canonical plan, and serializable continuation evidence.
- `test:normal-release-lane-status`,
  `test:normal-release-lane-current-state`, backend `tsc --noEmit`, backend
  build, and `git diff --check` passed.

## Combined first-release infrastructure planning workflow — 2026-07-29

**Result: passed in one disposable local PostgreSQL/Redis process fixture. No
Project-Tst, live AWS, or infrastructure mutation was involved.**

`test:normal-first-release-infrastructure-plan-supervised-runtime` now creates
one isolated first-release project, its passing pinned deployment contract,
one desired/unapplied InfrastructureManifest, immutable InitialReleaseDraft,
planned infrastructure parent, and clean `intent.infrastructure.plan` outbox
through the normal authenticated preparation boundary. It starts a real local
HTTP application and the independent `normal-v1-infrastructure-plan` worker
process with temporary exact project/`dev`, ownership, planning, and execution
gates only.

The authenticated exact dispatch route published one deterministic frozen
BullMQ plan job. A duplicate request did not publish another job. The worker
ran the canonical local-mock Terraform plan lifecycle (offline local state,
no AWS provider call), persisted one immutable plan and one succeeded
`infrastructure_terraform_plan` journal, then used the fenced continuation to
leave the parent `plan_completed`, create exactly one approval-required apply
child and one clean, zero-attempt `intent.infrastructure.apply` outbox. The
manifest remained unapplied and the InitialReleaseDraft was unchanged.

The fixture also proved an unauthenticated request receives `401`; a valid
session outside the exact project scope receives a sanitized blocked result;
neither case publishes. Repeated dispatch after completion cannot republish
the original plan outbox. Authenticated current-state returned
`FIRST_RELEASE_INFRASTRUCTURE_APPLY_AWAITING_APPROVAL` after durable
completion. Shutdown left zero active operation leases, cross-lane owners, and
outbox claims; the worker exited naturally, its output remained sanitized, and
the isolated Redis prefix was empty after queue cleanup.

Focused verification passed:

- `test:normal-first-release-infrastructure-plan-supervised-runtime`;
- `test:normal-first-release-infrastructure-plan-execution`,
  `test:inactive-v1-infrastructure-plan-handler`,
  `test:inactive-v1-consumer:integration`,
  `test:infrastructure-plan-continuation:postgres`, and
  `test:normal-release-lane-current-state`;
- backend TypeScript checking/build, frontend build, and `git diff --check`.

Evidence classification: the combined runtime proof is isolated/local only;
no live AWS evidence was requested or collected. No Terraform apply, release
creation, Docker/ECR/ECS action, legacy pipeline, rollback, deletion, or apply
outbox dispatch occurred. The next smallest separately approval-gated gap is a
supervised `intent.infrastructure.apply` execution boundary and its first live
infrastructure proof.

## Default-off infrastructure apply boundary — 2026-07-29

**Result: passed in one disposable supervised PostgreSQL/Redis workflow. No
AWS or Project-Tst operation occurred.**

The normal lane now has a separate exact
`POST /api/projects/:projectId/release-lane/infrastructure-apply/dispatch`
boundary and a dedicated `normal-v1-infrastructure-apply` consumer role. Both
require independent default-off apply gates, a single project/`dev` allowlist,
and the existing ownership gates. They accept only
`intent.infrastructure.apply` from `deployguard-infrastructure-v1`; neither
the release nor plan worker was broadened.

The apply handler validates the approval-required apply child, its historical
`plan_completed` parent, immutable draft, planned/unapplied manifest, saved
plan hash, and matching published frozen job before recording the exact
`infrastructure_terraform_apply` side effect. It calls the existing
`V1InfrastructureManifestApplyService` through a fenced invocation entry point
and then uses the existing normal completion path for the apply child. The
parent stays historical and the draft is retained. Current-state now has safe
codes for apply queued/running and for applied infrastructure awaiting the
separate first-release execution.

The deterministic local Terraform state/output adapter is injectable only at
the apply-service boundary. It durably records a plan-hash/input-identity
matched state lineage and sanitized output hash, replays the same evidence for
the same immutable plan, and rejects a changed hash without overwriting state.
The normal S3/AWS branch remains the existing real Terraform state client and
is not bypassed or modified by the fixture mode.

The combined disposable fixture starts the real authenticated HTTP app, runs
the planning worker through `plan_completed`, stops it, starts the independent
apply worker, and dispatches the one exact apply outbox. It proved one
deterministic apply job, one succeeded apply journal, an applied manifest with
truthful local state/output evidence, a completed apply child, preserved parent
and draft, no duplicate dispatch, and the current-state code
`FIRST_RELEASE_INFRASTRUCTURE_APPLIED_RELEASE_AWAITING_EXECUTION`. Both workers
exit cleanly and the isolated queue prefix is removed at teardown.

Focused checks passed:

- `test:normal-first-release-infrastructure-apply-execution`;
- `test:inactive-v1-infrastructure-apply-handler`;
- `test:deterministic-local-infrastructure-apply-state` and
  `test:normal-first-release-infrastructure-apply-supervised-runtime`;
- `test:normal-release-lane-current-state`, backend type-check/build, frontend
  build, and `git diff --check`.

The uncertain apply lifecycle is now apply-specific and nonterminal. A handler
outcome of `apply_reconciliation_required` is accepted only for
`intent.infrastructure.apply`; it releases the exact operation lease instead
of terminalizing the child, allowing the frozen published job to be reclaimed.
The deterministic fixture writes durable state, reports one ambiguous response,
and on the next claim verifies the exact plan/input identity from that state,
marks the existing uncertain apply journal succeeded, persists the applied
manifest, and completes the same child without another apply invocation. Other
message types retain their prior terminal finalization behavior.

Focused uncertain verification passed through
`test:normal-first-release-infrastructure-apply-uncertain-runtime`; it uses the
same disposable PostgreSQL/Redis/HTTP/worker fixture, proves the parent and
draft remain unchanged, and tears down all worker, queue, lease, ownership, and
Redis state. Invalid or changed identity remains fail-closed.

Live AWS evidence remains none. No ReleaseManifest, Docker/ECR/ECS operation,
rollback, legacy pipeline, Terraform destroy, or live Terraform apply was
reached. The next separately approval-gated gap is one bounded live
first-release Terraform apply using the verified remote-state contract, then
the first ECS release execution.

## Bounded live first-release eligibility check — 2026-07-29

**Result: blocked before mutation by contradictory Project-Tst lifecycle
identity. No gate, queue, database lifecycle, Terraform, or AWS mutation
occurred.**

The controlled database contains two `dev` projects for the approved
Project-Tst repository, but neither is an eligible normal first release:

- the historical Project-Tst record has no v1 manifest/intent/draft chain, but
  it has a completed legacy pipeline run, stale deployment-contract/preflight
  source evidence, and existing remote-state history under its project scope;
- the fresh Project-Tst Canary record already has applied InfrastructureManifest
  revision 4, a long-lived healthy ECS service, and stable ReleaseManifest
  revision 8 after multiple completed normal-v1 releases.

Consequently, there is no unique parent `infrastructure_change` intent,
`plan_completed` apply child, desired/unapplied InfrastructureManifest,
immutable InitialReleaseDraft, saved live Terraform plan, and clean
`intent.infrastructure.apply` outbox that can satisfy the approved
first-release apply contract. Preparing the historical record would also risk
adopting or colliding with pre-existing state and would contradict the frozen
new-project classification. Reusing the canary would be a later release, not a
first release.

Read-only local and live checks established:

- PostgreSQL and Redis were reachable; there were zero active operation leases,
  zero active cross-lane owners, and zero outbox claims.
- The canary revision-4 S3 state object exists, is encrypted, has the exact
  durable version identity, has no active native lock, and its sanitized output
  hash is present.
- The existing canary ECS service is active at desired/running `1/1`, with zero
  pending tasks, one deployment, one healthy ALB target, immutable ECR history,
  and HTTP `200` at the stored health path.
- The historical project scope has existing remote-state versions, so it is
  not a collision-free new state scope.

The required safe action was therefore to stop at the contradictory identity
gate. The infrastructure apply consumer was not started, neither exact outbox
boundary was called, no plan was regenerated, and the release lane was not
entered. Focused apply/release and build checks were not executed because no
implementation changed and the live workflow was ineligible before its
pre-mutation boundary; `git diff --check` remained the only relevant repository
check.

The next step is not legacy-path retirement. It requires an explicit product
decision selecting a genuinely new, collision-free project identity and fresh
state key for a first-release proof, or re-scoping the requested operation as a
later release of the existing canary. Either path needs a new exact approval;
the present first-release approval cannot truthfully authorize it.

## Smart Retail Pro first-release qualification — 2026-07-29

**Result: blocked before first-release planning by a verified normal-v1
managed-database foundation gap.** This qualification made no queue, worker,
Terraform, AWS, release, or other cloud mutation.

The approved public source `232378taniakhawar/smart-retail-pro` was pinned at
`b91850a6e90d24a6f5fce3863b1930b2a0e6972b` on `main`. A clean local contract
check passed: dependency installation and the production build succeeded; the
application initialized its supplied schema against a disposable PostgreSQL
service over Docker service DNS (not `localhost`); the root endpoint returned
HTTP 200; and a database-backed registration operation succeeded. The
disposable containers, network, database, and ephemeral values were removed.
The repository has no explicit health route, so `/` is its currently truthful
root-health fallback.

One new normal authenticated project was created through the existing workflow
(sanitized identity prefix `5a294142`), after confirming no existing
DeployGuard project used this repository. Detection persisted the pinned commit
and classified the application as Next.js with PostgreSQL required. The normal
deployment-requirements resolver selected the existing managed PostgreSQL
contract, generated a fresh encrypted JWT-secret reference, and produced a
passing preflight with only non-blocking warnings (no Node pin and no explicit
health route). The supplied provisional database password and JWT secret were
not used, logged, or persisted. A deployed configuration must use the managed
database's internal endpoint and generated secret reference; it cannot retain
the provisional `localhost` database host.

The blocker is in the normal v1 infrastructure planning implementation, not in
source qualification. `V1InfrastructureManifestPlanService` deliberately
rejects every manifest whose database mode is not `none` (and also rejects the
Cloud Map discovery needed by the managed-database contract), with the
stateless-foundation error at its input-validation boundary. The normal
first-release planner correctly derives `database.mode = managed` for this
repository, so an infrastructure-plan job would fail before a truthful plan
could be saved. It would be unsafe to bypass that check, claim a database-free
topology, or retain a local-only host value.

Durable local verification after the stop point found zero deployment intents,
InfrastructureManifests, InitialReleaseDrafts, outbox rows, active operation
leases, and active cross-lane owners for the fresh project. All normal-v1 gates
remained unset/default-off. Live AWS evidence is **none**; Terraform planning
or apply, ECR/ECS work, and release execution were not attempted. No code was
changed in this qualification; `git diff --check` passed against the existing
worktree.

The next smallest gap is a separately approved, bounded implementation of a
managed-PostgreSQL-aware normal-v1 infrastructure planning and apply contract:
it must plan and validate the required database, discovery, secret-reference,
state, output, and cost/policy evidence rather than relying on the stateless
canary assumptions. After isolated verification, a new exact approval would be
required for any live plan, apply, and first ECS release.

## Smart Retail Pro managed PostgreSQL normal-v1 foundation — 2026-07-29

**Result: implemented and verified with disposable local PostgreSQL/Redis only.**
No Smart Retail Pro durable row, AWS resource, Terraform remote plan/apply,
Docker image, ECR, ECS, release, queue outside the disposable prefix, or cloud
client was used.

The normal infrastructure planner now accepts only a managed PostgreSQL
contract backed by the persisted database-tier identity. It binds the immutable
tier revision, PostgreSQL engine, internal host, database name/user,
persistence/backup requirements, private discovery namespace, and safe secret
*references* into the manifest plan identity. It rejects malformed secret
references, a changed tier revision, absent private networking/discovery,
unsupported engine, and stateless/managed evidence mismatch. Terraform variables
contain logical references only; the plan artifact records deferred-cost policy
evidence (`COST_ESTIMATE_DEFERRED`) rather than a fabricated price. No password
or JWT value is read from the project or emitted into plan, journal, output, or
log evidence.

The local deterministic state adapter now produces only sanitized managed
database output identities (internal host, port, discovery/security and secret
reference identifiers). The fenced apply service validates those outputs before
marking a manifest applied; uncertain state remains reconcilable rather than
causing a repeat apply. The Terraform foundation enables the infrastructure-
owned database service independently of the later application ECS service, so
the first release remains release-independent.

The combined supervised fixture used a fresh disposable project and isolated
Redis prefix. It authenticated normal first-release preparation and exact plan
dispatch, consumed one frozen plan job, saved one immutable plan, reached
`plan_completed`, produced one approval-required apply child/outbox, then
independently consumed the exact apply message through the deterministic state
adapter. It left the draft unchanged, recorded one truthful apply outcome, and
restored the expected durable apply/pending-first-release projection. Duplicate
dispatch/delivery and the uncertain-apply reconciliation fixture reused durable
identity and did not create a second plan or apply effect. All child processes,
temporary databases, queue state, claims, operation leases, and cross-lane
ownership were gone after teardown.

Two directly exposed defects were corrected: the plan continuation used the
envelope payload hash where the immutable planner request fingerprint was
required, and the separately supervised apply consumer attempted to interpret
its fenced BullMQ session as an operational status object. The consumer now
uses the same typed lifecycle contract as the plan worker. The frozen consumer
validator also permits the separately gated exact apply message, while retaining
the complete infrastructure queue contract for unscoped consumers.

Focused verification passed: managed and stateless supervised plan/apply
fixtures, plan continuation PostgreSQL concurrency, deterministic local apply
state, plan/apply handlers, uncertain reconciliation, frozen consumer contract,
backend type-check/build, Terraform format/validation, frontend build, and
`git diff --check`. Evidence is **isolated/local only**; live AWS evidence is
**none**.

The next smallest approval-gated gap is a bounded remote Smart Retail Pro
Terraform plan review, followed separately by an exact live infrastructure
apply and then the first release. Those actions require new approval and must
not reuse this local fixture as cloud evidence.

## Smart Retail Pro remote-plan attempt — 2026-07-29

**Result: blocked safely before AWS access, Terraform initialization, worker
startup, outbox publication, or durable lifecycle mutation.** The exact fresh
Smart Retail Pro project (sanitized prefix `5a294142`) remains a valid new
project: its deployment contract and detection both pin
`b91850a6e90d24a6f5fce3863b1930b2a0e6972b`, its preflight is passing and bound
to that contract hash, and its managed PostgreSQL tier is persisted with
PostgreSQL/managed/persistent/backup/TLS evidence. It has zero active operation
leases, release-lane owners, or outbox claims.

The durable project has **zero** InfrastructureManifest revisions,
DeploymentIntents, InitialReleaseDrafts, and orchestration outboxes. Therefore
there is no exact desired S3-backed manifest, frozen parent, immutable draft,
or clean `intent.infrastructure.plan` message that the authenticated exact
dispatch boundary may legally publish. Creating those records is the separate
normal first-release preparation transition and was not silently substituted
for this remote-plan request.

In addition, the runtime environment loaded by the backend has none of the
exact remote-plan gates or identity settings required by the existing
fail-closed plan service: remote-plan enablement, deferred-cost acknowledgement,
the exact project/dev canary scope, expected AWS account, and Terraform state
bucket/region configuration. No other repository-controlled environment source
contains an alternate approved mapping. Since the manifest/state key does not
exist and the service refuses remote planning without those exact values, AWS
collision/state inspection would be both incomplete and unauthorized by the
frozen implementation.

Consequently, live AWS/read-only planning evidence is **none**; isolated/local
managed-database evidence remains the prior passing fixture evidence. No
Project-Tst scope was read or changed. The precise next approval must authorize
the normal first-release preparation for this project **and** supply the exact
approved remote-state/account/region configuration (without committing it),
after which the bounded worker/dispatch remote-plan operation can be run once.

## Smart Retail Pro remote first-release plan — 2026-07-29

**Result: Terraform planning succeeded, but the durable plan-to-apply
continuation is blocked by a corrected local schema prerequisite.** The normal
authenticated first-release preparation ran once for the fresh Smart Retail Pro
`dev` scope (sanitized project prefix `5a294142`) and created one
`infrastructure_change` parent, one desired/unapplied InfrastructureManifest
revision, one immutable InitialReleaseDraft, and one clean infrastructure-plan
outbox. It created no ReleaseManifest or legacy pipeline run.

The remote state preflight derived a usable configured AWS account and region,
then verified the existing state bucket's versioning, encryption, and public
access block. The fresh revision-scoped state key and native lock key were
absent before planning and remained absent after the plan completed; collision
checks for the deterministic foundation identities were clear. The exact plan
worker was started only with process-scoped project/dev and remote-plan gates,
and the authenticated exact-dispatch boundary published the one frozen plan
outbox. No broad outbox scan was used.

Terraform initialized the real S3 backend and saved one immutable remote-plan
artifact and succeeded planning journal. It did not apply infrastructure and
left no live state object or active lock. The plan was stopped before its
approval-required apply continuation because the controlled local database had
not yet recorded migration `1760000049000`, whose additive status constraint
permits `plan_completed`. The continuation transaction therefore failed closed
instead of fabricating an apply child. The migration was subsequently applied
once through the normal migration runner and its status constraint is now
present; the already terminal parent remains preserved as truthful historical
evidence. No automatic retry or manual lifecycle rewrite was performed.

This directly exposed an operational prerequisite gap: a saved plan whose
continuation is interrupted by a pre-existing schema mismatch has no fenced
recovery transition. The existing ownership API correctly refuses to reclaim a
terminal parent, so creating an apply child now would require a new, separately
reviewed recovery contract that revalidates the saved plan, draft, manifest,
published delivery, and fresh fences without regenerating Terraform work.

Evidence classification: managed-database behavior and continuation tests are
**isolated/local**; the S3 backend/account/state and Terraform *plan* are
**live AWS read-only planning evidence** only. There is no Terraform apply,
ECR, ECS, release, or Project-Tst mutation evidence. The worker shut down
gracefully; no active ownership, operation lease, or active lock remains.

The next smallest gap is the fenced, idempotent saved-plan continuation
recovery for this exact failure mode. Only after that transition has produced
`plan_completed`, one approval-required apply child, and one clean apply outbox
would a separate approval be needed to apply the exact saved plan once.

Focused verification after the migration correction passed: the transactional
planner PostgreSQL concurrency/rollback fixture, plan-completion continuation
PostgreSQL fixture, additive status migration apply/rollback fixture, backend
type-check/build, frontend build, Terraform configuration validation, and
`git diff --check`. The planner fixture was also brought forward to include the
already-required managed-database identity columns; this was a disposable test
schema correction only.

## Smart Retail Pro saved-plan continuation recovery — 2026-07-29

**Result: recovered without regenerating Terraform.** A dedicated serializable,
advisory-locked recovery contract now accepts only the historical
`INFRASTRUCTURE_PLAN_CONTINUATION_FAILED` parent after revalidating its saved
plan, immutable request fingerprint, desired manifest, draft, and delivered
plan outbox. It acquires fresh short-lived independent fences, preserves the
failed parent and planning evidence unchanged, and creates the deterministic
approval-required infrastructure-apply child plus one clean unpublished apply
outbox. Replays reuse that child/outbox.

The exact Smart Retail scope now has one preserved failed planning parent, one
existing immutable saved plan and succeeded planning journal, one apply child,
and one pending zero-attempt apply outbox. The manifest remains desired and
unapplied; the draft is unchanged. No state object or native lock exists, and
no Terraform apply, cloud resource, release, ECR, or ECS action occurred.
Fresh recovery fences were released after verification. Focused continuation
and migration PostgreSQL checks, backend type-check/build, and `git diff
--check` passed. Evidence is isolated/local plus prior live-AWS read-only plan
and state evidence only.

The next approval-gated gap is dispatching and applying this exact saved plan
once, followed separately by the first ECS release.

## Smart Retail Pro recovered apply dispatch — 2026-07-29

**Result: blocked before Terraform apply.** The exact recovered apply child and
its zero-attempt outbox were revalidated and dispatched once through the
authenticated exact-dispatch boundary. The supervised apply worker then failed
closed with `INFRASTRUCTURE_APPLY_CONTEXT_INVALID` before invoking Terraform.
The cause is a remaining normal-path predicate that accepts only a
`plan_completed` parent, while the deliberately preserved schema-gap parent is
historical `failed` evidence. No Terraform state object, lock, cloud resource,
database, ECR, ECS, or release operation was created.

The parent remains historical, the manifest remains desired/unapplied, and the
apply child is terminal failed. The worker was stopped and process-scoped gates
were removed. The next smallest safe implementation is a fenced apply-context
recovery/validation rule that recognizes only the deterministic recovered child
of this exact schema-gap parent, followed by a separately approved replacement
or reconciliation path for the terminal apply delivery. No first ECS release is
authorized until that durable apply lifecycle is corrected.

## Smart Retail Pro replacement apply delivery recovery — 2026-07-29

**Result: recovered delivery prepared; not dispatched.** The apply validator
now retains its ordinary `plan_completed` parent requirement and admits only the
exact schema-gap historical lineage as a narrow exception. A serializable,
advisory-locked delivery-recovery transition then preserved the original failed
apply child and its published outbox unchanged, and created one deterministic
replacement approval-required child with one pending, zero-attempt, unclaimed,
unpublished `intent.infrastructure.apply` outbox. The manifest remains desired
and unapplied, with the immutable saved plan and draft unchanged.

Backend type-check/build and `git diff --check` passed. This is local durable
recovery evidence only; live AWS evidence remains the prior read-only plan/state
inspection. No Terraform, AWS, ECR, ECS, database, or release action occurred.
The next separately approved step is dispatching and applying the exact
replacement delivery once, then proceeding to the first ECS release only after
conclusive infrastructure verification.

## Smart Retail Pro uncertain-apply read-only reconciliation — 2026-07-29

**Result: conclusively no AWS mutation.** The immutable saved-plan SHA-256
still matches the durable manifest evidence and describes 56 creates, zero
updates, replacements, or deletes. The replacement apply delivery was
published once and its handler journal became uncertain, but the working
directory contains no apply output or crash artifact and none of its files was
written during the apply interval. The manifest remains `manual_review`; no
durable Terraform outputs or state version were persisted.

The apparent uncertainty was caused before Terraform execution. The bounded
worker configuration omitted the required expected-account setting. The apply
service marked the manifest `applying` before checking that read-only
precondition, and the generic invocation wrapper then reported
`PLACEHOLDER_HANDLER_THROWN`. S3 version history proves that the exact state
key has never had a version or delete marker. The lock key has one historical
version and delete marker from the earlier planning operation, whose sanitized
lock metadata identifies `OperationTypePlan`; there is no apply lock version.
Therefore `terraform apply` never reached native lock acquisition.

Live read-only AWS inspection used the configured account and `us-east-1`,
exact deterministic names, and the project/environment/manifest/input identity
tags. Every planned resource group is absent:

- networking (19 absent): one VPC, four subnets, one internet gateway, one
  EIP, one NAT gateway, two route tables, four associations, and five security
  groups;
- discovery (3 absent): one private namespace and two discovery services;
- managed PostgreSQL foundation (16 absent): one database ECS cluster, service,
  and task definition; one EFS filesystem, one access point, two mount targets;
  one KMS key; two secret records and two secret versions; one log group; and
  one backup vault, plan, and selection;
- application foundation (7 absent): one ECR repository and lifecycle policy,
  one application ECS cluster and log group, and one ALB, listener, and target
  group;
- shared execution identity (10 absent): five IAM roles, two inline policies,
  and three managed-policy attachments.

Dependent resources without independent tags are also conclusively absent
because their exact parents are absent. No expected resource is classified as
created, partial, conflicting, or indeterminate. CloudTrail management events
for the exact worker interval contain read-only identity/inspection calls and
no Terraform-provider create, update, or delete API. These 55 AWS resources
plus the one local `random_password` node account for all 56 planned creates;
the local node remained plan-only and has no persisted Terraform state or
exposed value.

A narrow diagnostic correction now performs remote-state/account/backend
preflight before `markApplying()` in the fenced apply path. A preflight failure
is recorded as `INFRASTRUCTURE_APPLY_PREFLIGHT_FAILED`, not an uncertain apply
or `PLACEHOLDER_HANDLER_THROWN`; confirmed apply failures and genuinely
uncertain post-invocation outcomes retain their existing behavior. The focused
handler regression proves the safe classification.

Cleanup is complete: no worker, active operation lease, cross-lane owner, or
outbox claim remains, and no first-release path started. No durable lifecycle
row was changed during this reconciliation.

Evidence classification:

- **isolated:** focused diagnostic handler regression only;
- **local:** durable intent/outbox/manifest/draft/journal correlation, saved
  plan hash and plan contents, workspace timestamps, and cleanup checks;
- **live AWS:** read-only S3 version/lock history, exact resource/name/tag
  inspection, and CloudTrail audit correlation. No live mutation evidence
  exists.

The next smallest action is a separately approved, canonical fresh replacement
apply delivery bound to the unchanged saved plan. It is safe to consider only
because no Terraform or AWS mutation is now conclusively proven; this
reconciliation did not create or dispatch that replacement and did not
authorize Terraform apply or the first ECS release.

## Smart Retail Pro recovered apply execution — 2026-07-29

**Result: blocked after one Terraform apply; first release not started.** The
exact recovered apply delivery was published once and the immutable saved plan
was invoked once. Remote state now has one version and records the complete
planned foundation shape. The native lock is absent. No second Terraform apply,
image build/push, task-definition registration, ECS application-service
creation, or release execution occurred.

Read-only state and AWS verification found a material contradiction: Terraform
state records the managed PostgreSQL foundation ECS service, while the exact
application cluster has no matching managed-database service. This means the
foundation cannot truthfully be persisted as `applied`; the InfrastructureManifest
remains `applying`, the failed apply child and its published outbox remain
historical, and its one uncertain apply journal remains reconciliation-required.
There are no active operation leases, cross-lane owners, outbox claims, or
workers.

Two verifier defects were corrected without another apply: managed-database
service verification now resolves the service identity from exact Terraform
state rather than treating the provider service ID as an ARN, and secret-reference
validation accepts Secrets Manager ARN references while still rejecting
assignment-like plaintext secret values. Those corrections exposed the real
missing-service contradiction rather than hiding it as a generic uncertain
result.

Evidence classification:

- **isolated:** focused apply-handler and manifest-apply safety checks passed;
- **local:** exact saved-plan hash, working-directory state inspection, durable
  manifest/intent/outbox/journal correlation, and process/lease cleanup;
- **live AWS:** one remote state version, released native lock, exact ECS
  cluster/service inspection, and foundation reads. The apply itself is live
  AWS mutation evidence; no release-lane mutation occurred.

The next smallest action is a separately approved state-reconciliation and
bounded managed-database service recovery package. It must determine why the
state-recorded service is absent and reconcile or repair that exact identity
without rerunning the saved Terraform apply. First ECS release execution remains
blocked until the InfrastructureManifest is conclusively `applied`.
