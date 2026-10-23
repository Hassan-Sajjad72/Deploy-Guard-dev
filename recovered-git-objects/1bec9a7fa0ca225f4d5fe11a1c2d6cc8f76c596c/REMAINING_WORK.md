# DeployGuard Remaining Work

Audit basis: 2026-08-01 current source/runtime evidence. This list contains only genuine remaining work. The completion tracker’s 100% scoped closure is preserved as a separate fixed-denominator metric; this document does not recalculate or blend it with deployment readiness.

## Smallest first implementation iteration

**P0-1 — Correct completed first-release stable/applied lineage projection.** This is the smallest bounded change that removes the immediate `NORMAL_FIRST_RELEASE_STATUS_MALFORMED` contradiction without mutating durable history or cloud state.

## Required before the first live deployment

### P0-1 — Lineage-aware completed first-release projection

- **Defect:** `NormalReleaseLaneStatusService` validates the completed intent/draft's superseded infrastructure revision instead of the stable ReleaseManifest's applied infrastructure revision, producing `NORMAL_FIRST_RELEASE_STATUS_MALFORMED` for Smart Retail.
- **Affected areas:** backend normal release-lane status, `ProjectCurrentStateService`, workspace/project projections, Overview, Pipeline, current-state fixtures.
- **Why it matters:** a stable healthy release is shown as blocked/malformed and the normal action cannot proceed truthfully.
- **Smallest safe approach:** add a read-only lineage resolver for completed first releases. Lock nothing and rewrite no row. Validate the stable release's exact applied infrastructure manifest plus immutable source/draft/recovery lineage; preserve the original superseded manifest as historical evidence. Fail closed on ambiguous or conflicting lineage.
- **Dependencies:** none.
- **Acceptance evidence:** Smart-shaped fixture projects stable release revision 1 on applied infrastructure revision 2 as completed/live; revision 1 remains superseded history; missing/mismatched lineage remains sanitized blocked; Overview, Pipeline, workspace summary, authorization, type-check/build pass; real Smart current-state becomes internally consistent after a read-only refresh.
- **Regression risk:** accepting unrelated applied infrastructure or concealing a real identity conflict.
- **Rollback/recovery:** revert the projector-only change; no durable migration or data rollback is required.

### P0-2 — Canonical production normal-v1 security scan

- **Defect:** the production release worker has no Trivy boundary or persisted `project_security_scans` evidence, while current-state requires such evidence and marks the stable release failed when absent.
- **Affected areas:** release worker image/composition, production release handler, image provenance, side-effect journal, security-scan persistence, current-state, worker health/configuration.
- **Why it matters:** live promotion can occur without the security evidence the UI and policy claim is required; stable AWS and canonical UI contradict each other.
- **Smallest safe approach:** install a pinned scanner in the release-worker image and add a default-off, exact-scope scan side effect after immutable image creation and before task/service mutation. Bind sanitized results to intent, candidate, source SHA, image digest, scanner identity, and policy. Persist/reconcile through the journal; fail closed if enforce mode lacks a scanner. Never log raw registry credentials or unbounded findings.
- **Dependencies:** P0-1 for unambiguous UI verification; approved scanner version/policy thresholds.
- **Acceptance evidence:** deterministic local registry/image fixture scans once; duplicate/restart reuses evidence; failed critical policy publishes no ECS mutation; succeeded scan appears in current-state and phases; release worker reports scanner version/ready without secrets; type-check/build and image checks pass.
- **Regression risk:** image pull/auth leakage, slow scans, false policy blocks, or repeating a scan after uncertain persistence.
- **Rollback/recovery:** keep the new capability default-off; disable the exact gate and revert the composition/handler change. Existing stable releases remain historical and are not retroactively fabricated.

### P0-3 — Canonical UI-driven first-release continuation

