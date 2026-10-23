# DeployGuard Current-State Audit — Final Result

Audit date: 2026-08-01

Scope: read-only audit of the repository, local runtime, PostgreSQL/Redis state, normal-v1 worker topology, focused regressions, and read-only AWS evidence. No application source, environment file, worker configuration, durable lifecycle row, queue delivery, or AWS resource was changed.

## 1. Executive verdict

**NO-GO for a new full controlled AWS deployment through the current developer UI.** The three production normal-v1 workers are healthy and exactly scoped to Smart Retail Pro `5a294142-f12c-4ffc-ab9a-c4b096ebd659/dev`, queues are idle, ownership is clean, and the existing Smart Retail service is live. Those facts prove operational readiness of the worker processes, not end-to-end product readiness.

Three P0 defects prevent a truthful full test:

1. The completed Smart Retail first release is projected as `NORMAL_FIRST_RELEASE_STATUS_MALFORMED` because the status reader validates the intent's superseded infrastructure revision instead of the stable release's applied infrastructure revision.
2. The stable live release has no canonical persisted security-scan row, so the operation projection marks Build/terminal state failed even though the release is stable and AWS is healthy. The production normal-v1 handler does not currently provide the Trivy/persisted-scan contract demonstrated by the local fixture.
3. A new first deployment cannot be driven end to end from the normal developer action. The UI stops after infrastructure preparation and has no canonical approval/apply/release continuation action; the managed-foundation first-release planning/execution gates are also not enabled in the current backend process.

Release-only redeployment is structurally much closer, but should not be tested live until the status and security-evidence defects are corrected. The unchanged-source command also needs an authoritative backend `NO_OP`/existing-operation response rather than relying on frontend suppression.

`FINAL_DAY_COMPLETION_TRACKER.md` retains its own **100% scoped tracker closure** metric (with its recorded local-runtime 76% and live-AWS 18% evidence measures). That fixed-denominator project metric is not a deployment-readiness percentage. This audit does not invent or blend a new percentage.

## 2. Documents and evidence inspected

Authority was applied in this order:

1. Current repository source and current runtime/durable state.
2. `FINAL_DAY_COMPLETION_TRACKER.md` and its iteration evidence.
3. The Railway-like two-lane architecture and recovery report.
4. The original FYP proposal.
5. `WORKING REPORT` as historical context only.
6. Root/backend/frontend/setup/architecture documentation, Compose definitions, package scripts, and tests.

Current evidence inspected included:

- normal release-lane controllers, preparation services, exact dispatcher, generic consumer runtime, release/infrastructure handlers, ownership/lease/fencing services, side-effect journals, terminal-outbox handling, convergence schedulers, and `ProjectCurrentStateService`;
- Overview, Pipeline, workspace Dashboard/Plan & Usage, Requirements, Infrastructure, Terraform State, Orchestration, Releases, Logs, Metrics, Settings, and their frontend API calls;
- PostgreSQL deployment intents, outboxes, release/infrastructure manifests, initial drafts, saved plans, stable projections, provenance, journals, ownership, operation leases, claims, reconciliation leases, security scans, legacy runs, and worker capabilities;
- Redis/BullMQ queue state, running Compose containers, process health, exact worker scope, and installed tools;
- focused planning, execution, status/current-state, frontend projection, TypeScript, and frontend build checks;
- read-only AWS identity/preflight, ECS deployment state, ALB target health, and HTTP response for the exact Smart Retail scope.

Historical documentation was not treated as proof when source or runtime contradicted it. Fixture, isolated/local, and live-AWS evidence are separated below.

## 3. Current authoritative architecture

The authoritative deployment architecture is the normal-v1 two-lane model:

- **Infrastructure lane:** immutable `infrastructure_change` intent → exact `intent.infrastructure.plan` outbox/job → saved Terraform plan and plan journal → `plan_completed` parent → approval-required apply child and exact `intent.infrastructure.apply` outbox/job → applied `InfrastructureManifest`.
- **Release lane:** immutable `release_only` intent → candidate `ReleaseManifest` → exact `intent.release.execute` outbox/job → immutable image provenance and deduplicated side-effect journals → existing-service update or first-service creation → convergence/health verification → stable promotion.
- **Coordination:** serializable planning, deterministic idempotency, project/environment advisory locks, cross-lane ownership, operation leases with fencing and heartbeat, exact outbox claims, deterministic BullMQ job IDs, and journal-backed reconciliation of uncertain external actions.
- **Read model:** `ProjectCurrentStateService` plus normal release-lane status is the canonical project response used by Overview and Pipeline. Workspace Dashboard and Plan & Usage use the authoritative workspace summary.

