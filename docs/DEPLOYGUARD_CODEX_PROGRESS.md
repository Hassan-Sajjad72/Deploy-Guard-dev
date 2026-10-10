# DeployGuard stabilization progress

Updated: 2026-10-10 (Asia/Karachi).

## Scope and authority

- Base: `origin/version1`, fetched during this run, `3ac3d951f9a339a177a627acd306fc54bc6b8ac1`.
- Work branch: `codex/m0-workflow-identity-20261010`.
- Worktree: `/tmp/deployguard-m0-kGHmNq/checkout`; original worktree's deletions, untracked specification and document files were preserved.
- Specification reviewed: owner-provided `backend/MASTER-PLAN.md`, v2.1, in the original worktree. It is untracked there and absent from the published baseline. Charter, R0/working rules, M0, dependencies, reporting and as-is sections informed this slice.
- The specification records R0 as NOT SIGNED OFF. The owner's current message explicitly authorizes existing-system stabilization. This run treats that as authority for M0 maintenance only, not approval of the future product decisions or M1–M19 implementation.
- Milestone: **M0 release blocked; M0.1–M0.9 locally verified**. The latest appended section owns current status. Earlier sections retain historical failures and next steps, superseded by later evidence; full M0 and AWS cleanup are not certified.
- No AWS API mutation, live workflow dispatch, Terraform apply/destroy, production DB access, dependency upgrade, schema migration or feature work was executed. GitHub reads for immutable action checks and local mocked provider tests are identified separately below.
- Tools: Node `v22.23.2`, npm `10.9.8`, Terraform `v1.15.8`; existing backend/frontend lockfiles retained. Installed dependencies were reused through local symlinks; this was not a fresh npm-ci reproducibility certification. Workflow Terraform remains pinned to `1.10.5`, so local Terraform-version parity is unverified.

## Confirmed defect and bounded fix

**Before:** a numeric dispatch receipt could become authoritative without operation correlation. When that ID was excluded, `findWorkflowRunAfter` selected the first recent workflow run regardless of operation. Exact-title discovery inspected only page one and selected the first match even when more than one run matched.

**Reproduction:** `verify-workflow-run-identity.ts` against the unchanged implementation returned run `30` (another operation) instead of `20` (the requested operation). Assertion failed with `'30' !== '20'`.

**After:** dispatch and interrupted recovery use the same exact-operation lookup. It requires a valid operation UUID, scopes the request to the configured workflow/registration branch/event/time range, inspects pagination, respects excluded IDs, and accepts only one matching run. Ambiguous, malformed, unavailable or truncated results retain uncertainty rather than enabling another dispatch. Numeric receipt IDs and receipt URLs no longer override observed identity. Removed the time-only lookup after verifying it had no remaining callers.

The lookup uses GitHub's documented page and creation-time filters, and rejects its filtered-search cap rather than assuming the listing is complete: [GitHub workflow-run API](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow).

Changed files: `backend/src/projects/pipeline/github-actions.service.ts`, `backend/scripts/verify-workflow-run-identity.ts`, `backend/package.json`, this progress file. The new regression check is registered in `test:lifecycle-properties`. No workflow executable or Terraform bytes changed.

## Existing system assessment

| Boundary | Evidence and present status |
| --- | --- |
| Application structure | NestJS `AppModule`/`ProjectsModule` retain the modular monolith; React/Vite builds. Existing historical entities remain registered, but retired mutation modules are not imported by `AppModule`. Dependency checks pass. |
| Active lifecycle authority | `ProjectsController` delegates deploy/retry/reset/rollback/destroy to `RailpackDeploymentService`. Exact source, service BuildTarget/runtime revisions, ENV/secret references, and immutable operation inputs remain authoritative. Local admission/lifecycle checks pass. |
| Workflow identity | Operation-named caller, exact 40-character workflow SHA, contract inputs, immutable action pins and nine executable fingerprints verified by local checks; run selection repaired in M0.1. No real dispatch was performed. |
| Build/security/cost | Existing pinned Railpack, runtime validation, immutable image/artifact contracts, Trivy enforcement and Infracost pathways retained. Runtime/build contract fixtures pass. Image publication, actual scanning and actual cost estimation were not performed. |
| Terraform/ECS boundary | Application desired count starts at zero only when DB-attached; no global `terraform_data.database_readiness` remains. Application lifecycle ignores ECS-owned desired count/task definition. All seven mocked Terraform plans pass; no AWS provision was performed. |
| Verification/promotion | Local release tests reject incomplete/false evidence and preserve immutable image/runtime identities. Existing transport readiness can classify HTTP business errors as a LIVE runtime; it does not certify the client's business behavior. No public endpoint was tested on AWS. |
| Redeploy/rollback | Direct ECS registration/update fixtures and exact historical task-definition rollback pass with fake AWS commands. Terraform fallback remains. This is local contract proof, not real ECS execution. |
| Destroy | Confirmation/scope validation and backend finalization fixtures pass, but the workflow's absence-evidence producer has a confirmed gap; these fixtures cannot prove actual AWS cleanup. |

## Verification record

Commands below ran from this worktree. Backend scripts use `npm --prefix backend run <name>`; frontend scripts use `npm --prefix frontend run <name>`.

| Commands | Actual result / evidence type |
| --- | --- |
| Backend `build`; frontend `build` | PASS, local compilation. Backend rebuilt after the production fix. |
| Backend `test:workflow-run-identity` | Baseline reproduction FAILED; fixed version PASS. Fixtures cover stale/untrusted/empty receipts, overlap, duplicate titles across pages, interrupted recovery, excluded IDs, old/wrong-event/wrong-branch runs, HTTP/transport/JSON failures, result/page caps, invalid IDs and no redispatch. |
| Backend `test:lifecycle-properties` | PASS: 1,000 lifecycle model sequences and 250 runtime properties, then new identity, unified lifecycle, dispatch-state and destroy-authority fixtures. Model properties are not AWS execution. |
| Backend `test:dispatch-state-projection`, `test:unified-railpack-lifecycle`, `test:low-risk-defect-closure` | PASS. Includes dispatch uncertainty, concurrent admission, missing terminal evidence, stable promotion, five DB admission states, healthy DB preservation and Terraform plan/apply classification. |
| Backend `test:direct-ecs-redeploy`, `test:direct-ecs-rollback` | PASS, fake AWS script execution; exact revision, secret-version compatibility and Terraform fallback covered. |
| Backend `test:destroy-confirmation-contract`, `test:destroy-lifecycle-authority` | PASS, local fixtures only; not owned-resource absence proof. |
| Backend `test:configuration-admission` | PASS, including chained dispatch-state, Railpack/Terraform and UUID checks. |
| Backend `test:release-identity`, `test:external-action-pins`, `test:railpack-runtime-contract` | PASS: configured release `df86ae471140f8fcb8cc893316b64faf8ca37b56` has matching bytes for all nine executables; seven action call sites across five approved actions resolve upstream; mocked MongoDB plan passes. |
| `node scripts/run-workflow-lint.mjs` | PASS: one workflow, actionlint `1.7.12`, shellcheck `0.11.0`. |
| `npm run test:terraform-product-matrix` | PASS: fmt, validate, seven mock-provider plan tests. No apply or AWS observation. |
| Backend `test:architecture-dependencies` | PASS: 308 modules / 1,140 dependencies, no violations, zero legacy executable references. |
| Backend `test:failure-diagnostics` | PASS: deterministic/unknown/service-specific/secret-safe diagnostics and five terminal failure paths. |
| Backend `test:application-runtime-validation`, `test:multi-service-release`, `test:multi-service-runtime`, `test:immutable-runtime-revisions` | PASS, local fixture/script contracts including rejected localhost binding, incomplete releases, runtime identity, secret pinning, DB isolation and transport convergence. |
| Frontend `test:session-refresh`, `test:overview-lifecycle`, `test:project-state-sync`, `test:rollback-stage-monotonicity`, `test:modal-viewport-browser` | PASS; the last is local Chromium verification of dialog geometry, keyboard/focus and responsive behavior. |
| Backend `test:full-local-certification` | FAILED on baseline: `verify-deployable-services.ts:19` reads removed `frontend/src/styles.css`. Earlier builds and legacy check pass. Later commands in this chained suite did not run; selected lifecycle checks above were executed independently. |
| Frontend `test:full-local-certification` | FAILED on baseline: `verify-destroy-operation-presentation.mjs:59` requires a Destroyed filter absent from the current Projects UI. All earlier checks in its chain passed. Later commands in that chain did not run; selected checks above were executed independently. |
| Backend `test:failure-ownership` | FAILED: references removed `frontend/src/components/projects/PipelineRecoveryPanel.jsx` at line 58. Standalone failure-diagnostic checks were then run and passed. |

