# DeployGuard FYP Modules: Exact PDF Requirement vs Current Implementation

**Authoritative FYP source:** `Deploy Guard Updated Document Final.pdf`, section 6, pages covering modules 6.1–6.17.

**Repository snapshot reviewed:** branch `test2`, commit `a571c14e9afc45bedf22ec1e4d22e136e8e3005e`.

This is the final module comparison after a `test2` source, contract, build, and local-certification audit. Every heading below is the module name from the supplied PDF. “Implemented” means source code is present and wired into the intended product path. It does **not** turn a source check into a live AWS, GitHub, SNS, or Stripe pass.

## Audit verdict for `test2`

**Overall status: UNVERIFIED for full certification.** The source/build/frontend contract audit is strong, but backend full-local certification is not green and no fresh GitHub/AWS/SNS/Stripe execution was performed for this audit.

| Audit area | Result | Exact evidence |
|---|---|---|
| Production build | **PASS** | `npm run product:build` compiled NestJS and built the Vite frontend successfully. |
| Frontend local certification | **PASS** | `npm --prefix frontend run test:full-local-certification` passed all included frontend checks. |
| Railpack and Terraform runtime contract | **PASS** | `test:railpack-runtime-contract` passed, including the managed-MongoDB Terraform plan test. |
| Explicit service/runtime behavior | **PASS** | `test:application-runtime-validation`, `test:multi-service-runtime`, `test:service-env-isolation`, `test:direct-ecs-redeploy`, and `test:direct-ecs-rollback` passed. |
| Failure diagnostics and AI safety | **PASS** | `test:failure-diagnostics`, `test:troubleshooting-boundaries`, and `test:dispatch-state-projection` passed. |
| Destroy, notification, export, API, and billing-subscription contracts | **PASS** | Destroy authority/confirmation, notifications, Terraform export, API equivalence, and billing subscription tests passed. |
| Backend full-local certification | **CONFIRMED DEFECT** | It stops at `test:deployable-services` because the verifier reads deleted `frontend/src/styles.css`; the frontend now uses split stylesheets under `frontend/src/styles/`. |
| Product-maturity certification | **CONFIRMED DEFECT** | `test:product-maturity-certification` still reads removed `frontend/src/components/layout/Sidebar.jsx`. |
| Billing certification scripts | **CONFIRMED DEFECT** | Backend Stripe verification expects `Manage Billing`; current UI correctly contains `Manage billing`. Frontend billing/Trivy verification expects `Current projects`; current UI uses `Projects`. These are stale test assertions, not proof that checkout or billing runtime is broken. |
| Developer-runtime-experience verifier | **CONFIRMED DEFECT** | It expects an older topology copy/order (`Source → Build → ECR → ECS → ALB → Application`) which the current Infrastructure UI no longer renders in that literal form. |
| Local product readiness | **EXPECTED BLOCKER** | `npm run product:verify` returned readiness `503` because the capability-contract fingerprint reports a stale compiled executable after the current build. The readiness gate correctly refuses to report READY until certified fingerprints are refreshed. |
| GitHub, AWS, SNS, Stripe providers | **UNVERIFIED** | This audit did not execute a configured live provider flow. Source and contract evidence must not be presented as fresh provider certification. |

### Audit commands that passed

- `npm run product:build`
- `npm --prefix frontend run test:full-local-certification`
- `npm --prefix backend run test:no-legacy-architecture`
- `npm --prefix backend run test:railpack-runtime-contract`
- `npm --prefix backend run test:application-runtime-validation`
- `npm --prefix backend run test:multi-service-runtime`
- `npm --prefix backend run test:service-env-isolation`
- `npm --prefix backend run test:failure-diagnostics`
- `npm --prefix backend run test:troubleshooting-boundaries`
- `npm --prefix backend run test:dispatch-state-projection`
- `npm --prefix backend run test:destroy-lifecycle-authority`
- `npm --prefix backend run test:destroy-confirmation-contract`
- `npm --prefix backend run test:notifications`
- `npm --prefix backend run test:terraform-export`
- `npm --prefix backend run test:billing-subscriptions`
- `npm --prefix backend run test:direct-ecs-redeploy`
- `npm --prefix backend run test:direct-ecs-rollback`
- `npm --prefix backend run test:api-contract-equivalence`
- `npx ts-node scripts/verify-authentication.ts` from `backend/`

### Architecture-consistency audit

