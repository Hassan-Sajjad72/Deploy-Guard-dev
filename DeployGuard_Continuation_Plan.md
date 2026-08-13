# DeployGuard Recovery and Continuation Plan

## Purpose

This document defines the exact order in which Codex should continue work on DeployGuard after recovery.

The target is a reliable lifecycle where:

- DeployGuard manages platform-owned environment variables.
- Users enter only application-specific variables.
- Stack detection produces one authoritative deployment profile.
- Dockerfile generation consumes that profile instead of guessing.
- Secrets can be safely reused after destroy and redeploy.
- CloudWatch Logs work for every project without manual IAM changes.
- GitHub Actions uses immutable deployment inputs.
- Terraform plans reconcile retained and existing resources safely.
- A LIVE project can be redeployed from a newer commit.
- Previous successful releases remain available for rollback.
- Destroy appears immediately in the UI and becomes `DESTROYED` only after infrastructure removal is verified.

Codex must complete one iteration at a time.

---

# Global Rules

1. Do not redesign the entire platform.
2. Do not convert the application to microservices.
3. Preserve the current React, NestJS, PostgreSQL, Redis/BullMQ, GitHub Actions, Terraform, ECS, ECR and ALB architecture.
4. Do not perform live deploy, rollback, destroy or Terraform apply unless explicitly authorized.
5. Do not manually delete AWS resources during implementation.
6. Never expose secrets in source files, logs, terminal output, Terraform plans, GitHub Actions output, Dockerfiles or reports.
7. Every iteration must include focused tests.
8. Run relevant backend and frontend builds after each iteration.
9. Stop after each iteration and report:
   - exact gap addressed;
   - files changed;
   - tests executed;
   - build results;
   - remaining risks;
   - whether the next iteration is safe.
10. Do not claim live AWS behavior is verified unless a controlled live test was actually completed.
11. Do not silently broaden framework support.
12. Fail closed when ownership, repository identity, commit evidence or infrastructure ownership is ambiguous.
13. Preserve existing working deploy, destroy and rollback behavior.
14. Avoid unrelated cleanup and refactoring.
15. Use the smallest safe change required.

---

# Required Order

1. Recovery baseline
2. Stack detection
3. Deployment-contract-driven Dockerfiles
4. DeployGuard-managed environment variables
5. Secrets Manager lifecycle
6. CloudWatch Logs
7. GitHub Actions safety
8. Terraform reconciliation
9. LIVE-project redeploy
10. Rollback workflow
11. Destroy lifecycle
12. Integrated end-to-end verification

Do not start a later iteration while an earlier dependency remains incomplete.

---

# Iteration 0 — Recovery Baseline

## Goal

Verify that the recovered DeployGuard repository is complete and safe to continue.

## Required Work

1. Verify these areas exist:
   - frontend;
   - backend;
   - worker;
   - Terraform templates/modules;
   - GitHub Actions workflow templates;
   - database migrations;
   - tests and scripts;
   - project documentation.

2. Verify active frontend routes still render:
   - `ProjectDetails`;
   - `ProjectOverviewLifecycle`;
   - pipeline history;
   - environment-variable management;
   - project settings.

3. Verify backend endpoints still exist for:
   - project creation;
   - stack detection;
   - deploy;
   - destroy;
   - rollback;
   - rollback release listing;
   - operation status;
   - pipeline history.

4. Verify BullMQ/Redis worker code still exists and can start.

5. Verify database migrations are ordered and can bootstrap a clean database.

6. Run:
   - backend build;
   - frontend build;
   - existing focused tests;
   - migration validation;
   - existing lint or type checks;
   - `git diff --check`.

7. Report:
   - missing files;
   - corrupted files;
   - unresolved imports;
   - broken routes;
   - migration blockers;
   - duplicated active and dormant components.

## Constraints

- Do not deploy.
- Do not destroy.
- Do not run Terraform apply.
- Do not modify AWS.
- Do not refactor architecture.
- Do not delete dormant code in this iteration.

## Done When

- Backend builds.
- Frontend builds.
- Existing tests run.
- Core deployment routes exist.
- Migration bootstrap is verified or its exact blocker is reported.