Release/configuration checks initially failed when the immutable workflow pin was supplied as a process variable: Nest `ConfigService({})` still reads inherited environment, defeating those tests' deliberate empty-configuration fixtures. Both checks subsequently passed using an ignored, credential-free `backend/.env` containing only the same pin from `.env.example`, without changing assertions or production security. Their sensitivity to inherited environment remains a maintenance issue.

## Unresolved defects and certification limits

1. **CONFIRMED DEFECT — destroy producer:** `.github/workflows/deployguard-reusable.yml` emits `generationResourcesRemoved`, `projectResourcesRemoved`, `terraformStateArtifactsRemoved` and `sharedPlatformUntouched` as literal true flags after Terraform destroy and limited cleanup. It lacks independent exact-scope absence checks for all owned ECS tasks/services, ALB/listeners/target groups, DB/EFS/Cloud Map/IAM/SG/log resources and state locks. S3 head-object failure is treated as absence even if caused by authorization/provider error; forced secret deletion is not independently checked for convergence. Do not certify cleanup from the passing backend fixtures.
2. **CONFIRMED DEFECT — baseline verification drift:** missing stylesheet, missing recovery panel, and stale Destroyed-filter expectation break the full suites. Reconcile each assertion with the supported current consumer while retaining equivalent behavioral/security checks. Do not restore obsolete UI or delete assertions just to obtain green tests.
3. **UNVERIFIED:** already-persisted historical run IDs are not independently operation-title-validated by the current reconciliation reader. M0.1 prevents newly acquired wrong bindings; no migration or historical data repair was attempted.
4. **UNVERIFIED:** disposable PostgreSQL migrations/API/full-stack integration and all remaining full-suite checks. No shared or production DB was accessed. A dedicated disposable test environment is needed before the M0 gate.
5. **UNVERIFIED:** AWS first deploy, dynamic MySQL task-IP grants, DB readiness failure evidence, true ECS rolling stability, public endpoint/business read-write, redeploy, immutable rollback, topology-apply ownership and idempotent exact-scope destroy on the tested SHA. No AWS E2E PASS is claimed.
6. **UNVERIFIED:** external fixture caller's exact SHA, cloud account permissions/cost approval and pinned workflow Terraform-version parity. Existing workflow fingerprints were preserved because executable bytes are unchanged.

## Prerequisites for later work

- Intelligence Harness: finish M0, agree and persist the future requirements baseline, establish M0S AWS permission/ownership/safety controls, then validate M1 snapshot/plan and M2/M3 build/ENV evidence. Define versioned advisory evidence, freshness/uncertainty and redaction rules; decide optional AI consent/provider/retention/spending. An existing AI troubleshooting module is not proof of a complete Harness.
- Multi-client workflow: approved agency/client/engagement/environment ownership, per-client resource/state/secret isolation and authorization tests, account strategy/BYOC decisions, quotas/cost attribution/audit/handoff contracts. Current user/project RBAC and one prototype AWS account are not certification of tenant isolation.
- AWS certification: explicit account/region/resource scope, spend cap, approver and teardown window, disposable representative fixtures, exact published 40-character caller pin and validated 64-character executable fingerprints. Obtain approval before any live provisioning or destructive test.

## Next exact step

M0.2: repair the three verified test-consumer drift failures against the current supported stylesheet/pipeline/Projects surfaces, retaining their original admission, ownership, failure and destruction guarantees; rerun the complete local suites in a disposable local DB environment. Then take a separate M0 slice for independent exact-scope destroy absence evidence, provider-denial and eventual-consistency fixtures. Keep AWS execution gated and do not begin Harness or multi-client implementation.

SAFE_TO_CONTINUE: YES for bounded local M0 stabilization; NO for product expansion or live AWS writes without their prerequisites.

## M0.2 — requested consumer repair and next deletion-observer slice (2026-10-10)

Baseline: local `2edbd38f0f9bef93c47b3e6c0ef354f976da5a90` on
`codex/m0-workflow-identity-20261010`; fetched `origin/version1` remained
`3ac3d951f9a339a177a627acd306fc54bc6b8ac1`. The original workspace and its
pre-existing changes remain untouched. Work is local; no push, merge, live AWS
execution, or product milestone expansion was performed.

### Consumer repair — PASS for the three requested checks

- `verify-deployable-services.ts` follows the active application/deployment CSS
  import graph, checks bounded vertical scrolling on the actual tree selector,
  and checks the real add-service handler/fresh UUID and canonical public-service
  selection. Exact-SHA, service admission, port, and all other safety assertions
  remain intact. No frontend behavior was modified.
- `verify-failure-ownership.ts` follows latest/historical operation-correlated
  links from PipelineExecution to Troubleshoot and verifies owner/code/service
  rendering from authoritative diagnosis/history. Every classifier and AI
  no-override assertion remains intact.
- `verify-destroy-operation-presentation.mjs` checks destroyed rows in the active
  All view and canonical presenter rather than a retired dedicated filter. It
  additionally verifies authoritative DESTROYED beats stale LIVE fallback and
  workflow completion still displays "Verifying deletion" until verified. The
  guarded confirmation, duplicate-control, retry, and Admin filter checks remain.

### Rerun evidence — not an all-green certification

Commands ran against disposable local PostgreSQL containers only. AWS credentials
were not populated. Temporary `.env` fixtures were confined to this worktree.

- Backend/frontend builds: PASS.
- All 44 non-wrapper backend `test:*` scripts were attempted independently, with
  no fail-fast hiding downstream checks: 41 initially passed; billing migration
  initially failed because the fixture database was empty, then PASS after the
  full migration chain and its required 32+ character fixture session secret were
  supplied. **Final distinct result: 42 PASS, 2 CONFIRMED DEFECT.** The raw initial
  run honestly retains `FAILED_CHECKS=3`; the successful billing rerun is separate.
- Frontend full local certification: all 24 checks PASS; extra session-refresh
  and billing/Trivy checks also PASS. Browser modal tests are local, not AWS E2E.
- Workflow actionlint/ShellCheck: PASS. Terraform fmt/validate and mocked matrix:
  PASS, 7 tests. Root canonical environment and live-app runner fixture checks:
  PASS. Cost-evidence and Infracost CLI checks were also run separately because
  their containing developer-runtime chain failed before reaching them: PASS.
- Direct ECS redeploy/rollback, workflow identity, lifecycle properties,
  architecture, admission, release identity, ownership, failure diagnostics,
  destroy-authority and local multi-user/schema checks: PASS (mocked/local).
- Docker fallback executable build initially hit Docker Hub auth HTTP 504; its
  independent retry PASS, including non-root execution and secret-history checks.
  No Docker/security assertion was disabled.
- Full-stack runner started real local Nest/React/PostgreSQL and applied migrations
  from zero, but **all 7 Playwright tests failed**. Five wait on retired
  `.new-project-fields select` selectors, one expects removed general project
  configuration in Settings, and one expects the retired "Connect GitHub App"
  heading. Screenshots and traces exist; post-browser persistence certification
  was not reached and is UNVERIFIED. The runner prints a hardcoded migration
  count of 101; the separately migrated fixture contains 111 recorded migrations.