| Layer | Current contract | Observed implementation | Executable path | Status | Evidence | Bounded next action |
|---|---|---|---|---|---|---|
| Service ownership | User explicitly supplies `Service[]`; no inferred application service authority. | New Project/Settings, service entities, runtime configuration, and Terraform service map use explicit service identifiers. | `test:no-legacy-architecture`, `test:multi-service-runtime`, `test:service-env-isolation` | **PASS** | No legacy executable references; multi-service/runtime tests passed. | Keep old detector/template records unreachable. |
| Build authority | Railpack owns language/framework/build/start interpretation; DeployGuard owns exact source and runtime contract. | Deployment freezes per-service build/runtime revisions and dispatches pinned Railpack workflow inputs. | `test:railpack-runtime-contract`, `test:application-runtime-validation` | **PASS** | Contract and validation tests passed. | Do not reintroduce generic detector/build-plan authority. |
| Workflow/result compatibility | Caller workflow, configured reusable SHA, and result contract must match. | GitHub App service verifies a pinned reusable workflow and executable contract before dispatch. | `test:railpack-runtime-contract` | **PASS** | Runtime contract passed; actual remote caller access was not exercised. | Run a configured GitHub App workflow for live proof. |
| Release/current-state authority | Complete generation service revisions select the live release; UI renders persisted state. | Current-state services and frontend projection tests use canonical state, not browser-only success. | `test:live-runtime-canonical-authority`, `test:dispatch-state-projection`, frontend full-local certification | **PASS** | All listed checks passed. | Keep UI wording changes synchronized with backend verifiers. |
| Certification executability | Full backend certification must follow current frontend paths and copy. | Several backend/frontend verifier scripts still require retired filenames or stale literal text. | `test:full-local-certification`, `test:product-maturity-certification`, billing/runtime verifier scripts | **CONFIRMED DEFECT** | Four stale verifier categories failed as recorded above. | Update only the stale assertions/files, then rerun full certification. |

## Important distinction: GitHub OAuth vs GitHub App installation

These are both implemented, but they do different jobs:

| Concern | Implemented behavior | Source evidence |
|---|---|---|
| **GitHub OAuth** | Identifies the person signing in, validates OAuth state, exchanges the authorization code, obtains the user profile/email, creates or finds the user, stores the OAuth access token, then sets the user session cookie. | [auth.controller.ts](../backend/src/auth/auth.controller.ts), [auth.service.ts](../backend/src/auth/auth.service.ts) |
| **GitHub App installation** | Gives DeployGuard repository access. The backend verifies the installation through GitHub, confirms its account matches the signed-in GitHub user, persists the active installation, then creates short-lived installation tokens for permitted repositories. | [github-app.service.ts](../backend/src/projects/github-app.service.ts), [projects.controller.ts](../backend/src/projects/projects.controller.ts) |

The GitHub App flow is therefore **implemented**. It belongs mainly to module 6.2 because it enables repository/project onboarding, while OAuth/RBAC/audit belong to module 6.1.

## 6.1. User Authentication & Audit Logging

### What the PDF requires

- Secure GitHub OAuth and standard email/password authentication.
- RBAC with Admin, Developer, and Read-Only users.
- Immutable PostgreSQL audit records for important actions such as deployments, Trivy failures, and cost approvals.

### What is implemented

- GitHub OAuth uses a state cookie, code exchange, GitHub profile/email lookup, and a signed HTTP-only user session cookie.
- User roles exist as Admin, Developer, and Read-Only. Developer and Admin actions are guarded; Read-Only users can inspect but cannot run developer actions.
- Administrator access is deliberately separate: it uses an admin-only password session and rejects GitHub identities from administrator login.
- Password hashing, password verification, signup, and login exist in [auth.service.ts](../backend/src/auth/auth.service.ts). The current frontend’s normal user entry is GitHub OAuth; ordinary user email/password pages are not exposed as the main product route.
- Audit records are written for OAuth start/success/failure, logout, GitHub App installation connection, deployment actions, and other protected operations.

### Difference from the PDF

- The PDF presents GitHub OAuth and email/password as equal ordinary-user entry methods. Current product behavior is GitHub-first for developers, with password login used for the separate administrator boundary.
- This is not a missing GitHub App feature. OAuth identifies the person; the App installation grants repository scope.

### Status and score

**Implemented, with a GitHub-first product choice. Score: 97/100.**

## 6.2. Project & Workspace Management

### What the PDF requires

- Create isolated projects in a workspace.
- Link specific GitHub repositories.
- Select target branches.
- Securely manage project environment variables.

### What is implemented

