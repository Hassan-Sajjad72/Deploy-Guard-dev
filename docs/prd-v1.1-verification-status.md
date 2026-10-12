# DeployGuard PRD v1.1 — verification status

**As of:** 2026-10-11 · **Branch:** `version1` (uncommitted working tree) · **Source of truth:** `docs/prdv1.0.md`

This records, for every requirement in the PRD corrections, what is implemented and what evidence verifies it. "Local" evidence is real code executed against fixtures, disposable PostgreSQL, Docker, or a real browser. It is not AWS certification. Live AWS results are listed separately and come only from authorized runs in account `762760349298` (`us-east-1`).

## Status key

| Status | Meaning |
|---|---|
| **Verified (local)** | Implemented, and a passing local check exercises the behavior. |
| **Verified (live)** | Additionally passed an authorized real-AWS run. |
| **Implemented, live-unverified** | Code exists and local checks pass; needs a live run. |
| **Blocked (external)** | Needs an external action: an AWS Support case, a release cut, a user decision, or credentials. |
| **Not implemented** | Absent from the code. |

## 1. Hosting profiles (PRD §2)

| Profile | Status | Evidence | Remaining before "available" |
|---|---|---|---|
| A — ECS Fargate | Verified (local); earlier M0 live certification | `test:lifecycle-properties`, `test:multi-service-*`, `test:direct-ecs-redeploy/rollback`, `test:destroy-*`, full-stack journey | Customer cross-account path needs a release cut (see §6) and a signed final provider proof. |
| B — EC2 | **Certified — available to customers in us-east-1** | Signed final proof from run `cdbe23df` (2026-10-11): deploy ×2, rejected-candidate retry, rollback, ownership guard, cleanup, AWS runtime monitoring, budget $21.88/mo complete. Expires 2026-11-10. | Re-certify before expiry or after any change to the executable. |
| C — Lightsail | **Certified — available to customers in us-east-1** | Signed final proof from run `a7542a36`: same seven checks; budget $5.44/mo complete (AWS Lightsail offer file). Expires 2026-11-10. | Accounts with the default 2-instance Lightsail quota cannot hold a rollback generation and a retry candidate at once. |
| D — Lambda | **Certified — available to customers in us-east-1** | Signed final proof from run `073d9960`: same seven checks; budget $0.62/mo complete. Expires 2026-11-10. | Re-certify before expiry or after any change to the executable. |
| E — S3 + CloudFront | Blocked (external: AWS) | Local artifacts and fence verified (`test:hosting-fence-coverage`). | AWS Support must verify the account for CloudFront. |

A profile is available only with a signed final provider proof for its region and executable fingerprint (`HostingProfileRegistryService`). Proofs are produced by `npm run sign:final-provider-proofs` from passing live evidence for the exact fingerprint (`b3195045…`, identical under ts-node and the compiled build); any change to the nine fingerprinted files invalidates them. This satisfies "do not represent an unimplemented profile as available" (AT-015).

## 2. Functional requirements