- Remaining backend failures: `test:developer-runtime-experience` assumes the old
  inline Source/Build/ECR/ECS/ALB/Application presentation;
  `test:product-maturity-certification` reads the removed Sidebar component.
  These were not silently repaired, skipped, or used to justify an all-green claim.

Evidence retained locally: `/tmp/deployguard-m0-all-backend.log`,
`/tmp/deployguard-m0-pre-final.log`, `/tmp/deployguard-m0-frontend.log`,
`/tmp/deployguard-m0-full-stack.log`, `/tmp/deployguard-m0-migrations.log`,
`/tmp/deployguard-m0-fixture-runner.log`, and this worktree's
`frontend/test-results/` (screenshots, video, trace, error contexts).

### Next bounded slice executed — independent read-only observer

Used `aws-infrastructure-auditor` to constrain verification to exact retained
ownership evidence, not inventory discovery or deletion. Added the standalone
`observe-deletion.mjs` component and `test:independent-aws-deletion`; no dependency,
Terraform resource, database semantics, or dispatch workflow changed.

Local fixtures PASS for all current Terraform managed resource types, 17 observed
resource kinds, state/lock objects, shared-parent exclusions, secret redaction,
lingering resources, bounded convergence, typed provider errors, account mismatch,
malformed/truncated responses, and exact ECS identity. ECS service IDs follow the
current AWS provider's `id` ARN, not a nonexistent `arn` attribute. A deleted-cluster
exception only proves service absence after that exact cluster independently
passes absence observation.

**CONFIRMED DEFECT remains in the existing destroy workflow:** its v2 success
booleans still are not derived from this independent observer. This slice does
not wire it into finalization or claim a complete owned-resource manifest. See
`docs/M0_DELETION_OBSERVER.md` for ownership coverage and the gated integration.
Existing nine dispatched executable fingerprints and configured immutable
workflow bytes remain unchanged; the standalone observer is not yet in that
certified executable set.

AWS_E2E_STATUS: UNVERIFIED. No AWS calls or AWS mutations were executed.
M0 completion, Harness, and multi-client readiness remain UNVERIFIED. Their
previous prerequisites still apply: green supported-consumer checks; durable,
complete generation/release/resource evidence; tenant authorization and immutable
identity; exact-SHA real deploy/redeploy/rollback/destroy proof; and explicit
approval before cloud mutations. No product features were started.

NEXT_BOUNDED_STEP: repair the newly exposed two backend and seven browser consumer
mismatches against the current supported surfaces, retaining behavioral/security
assertions. Then separately persist complete pre-destroy ownership evidence across
partial failures/retries and gate workflow finalization on independent absence
observations. Publication, SHA-256 certification refresh, exact fixture caller pin,
and approved AWS execution follow only after local contracts pass.

## M0.3 — remaining certification consumers closed (2026-10-10)

Status: DONE_WITH_CONCERNS. This bounded local test-consumer milestone is complete;
M0 as a whole and real AWS cleanup certification are not complete. The earlier
AGENTS.md instructions were revoked by the user for this continuation. The
original M0 architecture, no-feature, security, and live-AWS safety requirements
remain in force. Work continued from `0631d2963dc327ecef09ff3a64865e489eeb5bcb`
on `codex/m0-workflow-identity-20261010`, isolated from the original worktree.

### Debug report

**Symptom:** two backend certification consumers and seven browser tests failed
against removed UI paths, selectors, and labels. Zero-to-head migrations were
reported with a hardcoded obsolete count.

**Root cause:** tests still assumed Sidebar/Dashboard ownership, an inline
infrastructure pipeline, and project-editing forms in Settings. The supported
frontend uses AppHeader, evidence-driven topology and metric labels, creation
inputs on the deployment page, and notification/lifecycle-only Settings. The
existing backend configuration APIs remain supported. A later database fixture
failure expected disabled persistence without requesting it; managed persistence
defaults to enabled.

**Scope / files changed:**

- `backend/scripts/verify-developer-runtime-experience.ts`: verifies source/build
  stages on their current owning surface, stable source identity, every topology
  inspector, immutable service identity, joint ECS/ALB health, exact resource
  disclosure, and metric-key-to-label mappings. Observation, provider-error,
  secret redaction, cost authority, and exact-plan assertions remain intact.
- `backend/scripts/verify-product-maturity-certification.ts`: follows the mounted
  AppHeader navigation and Projects polling owner; checks canonical failure stage
  labels and provider-reported Stripe test mode. Workspace reconciliation,
  observation coalescing, query throttling, protected billing, and retired-route
  assertions remain intact.
- `frontend/e2e/full-stack.spec.js`: selects controls by exact accessible names,
  verifies canonical multi-service directory/entrypoint payloads, retained tree
  expansion/search/scrolling/race/manual-entry behavior, and exact level-one page
  headings before and after reload. Existing configuration mutations use the
  real Nest API and real PostgreSQL rather than removed Settings forms. All nine
  mutation contracts, response masking, selected-service deletion rejection,
  destroy confirmation, rollback candidates, current/detailed-state agreement,
  and read-only/deploy authorization checks remain. Read-only assertions now
  inspect real disabled email/archive controls rather than an absent retired
  button. Managed persistence's enabled default is asserted; the final fixture
  explicitly requests disabled persistence, preserving its existing exact SQL
  assertion. This is **not** browser proof for retired configuration forms.
- `backend/scripts/run-real-full-stack-certification.ts`: counts actual recorded
  migrations and labels measured configuration work as API mutations, not browser
  mutations. Existing encryption-at-rest, service isolation, database attachment,
  foreign-key/uniqueness, immutable release, retry-history and cascade assertions
  were not removed or weakened. Release/destroy records inserted by this harness
  are synthetic persistence fixtures, not AWS execution evidence.
- This progress report.

No production UI/backend, Terraform, workflow, dependency, or deployment
fingerprint changed. The investigate skill required reproduced failures and
current ownership tracing before adapting the consumers; it kept production
changes out of this test-only slice.

### Executed verification

Before edits, both failing backend checks reproduced their original failures.
The previous seven browser failures were supported by retained logs and traces.
The first repaired browser run passed six tests; the seventh exposed ambiguous
heading matching, fixed with exact level-one assertions. The next run passed all
seven browser tests and exposed the implicit persistence fixture mismatch. The
final clean aggregate passed both browser and subsequent real database checks.

`npm --prefix backend run test:pre-final-certification`: **PASS, exit 0**.
Selected literal output from `/tmp/deployguard-m0-consumers-pre-final.log`:

```text
POSTGRES_MIGRATIONS_FROM_ZERO=PASS COUNT=111
7 passed (20.5s)
PLAYWRIGHT_FULL_STACK=PASS API_MUTATIONS=9 BROWSER_SURFACES=5 GITHUB_SELECTION=EXPECTED_BLOCKER
POSTGRES_INTEGRATION=PASS MIGRATIONS_FROM_ZERO=1 SERVICE_ENV_ISOLATION=1 DATABASE_ATTACHMENT=1 CASCADE=1 LIVE_UNIQUENESS=1
CROSS_PAGE_DATA_CONSISTENCY=PASS OVERVIEW_PIPELINE_INFRASTRUCTURE_MONITORING_SETTINGS=1
GITHUB_WORKFLOW_LINT=PASS WORKFLOWS=1 ACTIONLINT=1.7.12 SHELLCHECK=0.11.0
LIFECYCLE_PROPERTY_TESTS=PASS SEED=20260831 RUNS=1000 RUNTIME_RUNS=250
UUID_ADMISSION_CONTRACT=PASS ACTIVE_CONTROLLERS=5
```