- **Defect:** after first-release infrastructure preparation, the UI does not dispatch plan, approve/dispatch apply, or prepare/dispatch the managed-foundation release. Applied-foundation state can be represented as completed and blocked by the same-source guard.
- **Affected areas:** current-state `nextAction`, prepare/dispatch controller responses, Overview/Pipeline action state machine, authorization, exact first-release gates, infrastructure plan/apply/release workers.
- **Why it matters:** a genuinely fresh project cannot reach its first live release through the promised one-action developer journey plus explicit infrastructure approval.
- **Smallest safe approach:** expose one sanitized, durable next-action enum: prepare foundation → dispatch plan → await approval → dispatch apply → await infrastructure → prepare release → dispatch release → observe. Reuse the existing exact authenticated boundaries and outboxes. Keep apply approval explicit, exact-scope, and default-off. HTTP must never start a worker.
- **Dependencies:** P0-1; P0-2 before release dispatch; one disposable AWS project/`dev` scope and approved cost plan.
- **Acceptance evidence:** disposable PostgreSQL/Redis/authenticated-browser workflow creates one parent/plan/apply child/release intent at the correct stages; duplicate clicks/requests produce no duplicate publication; refresh resumes the same next action; wrong role/project/environment and conflicting evidence publish nothing; no fake legacy run; all workers cleanly stop.
- **Regression risk:** accidental apply approval, same-source deadlock, overlapping lane ownership, or a second intent/outbox.
- **Rollback/recovery:** disable all new exact gates and hide the next action; durable pending outboxes remain clean and manually auditable.

### P1-1 — Reproducible least-privilege worker configuration

- **Defect:** the current running containers expose the Infracost key only to the plan worker, but the persisted Smart Retail Compose override references it for release and apply too.
- **Affected areas:** repository-owned Compose override/runbook, secret injection, worker recreation checks.
- **Why it matters:** a restart/recreate may widen secret exposure and make the observed ready runtime non-reproducible.
- **Smallest safe approach:** remove the Infracost secret mapping from release/apply in the persisted composition; retain it only in plan. Add environment-presence assertions that print booleans, never values. Keep Stripe/SNS and fixtures disabled.
- **Dependencies:** none; perform before any worker recreate.
- **Acceptance evidence:** rebuilt/recreated workers all ready for one exact project/`dev`; Infracost key present/nonempty only in plan; tool versions correct; no queue/job/AWS mutation; `.env` ignored and mode 600.
- **Regression risk:** starving the plan worker of required cost evidence or accidentally printing a secret.
- **Rollback/recovery:** restore the backed-up Compose override, recreate idle workers, and verify exact environment presence again.

### P1-2 — Make current-state GET a documented read boundary

- **Defect:** current-state may invoke cloud reconciliation with refresh enabled and persist reconciliation/cache evidence when stale.
- **Affected areas:** `ProjectCurrentStateService`, cloud-state reconciliation, controller semantics, browser refresh tests.
- **Why it matters:** a browser GET does not start deployment, but hidden external reads/persistence complicate refresh guarantees, latency, and failure behavior.
- **Smallest safe approach:** return durable canonical state on GET and move active cloud refresh to an explicit, authorized, bounded reconciliation command or background observer. If read-through refresh is retained, document and test its exact read-only-cloud/write-cache contract.
- **Dependencies:** P0-1 to stabilize the projection.
- **Acceptance evidence:** repeated browser refresh creates no lifecycle transition, queue action, ownership, lease, or AWS mutation; behavior under expired cloud cache is deterministic; frontend state remains identical.
- **Regression risk:** stale health display or breaking current reconciliation freshness.
- **Rollback/recovery:** restore read-through refresh while retaining explicit audit logs and mutation guards.

## Required before release-only redeployment testing

### P1-3 — Authoritative unchanged-source `NO_OP`/existing operation