- Projects are durable PostgreSQL records with repository, branch, owner, deployable-service, configuration, generation, and release relationships.
- A signed-in Developer/Admin can connect an installation through `POST /api/projects/github/installations/:installationId/connect`.
- The connection checks that the GitHub App installation belongs to the currently signed-in GitHub account before saving it as active.
- Repository listing uses short-lived GitHub App installation tokens. The user can inspect repository information, branches, and directories only through accessible installations.
- Project setup supports service directories, selected branches, service-scoped environment values, secret handling, and managed-database attachment.
- Current state and project pages read persisted project data rather than holding deployment truth in the browser.

### Difference from the PDF

- The current product is more explicit than the PDF about multi-service ownership: environment values and runtime configuration belong to a selected service, not only to a whole project.
- A valid GitHub App configuration and installation are required for live repository access. That is an external setup requirement, not missing project management code.

### Status and score

**Implemented. Score: 92/100.**

## 6.3. Rule-Based Stack Detection Engine

### What the PDF requires

- Shallow-clone repositories and inspect language/framework files such as `package.json`, `requirements.txt`, `pyproject.toml`, and `Gemfile`.
- Determine framework, package manager, runtime, port, health endpoint, database need, and persistent-storage need.
- Produce a deterministic deployment profile and choose a safe template or require a custom Dockerfile.

### What is implemented

- The project resolves the selected source to an exact commit SHA before deployment.
- [repository-source.service.ts](../backend/src/projects/repository-source.service.ts), build-target resolution, and port resolution produce a canonical service-level build/runtime contract.
- The current deployment service persists immutable build-target revisions and fails closed when service/build/port evidence is missing or contradictory.
- Railpack consumes this canonical contract as the primary application builder.

### Difference from the PDF

- The current architecture intentionally does not keep the PDF’s broad named framework catalogue as its main authority. It uses canonical build contracts plus Railpack rather than promising a generic detector for every ecosystem.
- JavaScript/Python paths are represented in the current build workflow. Ruby/Gemfile detection and all PDF-listed framework-specific parsing are not proven as supported current behavior.

### Status and score

**Implemented as a narrower deterministic build-contract system. Score: 76/100.**

## 6.4. DevOps Template Engine & Pre-Flight Validation

### What the PDF requires

- Store optimized Docker templates using secure, multi-stage images.
- Generate a structured pre-flight JSON report showing detected stack and selected template before the build.

### What is implemented

- Railpack is the normal builder. The release workflow installs a pinned Railpack version and builds immutable images from the exact selected source.
- A Docker fallback manifest and templates exist under [infrastructure/docker-fallback](../infrastructure/docker-fallback), but they are intentionally restricted to a proven eligible internal Railpack failure. They are not a general replacement for the primary builder.
- Deployment requirements, build-target resolution, port resolution, runtime-secret materialization, database reconciliation, and AWS capability checks run before workflow dispatch.
- The pipeline contains pre-flight/deployability stages and records configuration evidence.

### Difference from the PDF

- The earlier generic template-selection/pre-flight-report model was superseded by the Railpack and canonical-contract model. Retired pre-flight/detection schema is not authoritative current behavior.
- A user-facing JSON report that says “framework X selected template Y” is not the current main interface.

### Status and score

**Partially implemented through a different, safer build strategy. Score: 60/100.**

## 6.5. CI/CD Pipeline & Asynchronous Queuing (Redis)

### What the PDF requires

- Use Redis and BullMQ for long Docker/Terraform jobs so NestJS stays responsive.
- Trigger GitHub Actions, tag images with commit SHA, push to ECR, and enforce ECR lifecycle cleanup.

### What is implemented

- A deployment creates a persisted operation with exact source SHA, project ID, operation ID, service configuration, and immutable dispatch inputs.
- The backend creates or verifies the repository caller workflow, validates a pinned reusable workflow, then dispatches GitHub Actions.
- The reusable workflow builds with Railpack, scans with Trivy, publishes immutable image evidence, runs Terraform/ECS work, and returns operation-correlated release/failure evidence.
- If dispatch acknowledgement is ambiguous, the backend preserves the operation and reconciles the exact GitHub workflow identity rather than assuming failure.

### Difference from the PDF

- This is the largest gap: `bullmq` exists as a dependency, but [compose.yaml](../compose.yaml) has no Redis service and [app.module.ts](../backend/src/app.module.ts) has no BullMQ module, queue registration, or worker. The active execution path is persisted control-plane state plus GitHub Actions, not an active Redis/BullMQ worker plane.
- ECR lifecycle policy behavior requires fresh AWS proof.