The same clean gate passed backend/frontend builds, all 24 frontend local checks
(including modal browser certification), all full-local backend consumers, API
equivalence, Terraform fmt/validate and 7 mocked matrix tests, lifecycle identity
and state tests, architecture checks (308 modules, 1140 dependencies, zero
violations), and configuration admission. No assertion was disabled and no
failing check was skipped.

Remaining registered non-wrapper backend checks were also executed: independent
AWS deletion observer, direct ECS redeploy/rollback, deployment requirements,
Terraform export, billing subscriptions, Stripe billing, notifications, Trivy
controls, and billing migration: **PASS**. Additional frontend session-refresh
and billing/Trivy checks, root canonical environment verification, and live-app
runner **fixture** verification: **PASS**. Together these cover all 44 registered
non-wrapper backend checks. Billing verification ran against the separately
migrated disposable local database with its required long fixture session secret.

Evidence: `/tmp/deployguard-m0-consumers-pre-final.log`,
`/tmp/deployguard-m0-consumer-runtime-before.log`,
`/tmp/deployguard-m0-consumer-maturity-before.log`,
`/tmp/deployguard-m0-consumer-runtime-after.log`,
`/tmp/deployguard-m0-consumer-maturity-after.log`,
`/tmp/deployguard-m0-consumers-full-stack.log`,
`/tmp/deployguard-m0-consumers-full-stack-confirm.log`, and
`/tmp/deployguard-m0-consumers-migrations.log`. Temporary containers and ignored
environment fixtures were restricted to this local checkout; original data and
running services were not changed.

### Remaining concerns / next bounded step

- Real GitHub repository selection: EXPECTED BLOCKER; no GitHub App installation
  is connected for the isolated fixture user. The supported connection/admission
  UI was verified, but real GitHub execution was not certified.
- AWS_E2E_STATUS: UNVERIFIED. No live AWS resource operations were performed.
  Existing destroy success flags are still not gated by the independent observer.
- Next: retain complete, immutable owned-resource manifests across partial
  failure/retry, then separately gate destroy finalization on independent exact
  absence observations. See `docs/M0_DELETION_OBSERVER.md`. Only after that
  integration passes contracts should changed cloud executable fingerprints be
  certified, the control-plane commit published, and a fixture pinned to its exact
  40-character SHA for an explicitly approved disposable AWS exercise.
- Intelligence Harness and multi-client implementation remain gated. Green local
  consumers satisfy one prerequisite, not durable evidence completeness,
  tenant-boundary proof, release publication, or real AWS lifecycle certification.

## M0.4 — immutable deletion-manifest retention transport (2026-10-10)

Status: **PASS — local transport and regression gates; production integration
and AWS cleanup UNVERIFIED**.

Baseline: `8d9f9525db7aeb6bce46e69a50390af620605050` on the existing isolated
M0 branch/worktree. Read-only `git ls-remote origin refs/heads/version1`
reconfirmed `3ac3d951f9a339a177a627acd306fc54bc6b8ac1`. Original `version1`
and its pre-existing file deletions/untracked documents remain untouched.

This is one bounded **local evidence-retention** slice, not complete M0, not
production cleanup integration, and not new product work. The infrastructure
auditor and lifecycle certifier skills required tracing actual Terraform,
direct-ECS, immutable generation and finalization ownership before implementation.
Their architecture reference is stale (test1); current source remains schema v3 /
release-result v5 and destroy-result v2, with nine dispatched executable hashes.

### Changes and reproduced boundaries

- Added `infrastructure/railpack-runtime/retain-deletion-manifest.mjs`: private
  local identifier snapshot storage, atomic content-addressed publication,
  synchronized files/directories, immutable hash receipts and exact-receipt
  restoration. Reordered identical captures are idempotent and concurrent first
  publication leaves one complete snapshot. A new retry operation can retain
  prior evidence without narrowing project/environment/account/region or the
  recorded generation/resource set. No directory/tag discovery selects authority.
- Restoring a partial Terraform snapshot would lose three previously captured
  resources in the executed fixture. Restoration now unions the original and
  partial snapshots; explicitly supplied historical/direct task definitions,
  ECR, runtime secrets, and exact state/lock keys are retained too. Empty current
  state is never substituted for a prior manifest. Missing/corrupt receipt objects,
  conflicting resource parents, scope changes and unsafe/symlinked stores fail
  closed. Receipts must themselves be retained in canonical durable history.
- Reproduced a validator defect: an unexpected `rawState` object was accepted
  by `validateDeletionManifest` (expected rejection failed). Root-level unknown
  fields are now rejected, preserving the identifier-only schema and preventing
  raw-state payloads from entering this transport. No existing assertion relaxed.
- Added real-filesystem/concurrent-CLI regression coverage in
  `backend/scripts/verify-deletion-manifest-retention.mjs`. Extended
  `test:independent-aws-deletion` to run it and included that check in the
  pre-final aggregate. The restored resource set is exercised through the existing
  observer with mocked AWS responses. No new dependency/schema/API/UI feature.
- Updated `docs/M0_DELETION_OBSERVER.md` with local APIs, CLI and precise limits.

The reusable workflow, Terraform resources, backend deletion parser/finalizer,
caller pin and every certified cloud executable remain unchanged. No code yet
calls this transport from an executing lifecycle. Snapshot hashes detect altered
bytes; they do **not** authenticate ownership or prove all receipts/resources
were collected. The production completeness gap remains explicit.

### Verification

`npm --prefix backend run test:independent-aws-deletion`: **PASS**.

```text
INDEPENDENT_AWS_DELETION=PASS MOCKED_AWS_ONLY=1 READ_ONLY=1 RESOURCE_FAMILIES=17 STATE_AND_LOCK=1 RESIDUE_AND_ACCESS_FAILURE_FAIL_CLOSED=1
DELETION_MANIFEST_RETENTION=PASS LOCAL_FILES_ONLY=1 PARTIAL_RETRY_UNION=1 IMMUTABLE_HASH_RECEIPTS=1 MISSING_OR_CORRUPT_FAIL_CLOSED=1 MOCKED_OBSERVER_HANDOFF=1
```

Direct ECS redeploy and rollback fixture checks: **PASS**; no ECS execution.
Supplementary deployment requirements, Terraform export, billing subscriptions,
Stripe, notifications, Trivy, frontend session refresh/billing UI and live-app
runner fixture checks: **PASS**. The runner check is synthetic, not live-app
certification. All nine dispatched file fingerprints still match the unchanged
certified pin. JavaScript syntax checks and `git diff --check`: **PASS**.

Initial pre-final run stopped at multi-user PostgreSQL authentication because the
previous milestone's disposable fixture had been removed. The separate canonical
environment check also required explicit canonical AWS/SNS keys. Neither check
was disabled. A new labelled localhost-only disposable PostgreSQL container and
an ignored credential-free local environment supplied those prerequisites; AWS
credential fields were explicitly empty and notifications disabled. Existing
PostgreSQL/monitoring containers and the original environment were not changed.
The complete chain was rerun with these explicit local prerequisites:
`npm --prefix backend run test:pre-final-certification`: **PASS, exit 0**.
Evidence: `/tmp/deployguard-m0-retention-pre-final-confirm.log`. The initial
failed run is retained as `/tmp/deployguard-m0-retention-pre-final.log`.

```text
POSTGRES_MIGRATIONS_FROM_ZERO=PASS COUNT=111
7 passed (23.0s)
PLAYWRIGHT_FULL_STACK=PASS API_MUTATIONS=9 BROWSER_SURFACES=5 GITHUB_SELECTION=EXPECTED_BLOCKER
POSTGRES_INTEGRATION=PASS MIGRATIONS_FROM_ZERO=1 SERVICE_ENV_ISOLATION=1 DATABASE_ATTACHMENT=1 CASCADE=1 LIVE_UNIQUENESS=1
GITHUB_WORKFLOW_LINT=PASS WORKFLOWS=1 ACTIONLINT=1.7.12 SHELLCHECK=0.11.0
LIFECYCLE_PROPERTY_TESTS=PASS SEED=20260831 RUNS=1000 RUNTIME_RUNS=250
UUID_ADMISSION_CONTRACT=PASS ACTIVE_CONTROLLERS=5
```