- **Defect:** same-source suppression depends on frontend current-state; direct preparation can fail the required `release_only` classification instead of returning a typed no-op/existing result.
- **Affected areas:** normal prepare service/controller response, classifier result mapping, Overview/Pipeline action state, tests.
- **Why it matters:** API retries, alternate clients, and stale tabs need server-authoritative idempotency with zero durable/job creation.
- **Smallest safe approach:** before transactional planning, resolve exact stable source/deployment contract/preflight identity. Return the existing completed operation or a sanitized typed `NO_OP` response when identical. Fail closed if apparently identical evidence conflicts.
- **Dependencies:** P0-1.
- **Acceptance evidence:** repeated authenticated requests for the stable SHA return the same identity/`NO_OP`; intent/outbox/job/provenance/journal counts do not change; changed commit proceeds to one release-only intent; malformed/cross-project/read-only requests publish nothing.
- **Regression risk:** masking a real configuration change as no-op.
- **Rollback/recovery:** remove the early response and retain existing fail-closed classification behavior.

### P1-4 — Controlled later-release acceptance fixture and live canary

- **Defect:** later-release contracts are extensively proven, but the current Smart state is blocked and the production security path has not been exercised as one current UI workflow.
- **Affected areas:** authenticated UI action, planner/preflight refresh, dispatcher, release worker, security scan, ECR/ECS/ALB, current-state/UI.
- **Why it matters:** documentation-era and isolated proofs do not prove the corrected current composition.
- **Smallest safe approach:** after P0-1/P0-2/P1-1/P1-3, create exactly one harmless visible commit in an approved canary project; use one browser action, one exact job, and read/journal reconciliation before any retry.
- **Dependencies:** P0-1, P0-2, P1-1, P1-3; operator approval for the live commit and AWS scope.
- **Acceptance evidence:** one prepare and dispatch network request, one deterministic job, one provenance, one scan, deduplicated mutation journals, completed PRIMARY rollout, healthy ALB, HTTP 200/version marker, stable projection, no Terraform, clean shutdown.
- **Regression risk:** live service disruption or duplicate external mutation after ambiguity.
- **Rollback/recovery:** use the existing bounded rollback only when stable predecessor eligibility and conclusive candidate failure are proven; otherwise stop and reconcile.

## Required before failure and rollback testing

### P1-5 — Replace remaining legacy stage-resume mutation entry

- **Defect:** Deployment Requirements “Save and deploy” can invoke `StageSelectiveResumeService` and create/queue a legacy `ProjectPipelineRun` despite retired legacy deployment.
- **Affected areas:** requirements controller/service, frontend Requirements action, legacy pipeline queue guards.
- **Why it matters:** two mutation paths can conflict with the normal-v1 ownership contract and violate the authoritative architecture.
- **Smallest safe approach:** make requirements saving configuration-only, then route deployment through the normal current-state next action. Return `410 Gone` from the stage-resume mutation for developer deployment use; keep historical reads.
- **Dependencies:** P0-3 for first-release continuation.
- **Acceptance evidence:** saving requirements never creates a pipeline run or job; Deploy uses only normal prepare/dispatch; source guard proves no reachable frontend call to legacy start/retry/resume queues.
- **Regression risk:** breaking legitimate operator recovery that reused the service.
- **Rollback/recovery:** retain a separately authorized operator-only recovery endpoint behind an explicit default-off gate if evidence proves it is still needed.

### P1-6 — Normal-v1 failure/reconciliation and rollback UX

- **Defect:** backend recovery contracts exist, but developers see raw safe codes and advanced legacy/operator controls; infrastructure-plan uncertainty has no clear supported ordinary recovery flow.
- **Affected areas:** current-state error mapping/next action, Overview/Pipeline guidance, operator reconciliation endpoints, release convergence, rollback authorization.
- **Why it matters:** crash/uncertainty tests need truthful wait/reconcile/fail behavior without encouraging duplicate clicks or unsafe legacy recovery.
- **Smallest safe approach:** define sanitized states for progressing, reconciling, exhausted, failed-before-mutation, failed-after-mutation, and rollback-eligible. Developer UI offers wait/retry-contact guidance only; exact reconciliation/rollback commands are operator/admin and reuse frozen identities/journals.
- **Dependencies:** P0-1, P0-3, P1-5.
- **Acceptance evidence:** disposable failure injection at image push, task registration, service update, plan, and apply boundaries; restart/concurrency do not repeat mutations; bounded exhaustion is terminal/sanitized; rollback appears only with a proven stable predecessor; all locks/leases/claims clean.
- **Regression risk:** enabling retry after a mutation or hiding actionable operator evidence.
- **Rollback/recovery:** disable new commands and fall back to read-only blocked/manual-review state; never revive terminal outboxes.

