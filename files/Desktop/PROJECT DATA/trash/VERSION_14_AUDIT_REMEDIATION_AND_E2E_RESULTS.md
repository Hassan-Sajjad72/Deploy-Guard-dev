# DeployGuard VERSION-14 Audit Remediation and E2E Results

Audit/remediation date: 2026-07-14 to 2026-07-15. Repository: the supplied `Deploy-Guard-dev` VERSION-14 workspace only.

This report distinguishes source verification, safe/mock execution, and live-provider execution. No Terraform apply or destroy was run. No ECS deployment, ALB health result, stable release, or runtime metric was fabricated.

## 1. Original six findings and reproduction evidence

| Finding | Severity | Reproduced evidence before correction |
| --- | --- | --- |
| A. Mock-state Terraform initialization | Critical | The shared template declared `backend "s3" {}` while local/mock initialization used `terraform init -backend=false`. The subsequent plan failed with `Backend initialization required`. The database's latest historical run stopped at infrastructure plan and no downstream FinOps/deployment record existed. |
| B. Frontend lifecycle order | High | `ProjectPipeline.jsx` independently grouped events with overlapping regular expressions and placed FinOps before Terraform plan, while the worker actually planned before estimating cost. |
| C. Dockerfile/Trivy semantics | High | Historical/current stage names such as `dockerfile_check`, `security_scan`, and build/security presentation caused a static Dockerfile check, image scan, and policy gate to be aggregated inconsistently. |
| D. State-lock placement | Medium | The worker acquired locks around operations, but current-state presentation modeled one later standalone lock stage. Waiting/heartbeat/release evidence was mainly infrastructure-only and could not reliably explain plan versus apply locking. |
| E. Approximately four-hour timestamp difference | Medium | Application-written `timestamp without time zone` values were approximately four hours behind PostgreSQL-generated UTC values in the audited America/New_York environment. Entities used mixed timestamp semantics for real instants. |
| F. Repeated detection/preflight | Low | Automation called detection and preflight generation unconditionally. Successful analysis had no input fingerprint, so unchanged source was rerun and changed source could not be proved stale. |

The initial audited data set contained 13 projects, 21 pipeline runs, no completed runs, no ECS deployments, no stable releases, and no runtime metric rows. Historical rows were retained.

## 2. Root cause and implemented fix for each finding

### A — Terraform backend consistency

Root cause: `-backend=false` disables backend initialization; it does not turn an S3 backend declaration into a local backend.

Fix:

- A validated per-run workspace is copied from the shared template. The shared template is never mutated during a run.
- Local/mock mode transforms only the copied `versions.tf` to an explicit local backend and performs normal `terraform init`.
- Remote mode retains S3 and initializes with a generated `backend.hcl` plus `-reconfigure`.
- A `.deployguard-backend-mode.json` marker prevents silent mode changes. A workspace containing state cannot change mode without an explicit migration/new workspace.
- Root, realpath, traversal, and symlink checks protect cleanup and execution. Reuse keeps a valid `.terraform` directory and removes only the per-run stale plan where safe.
- Backend mode is recorded in infrastructure and projected pipeline evidence.
- The safe E2E also found and fixed two genuine post-init issues: an apply-time Cloud Map value was used in `count`, and an empty pre-apply `terraform state pull` was treated as corrupt. ECS now consumes the already-created Cloud Map service ARN, and empty first-plan state is recorded as skipped/no-state.

### B — Canonical lifecycle

Root cause: backend worker behavior, current-state aggregation, and frontend grouping each owned a separate ordering model.

Fix: `pipeline-stage-registry.ts` now owns technical keys, labels, order, required/skippable semantics, source, high-level grouping, and historical aliases. Current-state exposes normalized `lifecycle` data and a lifecycle version. The Pipeline page renders this server-provided lifecycle without regex reordering.

### C — Security stage separation

Root cause: static configuration checks and post-build CVE analysis were represented through overlapping names.

Fix: worker events, metrics, presentation, notifications, and AI evidence now distinguish `dockerfile_security_check`, `docker_build`, `trivy_image_scan`, and `security_gate`. Historical aliases remain readable. Default policy blocks fixable Critical application dependencies only; High, OS/base-image Critical, and non-fixable findings warn unless strict settings are enabled.

### D — Operation-scoped locks

Root cause: lock records were operationally correct in parts of Infrastructure but lacked a normalized plan/apply projection and complete terminal handling.