Backend/frontend builds, all full-local consumers, actual non-root Docker fallback
build/security checks, real local PostgreSQL integration, seven browser tests,
API contracts, workflow lint, seven mocked Terraform matrix tests, lifecycle
properties, architecture boundaries (308 modules / 1140 dependencies, zero
violations), configuration admission and the new retention gate all passed.
No failing assertion was removed or security requirement weakened. Supplemental
billing migration passed after all 111 migrations on the separate disposable
fixture; evidence: `/tmp/deployguard-m0-retention-migrations.log`. Local Terraform
remains 1.15.8 versus workflow pin 1.10.5; no version-parity claim is made.
The exact labelled `deployguard-m0-retention-20261010` fixture container and its
own anonymous volume were removed after verification; all existing containers
were preserved. The ignored worktree environment was restored to its original
credential-free workflow pin. Test-owned retention directories were cleaned up.

### Ownership / lifecycle classification

| Resource family | Canonical owner | Expected action | Observed result / cleanup evidence | Status |
| --- | --- | --- | --- | --- |
| Terraform ECS/ALB/network/IAM/log/DB/EFS/Cloud Map resources | Exact owned Terraform state | Retain identifiers before mutation; restore through partial retry | Real local snapshot union and observer fixture checks; no AWS queries | PASS locally; AWS UNVERIFIED |
| Direct/historical ECS definitions, ECR, runtime secrets | Immutable revisions / validated creation evidence | Include every exact external identifier | Explicit synthetic manifest inputs preserved; production collection not integrated | PASS transport; completeness UNVERIFIED |
| State and lock objects | Exact project/environment backend keys | Retain/check exact keys; exclude shared bucket | Both keys retained and mock-observed; bucket never selected | PASS locally; AWS UNVERIFIED |

| Action | Admission identity | Workflow/result contract | Expected / actual transition | External execution | Status |
| --- | --- | --- | --- | --- | --- |
| Destroy retry | New operation, fixed owner, exact recorded generation union | Existing destroy-result/v2 unchanged | Restore all trusted receipts; missing/corrupt objects block restoration | Local filesystem + mocked observer only; finalizer not changed | PASS retention; cleanup UNVERIFIED |
| Deploy/redeploy/rollback | Existing immutable source/service/runtime identities | Existing release-result/v5 and fingerprints unchanged | Existing regression and direct-ECS fixtures retained | No GitHub dispatch or AWS execution | PASS local contracts; AWS UNVERIFIED |

### Unresolved / next bounded slice

Integrate exact ownership capture and receipt durability into the canonical
operation history for every creation attempt, including failed deployment and
direct-ECS registration, not just successful LIVE releases. Prove the complete
historical generation/service set, owned secrets/ECR, bootstrap and direct task
revisions, runtime tasks and state/lock scope are included. Then separately gate
destroy finalization on complete independent observations. No optimistic v2
success flags should be treated as cloud evidence in the interim.

AWS_E2E_STATUS: **UNVERIFIED**. Real GitHub selection remains an expected fixture
blocker. Publishing a changed workflow/certified commit and an approved disposable
AWS exercise remain prerequisites; no push, cloud mutation or destructive AWS
operation occurred. Intelligence Harness and multi-client work remain gated by
completed M0, approved requirements, M0S safety and tenant/ownership evidence.

## M0.5 — production runtime-secret ownership collection (2026-10-10)

Status: **PASS — local production-path integration and regression gates;
AWS resource cleanup UNVERIFIED**.

Baseline: `5a3ff8f8908ef5e6cd89ff1a19e8f02b5458789f`; isolated branch
`codex/m0-workflow-identity-20261010`, `/tmp/deployguard-m0-kGHmNq/checkout`.
Read-only remote check reconfirmed `origin/version1` at
`3ac3d951f9a339a177a627acd306fc54bc6b8ac1`. The owner's original worktree and
its existing deletions/untracked files remain untouched. Work is authorized M0
maintenance only; future requirements are not treated as approved.

### Bounded defect / implementation

The production backend materialized runtime secrets before workflow dispatch,
but only kept provisional mutations in an in-memory compensation array. No
durable exact-name intent or owned ARN was recorded on that path. The executed
baseline fixture created a secret and failed its expected recorder assertion
with `[]` instead of `["intent", "owned"]`. Provider-response uncertainty and
process interruption therefore lacked durable ownership-attempt evidence.

This slice closes **runtime-secret collection only**, not the whole resource
inventory or destroy gate. The infrastructure auditor and lifecycle certifier
skills required immutable operation/service scope, explicit intent-vs-owned
classification, fail-closed persistence, compensation safety and separate local
versus AWS evidence. Current source (schema v3 / release-result v5) supersedes
the skills' stale test1 architecture reference.

- `GithubActionsRuntimeSecretService.materialize` requires a recorder. The
  low-level materializer emits `intent` before any provider work, retains an
  existing owned identity before restore/version writes, and records a newly
  returned ARN before continuing. No secret values are sent to the recorder.
- `RailpackDeploymentService.dispatch` supplies the durable recorder, which
  inserts identifier-only evidence and SHA-256 receipts in existing
  `project_pipeline_events` with source `runtime_secret_ownership`. This reuses
  the existing PostgreSQL model, without migrations, dependencies or a competing
  release authority. Inserted rows survive mutable operation-metadata writes,
  terminal failure, compensation and subsequent retry. Existing control-plane
  cascade semantics remain; these hashes are not signatures/admin tamper proof.
- `runtime-secret-ownership.ts` validates exact project/operation/service,
  environment, role-derived account, region, secret namespace and physical ARN.
  It rejects unknown payload fields and version-qualified/cross-scope ARNs.
  Receipt hashing sorts keys for actual PostgreSQL JSONB round trips.
- A lost create response leaves only an intent; no ARN or absence proof is
  fabricated. Valid post-create identities remain compensable if receipt
  insertion fails. Invalid identities do not enter the compensation list.
  Prior-version candidates are tracked before writes whose responses may be
  ambiguous; compensation still stops after possible remote workflow acceptance.
- Storage/validation failures are platform-owned
  `DG_RUNTIME_SECRET_OWNERSHIP_PERSISTENCE_FAILED`, not AWS failures. The existing
  diagnostic catalogue marks retry `NOT_SAFE_YET` until persistence/scope and any
  ambiguous write are reconciled. Raw storage errors are not public diagnostics.
- Added `test:runtime-secret-ownership` to the pre-final aggregate and extended
  the actual admission/dispatch fixture to require and execute the recorder.
  Existing admission, service isolation, immutable snapshot, compensation and
  lifecycle assertions were retained. The production collector tests use
  injected provider calls, not live AWS execution.

NestJS/React, GitHub Actions, Railpack, Terraform and ECS contracts are preserved.
No workflow, Terraform, immutable caller pin, cloud executable fingerprint,
destroy parser/finalizer, product feature or AWS resource changed in this slice.

### Verification

New collector check: **PASS**, using real disposable PostgreSQL after all 111
migrations and mocked Secrets Manager. It exercises actual journal inserts,
JSONB hash stability, failed-operation metadata replacement, a real retry,
ambiguous create/version writes, a database-triggered post-create insert failure,
exact compensation, and exclusion of cross-account compensation candidates.