---

# Iteration 1 — Reliable Stack Detection

## Goal

DeployGuard must correctly detect supported application stacks and produce one validated deployment profile.

The deployment profile must be the single source of truth for Dockerfile generation, GitHub Actions, Terraform and ECS.

## Supported Baseline

### JavaScript and TypeScript

- Next.js SSR
- Next.js static export
- React with Vite
- Express
- NestJS
- Fastify

### Python

- Flask
- FastAPI
- Django
- Streamlit

Do not add frameworks outside this baseline in this iteration.

## Required Detection Outputs

For every supported application, determine and persist:

- ecosystem;
- language;
- framework;
- framework mode;
- package manager;
- lockfile;
- declared runtime version;
- application root directory;
- install command;
- build command;
- start command;
- output directory;
- runtime port;
- health-check path;
- SSR, static or backend-service classification;
- database requirement only when proven;
- required runtime variables;
- required build-time variables;
- repository identity;
- branch;
- exact Git commit SHA;
- detection confidence;
- evidence supporting every decision;
- validated user overrides;
- warnings and unsupported conditions.

## Required Behavior

1. Use repository evidence, not filenames alone.
2. Inspect package scripts, dependencies, lockfiles, framework config, imports, Python dependency files, entry files, Dockerfiles and folder structure.
3. Distinguish:
   - Vite React from generic React;
   - Next.js SSR from static export;
   - NestJS from generic Node;
   - Fastify from Express;
   - FastAPI from Flask;
   - Django project root and settings module;
   - Streamlit entry file.
4. Detect application-factory patterns where supported.
5. Detect a monorepo or application subdirectory only when one supported root can be identified confidently.
6. Never invent commands when evidence is insufficient.
7. Return `MANUAL_INPUT_REQUIRED` when:
   - multiple roots are equally plausible;
   - start command is ambiguous;
   - framework evidence conflicts;
   - repository is empty;
   - repository is unsupported;
   - required runtime evidence is missing.
8. Refresh detection whenever the configured branch commit changes.
9. Reject deployment when:
   - detection commit SHA differs from deployment-contract SHA;
   - repository or branch changed after detection;
   - overrides conflict with repository identity;
   - stored evidence is stale.
10. Preserve explicit user overrides only after validation.
11. Never silently fall back to generic Node or Python when evidence conflicts.

## Required Test Fixtures

- Next.js SSR
- Next.js static export
- Vite React
- Express
- NestJS
- Fastify
- Flask
- Flask application factory
- FastAPI
- Django with non-default settings structure
- Streamlit
- unsupported repository
- empty repository
- ambiguous monorepo
- stale detection after a new commit
- conflicting user override
- missing start command
- missing lockfile
- package-manager mismatch

## Constraints

- Do not deploy.
- Do not change Terraform.
- Do not modify AWS.
- Do not broaden framework support.
- Do not generate unsafe fallback commands.
- Do not alter rollback or destroy behavior.

## Done When

- Every supported fixture produces a deterministic profile.
- Ambiguous and unsupported fixtures fail safely.
- Detection stores exact commit evidence.
- Deployment is blocked when detection is stale.

---

# Iteration 2 — Deployment-Contract-Driven Dockerfiles

## Goal

Generated Dockerfiles must consume the validated deployment profile and must not redetect or guess independently.

Runtime configuration should be injected at runtime wherever technically possible.

## Single Source of Truth

The Dockerfile generator must consume:

- framework;
- framework mode;
- application root;
- package manager;
- install command;
- build command;
- start command;
- output directory;
- runtime port;
- health-check path;
- runtime version;
- build-time variable classification;
- runtime variable classification;
- commit SHA.

No later stage may independently guess these values.

## Runtime Injection Rules

1. Inject secrets and operational values through:
   - ECS environment variables;
   - ECS Secrets Manager references;
   - safe runtime command arguments where required.

2. Never place secrets in:
   - Dockerfiles;
   - Docker build arguments;
   - image layers;
   - generated repository files;
   - GitHub Actions logs;
   - Terraform plans;
   - image history.