Fix: plan and apply each acquire/heartbeat/release their own lock. Important lock events are mirrored into pipeline evidence with an operation prefix. Waiting, acquired, heartbeat, released, stale/orphaned, recovery-required, and release failure are projected. Queue items are terminalized after a resumed operation. Heartbeat shutdown no longer writes a misleading active heartbeat. Release remains idempotent and occurs from success/failure paths.

### E — Timestamp instants

Root cause: real instants used `timestamp without time zone`, mixing PostgreSQL UTC defaults and Node/local wall-clock writes.

Fix: the forward migration converts audited instant columns to `timestamptz`; matching TypeORM entities now declare `timestamptz`. UTC serialization remains ISO-8601 and the frontend localizes only at display time. The conversion policy is in section 7.

### F — Analysis reuse

Root cause: detection/preflight success did not identify the repository revision and relevant configuration that produced it.

Fix: stable SHA-256 input fingerprints cover repository, branch, resolved commit, app directory, detection/template/configuration inputs, and environment-variable key/secret classification. Automation reuses only a matching successful result, logs `reused` separately, and single-flights concurrent requests. Explicit detection/preflight endpoints still force reanalysis. Direct pipeline start rejects stale analysis.

## 3. Files and migrations changed

The workspace already contained in-progress Modules 13–17 files and other user changes. They were audited and preserved rather than recreated or reverted.

Primary VERSION-14 remediation files:

- Lifecycle/current state/frontend: `backend/src/projects/pipeline/pipeline-stage-registry.ts`, `pipeline-stage-presenter.ts`, `pipeline-worker.service.ts`, `pipeline.service.ts`, `pipeline-status.ts`, `pipeline.types.ts`, the three `backend/src/projects/current-state/*` model/resolver/service files, and `frontend/src/pages/ProjectPipeline.jsx`.
- Terraform/state: `backend/src/infrastructure/infrastructure.service.ts`, `terraform-runner.service.ts`, state heartbeat/lock services and state entities, `backend/terraform/base-network/main.tf`, Cloud Map outputs, and ECS service main/variables.
- Detection/preflight: `backend/src/projects/analysis-fingerprint.ts`, detection profile/workspace services, preflight service, and detection/preflight entities.
- Security/metrics/integration: pipeline worker, security policy service/config consumers, Trivy metrics, notification event mapping, and AI evidence mapping.
- Timestamp entities: audit, auth/users/projects/pipeline/security, FinOps, infrastructure, state, storage, orchestration, observability, AI, notifications, destroy, Terraform export, and billing entities representing real instants.
- Module integration: `projects.module.ts`, `app.module.ts`, data source, orchestration module/service, and Modules 13–17 service/controller/entity files where audit findings required corrections.
- Verification: `backend/scripts/verify-version14-remediation.ts`, `run-safe-version14-e2e.ts`, updated automation/security checks, existing Modules 13–17 verification scripts, and `backend/package.json`.
- Documentation: this report, `MANUAL_SETUP_FOR_TESTING_LAUNCH.md`, `MANUAL_SETUP_MODULES_13_17.md`, and `ARCHITECTURE.md`.

Migration inventory:

- Existing Modules 13–17 schema: `1760000012000-CreatePlatformExtensionTables.ts`.
- Existing provider event hardening: `1760000013000-HardenPlatformExtensionEvents.ts`.
- New forward remediation migration: `1760000014000-Version14LifecycleTimestampsAndFingerprints.ts`; it adds detection/preflight fingerprints, `apply_disabled`, indexes, and timezone-aware instant conversion.

No historical run/event migration renamed old stage data, and the database was not reset.

## 4. Canonical backend lifecycle order and old-stage aliases