The legacy pipeline is retained as historical/read compatibility data, not an authoritative deployment path. Core legacy start/retry/direct-deploy endpoints return `410 Gone`. That retirement is incomplete at the UI/service perimeter because advanced legacy-era mutation controls and stage-selective recovery remain reachable (section 5).

## 4. Current real execution path

### Later release-only path

The current path is:

1. Overview or Pipeline Start action checks canonical current state and uses an in-flight guard.
2. Authenticated `POST /api/projects/:projectId/release-lane/prepare` enters the normal preparation boundary.
3. The service validates exact project/`dev`, authorization, activation gates, repository/deployment contract, preflight, applied infrastructure, stable release, and blockers.
4. The transactional planner classifies the change and creates/reuses one immutable release intent, candidate manifest, and pending outbox under an advisory lock.
5. Authenticated `POST .../release-lane/dispatch` calls `dispatchExact()` for that frozen outbox only.
6. BullMQ publishes one deterministic job to the normal-v1 release queue.
7. The exact release worker rejects wrong role/message/project/environment before handler invocation, then acquires cross-lane ownership followed by its fenced operation lease.
8. The production handler performs or reconciles image build/push, provenance, task-definition registration, existing-service update (or supported bootstrap), rollout/ALB/HTTP verification, and stable promotion using durable journals.
9. The worker truthfully finalizes or enters the bounded reconciliation contract, releases claims/leases/ownership, and the browser restores state through current-state.

### First deployment path

Backend components exist for preparation, exact infrastructure-plan dispatch, supervised plan consumption, nonterminal plan-to-apply continuation, exact apply dispatch, supervised saved-plan apply, and managed-foundation first-release planning. They are not one usable developer workflow:

1. A new-project Start action can prepare the infrastructure parent, desired manifest, immutable draft, and clean plan outbox.
2. The frontend then reports that foundation execution is not enabled; it does not dispatch the plan.
3. There is no developer approval/apply action wired to the exact apply boundary.
4. After infrastructure apply, current-state may report `FIRST_RELEASE_INFRASTRUCTURE_APPLIED_RELEASE_AWAITING_EXECUTION` as a completed release-lane state. The same-source frontend guard then blocks the action that would prepare the managed first release.
5. The current backend process does not have the managed-foundation first-release planning/execution gates enabled.

Therefore the components are independently implemented, but the normal UI does not yet orchestrate the complete first-deployment state machine.

## 5. Frontend-backend integration assessment

### Correct integrations

- Overview and Pipeline restore the canonical normal operation via current-state and do not prepare or dispatch from a refresh effect.
- The action uses a synchronous in-flight ref to prevent double-click/React Strict Mode duplicate requests.
- Overview/Pipeline show latest attempted release separately from stable release when valid v1 evidence exists.
- Workspace Dashboard and Plan & Usage use one workspace-summary response; no frontend project-by-project release polling was found.
- A live URL is shown from stable v1 evidence when that evidence is valid.
- Retired normal start/retry/direct-deploy backend routes fail closed rather than reviving the legacy worker.

### Defects and conflicting integrations

- The selected live project currently renders a blocked/malformed normal state, so its action only refreshes instead of issuing a valid redeploy.
- Completed stable AWS state can render a failed Build/final result because the canonical security-scan record is absent.
- The unchanged-source behavior is only reliably suppressed by frontend state. A direct authenticated prepare reaches a release-only classification requirement; a true `no_op` classification fails instead of returning a typed existing/no-op operation.
- `ProjectCurrentStateService.getCurrentState()` can invoke cloud reconciliation with refresh enabled and persist reconciliation/cache evidence when stale. It does not start deployment, but the GET boundary is not strictly a database-only read.
- Project Pipeline can expose legacy cancel/retry/Terraform approval controls when no canonical normal operation is present. Some backend counterparts are retired, making the UI misleading.
- Deployment Requirements “Save and deploy” can still enter `StageSelectiveResumeService`, which can create/queue a legacy `ProjectPipelineRun`. This is a real mutation path that conflicts with the retired-legacy product contract.
- Developer-visible advanced pages expose orchestration rollback/scaling, storage recovery, Terraform-state validation/recovery/force-unlock, destroy/cleanup, raw cloud identities, and other operator controls.
- Status errors commonly surface raw safe codes rather than simple developer-owned guidance.
- Advanced Releases/Orchestration/Logs/Metrics pages still use compatibility or legacy-shaped readers, so not every page shares exactly the same latest/stable/current-operation semantics.

## 6. Minimum UI compared with current UI