3. DeployGuard manages reserved variables such as:
   - `PORT`;
   - `NODE_ENV`;
   - `AWS_REGION`;
   - `DATABASE_URL`;
   - generated database variables;
   - project ID;
   - environment ID;
   - operation ID;
   - log-group identifiers.

4. Users may supply only application-specific variables.
5. Reserved variables cannot be created, edited, deleted or overridden by users.

## Build-Time Variable Rules

Use explicit categories:

- `BUILD_TIME_PUBLIC`
- `RUNTIME_PUBLIC`
- `RUNTIME_SECRET`
- `PLATFORM_MANAGED`

Rules:

1. Only proven public build-time variables may be passed during build.
2. Framework-defined public prefixes may be recognized where supported.
3. Secrets must never be passed as build arguments.
4. Changing a build-time public value requires a new image build.
5. Runtime secrets remain outside the image.
6. Reject configuration when a secret is requested at build time.

## Dockerfile Requirements

- deterministic base-image selection;
- supported runtime major version;
- correct application root;
- lockfile-aware installation;
- multi-stage builds where appropriate;
- production-only final dependencies;
- non-root runtime user where supported;
- correct output copying;
- no development server in production;
- bind to `0.0.0.0`;
- use runtime-injected `PORT`;
- deterministic start command;
- no embedded credentials;
- appropriate `.dockerignore`;
- framework-appropriate startup and health behavior.

## Framework Cases

Verify Docker generation for:

- Next.js standalone/SSR
- Next.js static export
- Vite React static serving
- Express
- NestJS
- Fastify
- Flask with a production WSGI server
- FastAPI with a production ASGI server
- Django with a production WSGI or ASGI server
- Streamlit with runtime address and port configuration

## Preflight Validation

Before workflow dispatch:

1. Validate the deployment profile.
2. Generate the Dockerfile from that exact profile.
3. Verify command consistency.
4. Verify required runtime variables will be supplied.
5. Reject missing build-time public variables.
6. Reject forbidden secret build arguments.
7. Build fixture images where practical.
8. Start fixture containers and verify:
   - process remains running;
   - expected port is listening;
   - health path responds;
   - runtime variables are received;
   - secrets do not appear in generated files;
   - secrets do not appear in image history.

## Constraints

- Do not modify application repositories.
- Do not inject guessed commands.
- Do not expose secrets.
- Do not deploy to AWS.
- Do not change rollback, destroy or Terraform architecture.

## Done When

- All supported fixtures generate valid Dockerfiles.
- Runtime injection works for fixture containers.
- Build-time and runtime boundaries are enforced.
- Unsafe secret build arguments are blocked.

---

# Iteration 3 — DeployGuard-Managed Environment Variables

## Goal

DeployGuard must own all platform, infrastructure and runtime variables.

Users should enter only application-specific values.

## Required Work

1. Identify all variables required by:
   - Dockerfiles;
   - ECS task definitions;
   - database containers;
   - Terraform;
   - GitHub Actions;
   - health checks;
   - logging;
   - deployment operations.

2. Create one authoritative reserved-variable registry.

3. Categorize each variable as:
   - platform-managed;
   - infrastructure-generated;
   - runtime secret;
   - runtime public;
   - build-time public;
   - user-defined.

4. Prevent users from:
   - creating reserved variables;
   - editing reserved variables;
   - deleting reserved variables;
   - overriding reserved variables;
   - supplying reserved names through APIs.

5. Remove UI fields for values DeployGuard can derive.

6. Show managed variables separately:
   - names may be visible;
   - secret values remain hidden;
   - label them `Managed by DeployGuard`.

7. Reject collisions with structured validation errors.

8. Preserve existing user-defined variables.

9. Ensure platform variables exist before deployment-contract finalization.

10. Version environment references with release evidence without exposing values.

## Constraints

- Do not deploy.
- Do not change Terraform architecture.
- Do not modify rollback or destroy behavior.
- Do not expose secret values.

## Done When

- Reserved variables are enforced in backend and frontend.
- Users manage only application-specific variables.
- Tests cover create, edit, delete and override attempts.

---

# Iteration 4 — Secrets Manager Lifecycle

## Goal

Normal destroy must not prevent redeployment ten minutes later because a fixed-name secret is scheduled for deletion.