| Order | Canonical high-level lifecycle | Technical stages | Important historical aliases |
| ---: | --- | --- | --- |
| 1 | Validate inputs | `validate_inputs` | `queued`, `preparing`, `readiness_check` |
| 2 | External CI validation | `external_ci_validation` | `github_actions`; optional/skippable unless required |
| 3 | Clone repository | `clone_repository` | `cloning` |
| 4 | Detect application | `stack_detection_snapshot` | exact key retained |
| 5 | Generate/check container configuration | `template_generation`, `dockerfile_security_check` | `dockerfile_generated`, `dockerignore_generated`, `dockerfile_check` |
| 6 | Build image | `docker_build` | `building_image` |
| 7 | Scan/evaluate security | `trivy_image_scan`, `security_gate` | `trivy_scan`, `security_scan`, `security_policy` |
| 8 | Push immutable image | `ecr_push` | `tagging_image`, `ecr_*` |
| 9 | Lock state and plan | `terraform_plan` plus plan-lock projection | `terraform_stage`, `infrastructure_plan`, `terraform_plan_lock`, `state_lock_plan` |
| 10 | Estimate/enforce cost | `finops_estimate`, `cost_gate` | `cost_analysis`, `cost_breakdown`, `cost_policy`, `cost_approval`, `cost_threshold` |
| 11 | Apply configuration gate | `terraform_apply_gate` | `infrastructure_apply_disabled_by_config` |
| 12 | Lock state and apply | `terraform_apply` plus apply-lock projection | `infrastructure_apply`, `terraform_apply_lock`, `state_lock_apply` |
| 13 | Optional storage | `efs` | `storage_*`, `persistent_storage`, `efs_*`, `backup_plan` |
| 14 | ECS deployment | `ecs_deploy` | `ecs_*`, `fargate_spot`, `autoscaling`, `spot_interruption` |
| 15 | Application health | `alb_health` | `alb_*` |
| 16 | Stable release | `stable_release` | `deployment_marked_stable`, `deployment_completed` |
| 17 | Observability readiness | `observability` | exact key retained |
| 18 | Complete | `complete` | `completed` |

Skipped, warning, waiting, disabled, failed, and completed statuses remain distinct. Optional/disabled stages stay visible but do not count as executed success.

## 5. Terraform local/mock versus S3/remote backend behavior

| Concern | Local/mock (`STATE_MOCK_MODE=true`) | S3/remote (`STATE_MOCK_MODE=false`) |
| --- | --- | --- |
| Shared template | Read-only source; copied per run | Read-only source; copied per run |
| Backend declaration in run copy | Explicit local backend | S3 declaration retained |
| Init | `terraform init -input=false -no-color` | Same plus `-reconfigure -backend-config=<validated backend.hcl>` |
| AWS state calls | Mock/no state bucket mutation | Bucket/versioning/encryption/public-block and S3 native lockfile configuration verification |
| State movement | Never automatic | Never automatic |
| Reuse | Same-mode workspace is idempotent | Same-mode workspace is idempotent |
| Mode change | Rejected if state exists; use a new workspace or reviewed migration | Same |
| Cleanup boundary | Validated real directory below configured root; no symlink/traversal | Same |

The remediation test performed real local `init`, `validate`, `plan`, and `show -json` with parseable plan JSON. Remote argument construction and mode guards were tested without executing AWS state changes.

## 6. State-lock behavior for plan and apply

Plan sequence: backend verification → plan lock request → acquired or queued → heartbeat → init/validate/plan/show → first-state validation skip or real-state validation → heartbeat stop → release → FinOps.

Apply sequence: FinOps/cost pass → apply-enabled gate → apply lock request → acquired or queued → heartbeat → apply/output persistence → heartbeat stop → release → storage/orchestration.

Rules:

- A waiting run stays waiting and cannot progress past Terraform.
- Lock evidence identifies `operation: plan` or `operation: apply`.
- Stale/orphan/recovery/release-failure evidence is projected into current state.
- Release is idempotent. Resumed queued operations are marked finished.
- No apply lock was acquired in the safe E2E because the apply configuration gate was disabled.

The automated checks cover resolver projection, queue terminalization helpers, mode safety, and release/heartbeat logic. A destructive worker-crash/recovery drill and two truly concurrent live workers remain a manual test before production.

## 7. Timestamp storage and migration rules

All audited real instants are stored as PostgreSQL `timestamptz` and serialized with a `Z`/offset. This includes pipeline runs/events, infrastructure operations, state/lock/queue records, deployments/releases, observability/log sessions, AI sessions/messages/results, notification delivery/subscription times, destroy/export records, billing/webhook/invoice times, users/projects, and audit records.

Legacy interpretation was determined from paired audited rows rather than applying one global shift:

- PostgreSQL-generated legacy `created_at`/`updated_at` wall times were interpreted as UTC.
- Legacy application/provider operation times written by the Node process were interpreted as `America/New_York`, matching the approximately four-hour observed difference at the audit date.
- The migration then stored the resulting instants as `timestamptz`.

Disposable-database proof seeded PostgreSQL-style `17:00` and application-style `13:00`; both migrated to `17:00Z` and displayed as `22:00+05` in Asia/Karachi. Create/start/fail/complete ordering and duration calculations now compare instants rather than ambiguous wall times.

