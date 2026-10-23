# DeployGuard FYP Modules: Written Requirement vs Current Implementation

**Repository snapshot:** `test2` at `a571c14e9afc45bedf22ec1e4d22e136e8e3005e`

**FYP source:** [DeployGuard FYP-II Final Presentation Data](../DeployGuard_FYP2_Presentation_Data.md)

## How this comparison is scored

This document compares the 17 FYP product modules against the current source code. The score measures **how closely the current implementation matches the documented module requirement**. It is not a live AWS certification score.

- **90–100:** implemented and wired into the product; only ordinary provider proof may remain.
- **70–89:** main feature exists, but an important flow is incomplete, conditional, or not freshly certified.
- **40–69:** partial implementation; substantial requirement remains.
- **0–39:** documented requirement is mostly absent from the composed product.

`UNVERIFIED` means the code or a static test cannot prove real external behavior. It is an honest status, not an automatic failure.

## The 17 FYP modules

| # | Module | What the FYP document says it must do | What is implemented now | Required difference / honest status | Score |
|---:|---|---|---|---|---:|
| 1 | **Frontend application and navigation** | Provide public pages, sign-in, developer workspace, project views, billing, and a separate administration experience. Project pages must retain context while users move between views. | **Implemented.** React routes include projects, deploy, overview, pipeline, infrastructure, monitoring, settings, troubleshooting, billing, and separate admin routes in [AppRoutes.jsx](../frontend/src/routes/AppRoutes.jsx). | Keep backend state authoritative. The UI must display a deployment result, never create one by browser state alone. | 100 |
| 2 | **Authentication and role-based access** | Authenticate users through GitHub OAuth, separate ordinary user and administrator access, and support developer, read-only, and administrator permissions. | **Implemented.** OAuth state and user session cookies are handled by [auth.controller.ts](../backend/src/auth/auth.controller.ts); admin password sessions use [admin-auth.controller.ts](../backend/src/auth/admin-auth.controller.ts); route guards enforce developer/admin boundaries. | The recent frontend fix makes initial `/api/auth/me` refresh single-flight. OAuth/cookie/RBAC architecture was not changed. Repeated real GitHub-provider reliability remains **UNVERIFIED**. | 95 |
| 3 | **GitHub App onboarding and repository source** | Connect a GitHub App installation, list permitted repositories, select branch and service directories, resolve an exact source revision, and reject invalid source/build input before cloud work. | **Implemented in source.** Project GitHub endpoints, repository source resolution, build-target resolution, and port resolution are wired through [projects.module.ts](../backend/src/projects/projects.module.ts). | Requires a real GitHub App installation for full proof. No installation is an external prerequisite, not proof that the feature fails. | 85 |
| 4 | **Service configuration and secret handling** | Configure each selected service separately, detect a build/start/port contract, attach an optional managed database, and protect environment secrets. | **Implemented.** The project module contains service-specific runtime config revisions, encrypted environment values, build target revisions, secret materialization, and database admission. | Cloud injection of every secret/database engine still needs live certification. Service-scoped configuration itself is present. | 90 |
| 5 | **Immutable build, scan, and delivery** | Build the selected exact source, validate it, run Trivy policy, publish immutable ECR images, and retain source/image/runtime identity. | **Implemented in deployment and workflow contracts.** [railpack-deployment.service.ts](../backend/src/projects/railpack-deployment.service.ts) seals immutable inputs and dispatches [deployguard-reusable.yml](../.github/workflows/deployguard-reusable.yml). | Contracts and local verification are not proof that all real repositories and AWS accounts run successfully. Fresh AWS execution remains required. | 85 |
| 6 | **Terraform, ECS, and release lifecycle** | Support first deploy, release-only redeploy, exact rollback, reset-fresh, and verified destroy with clear Terraform, DeployGuard, and ECS ownership. | **Partially implemented.** Deploy, retry, reset-fresh, rollback, and destroy entry points exist. Direct ECS release/rollback is deliberately allowed only after a compatible live topology is proven. | First deploy and topology changes still fall back to Terraform bootstrap when direct ECS proof is absent. Full ownership behavior requires fresh AWS certification. | 70 |
| 7 | **Managed database readiness** | Support PostgreSQL, MySQL, and MongoDB contracts, reconcile database state, gate only the attached service, and never silently delete healthy data on reset-fresh. | **Implemented in source.** Managed database reconciliation/admission and database runtime Terraform contracts exist. | MySQL dynamic task-network grants, MongoDB, database-failure isolation/recovery, and some topology cases remain **UNVERIFIED** in live AWS. | 70 |
| 8 | **Durable data, identities, and audit** | Persist projects, services, build targets, config revisions, deployment generations, stable releases, pipeline evidence, and audited actions. | **Implemented.** [app.module.ts](../backend/src/app.module.ts) registers the related TypeORM entities; audit, generation, and stable-release records are wired into the control plane. | PostgreSQL is the durable record. Queue state, browser state, or a GitHub status must not replace it. | 95 |
| 9 | **Redis and BullMQ worker plane** | Use Redis-backed BullMQ queues/workers for deployment, lifecycle, and emergency-cleanup jobs, with retries/backoff while PostgreSQL remains authoritative. | **Mostly missing from the composed product.** `bullmq` is installed and historical queue-related entities exist. | [compose.yaml](../compose.yaml) has no Redis service, and [app.module.ts](../backend/src/app.module.ts) has no `BullModule`, queue registration, or worker. The FYP must not claim active Redis/BullMQ execution until it is wired and tested. | 15 |
| 10 | **Current state, pipeline, and release UI** | Show active operation, stage progression, failure evidence, stable release versus latest attempt, and only lifecycle actions that are currently permitted. | **Implemented.** Project Pipeline, Overview, current-state services, and persisted run records separate attempted generations from stable releases. | Refresh/reconnect must re-read backend truth. It must not infer a successful release from a client-side action. | 90 |
| 11 | **Monitoring, metrics, and live logs** | Present AWS runtime metrics and CloudWatch logs, stream sanitized logs, expose Prometheus metrics, and provide Grafana dashboards. | **Implemented in source and local composition.** [observability.module.ts](../backend/src/observability/observability.module.ts) wires CloudWatch-facing services and Prometheus metrics; local Compose starts Prometheus and Grafana. | Actual CloudWatch data requires AWS credentials and a runtime. It is therefore source-implemented but external-provider behavior is **UNVERIFIED** until run. | 85 |
| 12 | **Evidence-grounded AI troubleshooting** | Collect sanitized evidence, bound and validate model input/output, require valid citations, keep AI advisory, and fall back deterministically. | **Implemented and recently hardened.** The AI path rejects zero valid evidence references, invented root-cause codes, and `SAFE_NOW` when deterministic ownership is `UNVERIFIED`. | AI cannot change terminal ownership, retry authority, release promotion, or infrastructure. Provider availability remains conditional, but deterministic fallback is present. | 95 |
| 13 | **Failure diagnosis and recovery** | Store code, stage, owner, service scope, cause, evidence, and retry guidance. Improve advice only from valid evidence and do not guess. | **Implemented and recently hardened.** [failure-diagnostic.service.ts](../backend/src/projects/failure-diagnostics/failure-diagnostic.service.ts) keeps terminal history and supports a read-time diagnosis from safely correlated later evidence. | If later evidence cannot be proven to belong to the failed operation, the answer remains `UNVERIFIED`. Original terminal fields must not be overwritten. | 90 |
| 14 | **Notifications** | Store user preferences/subscriptions/deliveries and send operational notifications through AWS SNS when configured. | **Implemented in source.** [notifications.module.ts](../backend/src/notifications/notifications.module.ts) wires preferences, subscriptions, delivery records, dispatcher, and SNS adapter. | Actual SNS delivery needs valid live configuration and credentials. That part remains **UNVERIFIED** until executed. | 80 |
| 15 | **FinOps, billing, and entitlements** | Estimate infrastructure cost for admission and separately provide Stripe test-mode subscriptions, invoices, checkout, signed webhooks, and server-side entitlements. | **Implemented in source.** [finops](../backend/src/finops) provides cost-related services, while [billing.module.ts](../backend/src/billing/billing.module.ts) wires billing and entitlement services. | Estimate is decision support, not an exact AWS bill. Stripe/webhook/provider proof is conditional on configuration and remains **UNVERIFIED** without a live run. | 80 |
| 16 | **Administration and platform governance** | Provide administrator-only overview, users/roles, project visibility, service readiness, and sanitized audit information. | **Implemented.** [AdminUsers.jsx](../frontend/src/pages/AdminUsers.jsx) provides overview, users, projects, and audit sections; the backend has admin APIs and separate admin authentication. | **Intentional difference:** central cloud-cleanup UI was removed at the user's request. Do not restore it. Project-scoped destroy remains supported. Legacy cleanup backend code is dormant and should only be retired in a separate scoped task. | 90 |
| 17 | **Portable local product operation** | Run PostgreSQL, migrations, backend, frontend, Prometheus, and Grafana in a repeatable containerized setup with health checks, dependency ordering, and persistent storage. | **Implemented.** [compose.yaml](../compose.yaml) defines PostgreSQL, migration, backend, frontend, Prometheus, Grafana, health checks, dependencies, and named volumes. | The composition intentionally has no Redis service, which confirms the BullMQ gap in module 9. Local success does not equal AWS lifecycle certification. | 90 |