### P1-7 — Complete controlled failure/rollback AWS matrix

- **Defect:** live evidence does not cover concurrent commits, cross-lane contention, worker crash after every mutation, unhealthy candidate rollback, partial Terraform apply, or the five ordinary no-Terraform releases required by the target acceptance contract.
- **Affected areas:** all normal-v1 workers, ownership/fencing/journals, AWS read/reconciliation, test runbook.
- **Why it matters:** these are the safety claims that distinguish a supervised deployment platform from a happy-path script.
- **Smallest safe approach:** run one bounded scenario at a time on one disposable project with immutable evidence snapshots and mutation counters. Inspect journals/AWS before every retry; never combine destructive cleanup with diagnosis.
- **Dependencies:** all P0 tasks and P1-1 through P1-6.
- **Acceptance evidence:** scenario-specific durable/AWS proofs; no repeated external mutation; one effective owner; correct stable/candidate separation; rollback only when eligible; five later releases invoke no Terraform; full cleanup after each case.
- **Regression risk:** AWS cost, quota use, or service disruption.
- **Rollback/recovery:** isolate project/account resources, retain remote state/history, use only contract-approved rollback, and stop at ambiguity.

## UI simplification

### P1-8 — Separate developer UI from operator/admin controls

- **Defect:** developer navigation exposes Terraform state/recovery/force-unlock, infrastructure internals, cleanup/destroy, storage recovery, orchestration rollback/scaling, ARNs, and other cloud details; some controls call retired or compatibility endpoints.
- **Affected areas:** sidebar/routes, Overview, Pipeline, Infrastructure, Terraform State, Storage, Orchestration, Settings, role authorization.
- **Why it matters:** the product does not yet meet the minimum Railway-like developer experience and exposes unsafe/unsupported actions.
- **Smallest safe approach:** make Overview, Deployments, Environment, Logs, Metrics, and Settings the developer surface. Move infrastructure approval, state/lock, cleanup, recovery, raw identities, journals, and worker health to an operator/admin route protected on both frontend and backend. Remove unsupported buttons rather than leaving dead actions.
- **Dependencies:** P0-3 and P1-5 so one canonical Deploy action replaces removed paths.
- **Acceptance evidence:** route/button/API inventory proves developers cannot invoke legacy/Terraform/recovery/cleanup mutations; owner/developer sees the minimum pages and canonical phases; operator/admin retains only explicitly supported controls; authorization tests pass.
- **Regression risk:** hiding a required project setting or relying on frontend-only role enforcement.
- **Rollback/recovery:** restore navigation visibility only after backend authorization is confirmed; keep all dangerous backend gates default-off.

### P1-9 — Unify latest/stable/current-operation semantics and guidance

- **Defect:** Overview/Pipeline/workspace are mostly canonical, but advanced Releases/Orchestration/Logs/Metrics can use legacy compatibility readers and raw safe codes.
- **Affected areas:** frontend API clients and projections, current-state/workspace responses, error copy.
- **Why it matters:** the same project can appear live, failed, malformed, or stale across pages.
- **Smallest safe approach:** use canonical current-state/workspace summary for release identity everywhere; keep specialized logs/metrics as subordinate data keyed to the canonical operation/stable release. Map safe codes to a small documented developer guidance enum.
- **Dependencies:** P0-1, P0-2.
- **Acceptance evidence:** authenticated refresh across all minimum pages shows identical latest attempt, stable release, status, source SHA, and URL; conflict fixtures fail blocked once; no N+1 polling or fake legacy run.
- **Regression risk:** losing historical legacy visibility or mismatching log/metric identities.
- **Rollback/recovery:** retain legacy history as a clearly labelled read-only archive separate from current status.