```text
RUNTIME_SECRET_OWNERSHIP_UNIT=PASS INTENT_BEFORE_PROVIDER=1 OWNED_BEFORE_EXISTING_MUTATION=1 SECRET_VALUES_RETAINED=0 FAILURE_OWNER=PLATFORM
RUNTIME_SECRET_OWNERSHIP_POSTGRES=PASS MIGRATIONS=111 APPEND_ONLY_ROWS=1 FAILURE_AND_RETRY_RETAINED=1 AMBIGUOUS_CREATE_INTENT_ONLY=1 POST_CREATE_COMPENSATION=1 AWS_EXECUTION=MOCKED
```

Evidence: `/tmp/deployguard-m0-secret-ownership.log`,
`/tmp/deployguard-m0-secret-ownership-confirm.log`,
`/tmp/deployguard-m0-secret-ownership-final.log`. Backend builds and focused
service-isolation/dispatch-state checks passed. The backend was rebuilt after
the final production changes, before the aggregate browser API started.

Supplementary direct ECS redeploy/rollback, deployment requirements, Terraform
export, billing migration/subscriptions/Stripe, notifications, Trivy, canonical
backend environment, frontend session refresh/billing UI and synthetic live-app
runner checks: **PASS**. The billing check used all 111 migrations on a separately
labelled, localhost-only disposable fixture. No production/shared database was
used. Fixture credentials are local-only, AWS credential fields empty, and
notifications disabled. Migration evidence:
`/tmp/deployguard-m0-ownership-migrations.log`; Trivy output:
`/tmp/deployguard-m0-ownership-supplemental.log`.

`npm --prefix backend run test:pre-final-certification`: **PASS, exit 0**.
Evidence: `/tmp/deployguard-m0-ownership-pre-final.log`.

```text
POSTGRES_MIGRATIONS_FROM_ZERO=PASS COUNT=111
7 passed (19.5s)
PLAYWRIGHT_FULL_STACK=PASS API_MUTATIONS=9 BROWSER_SURFACES=5 GITHUB_SELECTION=EXPECTED_BLOCKER
POSTGRES_INTEGRATION=PASS MIGRATIONS_FROM_ZERO=1 SERVICE_ENV_ISOLATION=1 DATABASE_ATTACHMENT=1 CASCADE=1 LIVE_UNIQUENESS=1
GITHUB_WORKFLOW_LINT=PASS WORKFLOWS=1 ACTIONLINT=1.7.12 SHELLCHECK=0.11.0
LIFECYCLE_PROPERTY_TESTS=PASS SEED=20260831 RUNS=1000 RUNTIME_RUNS=250
UUID_ADMISSION_CONTRACT=PASS ACTIVE_CONTROLLERS=5
```

The aggregate passed backend/frontend builds, all full-local consumers, Docker
fallback security/executable build, independent observer/retention checks, the
new PostgreSQL collector gate, real local API/browser/persistence checks, API
equivalence, workflow lint/contracts, seven mocked Terraform matrix tests,
lifecycle properties, architecture boundaries (309 modules / 1145 dependencies,
zero violations), and configuration admission. All nine dispatched executable
fingerprints still match the unchanged pin. No assertion was disabled and no
security requirement relaxed. No AWS end-to-end execution occurred; local
Terraform remains 1.15.8 versus workflow pin 1.10.5, so tool-version parity is
still unverified. Testcontainers fixtures stopped through their own cleanup.
The exact labelled `deployguard-m0-ownership-20261010` fixture container and its
own anonymous volume were removed after verification; existing containers were
preserved. The ignored worktree environment was restored to its credential-free
workflow pin. No user data or live infrastructure was deleted.

### Resource and lifecycle evidence

| Resource family | Canonical owner | Expected action | Observed result / cleanup evidence | Status |
| --- | --- | --- | --- | --- |
| Application/build runtime secrets | Admitted project/service/operation and validated exact namespace | Commit intent; retain owned ARN; preserve through failure/retry | Actual PostgreSQL rows and integrity receipts; mocked provider/compensation only | PASS local integration; AWS UNVERIFIED |
| Terraform/ECR/direct-ECS resources and running tasks | Existing immutable lifecycle ownership | Collect every create/partial failure before final deletion verification | Not implemented by this secret-only slice | UNVERIFIED |

| Action | Admission identity | Workflow/result contract | Expected / actual transition | External execution | Status |
| --- | --- | --- | --- | --- | --- |
| Deploy/retry pre-dispatch secret materialization | Immutable admitted operation/service snapshot | Schema v3 and release-result v5 unchanged | Evidence persistence failure blocks dispatch; provider uncertainty retains intent | Real local PostgreSQL; mocked AWS only | PASS local integration; AWS UNVERIFIED |
| Destroy/rollback | Historical immutable generation/service set | Existing destroy-result/v2 / release-result/v5 unchanged | No new finalization or cleanup authority granted | No dispatch or cloud execution | UNVERIFIED externally |

### Remaining defects / next bounded milestone

Collect Terraform partial-state, exact ECR repositories and direct/historical ECS
task definitions for every workflow attempt; persist those artifacts into canonical
operation history even after failure. Add running-task and full generation/service
coverage before claiming a complete deletion manifest. Legacy operations without
ownership journals remain incomplete; do not backfill them using mutable current
configuration or turn intents into owned identity without exact-name/tag proof.

Then wire the complete retained inventory into independent observation and gate
destroy finalization. Existing optimistic v2 success booleans still lack that
gate. Real AWS lifecycle remains **UNVERIFIED**; Terraform tool-version parity,
published workflow SHA/fingerprints and approved disposable account/region/spend/
teardown remain prerequisites for external execution. No push or AWS mutation
occurred. Intelligence Harness and multi-client work remain gated by complete M0,
requirements sign-off, M0S controls and tenant/resource ownership certification.

## M0.6 — observer compatibility, task evidence and lifecycle quality

User authorization now covers all remaining local M0 slices and verified logical
checkpoint commits. The user explicitly deferred live AWS verification until
account, region and exact project details are supplied. No AWS query, mutation,
workflow dispatch or publishing was performed.

- Fixed the observer's incompatible environment grammar, non-string identity
  coercion, asynchronous caller-input mutation and raw CLI parse-error disclosure.
- Added exact ECS task/cluster observations: actual STOPPED or exact MISSING is
  required. Desired STOPPED, foreign/ambiguous responses and remaining tasks cannot
  certify absence. An INACTIVE cluster alone cannot justify a child lookup error.
- Added bounded recognized transient-error retries, preserving fail-closed denial
  and clearing stale provider diagnostics. Kept all existing assertions.
- Released the runtime-secret SDK client on Nest shutdown and ensured disposable
  PostgreSQL cleanup runs even if its database teardown fails.

Verification: `test:pre-final-certification` exited 0. This includes backend/frontend
builds, supported UI/regression checks, real local PostgreSQL migrations/integration,
Playwright full-stack tests, workflow lint (actionlint/ShellCheck), producer/consumer
contracts, Terraform mock scenarios, lifecycle properties and architecture checks.
GitHub-selection fixtures retain EXPECTED BLOCKER; none is AWS execution. Log:
`/tmp/deployguard-m0-quality-pre-final.log`. Focused runtime-secret ownership tests
also passed in `/tmp/deployguard-m0-quality-ownership.log`; after the final identity
type guard, both independent-observer and retention tests were rerun successfully.

Review: exact-ID reads only, bounded retries, no new cleanup authority, dependency,
Terraform resource, workflow executable or fingerprint change. Full ownership
collection and production destroy-result gating remain the next local slices;
historical incomplete evidence must fail closed. AWS cleanup verification is
pending, not successful. The Intelligence Harness and multi-client prerequisites
listed above remain unchanged.

## M0.7 — accepted-dispatch uncertainty and bounded terminal artifacts

Independent review reproduced a malformed workflow-listing TypeError after an
accepted POST. It lost dispatch uncertainty and could enable runtime-secret
compensation while the workflow was running. Strict listing-field validation and
the accepted-POST exception boundary now preserve `dispatchMayHaveOccurred`.
The regression exercises actual Railpack compensation: 39 malformed listings and
two unexpected discovery exceptions, one POST and zero secret/provider calls.