## What we missed from the FYP document

1. **Active Redis/BullMQ execution plane:** this is the largest direct FYP mismatch. The package is installed, but Redis and worker registration are not part of the running composed product.
2. **Fresh live AWS proof for all lifecycle cases:** direct ECS release ownership, topology reapply protection, repeat destroy, MongoDB, MySQL dynamic grants, and database isolation/recovery require execution on the exact commit.
3. **Fresh provider proof:** GitHub App/OAuth repetition, SNS delivery, Stripe events, and CloudWatch runtime observation need valid external configuration and an executed test.
4. **Central cleanup differs from the original FYP scope:** the UI was deliberately removed. This is not an accidental gap; it is a product decision. The dormant backend code is not a supported frontend feature.

## What we added or improved beyond the written FYP module list

1. **Safer AI enforcement:** live AI output and deterministic fallback now both require valid evidence references and approved root-cause vocabulary.
2. **Read-time failure improvement without rewriting history:** later evidence can improve the current diagnosis only when operation correlation is proven; terminal audit data stays immutable.
3. **Explicit `UNVERIFIED` safety:** the product prefers uncertainty over invented ownership, root cause, or retry permission.
4. **Single-flight session refresh:** the frontend now prevents duplicate initial `/api/auth/me` requests and ignores stale async completions after logout/newer state.
5. **Clearer role boundaries:** read-only, developer, and separate administrator surfaces are explicitly protected; central cleanup is not exposed to ordinary admin UI.
6. **More honest certification language:** local/structural verification is separated from live AWS/provider proof.

## Overall achievement score for the 17 documented modules

**83 / 100 — source alignment with the FYP module requirements.**

This is the equal-weight average of the 17 module scores above: **1405 ÷ 17 = 82.65**, rounded to **83**.

This should be read plainly:

- The core product modules are present and the overall system is far beyond a prototype UI.
- The score is reduced mainly by the unwired Redis/BullMQ worker plane and incomplete fresh AWS/provider certification.
- This is **not** an 83/100 live-cloud reliability score. Live reliability needs a separate exact-SHA AWS certification matrix.

## Evidence used

- FYP scope: [DeployGuard_FYP2_Presentation_Data.md](../DeployGuard_FYP2_Presentation_Data.md)
- Product intent and known limits: [PRODUCT.md](../PRODUCT.md)
- Current application composition: [backend/src/app.module.ts](../backend/src/app.module.ts) and [compose.yaml](../compose.yaml)
- Frontend routes and session coordination: [AppRoutes.jsx](../frontend/src/routes/AppRoutes.jsx) and [AuthContext.jsx](../frontend/src/context/AuthContext.jsx)
- Deployment, diagnostic, observability, notification, billing, and admin modules linked in the table above.