## Required Lifecycle

Normal destroy:

- retain project secrets;
- mark them retained or inactive;
- allow later reuse.

Permanent deletion:

- must be a separate explicit purge;
- must not be triggered by the normal destroy button.

## Required Behavior

1. Tag each DeployGuard-owned secret with:
   - `ManagedBy=DeployGuard`;
   - `DeployGuardProjectId`;
   - `Environment`;
   - `SecretPurpose`.

2. Before Terraform plan:
   - discover the expected secret;
   - verify ownership tags;
   - reuse/import active secrets;
   - restore recoverable secrets when ownership is valid;
   - fail closed on mismatch;
   - avoid duplicate fixed-purpose secrets.

3. Normal destroy must not schedule reusable secrets for deletion.

4. Redeployment shortly after destroy must reuse retained secrets without name collisions.

5. Terraform must not replace secret versions only because generated values differ from local configuration.

6. New projects must still create initial values normally.

7. Legacy secrets may be adopted only after exact ownership verification.

8. Do not create new versions unnecessarily during import.

9. Never print secret values.

10. Design, but do not activate, a separate permanent purge workflow.

## Required Tests

- missing secret
- active secret
- retained secret
- scheduled-deletion secret
- restored secret
- wrong tags
- missing tags
- duplicate names
- new-project creation
- redeploy after destroy
- Terraform no-op for existing secret versions

## Constraints

- Do not use force deletion without recovery in normal destroy.
- Do not manually alter live AWS resources.
- Do not change rollback behavior.
- Do not reveal secret values.

## Done When

- Normal destroy retains reusable secrets.
- Redeploy avoids scheduled-deletion collisions.
- Ownership checks fail closed.
- Terraform does not replace secret versions unexpectedly.

---

# Iteration 5 — Project-Scoped CloudWatch Logs

## Goal

Every project must receive safe CloudWatch logging without creating or editing IAM policy manually for each project.

## Required Names

- `/deployguard/<projectId>/app`
- `/deployguard/<projectId>/database`
- `/deployguard/<projectId>/deployment`

Use existing compatible repository conventions where present.

## Required Behavior

1. Generate log-group names automatically.
2. Users must not enter them.
3. Create and configure log groups automatically.
4. Use one bounded IAM pattern covering only the DeployGuard namespace.
5. Do not create a new IAM policy per project.
6. Permit only required actions:
   - `logs:CreateLogGroup`;
   - `logs:CreateLogStream`;
   - `logs:PutLogEvents`;
   - `logs:DescribeLogStreams`.
7. Do not grant `logs:*`.
8. Do not grant access to unrelated groups.
9. Configure retention.
10. Tag log groups with ownership metadata.
11. Validate tags before adoption.
12. Make Terraform idempotent when groups already exist.
13. Keep app, database and deployment logs separated.
14. Include required log identifiers in the deployment contract.

## Required Tests

- new project log group
- existing owned group
- wrong tags
- unrelated group denied
- wildcard policy supports another valid project UUID
- retention
- Terraform no-op after adoption
- namespace separation

## Constraints

- Do not grant global CloudWatch access.
- Do not deploy.
- Do not alter detection or rollback logic.

## Done When

- One bounded policy supports all valid project log groups.
- New projects need no manual IAM edit.
- Existing groups reconcile safely.

---

# Iteration 6 — GitHub Actions Safety

## Goal

Every deployment must run from immutable, operation-scoped inputs.

Workers and workflows must not read mutable project state midway through a run.

## Required Immutable Inputs

- operation ID
- project ID
- environment
- repository
- branch
- exact commit SHA
- deployment-profile version
- deployment-contract version
- image tag
- image digest
- runtime port
- health path
- environment references
- infrastructure namespace

## Required Behavior

1. Validate repository, branch and commit before dispatch.
2. Ensure detection SHA matches contract SHA.
3. Persist queued operation before dispatch.
4. Store workflow run ID immediately after dispatch.
5. Prevent concurrent deploy, destroy or rollback for one project.
6. Retry must remain attached to the same operation.
7. Retry must not silently use a newer commit.
8. Centrally manage required workflow permissions.
9. Do not require per-project manual policy changes.
10. Return structured errors for:
    - dispatch failure;
    - authentication failure;
    - workflow missing;
    - wrong repository;
    - stale commit;
    - duplicate active operation;
    - invalid contract.