The new artifact regressions initially failed on unbounded ZIP inflation and on
invalid archives/provider retrieval outages leaving successful workflows running
indefinitely. Archive/listing streams and inflation now have enforced byte limits,
HTTP retrieval has timeouts, duplicate entries/identities and malformed archives
fail closed, and response streams are cancelled/released on rejection. Stored,
deflated and streamed-data-descriptor ZIPs remain compatible. Terminal invalid
artifacts fail validation; temporary retrieval outages use the existing bounded
pending-evidence window and cannot promote a release. Invalid historical retry
metadata is repaired to a finite window; raw provider/ZIP bytes are not persisted.
No dependency, architecture, public workflow schema or executable fingerprint
changed. All previous assertions remain.

Verification: focused backend build, `test:github-artifact-boundaries`,
`test:workflow-run-identity`, and `test:dispatch-state-projection` passed.
`test:pre-final-certification` exited 0 in
`/tmp/deployguard-m0-artifact-pre-final.log`, including all aggregate local
build/integration/browser/architecture/lifecycle/workflow/Terraform checks.
Independent read-only review additionally tested standard ZIP compatibility.
Tests use local fixtures and injected HTTP/AWS behavior, not cloud execution.

Next: strengthen the existing deletion consumer's frozen-scope and transaction
checks, then complete production ownership/observation gating. The existing
destroy producer still emits optimistic v2 flags; it is not independently
certified. Live AWS verification remains explicitly deferred by the user.

## M0.8 — strict destroy identity and complete frozen generation scope

Reproduced two executable consumer defects: non-string generation IDs were
silently filtered from claims, and a claim including only LIVE could finalize
despite a larger frozen generation set. The parser now rejects the entire
malformed claim, enforces the existing canonical environment grammar and keeps
the v2 public shape. One shared scope matcher reuses runtime-contract validation
and requires exact project/environment/operation/source SHA plus the complete
immutable `projectDeletion.generationIds` set. Final artifact validation,
finalization, cleanup-only retry and project deletion all use it. Missing frozen
context cannot be reconstructed from mutable configuration to authorize deletion.

Project deletion revalidates the persisted operation inside its transaction,
holding a pessimistic row lock through deletion. The new regression covers
narrowed/widened/substituted identities, order independence, missing context,
revoked eligibility and the requested lock. Existing lifecycle fixture inputs
now model the actual frozen runtime input; no assertions were weakened or removed.
This is scope/concurrency protection, **not independent AWS absence proof**.

Verification: backend build; focused scope, destroy-authority, unified-lifecycle,
dispatch-projection and architecture checks passed. Full pre-final gate exited 0
both before and after the final lock addition; latest log:
`/tmp/deployguard-m0-destroy-scope-lock-pre-final.log`.
Additional direct ECS redeploy/rollback, requirements, export, billing/Stripe/
migration, notifications and Trivy checks passed in
`/tmp/deployguard-m0-extra-checks.log`. Root live-app runner fixture and extra
frontend session/billing checks passed (no live execution).

The root canonical-environment check initially failed with the pin-only worktree
environment, which is not a configured product-start fixture. It passed unchanged
against `/tmp/deployguard-m0-environment-r0YiJD`, a separate credential-free
configuration pointing only at the owned disposable local PostgreSQL container.
The original and worktree backend environment files were not overwritten.

Next local safety slice: prevent a new admission racing a verified destroy's
control-plane cleanup; check active operations/current generations under the
existing configuration lock, and verify the transaction boundary with real local
PostgreSQL. Complete production ownership collection/observation gating remains
open. No AWS query or mutation, workflow dispatch or push occurred.

## M0.9 — serialize cleanup against admission and verify real DB contention

Executed the previous checkpoint's actual admission method with a pending delete
fixture: it entered configuration admission instead of returning a cleanup
conflict (`BASELINE_CLEANUP_CONFLICT_HTTP409=false CONFIGURATION_READS=1`).
The current method blocks deploy/rollback/destroy admission while a terminal
destroy remains in `project_delete_cleanup`; cleanup-only retry remains the
existing recovery path. No AWS/provider work is authorized by this guard.

The deletion transaction now reuses the canonical configuration lock used by
admission, revalidates its locked operation, rejects any other active operation,
and compares all current persisted generation IDs to the exact verified frozen
set. It cannot cascade-delete a newly added generation or active attempt on stale
cleanup authority. No provider call was moved into the locked transaction.

The expanded scope test migrates a separate disposable PostgreSQL from zero,
uses the actual service and repositories with injected notification/GitHub
adapters, verifies real admission conflicts and generation drift, and contends
from a second DB connection at the final deletion boundary. It observes the
configuration lock held, a blocked authority-row update (`55P03`), and successful
project/operation/generation cascade only after eligible scope passes. Every
fixture connection/container is closed in `finally`. No assertion was weakened.

Verification: focused build/scope/dispatch checks passed.
`test:pre-final-certification` exited 0 after the final simplification, in
`/tmp/deployguard-m0-cleanup-concurrency-pre-final.log`; it includes the real DB
contention test, backend/frontend builds, full local browser/integration suites,
workflow lint/contracts, Terraform mock matrix, lifecycle and architecture checks.
AWS cleanup remains explicitly deferred, **UNVERIFIED**, not a blocker to local
test execution. The detailed verified review is `docs/M0_VERIFIED_REPORT.md`.

### Actual next authorization boundary

**Release remains blocked by the known destroy proof gap.** The frozen generation
set protects identity, not inventory completeness or AWS absence. The current
public v2 workflow cannot supply complete retained ownership/observation evidence,
and historical operations lack Terraform/ECR/direct-ECS provenance. Accepting its
optimistic flags as independent proof is not an option.

Before a compatibility-affecting producer/consumer replacement, the owner was
asked to approve a versioned stricter destroy contract and fail-closed automatic
deletion for historical runs until ownership is recovered. Alternatively, retain
the current contract and keep release blocked. This is a real legacy-compatibility
decision, not a request to run AWS. No replacement, push or workflow dispatch was
assumed authorized. All completed local safety fixes remain checkpointed.

## M0.10 — approved strict destroy proof and fail-closed historical deletion

The owner approved a stricter versioned destroy contract and fail-closed legacy
deletion on 2026-10-10. This does not authorize publication or AWS execution.
Backend admission now freezes complete operation-bound ownership receipts,
including failed attempts, into immutable destroy context. Missing, duplicated,
corrupt, incomplete or ambiguous historical journals block admission. State and
lock identities remain exact project/environment keys; the shared bucket is not
a deletion target. Stable hashing and normalized manifests survive JSONB key order.

Destroy v3 requires exact frozen ownership and per-resource observer observations,
scope, hashes, timestamps, typed absence or supported inactive/stopped states.
Legacy v2 flags cannot authorize cleanup, retry, ancestor projection or success
notifications. Eligibility still requires the validated terminal cleanup state;
raw proof cannot revive a running or validation-failed operation. Validated
cleanup failures retain the existing cleanup-only retry path.

Initial new-code compilation failed on TypeScript narrowing and was corrected
without suppression. The existing notifications consumer initially failed because
its positive fixture supplied only a boolean marker; it now supplies the full
simulated v3 context and retains every original assertion. A negative legacy
notification assertion was added. Notifications now run in the aggregate gate.

Final verification: `test:pre-final-certification` exited 0 against the final
source, `/tmp/deployguard-m0-v3-eligibility-final-pre-final.log`. Focused v3,
lifecycle, notification and real PostgreSQL scope/contention checks also passed.
No assertions were weakened, dependencies added or deployment workflow/certified
executable fingerprints changed. Architecture, security, error handling, retry
eligibility, JSONB integrity and unrelated-diff review were completed locally.