## 8. Detection/preflight cache invalidation rules

Detection is reusable only when its status is successful and its fingerprint still matches repository identity, branch, resolved commit SHA, and normalized app directory. A changed repo, branch, app directory, commit, failed/missing result, or explicit detection request causes execution.

Preflight is reusable only when passed/passed-with-warnings and its fingerprint matches the current successful detection, commit/template/app directory, and relevant environment-variable key/secret classification. Changed detection/template/configuration, failed/missing report, or explicit generation causes execution.

Automation uses `getOrRunDetection` and `getOrGenerateReport`; direct user reanalysis remains forceful. In-process single-flight prevents duplicate concurrent work. Audit actions distinguish reuse from execution. A stale fingerprint prevents direct pipeline start.

## 9. Commands executed with pass/fail results

| Command/check | Result |
| --- | --- |
| Baseline Git status/config/docs/source/DB counts | Passed read-only inspection; dirty pre-existing worktree preserved |
| PostgreSQL `pg_isready` and Redis ping | Healthy |
| Disposable/test migration sequence | All 15 repository migrations passed after creating the repository's required legacy base fixture; VERSION-14 down/seed/up timestamp proof passed |
| Actual DB `npm run migration:run` / `migration:show` | Passed; all 15 shown `[X]`, including `1760000014000` |
| `npx tsc --noEmit` | Passed |
| `npm run build` (backend) | Passed |
| `npm run build` (frontend) | Passed; 164 modules transformed |
| `npm run test:detection` | Passed; six fixtures plus app-directory safety |
| `npm run test:auth` | Passed; email/password/session/GitHub OAuth URL |
| `npm run test:automation` | Passed |
| `npm run test:security-policy` | Passed; classification, defaults, strict cases, Dockerfile policy |
| `npm run test:docker-templates` | Passed |
| `npm run test:version14-remediation` | Passed; exact order, aliases, fingerprints, backend args/root/mode/reuse, real local Terraform smoke |
| `npm run test:ai-troubleshooting` | Passed |
| `npm run test:notifications` | Passed |
| `npm run test:infrastructure-lifecycle` | Passed |
| `npm run test:terraform-export` | Passed |
| `npm run test:billing` | Passed |
| Temporary `PORT=5101 TYPEORM_SYNCHRONIZE=false npm run start` | Passed; every module/router initialized and Nest reported successful startup; process then stopped |
| Safe E2E, first unisolated attempts | Failed honestly; a developer worker started before remediation consumed the shared queue and reproduced the old backend error |
| Safe E2E isolated regression attempts | Exposed then fixed Cloud Map unknown `count`, empty pre-apply state classification, and exercised configured Security/FinOps gates |
| Final isolated safe E2E | Passed to configured terminal pause `apply_disabled` |

No frontend lint/test/typecheck script is configured beyond the successful Vite production build. The repository's clean migration chain assumes pre-existing base auth/project tables because those base migrations are absent; see section 14.

## 10. Safe/mock end-to-end run ID and exact stage results

Final run ID: `30b40317-7a00-4928-94b2-4f7308f97adc`.

Configuration: isolated queue `pipelineQueueVersion14E2E`; external CI optional; local/mock state; mock FinOps; tier enforcement off; explicit cost approval path on; EFS default off; CVEs advisory for this controlled run; Terraform apply disabled.

Exact result sequence:

1. `validate_inputs` — passed.
2. `external_ci_validation` — skipped, internal pipeline continued.
3. `clone_repository` — passed.
4. `stack_detection_snapshot` — passed; valid cached analysis was reused only after matching fingerprints.
5. `template_generation` — Dockerfile and dockerignore passed.
6. `dockerfile_security_check` — passed with advisory warning.
7. `docker_build` — passed.
8. `trivy_image_scan` — passed execution; findings remained advisory for this run.
9. `security_gate` — passed configured policy.
10. `ecr_push` — configuration, repository, login, immutable tag, push, and lifecycle policy passed using the already configured test AWS/ECR path.
11. `terraform_plan` — plan lock acquired; heartbeat active; local backend initialized; validate, plan, and show JSON passed; no applied state existed; lock released.
12. `finops_estimate` — mock estimate and breakdown passed and remained labeled mock.
13. `cost_gate` — saved threshold required approval; the verifier approved only this run's estimate `2c3b73f6-69d2-479f-92c0-e7c09bdd799a`; the same run resumed.
14. `terraform_apply_gate` — stopped honestly as `disabled_by_config`; run status `apply_disabled`.