11. Enforce idempotency.
12. Prevent cross-project contract use.
13. Pass secrets only through secure references.
14. Prevent credential leakage in logs.

## Required Tests

- stale commit
- wrong repository
- wrong branch
- duplicate operation
- duplicate click
- same-operation retry
- retry attempting newer commit
- missing workflow
- dispatch error
- operation persisted before scheduling
- run ID persistence
- cross-project rejection

## Constraints

- Do not run a live workflow.
- Do not change Terraform architecture.
- Preserve endpoint contracts unless a proven defect requires a minimal correction.

## Done When

- Operations are immutable and idempotent.
- Dispatch uses fixed contract data.
- Stale and duplicate operations are rejected safely.

---

# Iteration 7 — Terraform Pre-Plan Reconciliation

## Goal

Resolve known repeatability failures before `terraform apply`.

No system can guarantee zero external failures, but DeployGuard must prevent known state, ownership and lifecycle conflicts.

## Reconcile Before Plan

- Secrets Manager secrets and versions
- CloudWatch log groups
- ECR repositories
- EFS file systems
- EFS access points
- Terraform backend prerequisites
- state-lock prerequisites
- retained resources
- existing ECS/ALB resources where relevant
- imported project-owned resources

## Required Behavior

1. Detect:
   - missing;
   - active;
   - existing;
   - imported;
   - retained;
   - scheduled for deletion;
   - ownership mismatch;
   - orphaned;
   - ambiguous resources.

2. Verify ownership tags before import or adoption.

3. Import only resources proven to belong to the project and environment.

4. Fail closed on ambiguity.

5. Ensure backend initialization is consistent:
   - do not declare a remote backend and use incompatible `-backend=false`;
   - initialize with intended backend config;
   - surface backend errors before plan.

6. Run:
   - `terraform fmt -check`;
   - `terraform validate`;
   - `terraform init`;
   - `terraform plan` with detailed exit codes.

7. Reject plans that unexpectedly:
   - replace retained secrets;
   - create needless secret versions;
   - destroy persistent EFS;
   - recreate unrelated resources;
   - cross project namespaces;
   - recreate owned existing log groups;
   - delete retained state resources.

8. Save a sanitized plan summary as operation evidence.

9. Do not store sensitive values.

10. Ensure repeated planning is idempotent.

## Required Fixtures

- first deployment
- repeated plan
- redeploy
- redeploy after destroy
- existing secrets
- existing log groups
- existing EFS
- wrong tags
- remote backend initialization
- scheduled-deletion secret
- unrelated project resource
- unexpected replacement

## Constraints

- Do not run apply.
- Do not alter unrelated architecture.
- Do not manually modify AWS resources.

## Done When

- Known secret, log, EFS and backend conflicts are handled before apply.
- Unsafe plans are rejected.
- Safe repeated plans are no-op or expected in-place updates.
- Sanitized plan evidence is persisted.

---

# Iteration 8 — LIVE-Project Redeploy

## Goal

A LIVE project must deploy a newer commit from the same repository without being destroyed first.

## Required UI Actions

For a manageable LIVE project:

- Open Application
- Redeploy
- Rollback application
- Destroy Infrastructure

Rollback may be disabled when no previous eligible release exists.

## Required Flow

1. User pushes a new commit.
2. User clicks `Redeploy`.
3. DeployGuard fetches the latest branch commit.
4. DeployGuard reruns detection.
5. DeployGuard creates a new validated profile.
6. DeployGuard creates a new immutable contract.
7. DeployGuard calls the existing deploy endpoint.
8. Queued operation appears immediately.
9. Existing live release remains available during deployment.
10. New release becomes live only after health verification.
11. Previous release remains stored as rollback evidence.
12. If the new deployment fails, the previous healthy release remains or is restored.

## Safety

