# DeployGuard FYP Modules: Exact PDF Requirement vs Current Implementation

**PDF used:** `Deploy Guard Updated Document Final.pdf`, section 6, “Modules”

**Repository snapshot:** `test2` at `a571c14e9afc45bedf22ec1e4d22e136e8e3005e`

This file uses the **exact 17 module names from the supplied PDF**. It does not rename, merge, or invent module names. The score measures source alignment with the PDF, not live AWS certification.

## 6.1. User Authentication & Audit Logging

- **Written in PDF:** GitHub OAuth and email/password login; Admin, Developer, and Read-Only RBAC; immutable PostgreSQL audit logs for actions such as deployments, scan failures, and cost approvals.
- **Implemented now:** GitHub OAuth, HTTP-only user sessions, separate administrator password sessions, role-protected frontend routes, TypeORM PostgreSQL audit records, and audit events are present.
- **Difference:** User email/password sign-up/login is not the supported ordinary-user flow in the current UI. Repeated real GitHub OAuth provider reliability is still **UNVERIFIED**.
- **Score:** **95/100**

## 6.2. Project & Workspace Management

- **Written in PDF:** Create isolated projects, connect a GitHub repository, select a branch, and manage `.env` variables securely.
- **Implemented now:** Projects, repositories, branches, deployable services, service-scoped encrypted environment variables, and GitHub installation access are implemented.
- **Difference:** Full repository selection needs a real GitHub App installation. That external dependency must be available for an end-to-end browser proof.
- **Score:** **90/100**

## 6.3. Rule-Based Stack Detection Engine

- **Written in PDF:** Shallow-clone a repository, detect language/framework from files such as `package.json`, `requirements.txt`, `pyproject.toml`, or `Gemfile`, then produce a deterministic deployment profile.
- **Implemented now:** The current source resolves the exact commit and service root, then creates a deterministic canonical build target and port/runtime contract before dispatching Railpack.
- **Difference:** The older PDF's broad framework-profile engine is no longer the current authority. The present design is narrower: exact service/build/port contract resolution rather than a visible generic framework catalogue. Ruby/Gemfile support is not proven.
- **Score:** **70/100**

## 6.4. DevOps Template Engine & Pre-Flight Validation

- **Written in PDF:** Maintain optimized Docker templates and generate a JSON pre-flight report showing detected stack and selected template before build.
- **Implemented now:** Railpack is the primary builder. A tightly controlled Docker fallback template manifest exists only for eligible Railpack internal failures. Deployment requirement and build-target admission occur before dispatch.
- **Difference:** The old general “template registry plus user-facing pre-flight JSON report” is not the current product path. The source itself retires older detection/preflight schema in favor of canonical Railpack contracts.
- **Score:** **55/100**

## 6.5. CI/CD Pipeline & Asynchronous Queuing (Redis)

- **Written in PDF:** Queue Terraform and Docker jobs with Redis/BullMQ, trigger GitHub Actions, tag artifacts with commit SHA, publish to ECR, and enforce ECR cleanup lifecycle policies.
- **Implemented now:** GitHub Actions dispatch, exact source identity, Railpack build, Trivy, immutable ECR image evidence, Terraform/ECS workflow stages, and persisted operation reconciliation are implemented.
- **Difference:** `bullmq` is installed but the running composition has **no Redis service, BullModule, queue registration, or worker**. Therefore Redis/BullMQ asynchronous execution must be considered missing. ECR lifecycle behavior needs AWS proof.
- **Score:** **65/100**

## 6.6. Security Scanning and Policy Enforcement System

- **Written in PDF:** Use Aqua Trivy as a mandatory pre-deployment scanner, classify findings, block critical/high vulnerabilities, require review where appropriate, preserve scan/audit evidence, and show remediation guidance.
- **Implemented now:** The reusable workflow installs/runs Trivy, produces structured evidence, and has advisory/enforced policy configuration. Scan outcomes are included in immutable release-result validation.
- **Difference:** Actual CVE outcomes, configured thresholds, and real blocking behavior need an executed workflow on the exact commit. The precise PDF policy matrix is not proven by source inspection alone.
- **Score:** **85/100**

## 6.7. Predictive Cost Analysis (FinOps)