### Status and score

**CI/CD is implemented; Redis/BullMQ execution is not wired. Score: 65/100.**

## 6.6. Security Scanning and Policy Enforcement System

### What the PDF requires

- Run Aqua Trivy before deployment.
- Parse severity/fixed-version findings.
- Block critical/high findings, require review for configured medium findings, retain low findings, and record policy decisions/audit data.
- Offer remediation guidance.

### What is implemented

- The reusable workflow installs Trivy and produces structured scan evidence bound to the immutable deployment operation.
- The deployment contract forwards `trivy_enabled` and `trivy_enforce` and rejects a release result when required scan evidence is missing or invalid.
- Source tests cover disabled, advisory, enforced, evidence, and workflow-forwarding paths.
- Scan failure/policy-block outcomes are carried as deterministic deployment failure evidence.

### Difference from the PDF

- The exact PDF severity policy and remediation-command UI are not fully proven by source inspection. Live CVE data and configured blocking behavior require a real workflow execution.

### Status and score

**Implemented in workflow contracts; live policy proof pending. Score: 88/100.**

## 6.7. Predictive Cost Analysis (FinOps)

### What the PDF requires

- Produce a Terraform plan and send it to Infracost.
- Show resource-level estimated cost.
- Block deployments over tier limits and require approval above warning thresholds.

### What is implemented

- The project has FinOps services, cost estimate/settings/resource-breakdown records, Infracost CLI integration, cost-plan evidence, and deployment-facing cost decisions.
- Cost estimates distinguish compute, storage, database, load-balancer, and related cost context.
- Billing entitlements are server-side rather than trusted from the browser.

### Difference from the PDF

- Current code explicitly supports a mock/bypass path when real Infracost is not configured. A real estimate requires a valid Infracost setup and exact Terraform plan.
- A cost estimate remains decision support; it is not a guaranteed AWS bill.

### Status and score

**Implemented with conditional real-provider operation. Score: 82/100.**

## 6.8. Infrastructure Provisioning & Service Discovery

### What the PDF requires

- Use Terraform to construct AWS networking and application infrastructure.
- Use Cloud Map private service discovery so internal services can communicate without public internet traversal.

### What is implemented

- Terraform modules cover network, registry, ALB, ECS service, database service, EFS, Cloud Map, IAM, and runtime infrastructure.
- The runtime contract records Cloud Map identifiers for managed databases and validates Cloud Map registration during runtime verification.
- Application/public routing and database/private discovery are separate concerns in the Terraform design.

### Difference from the PDF

- The exact VPC/subnet/NAT topology and all multi-service communication cases must be proven in AWS for the commit under test.

### Status and score

**Implemented in Terraform/runtime contracts; AWS topology proof pending. Score: 86/100.**

## 6.9. Distributed State Management

### What the PDF requires

- Store versioned Terraform state in S3.
- Use DynamoDB conditional locks, heartbeat checks, orphan recovery, conflict queueing, validation, checksum checks, and recovery from prior state.

### What is implemented

- Project Terraform-state, lock, queue-item, validation-result, recovery-request, and safety-snapshot records exist.
- The current architecture uses encrypted/versioned S3 state with **native S3 lockfile coordination**, as documented in the current FYP presentation source.
- State safety and lock history are recorded without treating browser state as infrastructure truth.

### Difference from the PDF

- The active implementation does not use the PDF’s DynamoDB lock/heartbeat protocol or Redis conflict queue.
- This is an architecture change, not a reason to invent DynamoDB behavior in the report. S3 lock behavior and recovery require AWS certification.

### Status and score

**Partially aligned through S3 native locking rather than the PDF design. Score: 72/100.**

## 6.10. Persistent Storage & Backup Recovery (AWS EFS)

### What the PDF requires

- Provision encrypted EFS for stateful workloads/databases.
- Use restricted access/mount permissions and preserve data through container restarts.
- Provide backup/recovery capability.

### What is implemented

- EFS, encryption, mount/access-point, and managed database persistence are part of the Terraform runtime contracts.
- Persistent-storage, storage-event, backup-record, and restore-request entities/services are present in the repository.
- Database configuration and reset-fresh admission explicitly protect healthy persistent data from silent deletion.

### Difference from the PDF

- An end-to-end EFS backup/restore run is not proven on the current SHA. Some historical storage services are retained for records but are not part of the root module’s ordinary active imports.

### Status and score