- Do not destroy before redeploy.
- Prevent duplicate clicks.
- Respect project-level operation lock.
- Reject stale detection.
- Do not use dormant legacy deployment components.
- Do not overwrite previous release evidence.
- Show structured errors.
- Disable redeploy while another operation is active.

## Required Tests

- LIVE project shows redeploy
- latest commit refresh
- detection before deploy
- stale commit blocked
- queued operation rendered
- duplicate click prevented
- previous release preserved
- current release changes only after health success
- failed release preserves prior healthy release

## Constraints

- Do not perform a live deployment during implementation.
- Do not alter Terraform, destroy or rollback architecture.
- Do not change detection rules without a proven failing test.

## Done When

- Same-project redeploy is reachable.
- A second successful release can be created.
- The first release remains eligible for rollback.

---

# Iteration 9 — Reachable Rollback Workflow

## Goal

Rollback must be visible, understandable and usable after a newer successful release exists.

## Required UI Behavior

1. Show `Rollback application` for manageable LIVE projects.
2. When no previous release exists:
   - show the button disabled;
   - display `No previous successful release is available`.
3. Do not silently hide API failures as an empty candidate list.
4. Distinguish:
   - no eligible releases;
   - API failure;
   - project not LIVE;
   - insufficient permission;
   - active operation.

## Candidate Rules

A candidate must be:

- completed successfully;
- older than the current live release;
- from the same project;
- from the same environment;
- backed by immutable evidence;
- associated with an exact image digest;
- associated with historical runtime configuration;
- associated with historical port and health settings.

Exclude the current live release.

## Execution Rules

Rollback must use:

- historical image digest;
- historical task definition or inputs;
- historical runtime references;
- historical port;
- historical health path.

Rollback must not:

- pull current repository code;
- rerun detection;
- regenerate Dockerfiles;
- rebuild an image;
- run unrelated Terraform;
- modify database data;
- automatically roll back database migrations.

## Failure Handling

1. Save the currently live task definition.
2. Deploy the selected historical release.
3. Verify health.
4. If health fails:
   - restore the previously live task definition;
   - mark rollback failed;
   - preserve evidence.

## Required Tests

- Release A succeeds
- Release B succeeds
- A becomes candidate
- B is excluded
- rollback uses A digest
- repository changes do not affect rollback
- no rebuild
- no redetection
- rollback failure restores B
- disabled UI when no candidate
- structured API failure

## Constraints

- Do not trigger a live rollback during implementation.
- Do not alter database data or migrations.
- Do not modify normal deployment architecture.

## Done When

- Rollback is reachable from Project Overview.
- Previous successful releases are listed correctly.
- Rollback uses immutable historical evidence.

---

# Iteration 10 — Immediate and Verified Destroy

## Goal

Destroy must appear immediately in the UI, while final `DESTROYED` status must only be set after infrastructure removal is verified.

## State Flow

```text
DESTROY_QUEUED
→ DESTROYING
→ DESTROYED
```

Failure:

```text
DESTROY_QUEUED
→ DESTROYING
→ FAILED
```

## Required Behavior

1. Persist destroy operation before scheduling.
2. Return queued operation immediately.
3. Close modal after queued response.
4. Show immediately:
   - operation ID;
   - status;
   - requested time;
   - current phase.
5. Transition to `DESTROYING` when execution starts.
6. Do not mark `DESTROYED` only because Terraform returned success.
7. Verify:
   - ECS application service absent;
   - ECS database service absent where applicable;
   - running task count is zero;
   - ALB listener and target resources are absent or detached;
   - application endpoint no longer serves the project;
   - normal-destroy project resources are absent.
8. Retain intentionally excluded resources:
   - project secrets;
   - retained Terraform state;
   - persistent storage according to policy;
   - audit history;
   - release history.
9. After verification, set canonical state `DESTROYED`.
10. Show `Deploy Again` for destroyed projects.
11. Allow redeployment shortly afterward using retained resources.
12. On failure:
    - show exact stage;
    - retain evidence;
    - allow idempotent retry;
    - avoid duplicate operations.

## Required Tests

- immediate queued response
- modal closes after success
- duplicate click prevented
- correct state transitions
- Terraform success without absence does not mark destroyed
- retained secrets remain
- endpoint verification
- failed destroy
- retry
- restart recovery
- redeploy after destroy