- **Written in PDF:** Parse Terraform plan through Infracost, show AWS resource-level monthly estimates, then block or require approval based on plan/tier thresholds.
- **Implemented now:** Infracost services, normalized cost records, project cost settings, cost evidence, and admission-oriented FinOps logic exist.
- **Difference:** The current code explicitly supports a mock/bypass mode when real Infracost is not configured. Real Infracost credentials and provider output remain **UNVERIFIED** without a live run.
- **Score:** **80/100**

## 6.8. Infrastructure Provisioning & Service Discovery

- **Written in PDF:** Use Terraform to create AWS networking and provision Cloud Map for private multi-service communication.
- **Implemented now:** Terraform modules define networking, ECS services, ALB, EFS, database service, and Cloud Map/private DNS. Runtime verification contains Cloud Map registration checks.
- **Difference:** The exact VPC topology described in the PDF and all multi-service network cases require fresh AWS execution proof.
- **Score:** **85/100**

## 6.9. Distributed State Management

- **Written in PDF:** Store versioned Terraform state in S3, acquire DynamoDB distributed locks with heartbeat, recover orphaned locks, queue conflicts, and validate/recover corrupted state.
- **Implemented now:** Terraform state, lock history, safety snapshots, state validation, and recovery records exist. The current architecture uses S3 native lockfile coordination rather than the PDF's DynamoDB conditional-write/heartbeat design.
- **Difference:** This is a deliberate implementation change. The Redis conflict queue and the PDF's DynamoDB heartbeat/orphan protocol are not the active composed execution path. S3 state behavior needs AWS certification.
- **Score:** **70/100**

## 6.10. Persistent Storage & Backup Recovery (AWS EFS)

- **Written in PDF:** Provision encrypted EFS for stateful workloads/databases and preserve data across container restarts with restricted permissions.
- **Implemented now:** Terraform contains EFS, access-point, encryption, and database-storage contracts. Storage and backup/restore entities and services exist in the repository.
- **Difference:** End-to-end EFS backup/recovery and persistent database behavior require live AWS proof. Not every historical storage service is part of the root application's active module imports.
- **Score:** **75/100**

## 6.11. Zero-Downtime Container Orchestration & Event-Driven Rollbacks

- **Written in PDF:** Use ECS Fargate Spot, target-tracking autoscaling, EventBridge Spot interruption handling, ALB `/health` checks, and automatic rollback to a stable commit.
- **Implemented now:** ECS, ALB health checks, stable-release identity, direct-ECS eligibility guards, rollback candidates, and EventBridge Spot Terraform modules exist.
- **Difference:** The current product treats rollback as an explicit governed lifecycle action, not an assumed automatic reaction. Fargate Spot interruption, zero-downtime behavior, and automatic rollback need live AWS certification.
- **Score:** **65/100**

## 6.12. Dual-Stack Monitoring & Observability

- **Written in PDF:** Monitor GitHub Actions/Trivy durations, stream ECS logs through SSE, and show Prometheus runtime metrics such as CPU, RAM, and latency.
- **Implemented now:** CloudWatch log/metric services, sanitized live-log presentation, pipeline metrics, authenticated Prometheus endpoint, and local Grafana/Prometheus composition are present.
- **Difference:** Real CloudWatch/ECS metric streams and all SSE behavior must be demonstrated against a live runtime. Local monitoring setup alone is not AWS proof.
- **Score:** **85/100**

## 6.13. AI-Powered Log Analysis & Chatbot

- **Written in PDF:** Correlate GitHub, Terraform, CloudWatch, and Trivy logs by deployment identifier; preprocess/redact logs; validate structured AI advice; support follow-up context; fall back safely if AI fails.
- **Implemented now:** Evidence is bounded and sanitized, references are validated, root-cause codes are restricted to known codes, AI cannot authorize `SAFE_NOW` for deterministic `UNVERIFIED` ownership, and a deterministic fallback exists.
- **Difference:** The current design is stricter than the PDF in one important way: AI is advisory and cannot change deterministic failure ownership, retry authority, or lifecycle state. Provider behavior remains conditional on configuration.
- **Score:** **95/100**

## 6.14. Alerting & Notification System