| ID | Requirement (short) | Status | Evidence |
|---|---|---|---|
| FR-013 | Personal workspace without client/engagement | Verified (local) | `verify-workspace-ownership-postgres`, `verify-customer-onboarding-browser` |
| FR-014 / FR-017 | Org-owned projects; safe migration of user-owned projects | Verified (local) | `verify-workspace-ownership-postgres` (ownership migration), migrations-from-zero (101) in full-stack run |
| FR-018 | Projects with repo + AWS binding, no agency records | Verified (local) | full-stack journey, `verify-workspaces-browser` |
| FR-021 | BYOC: separate control-plane and customer authority | Verified (local) | `verify-customer-execution-contract` (role chaining, per-operation authorization), `verify-hosting-customer-boundaries` |
| FR-022 / FR-023 | Connect authorized AWS accounts; verify identity, role, trust, region, permissions | Verified (local) | `verify-hosting-customer-boundaries` (account drift, revoked/foreign-region bindings), `verify-customer-onboarding-browser` |
| FR-024 | Production workloads only in authorized bindings | Verified (local); cross-account untested live | `DG_CUSTOMER_ACCOUNT_MISMATCH` gate in workflow; customer contract tests |
| FR-029 | Regions enabled per verified profile | Verified (local) | Registry requires a per-region signed proof |
| FR-036 / FR-041 | Reuse exact-SHA analysis, build targets, env analysis | Verified (local) | `test:build-target-resolution`, `test:deployment-requirements`, `test:service-port-resolution` |
| FR-045 / FR-047 | Recognize dependencies; keep explicit DB attachments | Verified (local) | `test:provider-hosting-features` (dependencies), full-stack DB attach/detach/change |
| FR-053 / FR-054 | Evaluate compatibility per profile; reject violations | Verified (local). **Defect fixed:** static/Lambda were eligible without proof the app is static or a Lambda handler. | `verify-deployment-planning` (Vite alone ≠ static; static build ≠ Lambda) |
| FR-055 / FR-056 | Record assumptions; itemized profile costs | Verified (local) | `test:provider-hosting-features`, `verify-hosting-customer-boundaries` (all 5 profiles priced) |
| FR-058 / FR-059 | Compare options; explicit no-eligible result | Verified (local) | `verify-deployment-planning` (`no_eligible_profile`), recommendation checks |
| FR-064 / FR-065 | Keep Gemini; provider adapter for planning AI | Verified (local) | `test:troubleshooting-boundaries`, `verify-deployment-planning` (advisory AI) |
| FR-073 | AI outages don't disable deterministic features | Verified (local) | Troubleshooting fallback path; planning works without AI |
| FR-077 / FR-078 | Versioned, immutable deployment plan with full contents | Verified (local) | `verify-deployment-planning`, `verify-planning-browser` |
| FR-084 | Review architecture, resources, costs, risks before approval | Verified (local) | `verify-planning-browser` |
| FR-085 / FR-124 | Unknown cost never zero | Verified (local) | Pricing outage → all 5 profiles `null` (`verify-hosting-customer-boundaries`); `verify-prd-repairs` |
| FR-086 | Keep Actions/Terraform/Railpack/ECS path | Verified (local) | Lifecycle, release, multi-service suites |
| FR-095 | Transport ≠ application health | Verified (local) | `test:destroy-lifecycle-authority` (new assertion: healthy ALB targets without a probe stay `unavailable`), `verify-prd-repairs` |
| FR-110 | Monitoring scoped to account and project | Verified (local) | `verify-log-stream-authorization`, `verify-aws-runtime-monitoring` |
| FR-117 – FR-119 | Pre-approval cost, total-cost categories, cost evidence | Verified (local) | Pricing suites |
| FR-123 | Recommend lowest eligible with explanation | Verified (local) | `test:provider-hosting-features` (eligibility + recommendation) |
| FR-139 / FR-141 | Terraform ZIP + JSON/PDF evidence exports | Verified (local) | `test:terraform-export`, `verify-operational-evidence`, Infrastructure page export actions |
| FR-153 / FR-157 | Subscriptions, trials, entitlements, Stripe; B2B invoices | Verified (local). **Regression fixed:** payment-failure SNS notification and audit restored. | `test:stripe-billing`, `test:billing-subscriptions`, `verify-billing-notifications-postgres`, `verify-organization-billing-postgres`, `verify-organization-entitlements-postgres` |

## 3. Non-functional requirements (PRD §7)

| Constraint | Status | Evidence |
|---|---|---|
| Server-side session revocation | Verified (local) | `verify-authentication`, `verify-log-stream-authorization` (logout, disabled identity, in-flight revocation) |
| DB TLS certificate verification | Implemented | `rejectUnauthorized: true` whenever `DATABASE_SSL=true` (`app.module.ts`, `data-source.ts`) |
| Org and account isolation across APIs and streams | Verified (local) | Full-stack: outsider gets 403 on project and env APIs and in the UI; viewer member is read-only |
| Fail-closed historical ownership | Verified (local) | `test:destroy-lifecycle-authority`, `verify-prd-repairs` |
| HTTP errors not reported healthy | Verified (local) | See FR-095 |
| Audit history survives project deletion | Verified (local) | `RetainedAuditEvidence` migration; `verify-prd-repairs` |
| Unknown prices never zero; total-cost comparison | Verified (local) | See FR-085/124 |

## 4. Acceptance tests (PRD §8)

| AT | Status | Notes |
|---|---|---|
| AT-001 Individual and team onboarding | Verified (local) | Live onboarding of a real customer account not run. |
| AT-004 Application compatibility | Verified (local) | Node/Python build-target and multi-service suites. |
| AT-006 Intelligence Harness | Verified (local) | Compatibility now requires verified build evidence for static/Lambda. |
| AT-012 Cost-aware compute selection | Verified (local) | Live price accuracy is not certified. |
| AT-013 Existing feature preservation | Verified (local), with 3 regressions fixed (see §5) | |
| AT-014 Customer account isolation | Verified (local) | Real cross-account certification needs separate test accounts. |
| AT-015 Hosting profile verification | EC2 live-passed once; others pending (§1) | |

## 5. Defects found and fixed this session