**Storage contract is implemented; recovery certification is pending. Score: 78/100.**

## 6.11. Zero-Downtime Container Orchestration & Event-Driven Rollbacks

### What the PDF requires

- Deploy on ECS Fargate Spot with target-tracking scaling.
- Handle EventBridge two-minute Spot interruption notices.
- Use ALB `/health` checks and automatically roll back to the previous stable Git commit without downtime.

### What is implemented

- ECS, ALB health/runtime verification, stable-release identity, manual rollback candidates, exact task-definition checks, and EventBridge Spot Terraform modules exist.
- Release-only redeploy and exact rollback are deliberately guarded by compatible runtime identity, source/image/config evidence, and live-topology eligibility checks.

### Difference from the PDF

- Current rollback is a governed lifecycle action; it must not blindly auto-rollback from a signal alone.
- Fargate Spot interruption recovery, zero-downtime behavior, and automatic rollback require real AWS execution before being claimed.

### Status and score

**Core runtime/rollback contracts exist; event-driven zero-downtime proof is pending. Score: 67/100.**

## 6.12. Dual-Stack Monitoring & Observability

### What the PDF requires

- Monitor GitHub Actions build/scan duration.
- Stream ECS stdout/stderr logs to the frontend through SSE.
- Present Prometheus CPU/RAM/latency telemetry on a dashboard.

### What is implemented

- Pipeline stages, stage timings, runtime metric snapshots, CloudWatch metrics/log services, and log sanitization are implemented.
- Prometheus endpoint support and local Prometheus/Grafana containers/dashboards are wired in the product composition.
- The UI has project monitoring and pipeline surfaces rather than only an operator terminal.

### Difference from the PDF

- Real CloudWatch/ECS stream behavior, metric availability, and all SSE reconnection paths need live runtime proof.

### Status and score

**Implemented in source/local composition; AWS stream proof pending. Score: 86/100.**

## 6.13. AI-Powered Log Analysis & Chatbot

### What the PDF requires

- Correlate GitHub, Terraform, CloudWatch, and Trivy failures by deployment identifier.
- Remove noise/secrets, create a bounded diagnostic context, validate structured responses, retain conversation history, and safely fall back if the AI provider fails.
- Cite actual evidence to reduce hallucination.

### What is implemented

- Troubleshooting collects operation-correlated pipeline, diagnostic, and observability evidence, bounds/deduplicates it, and redacts sensitive values.
- AI responses must cite valid supplied evidence IDs and use approved root-cause codes. Zero valid citations, invented codes, and unsafe `SAFE_NOW` recommendations under deterministic `UNVERIFIED` ownership are rejected.
- AI cannot alter persisted failure owner, terminal diagnosis, retry decision, deployment state, or release promotion.
- If provider output is invalid/unavailable, a deterministic evidence-only fallback follows the same evidence rules.

### Difference from the PDF

- The current implementation intentionally gives AI less authority than the PDF’s conversational wording might imply. This is safer: AI explains evidence but never controls infrastructure.
- Real provider availability is configuration-dependent.

### Status and score

**Implemented with stronger evidence controls than the PDF describes. Score: 97/100.**

## 6.14. Alerting & Notification System

### What the PDF requires

- Track Queued, Building, Scanning, Provisioning, Deployed, and Failed lifecycle states.
- Send critical event notifications through AWS SNS to email/webhook destinations.

### What is implemented

- Pipeline operations persist lifecycle state/stages and terminal outcomes.
- Notification preferences, subscriptions, deliveries, dispatcher, SNS adapter, and project notification settings are implemented.
- Notification content uses sanitized data rather than raw secrets/logs.

### Difference from the PDF

- SNS publish/subscription delivery depends on real AWS configuration and credentials, so live notification delivery is **UNVERIFIED** until executed.

### Status and score

**Implemented in source; provider delivery proof pending. Score: 82/100.**

## 6.15. Infrastructure Lifecycle & Demolition (Destroy)

### What the PDF requires

- Use dual confirmation and Terraform destroy to remove active environments.
- Protect persistent EFS volumes to prevent accidental data loss.

### What is implemented

- Destroy uses explicit admission/confirmation, an operation-correlated Terraform destroy action, AWS deletion verification, preserved evidence, and control-plane finalization.
- Project-scoped destroy remains supported. The removed central cloud-cleanup screen is separate from normal project lifecycle destroy.
- The product preserves database/data recovery contracts and does not silently delete healthy persistent data merely to reset a deployment.

### Difference from the PDF

