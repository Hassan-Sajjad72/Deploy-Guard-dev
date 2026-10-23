# DeployGuard Railway Product Contract

Status: authoritative intended-product contract  
Effective date: 2026-08-01

## Authority and conflict policy

This file is the sole authority for DeployGuard's intended finished developer
product, developer/operator separation, and launch behavior.

- Current source code, database schema, runtime configuration, and passing tests
  remain authoritative for what exists today.
- [REMAINING_WORK.md](REMAINING_WORK.md) is the sole active implementation queue.
- [FINAL_RESULT.md](FINAL_RESULT.md) contains evidence and verdicts only.
- All other Markdown files, architecture reports, trackers, proposals, PDFs,
  completion reports, and audit documents are historical or reference evidence.
  This includes `FINAL_DAY_COMPLETION_TRACKER.md`,
  `PHASE_10_NORMAL_WORKFLOW_INTEGRATION.md`,
  `TYPEORM_SCHEMA_CONTRACT_AUDIT.md`, `CURRENT_ORCHESTRATION_MAP.md`,
  `SOURCE_OF_TRUTH_CONFLICTS.md`, `SETUP_REQUIRED.md`, the working report, the
  original proposal, and the Railway-like architecture/recovery report.

When evidence conflicts, this contract controls intended user behavior; verified
code/runtime/tests control current implementation; protected safety guarantees
remain mandatory; the required change belongs only in `REMAINING_WORK.md`.

## Protected execution foundation

The verified shared normal-v1 foundation is protected. Product work must reuse,
not broadly redesign, its release, infrastructure-plan, and infrastructure-apply
workers; shared/canary activation; immutable intents and manifests; deterministic
outbox/BullMQ identity; advisory locks; cross-lane ownership; leases, fencing,
heartbeat, side-effect journals, bounded reconciliation, isolation, stable/latest
separation, unchanged-source `NO_OP`, and truthful durable history.

The preferred change order is developer projection, canonical action, automatic
composition of existing exact commands, authorization separation, frontend
presentation, then platform-owned reconciliation presentation. Core execution may
change only when focused evidence proves these existing boundaries insufficient.

## Normal developer journey

1. Sign in.
2. Select or connect a GitHub repository.
3. Select a branch when necessary.
4. DeployGuard determines whether the complete stack is supported.
5. DeployGuard requests only genuinely missing application-owned configuration.
6. The user clicks **Deploy** once.
7. The application progresses through **Preparing → Building → Deploying →
   Verifying → Live**.
8. The user receives repository, branch, commit, current status, estimated monthly
   cost when available, application logs, deployment history, previous stable
   deployment, verified live URL, and concise application-level error guidance.

Ordinary source changes use the release-only path and never invoke Terraform. An
immutable configuration-identity change may validly redeploy an unchanged source
commit. A browser refresh restores durable state and never creates or dispatches
work.

## Developer surface

Normal developer navigation contains only:

- Overview
- Deployments
- Environment
- Logs
- Metrics
- Settings

Developers may see repository/branch/commit, simple deployment progress,
application configuration, estimated cost, application logs, latest attempt,
previous stable release, stable URL, and application-owned errors.

Developers must not see or operate Terraform plan/state/lock/apply controls;
infrastructure manifests/revisions; AWS/IAM/ARN/ECS/ECR/ALB details; inventory
errors; workers/capabilities; queues/job IDs; outboxes/claims; ownership/leases/
fences; journals; raw `NORMAL_*` codes; cleanup/residue/force-unlock controls;
recovery stages; low-level rollback; or fixture/mock/provider gates.

Those capabilities remain available only through backend-authorized operator/admin
routes and UI. Hiding a link is not authorization. Developer presentation uses
**Deploy**, **Redeploy**, **Approve Cost**, **Provide Configuration**,
**Open Application**, or no button while automatic work progresses. It never asks
the developer to review or execute an internal deployment stage.

## Canonical sanitized developer backend contract

One authoritative response powers all minimum developer pages. It exposes:

- `developerState`: `ready`, `preparing`, `queued`, `building`, `deploying`,
  `verifying`, `live`, `configuration_required`, `approval_required`,
  `failed_application`, `platform_attention`, or `unsupported`;
- `developerAction`: `deploy`, `redeploy`, `provide_configuration`,
  `approve_cost`, `open_application`, or `none`;
- `developerMessage`, `progress`, `repository`, `branch`, `commit`,
  `latestAttempt`, `stableRelease`, `stableUrl`, `estimatedCost`,
  `missingConfiguration`, `applicationError`, and `canRetry`.

Overview, Deployments, Environment, Logs, Metrics, and Settings must agree about
the current operation, latest attempt, stable release, commit, and URL. The
frontend must not reconstruct truth by merging worker, Terraform, inventory,
legacy, and infrastructure responses. Detailed current-state evidence remains a
separate operator/admin projection. A URL is live only when backed by verified
stable-release evidence.

## Blocker ownership