- **Written in PDF:** Track deployment lifecycle states and use AWS SNS to send critical-event email/webhook notifications.
- **Implemented now:** Notification preferences, subscriptions, delivery records, dispatcher, SNS adapter, and project notification settings are present.
- **Difference:** Live SNS delivery requires AWS credentials/configuration. It remains **UNVERIFIED** until a real publish/receipt is executed.
- **Score:** **80/100**

## 6.15. Infrastructure Lifecycle & Demolition (Destroy)

- **Written in PDF:** Use dual confirmation and `terraform destroy` to remove active environments while explicitly protecting persistent EFS volumes from accidental loss.
- **Implemented now:** Destroy admission/confirmation, Terraform destroy dispatch, AWS deletion verification, persisted evidence, and project-scoped lifecycle finalization are implemented.
- **Difference:** The exact PDF rule “always skip EFS volume destruction” is not a safe universal current claim because storage/database lifecycle must follow the project's authoritative recovery/data contract. Repeat-destroy and database preservation scenarios require AWS proof.
- **Score:** **80/100**

## 6.16. Vendor Independence & Terraform Export (No Lock-in)

- **Written in PDF:** Let users download generated Terraform scripts as a ZIP archive to retain ownership of infrastructure-as-code.
- **Implemented now:** A Terraform export module, controller, artifact entity, and export service are present.
- **Difference:** The application remains AWS-specific, exactly as the PDF's limitations section states. Export correctness should be confirmed with an actual generated project archive.
- **Score:** **85/100**

## 6.17. Subscription & Billing Management

- **Written in PDF:** Offer Free/Pro plans, secure payment checkout, plan/invoice dashboard, payment updates, usage tracking, and tier-limit alerts.
- **Implemented now:** Billing accounts, subscriptions, checkout sessions, invoices, payments, webhook events, usage counters, entitlements, and billing UI/services are present. Stripe is intentionally test-mode when configured.
- **Difference:** Real payment processing must not be claimed without valid provider configuration and webhook execution. Current proof is structural/test-mode rather than production commerce evidence.
- **Score:** **80/100**

## What the current product missed from the PDF

1. **Redis/BullMQ queue and worker runtime:** this is the clearest missing PDF module requirement.
2. **The original broad stack-detection/template model:** the product shifted to Railpack plus canonical build contracts and a restricted fallback, rather than the PDF's visible framework/template catalogue.
3. **DynamoDB heartbeat lock protocol:** current state safety uses S3 native lockfiles, not the documented DynamoDB lock heartbeat and queue design.
4. **Fresh AWS/provider certification:** the code cannot prove Fargate Spot interruption recovery, all database engines, zero-downtime rollback, CloudWatch/SNS/Stripe production behavior, or repeat destroy.

## What the current product added or made safer than the PDF

1. Immutable deployment generation, runtime-config revision, image, task-definition, and stable-release identities.
2. Deterministic failure code, owner, service scope, evidence references, and safe retry guidance.
3. Read-time diagnosis improvement from later evidence without rewriting terminal audit history.
4. Strict AI evidence enforcement: unsupported citations, invented root-cause codes, and unsafe AI retry claims are rejected.
5. Explicit `UNVERIFIED` behavior instead of guessing whether a failure belongs to the application, platform, or provider.
6. A separate administrator session and clear developer/read-only route boundaries.

## Overall achievement against the PDF modules

**79 / 100 — source alignment with the 17 exact PDF modules.**

Calculation: **1340 ÷ 17 = 78.82**, rounded to **79**.

The score is not higher mainly because the PDF requires an active Redis/BullMQ worker system, a DynamoDB lock/heartbeat protocol, and several live AWS behaviors that are not proven in the current composed application. It is not a claim that the system is 79/100 reliable in production.

## Evidence used

- Supplied PDF: `Deploy Guard Updated Document Final.pdf`, pages containing section 6.1–6.17.
- Current code: [backend/src/app.module.ts](../backend/src/app.module.ts), [compose.yaml](../compose.yaml), [backend/src/projects/railpack-deployment.service.ts](../backend/src/projects/railpack-deployment.service.ts), [infrastructure/railpack-runtime](../infrastructure/railpack-runtime), and the linked source modules above.
