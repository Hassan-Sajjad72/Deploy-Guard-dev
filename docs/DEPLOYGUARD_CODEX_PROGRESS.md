# DeployGuard stabilization progress

Updated: 2026-10-10 (Asia/Karachi).

## Scope and authority

- Base: `origin/version1`, fetched during this run, `3ac3d951f9a339a177a627acd306fc54bc6b8ac1`.
- Work branch: `codex/m0-workflow-identity-20261010`.
- Worktree: `/tmp/deployguard-m0-kGHmNq/checkout`; original worktree's deletions, untracked specification and document files were preserved.
- Specification reviewed: owner-provided `backend/MASTER-PLAN.md`, v2.1, in the original worktree. It is untracked there and absent from the published baseline. Charter, R0/working rules, M0, dependencies, reporting and as-is sections informed this slice.
- The specification records R0 as NOT SIGNED OFF. The owner's current message explicitly authorizes existing-system stabilization. This run treats that as authority for M0 maintenance only, not approval of the future product decisions or M1–M19 implementation.
- Milestone: **M0 in progress; M0.1 workflow-run identity locally verified**. Full M0 completion remains blocked by the defects and certification gaps below.
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