| Minimum Railway-like developer surface | Current state | Required correction |
|---|---|---|
| Repository and branch | Present | Keep |
| Unresolved application-owned values | Present through Requirements/current-state, but separate and coupled to a legacy stage-resume action | Keep the values; replace “Save and deploy” with normal-v1 preparation only |
| One Deploy/Redeploy action | Labelled “Start Pipeline”; blocked by malformed state; first-release continuation incomplete | Use one state-driven Deploy/Redeploy action backed by canonical next actions |
| Analyze, Build, Prepare, Deploy, Verify | Rendered for a canonical operation | Correct security and lineage projections; retain phases |
| Current operation status | Present, but synthesized state can contradict stable AWS | Make durable normal-v1 evidence authoritative and internally consistent |
| Previous stable release and live URL | Present when valid v1 evidence exists | Preserve; never infer URL from an unverified attempt |
| Application logs | Available, but split across operation/legacy views | Make application logs the default developer view |
| Simple error/reconciliation guidance | Raw safe codes and operator detail remain visible | Map safe codes to concise retry/wait/contact-admin guidance |

The minimum developer navigation should be Overview, Deployments, Environment/Requirements, Logs, Metrics, and Settings. Terraform plans/state/locks, worker/fence/journal identity, ARNs, cleanup, residue, recovery stages, and infrastructure approval belong in a separate operator/admin surface.

## 7. Current deployment blockers and root causes

### P0 — `NORMAL_FIRST_RELEASE_STATUS_MALFORMED`

This is an active projection/reconciliation compatibility defect over valid historical recovery lineage, not evidence that the stable release is malformed.

- The completed release-only intent points to `InfrastructureManifest` revision 1.
- The immutable initial draft also preserves revision-1 lineage.
- Revision 1 is now `superseded` after the managed-foundation correction.
- Stable `ReleaseManifest` revision 1 points to applied `InfrastructureManifest` revision 2 and the same pinned source commit.
- `NormalReleaseLaneStatusService` selects the intent/draft infrastructure revision, recognizes a first release because the stable release identity matches the candidate, and then requires that selected revision to be `applied`. Revision 1 is superseded, so it emits `NORMAL_FIRST_RELEASE_STATUS_MALFORMED` and projects the wrong applied revision.

Supported repair: do not rewrite any historical row. For completed first-release recovery lineage, validate the stable ReleaseManifest's exact applied InfrastructureManifest and immutable lineage back to the original intent/draft. Preserve revision 1 as history and report applied revision 2. Add a real Smart-shaped regression fixture plus conflict cases.

### P0 — missing production security evidence

Smart Retail has a stable image/release but no `project_security_scans` row. The current-state operation therefore reports security unavailable and converts the completed result into failed. The release worker image has no Trivy binary, and the production normal-v1 release composition does not persist the scan evidence produced by the deterministic local fixture. Backend `TRIVY_SCAN_ENABLED=true` alone does not enforce scanning in the independent release worker.

Supported repair: integrate a canonical, immutable image scan at the normal-v1 production release boundary, persist intent/release/image-bound sanitized findings before promotion, and fail closed before deployment when required scanning is unavailable. Do not conceal this by weakening the projection.

### P0 — incomplete first-deployment UI state machine

The normal action does not sequence exact plan dispatch, approval-gated apply dispatch, and managed-foundation first-release preparation/dispatch. State naming also blocks the next same-source action after infrastructure apply. This prevents the required fresh UI-to-AWS acceptance test.

Supported repair: expose a sanitized canonical `nextAction` for each first-release state and route each action to the existing exact authenticated boundary. Keep apply explicitly approval-gated. Never start workers from HTTP. Configure exact managed-foundation gates only for the controlled project/process.

### P1 — worker configuration reproducibility

The running containers correctly expose `INFRACOST_API_KEY` only to the plan worker, but the persisted Smart Retail Compose override references it for release and apply as well. Recreating from that file can violate least privilege. Correct the override before the next recreate and verify environment presence without printing values.

### P1 — authoritative unchanged-source result

The backend should return the existing stable/completed operation or an explicit `NO_OP` response transactionally without creating an intent/outbox/job. Frontend suppression alone is not the command contract.

## 8. Duplicate, concurrency, retry and reconciliation behavior