Furthest reached stage: Terraform apply configuration gate. EFS, Terraform apply, ECS, ALB health, stable release, observability readiness, and complete did not execute. This is the expected terminal state for the configured safe mode, not proof of a live deployment.

Final cross-table consistency check: the run is `apply_disabled` with no failure/completion timestamp or error; its infrastructure environment is `cost_check_required` with a real plan summary and no stale failure; its mock estimate is approved; and deployment count for the run is zero.

## 11. Live AWS validation status with no fabricated claims

Live Terraform apply/destroy was not authorized and was not run. Remote S3 initialization was verified through safe argument/configuration tests only. The safe run performed an ECR image push and lifecycle-policy operation using existing configured test access; no AWS credentials or resource identifiers are recorded here.

Pending live proof:

- STS account/region and least-privilege IAM review.
- Existing versioned, encrypted, private S3 state bucket with native lockfile permissions.
- Real Infracost/cost decision.
- Disposable Terraform apply.
- EFS decision, ECS task/service stability, ALB target/application health.
- Stable release, CloudWatch/runtime metrics/logs, rollback.
- Guarded cleanup with state and AWS inventory reconciliation.

Therefore DeployGuard is not declared live end-to-end complete.

## 12. Modules 13–17 verification matrix

| Module | Backend | Frontend | Persistence | Automated verification | Demo/mock status | Live/manual status |
| --- | --- | --- | --- | --- | --- | --- |
| 13 AI troubleshooting | Multi-source sanitized evidence; corrected normalized failed stage; references; structured validation; one retry/fallback; timeout/rate/quota; five-pair context | Troubleshooting page/provider labeling | Sessions, messages, results | Build and `test:ai-troubleshooting` passed; code review confirmed evidence binding and bounded context | Deterministic demo/fallback is honest | Real provider response/network/model and historical backend-error diagnosis through a live configured provider remain manual |
| 14 Notifications | Canonical event mapping; preferences; confirmed-subscription requirement; dedupe/retry/final state; audit | Notification settings panel | Preferences, subscriptions, deliveries | Build and `test:notifications` passed | Missing SNS is `skipped_unconfigured`; unconfirmed is not sent | SNS topic/IAM/email confirmation and actual provider delivery pending |
| 15 Destroy | Two confirmations, recent auth, RBAC, active run/operation/lock exclusion, bounded targets, preservation, corrected backend marker, queue/lock/finally release, retry/cancel | Destroy review/challenge panel | Challenges and operations | Build and `test:infrastructure-lifecycle` passed | Demo records `demo:no_state_mutation`, not a fake backup | Live requires disposable versioned state and separately authorized destroy/cleanup |
| 16 Terraform export | Validated root/realpath/symlink, allowlist, referenced modules, placeholders, manifest/checksums, size/expiry/ownership/quota/audit, credential-like content rejection | Infrastructure export action | Export artifacts | Build and `test:terraform-export` passed | Representative local ZIP passed | Download/expiry cleanup under deployed worker remains manual; no provider operation needed |
| 17 Billing | Backend-authoritative entitlements, transactional counters, period/downgrade behavior, hosted Stripe path, raw-body signature, duplicate retry and out-of-order guards | Plan & Usage page with demo/live labeling | Account, subscription, usage, checkout, invoices, webhook idempotency | Build and `test:billing` passed | Demo Free/Pro path remains server-authoritative | Stripe test checkout/portal/signed duplicate/out-of-order webhooks and invoice notification pending |

No card number/CVC is stored, no frontend query flag grants Pro, no notification is marked sent merely because a row exists, and no destroy demo mutates AWS state.

## 13. Modules 1–12 regression results

| Module | Result | Evidence / limit |
| --- | --- | --- |
| 1 Auth & audit | Passed | Email auth/session and GitHub OAuth URL tests; Nest routes/RBAC/audit wiring built and initialized |
| 2 Projects/workspace | Passed source/runtime regression | Existing data preserved; project/current-state routes initialized; no destructive CRUD test on user data |
| 3 Stack detection | Passed | Six fixtures and safe E2E snapshot/reuse |
| 4 Templates/preflight | Passed | Hardened template script plus safe E2E generation/check |
| 5 BullMQ pipeline | Passed to safe terminal mode | Isolated worker executed ordered run; automation cancel/retry checks passed; old developer worker requires restart |
| 6 Security | Passed configured path | Dockerfile, Trivy execution, classification, warning/blocking policy tests |
| 7 FinOps | Passed mock/approval path | Plan preceded estimate; mock label, threshold pause, explicit approval, same-run resume |
| 8 Infrastructure | Passed plan only | Real local init/validate/plan/show JSON; no apply |
| 9 State/lock | Passed plan-lock path | Acquire/heartbeat/release and no-state skip observed; remote/concurrent crash drills pending |
| 10 Persistent storage | Correctly not executed | EFS default disabled; live provisioning/backup not proved |
| 11 ECS/ALB/rollback | Source/build only | Terraform graph plan fixed; no live deployment or rollback claimed |
| 12 Observability | Source/build only | Pipeline metrics/events persisted; runtime CloudWatch/Prometheus requires a real deployment |