Developer-resolvable blockers are limited to unsupported/inaccessible repository,
uninferable build/start command, genuinely required environment values,
application build/health failure with sanitized guidance, and workspace-owner cost
approval when policy requires it.

Inventory read failures, Terraform transitions, stale cloud evidence, worker/AWS
uncertainty, lock/lease reconciliation, old lineage, residue classification,
IAM/platform configuration, provider outages, quota, and internal policy are
platform-owned. They preserve the immutable operation, reconcile automatically
when safe, enter bounded operator review otherwise, and never invite blind retry.
Developers see only a neutral `platform_attention` message and retain any previous
stable deployment.

## Existing project and residue contract

Operator-only reconciliation classifies prior evidence as exactly one of:

1. valid existing stable deployment;
2. adoptable existing deployment;
3. incomplete but recoverable operation;
4. conclusively safe abandoned residue;
5. ambiguous state requiring operator review.

Only conclusively safe project-owned residue may expose operator cleanup. Truthful
history and valid resources are never deleted to manufacture a fresh Deploy
button. Valid deployments expose stable state and normal **Redeploy**. Recoverable
operations resume the same immutable identity. Developers never perform cleanup.

## Automatic deployment and cost policy

For a clean supported project, one Deploy click creates or reuses one immutable
normal-v1 operation, dispatches exact infrastructure planning, evaluates
Infracost, applies policy, dispatches exact apply when authorized, reconciles the
foundation, prepares and dispatches the first release, builds/publishes one
immutable image, deploys, verifies, promotes stable, and exposes the stable URL.
HTTP requests never start worker processes. Duplicate clicks/requests create one
effective operation and one effective set of external side effects.

Cost policy is explicit:

- non-destructive first deployment below the workspace threshold is internally
  auto-approved;
- cost above threshold exposes the estimate and **Approve Cost** only to an
  authorized workspace owner;
- destructive or unusually broad changes require operator/admin approval;
- ordinary source-only redeployment is release-only and has no Terraform step.

Cost evidence is never fabricated and enforced policy is never bypassed.

## Supported-stack matrix

Detection alone is not support. Launch support requires reliable detection, a
valid Docker build, build/start commands, `0.0.0.0`, platform port binding,
meaningful health checks, normal release-handler deployment, and useful logs.

| Stack | Current adapter evidence | Launch contract status |
|---|---|---|
| Node.js / Express | Detection, Docker template, commands, port and preflight fixtures pass | Candidate; full normal-v1 acceptance required |
| React / Vite static | Detection and deterministic static template/preflight fixtures pass | Candidate; full normal-v1 acceptance required |
| Next.js | SSR/static detection and template/preflight fixtures pass | Candidate; full normal-v1 acceptance required |
| Python / Flask | Detection, template, command and preflight fixtures pass | Candidate; full normal-v1 acceptance required |
| Python / FastAPI | Detection, template, command and preflight fixtures pass | Candidate; full normal-v1 acceptance required |
| Python / Streamlit | Detection, template, command and preflight fixtures pass | Candidate; full normal-v1 acceptance required |
| Django | Detection, template, command and preflight fixtures pass | Candidate; full normal-v1 acceptance required |
| NestJS, Fastify, generic Node/Python, custom Dockerfile | Partial detector/template support exists | Not launch-certified until full adapter proof |
| React Native, PHP/Laravel, Ruby, other stacks | No complete verified adapter | Unsupported |

Until a candidate passes the complete adapter acceptance, the product must not
claim it as launch-supported. Unsupported repositories receive only: **“This
repository type is not yet supported.”** They receive no Docker, Terraform, ECS,
or cloud-repair guidance.

## Environment values and secrets

DeployGuard requests only genuinely required application variables. Values are
isolated by workspace/project/environment, encrypted at rest using the supported
mechanism, masked, absent from frontend responses/logs/images/queue payloads, and
frozen into an immutable deployment configuration identity. Configuration changes
may trigger deployment even when source is unchanged. Cross-project/workspace
reuse is prohibited. Users are never asked for platform AWS, Terraform, worker,
or Infracost configuration.

## Multi-user and multi-project contract

Every operation binds actor → workspace → project → environment → immutable
operation. Authorization isolates projects, logs, secrets, deployments, and URLs.
Different projects progress independently; same-project mutations serialize;
shared workers require no project restart/configuration; substitution fails; and
queue/concurrency controls prevent duplicate work. No Smart Retail, Project-Tst,
or test-project exception belongs in product code.

## Launch acceptance

Launch requires the full program acceptance: clean Express and Python projects,
an application requiring configuration, existing Smart Retail and Project-Tst
history, source `NO_OP` and release-only changes, automatic first deployment,
cross-workspace denial, secret isolation, concurrency/serialization, duplicate
click, refresh, worker restart, stable/latest separation, and zero leaked leases,
owners, or claims on real local PostgreSQL/Redis/backend/frontend/shared workers.
No developer page may expose the prohibited internal terminology. All protected
tests/builds must pass and no unresolved P0/P1 launch blocker may remain.

This transformation program stops before live AWS mutation. Live AWS evidence is
reported separately and never inferred from local success.