This is a backend safety foundation, NOT complete ownership collection or AWS
certification. No production publisher yet emits the complete ownership journal;
all unprovable historical destruction therefore fails closed. Next bounded work
must revalidate frozen receipts against durable authority before external cleanup
and again before the DB cascade, then address complete production collection and
workflow integration. Live AWS verification remains pending by owner direction.

## M0.11 — durable ownership revalidation at both cleanup boundaries

Admission and deletion now reuse one bounded durable ownership reader. It covers
every relevant operation, including failed attempts that never became generations;
unknown historical environments are not silently excluded. Missing, duplicate,
corrupt or changed journals cannot remain authoritative just because a previously
frozen manifest hashes correctly.

Deletion re-reads its locked persisted operation, active-operation and generation
set, and every retained receipt before SNS/GitHub cleanup, then independently
repeats these checks inside the locked final DB cascade. Provider calls remain
outside DB transactions. Real PostgreSQL tests prove pre-cleanup rejection,
post-provider receipt drift preserving project history for recovery, configuration
lock/row contention and the eligible final cascade. No existing assertions were
removed. Unexpected DB/provider details no longer become public cleanup errors.

Focused build/v3/scope tests passed; the full gate exited 0 in
`/tmp/deployguard-m0-durable-revalidation-pre-final.log`. Final source also passed
the later fresh-dependency/Terraform-parity gate described below. This does not
prove inventory completeness; canonical revision/secret cross-checking and the
production collector remain pending. No AWS execution occurred.

## M0.12 — dependency security and clean/version-parity verification

A clean-checkout audit exposed seven backend production findings (including one
critical and three high) and one frontend high finding. Additional full audit
coverage exposed four high development-tooling packages. The locked dependency
versions, including exact vulnerable parent pins, were traced before changes.
The proxy/IP regression failed on the original library; the original source-map
consumer also failed the required oversized-section rejection. No application
exploit or production incident is claimed.

Targeted lock refreshes stayed within existing declared major-version contracts,
including compatible Nest/Smithy parents needed to obtain patched dependencies.
No dependency, override or product feature was added. The source-map positive
fixture initially exceeded the patched consumer's documented maximum; it was
corrected to assert BOTH rejection above the bound and unchanged code with a
nine-million-line accepted offset. The code-preservation and timeout assertions
remain. Both actual-consumer regressions and both full audits now pass with zero
vulnerabilities, including development tooling. They are mandatory aggregate
checks; no severity threshold, advisory allowlist or failed-check suppression
was introduced. Security changes are checkpointed in `54fe96a`.

Default backend/frontend `npm ci` succeeded in a separate shallow local clone.
A first full-history clone overflowed `/tmp` because Git history is 17 GB; Git
removed its failed partial copy. A shallow clone on disk succeeded without user
file cleanup. Only task-owned dependency symlinks were redirected to the fresh
install; original workspace/dependencies were preserved. HashiCorp Terraform
1.10.5 was fetched and its published SHA-256 verified, matching the workflow pin.

The final full gate exited 0 with fresh dependencies and Terraform 1.10.5:
`/tmp/deployguard-m0-clean-dependencies-terraform1105-pre-final.log`. Backend/frontend
builds, workflow lint, seven Terraform mock scenarios, local browser/API tests,
111-migration integration, actual receipt/lock-contention tests, architecture and
regressions pass. Extra direct-ECS, requirements, billing/Stripe, Trivy/export and
frontend checks passed. The first supplemental billing migration check selected
default DB credentials; it failed authentication and was rerun successfully with
explicit owned disposable-DB scope. The canonical environment check passed with a
separate credential-free fixture. No check was skipped or assertion weakened.

Next bounded work: prove that complete journals cannot omit canonical historical
service revisions or durable runtime-secret identities, then complete production
ownership collection and workflow integration. Live AWS verification remains
pending by owner direction, not silently treated as successful.

## M0.13 — canonical inventory minimum and whole-project scope

The durable reader now cross-checks full journals against every retained service
revision and runtime configuration, all validated runtime-secret intent/owned
receipts, and independent database identities. Each historical task revision must
be included; latest/LIVE task identities cannot substitute for old ones. Empty
resource journals with complete-family flags cannot erase canonical evidence.
The check rejects missing identities rather than inventing deletion authority.
Unsealed failed database configuration alone does not imply a database was created.

Review found that finalization deletes the whole project, while the old reader
excluded explicit other-environment history. The reader and finalization now
inspect all project generations/configurations/history and fail closed on mixed
or malformed environments. This is not a new cross-environment cleanup lifecycle.
Real PostgreSQL tests prove rejection before provider work for canonical task
drift, unresolved secret intents, owned secrets omitted from journals, and an
unverified other-environment generation. Existing contention, receipt-integrity,
post-provider drift, cascade, lifecycle and notification assertions remain.

Focused checks passed. The full release gate exited 0 with fresh locked
dependencies and Terraform 1.10.5:
`/tmp/deployguard-m0-canonical-coverage-pre-final.log`. Compilation, audits,
workflow lint, seven Terraform mock scenarios, local full-stack checks, 111
migrations, lifecycle properties and architecture checks all passed. Final
security, concurrency, error-handling and unrelated-diff review found no new
dependency or product feature. The public workflow and certified bytes are
unchanged. This cross-check establishes a minimum, not complete collection or
real AWS absence. Production ownership transport/collection remains next.

A read-only local reproduction also confirmed the next collector defect:
`captureDeletionManifest` accepts an explicitly prod-tagged resource into a dev
manifest when the project tag matches. This must be fixed and regression-tested
before the collector is integrated. No AWS query or mutation occurred.

## M0.14 — reject explicit collector environment contradictions

The reproduced capture defect is fixed with one pre-delegation check. A managed
resource explicitly tagged for another or malformed environment cannot enter the
current environment's inventory, even when its project tag or owned parent
matches. Matching tags preserve identifier-only output. Older absent tags are not
fabricated; capture alone still cannot grant historical completeness authority.

The new regression failed on the old implementation with a missing expected
exception: `/tmp/deployguard-m0-environment-capture-before.log`. It now passes 15
negative combinations across owned topology, untagged children and delegated
secret versions, plus matching-environment and unchanged existing assertions.
Focused observer/retention/v3-consumer checks passed. The full gate exited 0:
`/tmp/deployguard-m0-environment-capture-pre-final.log`, using fresh reviewed locks,
full audits and Terraform 1.10.5. Final diff/security/architecture review confirmed
two implementation/test files, no new dependency, no public workflow/certified
byte change and no AWS execution. Production ownership transport/collection and
the v3 producer remain unfinished; live AWS remains explicitly pending.

## M0.15 — exact workflow ownership-artifact intake

Resumed the preserved eight-file intake candidate without changing its tested
source snapshot (`2d2dbe757c93f67fad5008ddc60fe1defab79436cc900463dbe68fe81470c85f`).
The exact correlated run supplies only the bounded operation-named ownership
artifact. Immutable dispatch identity is checked again under configuration and
operation locks; identifier receipts are normalized, append-only and idempotent.
Runtime-secret coverage comes from server intent/owned pairs, including distinct
same-key build/runtime secret identities, not runner completeness declarations.
Missing/invalid/conflicting evidence remains non-authoritative and blocks destroy;
ownership intake does not weaken release promotion or terminal failure handling.

On resumption, `npm run build && npm run test:aws-ownership-ingestion` exited 0.
Real disposable PostgreSQL ran all 111 migrations and verified concurrent
idempotency, locked transport drift, failed-attempt retention and bounded append-only
conflicts. The unchanged snapshot also has the prior complete local gate's exit-0
record `/tmp/deployguard-m0-ownership-intake-pre-final.log`. Review covered canonical
module boundaries, bounded transport, secret-safe errors, locks and resource cleanup;
no dependency, migration, AWS operation or publication was introduced.

This checkpoints intake only. Complete production collection/durable write evidence
and strict v3 destruction publishing are still required by roadmap S01.