Pipeline owns ordered lifecycle/progress. Pipeline Events owns focused event evidence; historical aliases render without rewriting data.

## 14. Remaining blockers and severity

| Severity | Blocker | Impact / action |
| --- | --- | --- |
| High operational | The developer worker PID observed during audit was started before remediation and still had old code loaded | Restart the normal worker before another default-queue deployment. The isolated final proof was intentionally unaffected. |
| High validation | No authorized live Terraform apply | ECS, ALB, stable release, observability, rollback, and live cleanup remain unproved. |
| Medium setup | Repository migrations begin after base auth/project schema and a truly empty database lacks those base migrations | New environments need the documented legacy/base bootstrap or a future consolidated baseline migration before running the 15 migrations. Do not infer `synchronize=true` for production. |
| Medium validation | Destructive/concurrency drills were not run | Exercise two workers, stale crash recovery, release retry, and guarded destroy only in a disposable environment. |
| Medium external | AI, SNS, Stripe, real Infracost, remote state, and runtime CloudWatch/Prometheus credentials/services were not configured for live tests | Follow the manual provider checklists; retain demo/unconfigured labels until real confirmation. |
| Low maintenance | Node 20 emitted an AWS SDK future-support warning | Plan Node 22 upgrade before the SDK's announced 2027 requirement. Current build/run passed. |

## 15. Manual settings, credentials, and actions still required

1. Restart the backend worker so the default `pipelineQueue` consumer loads current source: stop the old worker gracefully, then run `cd backend && npm run worker:pipeline`.
2. Keep `TYPEORM_SYNCHRONIZE=false`; back up PostgreSQL and verify all migrations with `npx typeorm-ts-node-commonjs migration:show -d src/data-source.ts`.
3. For safe testing use `STATE_MOCK_MODE=true`, `FINOPS_MOCK_MODE=true`, `TERRAFORM_APPLY_ENABLED=false`, external CI optional, EFS default off, and deliberate Security/FinOps policy settings.
4. For live testing verify `aws sts get-caller-identity`, region/account, least-privilege IAM, ECR, versioned/encrypted/private S3 state with native lockfiles, tags, quotas, and cleanup ownership. Keep secrets backend-only.
5. Configure real Infracost, AI, SNS, Stripe, CloudWatch/Prometheus only as described in the two manual setup guides. Confirm SNS subscription before expecting sent delivery.
6. Explicitly approve one disposable live apply only after reviewing Terraform plan and monthly cost. Do not reuse the audit project for destructive testing.
7. After deployment verify ECS desired/running tasks, task definition image SHA, ALB target and application health, stable-release row, logs/metrics, rollback, then guarded cleanup.

## 16. Cloud-cost and cleanup status

- No Terraform apply or destroy was executed, so this audit did not create VPC, NAT Gateway, ALB, ECS, EFS, Backup, or CloudWatch runtime resources.
- The safe pipeline pushed immutable test images and applied an ECR lifecycle policy in the configured repository. ECR storage may incur a small cost. Review image tags and delete only audit tags that are not referenced by any deployment.
- Local PostgreSQL/Redis data, historical runs, safe-run evidence, Terraform plan workspaces, and Docker images were retained for auditability. They are not fake deployment records.
- Generated `.deployguard/terraform-workspaces` plan artifacts can be removed later only after confirming no active/retry/export operation references them and only within the validated workspace root.
- AI/SNS/Stripe live calls did not occur. Mock FinOps does not represent a provider charge or guaranteed AWS price.
- Future live cleanup must use the guarded destroy review and then reconcile Terraform state, AWS inventory, ECR images, CloudWatch retention, and intentionally preserved EFS/KMS/backup/shared resources. Shared state buckets/tables and unrelated resources must never be included.
