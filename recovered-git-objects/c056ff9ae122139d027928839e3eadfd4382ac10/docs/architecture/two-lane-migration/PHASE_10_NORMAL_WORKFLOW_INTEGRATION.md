# Phase 10 — Normal Workflow Integration Audit

**Status:** design only. No runtime, database, queue, Terraform, or cloud state
was changed by this audit.

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