## Constraints

- Do not perform a live destroy during implementation.
- Do not use normal destroy for permanent purge.
- Preserve idempotency and project lock.
- Do not falsely report success.

## Done When

- Destroy appears instantly.
- Final state is evidence-based.
- Retained resources permit near-term redeployment.
- Failure and retry behavior are tested.

---

# Iteration 11 — Integrated End-to-End Verification

## Goal

Verify that all iterations work together.

Run only after all previous iterations pass.

## Controlled Lifecycle

1. Select a controlled test repository.
2. Create one DeployGuard project.
3. Confirm stack detection.
4. Confirm deployment profile.
5. Confirm Dockerfile generation.
6. Confirm user enters only application-specific variables.
7. Confirm platform variables are managed automatically.
8. Deploy Release A.
9. Confirm:
   - GitHub Actions run linked;
   - image digest captured;
   - ECS healthy;
   - CloudWatch logs working;
   - secrets tagged correctly;
   - Terraform evidence saved.
10. Push a harmless visible code change.
11. Use `Redeploy`.
12. Deploy Release B.
13. Confirm Release A remains available.
14. Confirm rollback becomes active.
15. Roll back to Release A.
16. Confirm no rebuild or redetection occurred.
17. Destroy infrastructure.
18. Confirm immediate `DESTROY_QUEUED`.
19. Confirm `DESTROYING`.
20. Confirm final `DESTROYED` only after verification.
21. Confirm retained secrets are not scheduled for deletion.
22. Redeploy the same project shortly afterward.
23. Confirm no secret name collision.
24. Confirm no manual CloudWatch IAM change is needed.
25. Confirm Terraform plan is safe and repeatable.

## Required Evidence

Capture:

- project ID;
- operation IDs;
- commit SHAs;
- workflow run IDs;
- image digests;
- release IDs;
- rollback source release;
- sanitized Terraform summaries;
- ECS health;
- CloudWatch log-group names;
- ownership tags without values;
- destroy verification;
- redeploy-after-destroy result.

## Constraints

- Use a controlled non-production project.
- Do not expose secrets.
- Do not declare success from tests alone.
- Separate external failures from application defects.

## Done When

```text
Create project
→ detect
→ generate contract
→ deploy Release A
→ push change
→ redeploy Release B
→ rollback to Release A
→ destroy
→ verify DESTROYED
→ redeploy shortly afterward
```

---

# Final Architecture Rule

The required dependency chain is:

```text
Repository evidence
→ validated detection profile
→ generated Dockerfile
→ immutable deployment contract
→ GitHub Actions build
→ image digest
→ Terraform/ECS deployment
→ runtime environment injection
→ health verification
→ immutable release record
```

No later stage may independently guess:

- framework;
- package manager;
- application root;
- install command;
- build command;
- start command;
- output directory;
- runtime port;
- health path;
- environment-variable ownership;
- repository;
- branch;
- commit SHA.

---

# Codex Continuation Protocol

For each iteration, Codex must:

1. Read this document.
2. Find the first incomplete iteration.
3. Inspect the current implementation before editing.
4. State the exact gap.
5. Implement only that iteration.
6. Add focused tests.
7. Run relevant builds.
8. Run `git diff --check`.
9. Do not perform live AWS actions unless explicitly authorized.
10. Stop and report.

Use this report format:

```text
Iteration:
Exact gap:
Files changed:
Behavior implemented:
Tests added:
Tests run:
Build results:
Live actions performed:
Known limitations:
Safe to continue:
Next iteration:
```

Codex must not continue automatically into the next iteration without explicit user instruction.

---

# Initial Codex Instruction

```text
Read the complete DeployGuard continuation plan in this Markdown file.

Start with the first incomplete iteration only.

Before editing, inspect the current repository and report the exact gap for that
iteration. Then implement only that bounded iteration, add focused tests, run
relevant builds, run git diff --check, and stop.

Do not deploy, destroy, roll back, run Terraform apply, modify live AWS
resources or expose secrets unless I explicitly authorize a controlled live
verification.

Do not continue automatically into the next iteration.
```