- The PDF’s unconditional “skip EFS deletion” is not the safe current rule. Storage handling must follow the project’s authoritative destroy/recovery contract, not a blanket frontend action.
- Repeat-destroy idempotency and database preservation need fresh AWS evidence.

### Status and score

**Implemented with safer project-scoped authority; certification pending. Score: 82/100.**

## 6.16. Vendor Independence & Terraform Export (No Lock-in)

### What the PDF requires

- Provide one-click download of a ZIP archive containing generated Terraform so users retain infrastructure ownership.

### What is implemented

- Terraform export has an active module, controller, artifact entity, canonical-file selection, ZIP builder, and verification script.
- Export is project scoped and is exposed as infrastructure evidence/export functionality.

### Difference from the PDF

- The platform remains AWS-specific, which matches the PDF limitations section. A generated archive should be tested against a real project before it is presented as a full customer handoff guarantee.

### Status and score

**Implemented. Score: 88/100.**

## 6.17. Subscription & Billing Management

### What the PDF requires

- Free/Pro tier limits, payment checkout, payment updates, invoices, a billing dashboard, usage tracking, and tier-limit alerts.

### What is implemented

- Billing accounts, subscriptions, checkout sessions, invoices, payments, webhook events, usage counters/events, entitlement checks, and billing UI/services exist.
- Stripe is designed as a test-mode integration when configured, and entitlements are evaluated server side.

### Difference from the PDF

- Production payment completion, webhook receipt, customer payment updates, and real invoice evidence cannot be claimed without live Stripe configuration.

### Status and score

**Implemented structurally and in test-mode design; live provider proof pending. Score: 84/100.**

## What is genuinely missing or materially different

1. **Redis/BullMQ runtime:** the PDF explicitly requires it, but it is not wired into the current Docker composition or root Nest application.
2. **DynamoDB heartbeat locking:** the PDF specifies it; current design uses S3 native lockfiles instead.
3. **Generic framework-template engine:** current Railpack/canonical-contract architecture is narrower and safer, but it is not the PDF’s broad framework/template catalogue.
4. **Unproven live AWS/provider scenarios:** EFS recovery, Fargate Spot recovery, zero-downtime/automatic rollback, all database cases, CloudWatch/SNS behavior, ECR lifecycle, and production Stripe behavior need exact-SHA execution evidence.

## What has been added or made safer than the PDF

1. Immutable identities linking source SHA, build target, runtime configuration, image digest, task definition, generation, and stable release.
2. Deterministic failure ownership, code, stage, service scope, evidence references, and retry guidance.
3. Read-time diagnostic improvement from safely correlated later evidence without modifying immutable terminal audit history.
4. Strict AI evidence enforcement and deterministic fallback validation.
5. Explicit `UNVERIFIED` status when the system cannot safely attribute a failure.
6. Clear separation of GitHub user OAuth, GitHub App repository access, developer/read-only roles, and separate administrator sessions.

## Final scores after the `test2` audit

**81 / 100 for implementation alignment with the 17 PDF modules.**

The score is the equal-weight average of the module scores: **1382 ÷ 17 = 81.29**, rounded to **81**.

This is an implementation-alignment score, not a production reliability claim. The score is reduced mainly by the absent Redis/BullMQ runtime, the different S3-versus-DynamoDB locking design, the narrower Railpack build model, and missing fresh AWS/provider certification.

**Full-certification score: not issued.** The backend aggregate suite currently fails on stale verifier assumptions, and the local readiness guard is correctly blocked by a stale certified capability fingerprint. Assigning a single production-readiness percentage would hide those facts.

## Code evidence reviewed

- Identity and App installation: [auth.controller.ts](../backend/src/auth/auth.controller.ts), [auth.service.ts](../backend/src/auth/auth.service.ts), [github-app.service.ts](../backend/src/projects/github-app.service.ts), [projects.controller.ts](../backend/src/projects/projects.controller.ts)
- Product composition: [app.module.ts](../backend/src/app.module.ts), [compose.yaml](../compose.yaml)
- Deployment and evidence: [railpack-deployment.service.ts](../backend/src/projects/railpack-deployment.service.ts), [deployguard-reusable.yml](../.github/workflows/deployguard-reusable.yml), [railpack runtime](../infrastructure/railpack-runtime)
- Operations: [observability](../backend/src/observability), [notifications](../backend/src/notifications), [finops](../backend/src/finops), [billing](../backend/src/billing), [terraform export](../backend/src/terraform-export)
