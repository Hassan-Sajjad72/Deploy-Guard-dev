# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: developers and small teams.** The model is Render-style: they have an app in a GitHub repository and want it running on AWS without needing to know cloud infrastructure or DevOps. No knowledge of AWS, Terraform, containers, networking or CI is assumed. Their job:
- pick a repository and branch;
- add environment variables, and optionally a database;
- get a working public URL;
- know when something breaks and what to do about it.

**Secondary, inside the same product:**
- **Read-only members.** Teammates who inspect projects and history without changing anything.
- **Platform administrators.** A separate console covers users and roles, fleet-wide operations, audit logs and emergency cloud cleanup. Admins can be assumed to be more technical.

## Product Purpose

DeployGuard is a deployment control plane for AWS. It turns a selected source revision plus explicit configuration into a traceable cloud release. Build, scan, publish, provision, verify, promote, observe, recover and destroy all run through one governed lifecycle.

Success means that for any project, a user can tell at a glance:
- whether it is live;
- exactly which source, image and configuration is serving;
- what happened in the latest attempt.

And they can act safely without guessing.

The product is heading for a real production launch, not only an academic demonstration.

## Positioning

Render-style simplicity on the user's own AWS footprint, with deterministic, evidence-preserving delivery. Every deployment has a fixed identity that links:

- the source SHA;
- the build target;
- the runtime config revision;
- the immutable image digest;
- the task revision;
- the stable release.

"Latest" is never a release identity. Failures are classified with a deterministic code, stage, owner (application, platform or cloud provider) and retry guidance, not just a failed command. Rollback targets an exact previous immutable release; it does not rebuild. Destroy is verified against AWS. Evidence is shown honestly: unverified states are labelled as such instead of being presented as passes.

## Operating Context

- **Developer journey:**
  1. Connect a GitHub App installation, then pick the repository, branch and one or more service directories.
  2. DeployGuard resolves each service's build and port contract and collects service-scoped environment variables.
  3. Optionally attach a managed database.
  4. Review readiness, then deploy.
  5. Watch pipeline stages, then operate the project.
- **Execution:** GitHub Actions with short-lived AWS federation (OIDC) builds, scans with Trivy, publishes to ECR, and runs Terraform and ECS operations.
- **Runtime:** ECS Fargate behind Application Load Balancers, with CloudWatch, Secrets Manager, EFS, service discovery and managed database containers.
- **Observation:** CloudWatch evidence projected through the API, Prometheus metrics and Grafana dashboards. Troubleshooting adds evidence-grounded AI analysis.
- **Control plane:** a React/Vite web app; NestJS/TypeScript APIs and workers; PostgreSQL as the durable record; Redis/BullMQ for asynchronous jobs; Stripe in test mode for billing.
- **Usage:** users mostly return to existing projects to check whether the app is live, read failures and act. A new deployment is a less frequent, deliberate flow. The underlying AWS machinery above is the product's job, not the user's. Users see it only as optional evidence.

## Capabilities and Constraints

- **Lifecycle:** first deploy, release-only redeploy, exact rollback to the previous stable release, retry of failed attempts, Reset & Deploy Fresh, and verified destroy.
- **Admission gates:** permissions, configuration, security scan policy, cost (Infracost) and managed-database readiness.
- **Multi-service projects:** configuration belongs to the selected service.
- **Roles:**
  - developer (can manage);
  - read-only (inspect only);
  - admin (a separate console with its own email/password sign-in; GitHub accounts cannot enter it).
- **Plans:** Free, Pro ($399/month) and Pro Plus ($799/month), through Stripe test mode. Billing can be disabled entirely, in which case usage is unrestricted.
- **Terminology already in use:** Project, Service, Pipeline, Attempt, Generation, Stable Release, Redeploy, Rollback, Destroy, Live, Deploying, Failed, Blocked, Ready, Destroyed.
- **Honesty rule:** the UI must never present unverified cloud states as healthy or passed. Unavailable evidence is shown as unavailable.
- **Not yet proven live** (structural only, needing fresh AWS proof):
  - MySQL dynamic task-network grants;
  - MongoDB;
  - database-failure isolation and recovery;
  - topology reapply preserving the active release;
  - repeat-destroy idempotency.

## Brand Commitments

- **Name:** DeployGuard.
- **Landing headline (binding):** "The future doesn't wait for infrastructure. Neither do we."
- **About page:** the founders shown are real and binding:
  - Hassan Sajjad (co-founder & CEO, DevOps);
  - Faria Fatima (co-founder, backend & systems);
  - Tania Khawar (co-founder, backend & AI).
- **Guidance credits:** Asim Ali Fayyaz (mentorship), Yaseen Mushtaq (supervision) and Intelligement (company).
- **Not binding:** the shield logo and every current visual choice may change.

## Evidence on Hand

- **Certification:** stored evidence of two clean deployments, plus one complete deploy → release-only redeploy → rollback → destroy sequence. It includes a successful public health response and verified removal of project-scoped resources.
- **Product screenshots** from a real deployment (RentMate): `presentation_assets/`. They cover the overview, infrastructure, monitoring, GitHub Actions and the live app.
- **Team photos:**
  - `frontend/public/team/hassan-sajjad.webp`
  - `frontend/public/team/tania-khawar.webp`
  - There is no photo of Faria Fatima; the About page uses an illustration.
- **Absent, never to be fabricated:**
  - customer logos;
  - testimonials;
  - usage numbers;
  - uptime or performance benchmarks;
  - security certifications;
  - real paying customers.

## Product Principles

1. **Exact identity over convenience.** Always show what precisely is running and what an action will touch. Never imply "latest".
2. **Evidence before assertion.** Every status traces to recorded evidence. Unknown is shown as unknown.
3. **Ownership in every failure.** Say whose failure it is (application, platform or cloud) and the next safe step.
4. **One governed path.** Deploy, redeploy, rollback and destroy are the same lifecycle with explicit confirmation for destructive steps. Operators keep control; the product removes ambiguity, not authority.
5. **No cloud knowledge required.** Speak in the user's terms first: app, deploy, live, URL, logs, what broke and how to fix it. The cloud vocabulary and exact identifiers (ECS, ALB, Terraform, digests, task revisions) stay available as evidence for whoever wants them, but are never needed to understand state or take the next step.