- **Duplicate clicks:** synchronous frontend in-flight guard prevents overlapping requests in one mounted page.
- **Duplicate preparation:** serializable planner transaction, project/environment advisory lock, immutable idempotency key, and unique durable identities reuse the canonical result or fail closed on changed evidence.
- **Duplicate dispatch:** `dispatchExact()` locks and claims only the requested clean outbox; deterministic BullMQ job identity prevents a second logical job.
- **Duplicate delivery/concurrent consumers:** exact role/message/scope validation occurs before ownership; cross-lane ownership, operation lease/fence, heartbeat, and journal identity produce one effective execution.
- **Second commit during deployment:** active intent/lease/current-state blockers prevent creation of an overlapping release-only operation; changed immutable identity cannot reuse the active operation.
- **Release during infrastructure plan/apply:** planner blockers and shared project/environment cross-lane ownership serialize the lanes.
- **Release uncertainty:** `RELEASE_EVIDENCE_AMBIGUOUS` supports a default-off, attempt/time-bounded convergence scheduler that reuses the same frozen job and succeeded journals. Process and Compose restart behavior is proven locally, not on a new live AWS deployment.
- **Infrastructure apply uncertainty:** the same child, saved plan, journal, state lineage, and output identity can be reclaimed for read-only reconciliation without applying twice. Ambiguous state remains nonterminal/reconciliation-required rather than looping automatically.
- **Infrastructure plan uncertainty:** it fails closed and does not blindly regenerate a saved plan, but ordinary operator recovery UX remains incomplete.
- **Browser refresh:** Overview/Pipeline GET current-state and do not invoke preparation/dispatch. The caveat is the read-side cloud-reconciliation persistence noted in section 5.
- **Current idle state:** zero exact active operation leases, cross-lane owners, reconciliation leases, or outbox claims were found.

## 9. First-deployment readiness

**NO-GO from the normal developer UI.** The plan and apply workers and backend exact-dispatch contracts are ready, and disposable supervised workflows prove their internal lifecycle. The developer journey is incomplete: plan dispatch is not automatic, apply has no approval action, applied-foundation state blocks managed first-release preparation, and relevant managed first-release gates are off in the current backend.

A controlled fresh AWS test also requires the security-scan boundary to be production-capable before release promotion. The first test must use a disposable exact project/`dev` scope, not Smart Retail or Project-Tst history.

## 10. Release-only redeployment readiness

**Conditional NO-GO.** The later-release planner, exact dispatcher, supervised worker, journal/reconciliation lifecycle, and prior live evidence are substantial and focused regressions pass. A new test should wait for:

1. the stable/applied lineage projection correction;
2. production security-scan persistence/enforcement;
3. an authoritative unchanged-source `NO_OP`/existing-operation response;
4. a recreated exact worker configuration that preserves least privilege.

After those corrections, one minimal new commit can exercise the existing release-only path without Terraform. No currently queued job should be reused.

## 11. Security, cost and cloud-tooling readiness

- **Docker:** available in the release worker (`20.10.24`).
- **Terraform:** available in plan/apply workers (`1.10.5`); not installed in the release worker, which is correct separation.
- **Infracost:** available only where required at runtime (`2.12.2` in the plan worker); an update to `2.14.1` was advertised but is not itself a blocker. Deferred-cost acknowledgement remains explicit.
- **AWS CLI:** available in plan/apply (`2.35.17`); absent from release. Source uses AWS SDKs for the release path, so CLI absence there is not a blocker.
- **Trivy:** absent from the release worker; this is a P0 because canonical live scan evidence is also absent.
- **AWS identity/config:** the operational read-only canary preflight passed for the current exact account/region configuration.
- **Secrets:** no secret value was printed. Environment files remain outside the audit changes. The running containers currently keep the Infracost key out of release/apply.
- **Runtime maintenance:** AWS SDK emitted a notice that future versions after January 2027 require Node.js 22 or newer; the current Node `20.19.4` toolchain needs a planned upgrade, not an emergency deployment bypass.
- **Stripe/SNS:** `BILLING_PROVIDER_ENABLED=false` and `NOTIFICATION_DELIVERY_ENABLED=false`; both are explicitly deferred and do not block core deployment testing.

## 12. Local-runtime evidence

At audit time:

- backend, frontend, PostgreSQL, Redis, release worker, infrastructure-plan worker, and infrastructure-apply worker were running;
- all three workers reported sanitized `ready=true`, exact project `5a294142-f12c-4ffc-ab9a-c4b096ebd659`, exact environment `dev`, no active message, and zero restarts;
- release queue: `active=0`, `waiting=0`, `delayed=0` (historical completed/failed jobs retained);
- infrastructure queue: `active=0`, `waiting=0`, `delayed=0` (historical failed jobs retained); deletion queues were empty;
- PostgreSQL showed one exact capability for each worker role and no active lease, owner, reconciliation lease, or outbox claim for the scope;
- no new intent, outbox publication, claim, delivery, or worker invocation occurred during this audit.