1. **Lightsail never started its app (most likely cause, fixed).** Confirmed locally: Ubuntu 22.04's dash rejects `set -o pipefail` and aborts before installing anything, while the rest of the bootstrap works on Ubuntu 22.04 at 512 MiB. Inferred but not documented by AWS: Lightsail runs user data behind its own `/bin/sh` launch steps (its browser-SSH CA key setup), which turns `#!/bin/bash` into a comment. The bootstrap is now POSIX sh, so it is correct either way, and `test:vm-bootstrap` runs the whole script under `/bin/sh`. One live run confirms.
2. **Compiled backend crashed on boot.** The hosting-profile path resolved relative to `src/`, so `npm start` (`dist`) failed in `HostingProviderAdapterService.onModuleInit`. Fixed for both layouts.
3. **Production image could not run any non-ECS profile.** It had no hosting-profile modules, no Terraform 1.10.5, and no provider lock file. Added, with Terraform checksum-verified.
4. **Provider proofs could never verify in production.** The executable fingerprint hashed `.ts` under ts-node but `.js` under `dist`. Both now hash the same sources.
5. **No UI to change a project after creation.** Services, per-service variables, database attachment, source branch, and project details were removed from Settings on 2026-10-09 and never rehomed. Restored as a **Configuration** page; the full-stack journey covers it.
6. **Payment-failure notifications silently stopped** in the Stripe migration (`56f01d8`). Restored after commit, deduplicated against Stripe redeliveries, with audit.
7. **Static and Lambda could be recommended for server apps** (FR-054). They now require verified build evidence.
8. **ECS boundary policy name collided** for a second project in the same customer account (IAM names are account-unique). It is now `ecs-task-boundary-<projectId>`, defined by one shared helper.
9. **Stale backend executable pins blocked the customer ECS path.** Re-pinned, after the content contract passed.
10. **Unclassified customer workflow failures.** Two catalog entries were missing (`DG_CUSTOMER_ACCOUNT_MISMATCH`, `DG_CUSTOMER_AUTHORIZATION_INVALID`), and the scanner now covers every runtime script.
11. **Monitoring dropped the unhealthy-instance signal** (computed, never rendered). It now shows as a warning.
12. **Lambda and static cleanup always failed** (found live). `aws s3api delete-objects` with `Quiet: true` prints nothing on full success, and the runtime parsed that empty output as JSON. Empty output is now treated as success; errors are still checked.
14. **EC2 and Lightsail could never pass the budget gate.** EC2 always had an unknown storage item, and Lightsail had unknown network and storage items, so no estimate was ever "complete" and the adapter would refuse every deployment. EC2 now prices image storage from reviewed quantities. Lightsail now prices bundle disk, transfer quota, overage and static IP from the official AWS Lightsail offer file, and fails closed when that file can't be read.
15. **The live harness never tested retry.** It now deploys a deliberately unhealthy candidate, asserts it is rejected while the route and the live generation stay healthy, removes it, and then retries successfully.
13. **Ownership-check failures were undiagnosable.** The AWS error code and the read command are now included in the message, never payloads or credentials.

About 30 test suites were stale after the UI and contract changes. Each was checked against the product behavior before being updated, and none was weakened. 17 new-module suites now run as `npm run test:product-modules`, and the new IAM fence check runs as `npm run test:hosting-fence-coverage`.

## 6. Open items

| Item | Type | Action |
|---|---|---|
| `test:release-identity` fails by design until release | Release gate | Commit, push, and re-pin `DEPLOYGUARD_REUSABLE_WORKFLOW` to the new control-plane SHA. Customer cross-account ECS only works after this. |
| CloudFront account verification | AWS Support | — |
| Orphan sweep in the production adapter | Not implemented | Needs tag-based discovery (`tag:GetResources`), which widens the session fence; requires approval. |
| Plan-limit enforcement off by default | Product policy | Limits apply only with `BILLING_ENABLED=true` and `BILLING_ENFORCE=true`. `PLAN_USAGE_ENFORCEMENT_ENABLED` (still in `backend/.env`) is dead code. |
| GitHub repository selection in the browser | External | Needs a connected GitHub App installation (expected blocker in the full-stack run). |
| 14 orphaned legacy verify scripts | Cleanup | Target removed modules (e.g. `src/infrastructure/*`, BullMQ pipeline); not run by any npm script. |
| Unwired BullMQ modules | Dead code | `InfrastructureLifecycleModule`, `StorageModule`, `FinOpsModule` are not imported by `AppModule`; the app needs no Redis. |
| Docker image Terraform is amd64-only | Packaging | Add the arm64 archive and checksum before arm64 builds. |