## Optional productization and deferred work

### P2-1 — Stripe billing provider

- **Defect/missing integration:** live Stripe subscription/webhook behavior is intentionally unconfigured; local gates/idempotency contracts do not equal provider proof.
- **Affected areas:** billing adapter, webhook ingress, plan/usage productization.
- **Why it matters:** commercial productization only; not core deployment safety.
- **Smallest safe approach:** keep `BILLING_PROVIDER_ENABLED=false` until product scope, credentials, webhook endpoint, price model, and test account are approved. Then run provider sandbox idempotency/order tests.
- **Dependencies:** commercial scope and provider credentials.
- **Acceptance evidence:** signed sandbox webhooks, duplicate/out-of-order handling, durable entitlement projection, no deployment mutation.
- **Regression risk:** incorrect entitlement or accidental charges.
- **Rollback/recovery:** disable provider gate and preserve last durable entitlement for operator review.

### P2-2 — SNS notification delivery

- **Defect/missing integration:** live SNS delivery is intentionally disabled; retry/deduplication is locally proven only.
- **Affected areas:** notification adapter, delivery worker/observability.
- **Why it matters:** delivery polish, not deployment correctness.
- **Smallest safe approach:** keep `NOTIFICATION_DELIVERY_ENABLED=false`; later add exact topic/account/region scope and provider sandbox evidence without coupling deployment finalization to notification success.
- **Dependencies:** notification product scope and AWS messaging permission.
- **Acceptance evidence:** one terminal event produces one deduplicated notification; provider failure never changes release truth.
- **Regression risk:** duplicate messages or deployment blocked by optional delivery.
- **Rollback/recovery:** disable delivery and retain durable notification records for replay.

### P2-3 — Toolchain and documentation consolidation

- **Defect:** Node.js 20 approaches the AWS SDK support boundary, and several setup/architecture documents still instruct legacy deployment paths or bypasses.
- **Affected areas:** backend/worker base images, CI, README/setup/architecture/runbooks.
- **Why it matters:** maintainability and operator safety after the core path is corrected.
- **Smallest safe approach:** test Node.js 22 in CI/worker images; after P0/P1 behavior lands, replace stale instructions with one normal-v1 runbook and clearly label historical reports.
- **Dependencies:** stabilized normal-v1 UI/runbook; scheduled runtime upgrade window.
- **Acceptance evidence:** focused backend/worker regression on Node 22; no SDK warning; documentation endpoint/config examples match source and default-off gates.
- **Regression risk:** native dependency/build changes or documentation racing implementation.
- **Rollback/recovery:** retain pinned Node 20 image temporarily while dependency incompatibilities are resolved; revert documentation independently.

## Dependency order for controlled acceptance

1. P0-1 status/lineage projection.
2. P0-2 production security scan.
3. P1-1 reproducible least-privilege workers.
4. P0-3 first-release next-action workflow.
5. P1-2 and P1-3 read/no-op command hardening.
6. P1-5 and P1-6 remove conflicting mutation paths and make recovery truthful.
7. Isolated browser/PostgreSQL/Redis acceptance.
8. One disposable live first deployment.
9. P1-4 release-only canary.
10. P1-7 controlled failure/rollback matrix.
11. P1-8/P1-9 UI consolidation can proceed alongside late failure-matrix work once the canonical action contract is stable.

No schema-reconciliation task is included: that work is outside this deployment audit and no current runtime defect requires reopening it. No task authorizes mutation of Smart Retail, Project-Tst, queues, or AWS until its stated dependencies and approval are satisfied.