Focused checks passed:

- backend normal planning, execution, status, and current-state suites;
- backend TypeScript no-emit type-check;
- frontend normal release-lane UI, normal release view, and current-state UI suites;
- frontend production build.

These tests prove focused contracts. They do not override the live durable-data contradictions described above.

## 13. Live-AWS evidence

Read-only live evidence for Smart Retail Pro showed:

- production canary preflight ready;
- exact application ECS service present;
- desired/running/pending tasks `1/1/0`;
- PRIMARY deployment `COMPLETED`;
- ALB target healthy;
- stable URL returned HTTP `200`;
- current applied infrastructure and stable release evidence remained unchanged.

No AWS mutation, job dispatch, Terraform operation, Docker build/push, task registration, service update, rollback, or deletion was performed. This is read-only confirmation of an existing release, not a new deployment acceptance test.

## 14. Features implemented but not yet proven live

- complete UI-driven first deployment across plan approval/apply and first release;
- production normal-v1 security scanning and persisted scan evidence;
- unchanged-source backend `NO_OP` command behavior;
- automatic bounded release convergence across a new real AWS uncertainty;
- infrastructure-plan/apply failure and recovery through the final developer/operator UX;
- controlled normal-v1 rollback for a newly failed later release;
- concurrent commit and cross-lane contention on live AWS;
- worker crash at each external mutation boundary on live AWS;
- partial Terraform apply recovery using the normal UI/operator flow;
- project deletion/cleanup acceptance;
- the target sequence of one fresh deployment followed by five ordinary code-only releases proving Terraform is not invoked.

## 15. Deferred non-blocking work

- Stripe provider integration and live billing webhooks;
- SNS delivery and live notification-provider evidence;
- broader billing/product-tier productization;
- production backup/restore provider drills beyond existing local contract evidence;
- optional observability polish and long-running retention/performance testing;
- Node.js 22 toolchain upgrade before the AWS SDK support deadline;
- schema-inventory business classification beyond the completed tooling/audit scope, unless a concrete runtime defect reopens it.

These items must remain disabled or explicitly scoped. They do not block the next core deployment implementation iteration.

## 16. Documentation contradictions and stale instructions

- `CURRENT_ORCHESTRATION_MAP.md` still describes automation/full legacy pipeline routes as current deployment paths.
- `docs/SETUP_REQUIRED.md` maps setup/testing to `/automation/start`, the legacy pipeline worker, and direct infrastructure operations.
- `docs/frontend-architecture.md` describes legacy start/retry behavior that now returns `410 Gone`.
- `docs/MANUAL_SETUP_FOR_TESTING_LAUNCH.md` describes legacy workers and security/cost bypasses that are unsafe for normal-v1 acceptance.
- `docs/ARCHITECTURE.md` mixes the retired pipeline with normal-v1 and can imply Stripe/SNS provider authority despite both providers being disabled.
- The root README is closer to current Compose/runtime behavior, but generic worker instructions do not communicate the exact managed first-release sequencing gap.
- Phase 10 and the completion tracker contain valuable chronological evidence, but some “complete” statements refer to isolated fixtures or earlier live corrections, not the current product journey.

These documents should be updated only after the corresponding product corrections, with one current runbook naming normal-v1 as the sole developer deployment path and legacy records as read-only history.

## 17. Go/no-go decision for full deployment testing

**Decision: NO-GO.** Keep all queues idle and do not click Deploy yet.

Go criteria, in dependency order:

1. Correct completed first-release status projection using stable applied infrastructure lineage without rewriting history.
2. Integrate and prove production normal-v1 image scanning with canonical persisted sanitized evidence.
3. Implement the first-release canonical `nextAction` flow through exact plan dispatch, approval-gated apply dispatch, and managed release preparation/dispatch.
4. Make unchanged source return an authoritative existing/`NO_OP` result with no publication.
5. Correct persisted worker configuration so a recreate keeps secrets least-privileged, then re-prove all three workers ready under the exact disposable project/`dev` scope.
6. Run focused local PostgreSQL/Redis/browser acceptance, including duplicate clicks, refresh, concurrent commits, lane contention, crash/reconciliation, and failed health.
7. Only then run one controlled fresh AWS first deployment, followed by a minimal release-only commit, rollback/failure drills, and the no-Terraform ordinary-release sequence.

The smallest safe next implementation iteration is the lineage-aware `NORMAL_FIRST_RELEASE_STATUS_MALFORMED` projection correction and its Smart-shaped current-state/UI regression fixture.
