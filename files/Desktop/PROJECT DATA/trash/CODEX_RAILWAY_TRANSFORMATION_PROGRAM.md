Goal

Transform DeployGuard into a launch-ready, Railway-like developer platform
while preserving the already verified shared multi-project normal-v1 execution
engine.

Normal users must be able to connect supported repositories, provide only
genuinely required application configuration, click Deploy once, follow simple
progress, and receive a live URL.

Work in bounded iterations. After every iteration, verify the repository,
update the single implementation queue, report evidence, identify the next
iteration, and stop so I can click Continue.

Do not mutate AWS or publish an operational deployment job during this program.

──────────────────────────────────────────────────────────────────────────────
AUTHORITATIVE DOCUMENT MODEL
──────────────────────────────────────────────────────────────────────────────

Use one authority for each type of truth.

1. Current source code, database schema, runtime configuration and passing tests
   are the authoritative truth for what currently exists and what already works.

2. Create RAILWAY_PRODUCT_CONTRACT.md at the repository root.
   It is the sole authority for the intended finished developer product,
   developer/operator separation and launch behavior.

3. REMAINING_WORK.md is the sole active implementation queue.
   No other document may independently define unfinished work.

4. FINAL_RESULT.md is evidence and verdict only.
   It must not act as another task list.

5. Older Markdown files, reports, architecture documents, trackers, proposals
   and PDFs are reference or historical evidence only.
   They must not override:
   - the Railway product contract;
   - verified current implementation;
   - protected safety invariants.

Do not create another tracker, roadmap, completion file or competing source of
truth.

When documents conflict:

- RAILWAY_PRODUCT_CONTRACT.md controls intended user-facing behavior.
- Current code/runtime/tests control the truthful existing implementation.
- Existing safety guarantees must be preserved.
- REMAINING_WORK.md records the required change.
- FINAL_RESULT.md records only verified evidence.

──────────────────────────────────────────────────────────────────────────────
PROTECTED EXISTING FOUNDATION
──────────────────────────────────────────────────────────────────────────────

The shared normal-v1 execution architecture is already verified and must be
treated as protected.

Do not broadly redesign or replace:

- shared release worker;
- shared infrastructure-plan worker;
- shared infrastructure-apply worker;
- shared/canary activation policy;
- immutable deployment intents;
- infrastructure and release manifests;
- deterministic outbox and BullMQ identities;
- project/environment advisory locking;
- cross-lane ownership;
- operation leases, fencing and heartbeat;
- side-effect journals;
- bounded reconciliation;
- workspace/project/environment isolation;
- stable-release versus latest-attempt separation;
- backend unchanged-source NO_OP behavior;
- current truthful durable history.

Change core execution or worker behavior only when a focused failing test and
runtime trace prove that the product contract cannot be satisfied through the
existing command boundaries.

Prefer changes in this order:

1. developer-facing backend projection;
2. canonical developer action;
3. automatic orchestration of existing exact commands;
4. developer/operator authorization separation;
5. frontend routes, pages, navigation and terminology;
6. platform-owned reconciliation presentation.

Do not perform broad refactors merely to simplify code.

──────────────────────────────────────────────────────────────────────────────
RAILWAY PRODUCT CONTRACT
──────────────────────────────────────────────────────────────────────────────

RAILWAY_PRODUCT_CONTRACT.md must define this exact target.

Normal developer journey:

1. Sign in.
2. Select or connect a GitHub repository.
3. Select a branch when necessary.
4. DeployGuard detects whether the complete stack is supported.
5. DeployGuard asks only for genuinely missing application-owned values.
6. The user clicks Deploy once.
7. The application progresses through:

   Preparing
   → Building
   → Deploying
   → Verifying
   → Live

8. The user receives:
   - repository and branch;
   - source commit;
   - current deployment status;
   - estimated monthly cost when available;
   - application logs;
   - deployment history;
   - previous stable deployment;
   - live application URL;
   - concise application-level error guidance.

Ordinary source changes use the release-only path and must not invoke Terraform.

A configuration change may produce a valid redeployment even when the source
commit is unchanged, provided the immutable configuration identity changed.

First deployment may internally perform:

prepare foundation
→ exact Terraform plan
→ Infracost evaluation
→ policy decision
→ exact apply
→ reconcile infrastructure
→ build release
→ deploy
→ verify
→ promote stable.

The normal developer must not manually execute those internal stages.

──────────────────────────────────────────────────────────────────────────────
DEVELOPER UI
──────────────────────────────────────────────────────────────────────────────

The normal developer navigation must contain only:

- Overview
- Deployments
- Environment
- Logs
- Metrics
- Settings

The normal developer may see:

- repository and branch;
- source commit;
- deployment status;
- simple progress;
- application configuration;
- estimated cost;
- application logs;
- stable URL;
- previous stable release;
- application-owned errors.

The normal developer must not see or operate:

- Terraform plan, state, lock or apply controls;
- infrastructure manifests or revisions;
- AWS account, IAM, ARN, ECS, ECR or ALB details;
- resource inventory errors;
- workers or worker capabilities;
- BullMQ queues or job IDs;
- outboxes or claims;
- ownership, leases or fencing;
- side-effect journals;
- raw NORMAL_* codes;
- cloud cleanup;
- residue internals;
- force unlock;
- recovery stages;
- low-level rollback commands;
- fixture, mock or provider gates.

Do not delete these platform capabilities.

Move them to protected operator/admin backend routes and an operator/admin UI.
Authorization must be enforced by the backend, not merely by hiding links.

The current screenshot must be corrected:

- remove “Inventory Error” from developer view;
- remove “Terraform Plan Blocked”;
- remove “Infrastructure Apply Blocked”;
- remove infrastructure preparation internals;
- remove Cloud Cleanup from normal user navigation;
- replace “Review Deployment” with:
  - Deploy;
  - Approve Cost;
  - Provide Configuration;
  - or no button while automatic work is progressing;
- hide raw Developer Details from ordinary users;
- replace platform internals with simple application-level guidance.

──────────────────────────────────────────────────────────────────────────────
SANITIZED DEVELOPER BACKEND CONTRACT
──────────────────────────────────────────────────────────────────────────────

Create one canonical sanitized backend projection for normal frontend pages.

It should expose concepts equivalent to:

developerState:
- ready
- preparing
- queued
- building
- deploying
- verifying
- live
- configuration_required
- approval_required
- failed_application
- platform_attention
- unsupported

developerAction:
- deploy
- redeploy
- provide_configuration
- approve_cost
- open_application
- none

Also expose:

- developerMessage;
- progress;
- repository;
- branch;
- commit;
- latestAttempt;
- stableRelease;
- stableUrl;
- estimatedCost;
- missingConfiguration;
- applicationError;
- canRetry.

The frontend must consume this contract.

It must not reconstruct deployment truth by combining Terraform, worker,
inventory, legacy and infrastructure responses.

Keep the detailed internal current-state and evidence projections for
operator/admin use.

All minimum developer pages must show the same:

- current operation;
- latest attempt;
- stable release;
- source commit;
- live URL.

──────────────────────────────────────────────────────────────────────────────
BLOCKER OWNERSHIP
──────────────────────────────────────────────────────────────────────────────

Expose only blockers the developer can personally resolve:

- unsupported repository/stack;
- inaccessible repository;
- missing build/start command that cannot be inferred;
- genuinely required environment values;
- application health failure;
- application build failure with useful sanitized guidance;
- cost approval when workspace policy requires it.

Do not expose platform-owned cloud and DevOps blockers as developer tasks.

Platform-owned problems include:

- inventory read failure;
- Terraform transition pending;
- stale cloud evidence;
- worker uncertainty;
- AWS API uncertainty;
- lock/lease reconciliation;
- old infrastructure lineage;
- safe residue classification;
- IAM/platform configuration;
- provider outage;
- account quota or internal platform policy.

Platform-owned problems must:

- preserve the same immutable operation;
- reconcile automatically when safe;
- enter bounded operator review when not safe;
- avoid blind retries;
- avoid asking the developer to restart the pipeline;
- appear to the developer only as a simple platform_attention message such as:

  “The platform is preparing your deployment. No action is required.”

or:

  “The platform needs attention. Your previous stable deployment is unchanged.”

──────────────────────────────────────────────────────────────────────────────
EXISTING PROJECT AND RESIDUE HANDLING
──────────────────────────────────────────────────────────────────────────────

Do not assume existing Project-Tst state must be deleted.

When a project has previous infrastructure or deployment evidence, classify it
through an operator-only reconciliation process as one of:

1. valid existing stable deployment;
2. adoptable existing deployment;
3. incomplete but recoverable operation;
4. conclusively safe abandoned residue;
5. ambiguous state requiring operator review.

Only conclusively safe project-owned residue may expose an operator cleanup
action.

The normal developer must never be asked to understand or perform cleanup.

Do not delete truthful history or valid cloud resources merely to manufacture a
fresh Deploy action.

For existing valid deployments, project the stable release and allow a normal
Redeploy action.

For recoverable operations, resume/reconcile the same immutable identity.

──────────────────────────────────────────────────────────────────────────────
AUTOMATIC FIRST DEPLOYMENT
──────────────────────────────────────────────────────────────────────────────

For a clean supported project, one Deploy click must:

1. create or reuse one immutable normal-v1 operation;
2. automatically dispatch infrastructure planning;
3. evaluate Infracost;
4. apply the configured approval policy;
5. dispatch exact infrastructure apply when authorized;
6. reconcile applied infrastructure;
7. prepare the first release;
8. dispatch the release;
9. build and publish the immutable image;
10. deploy it;
11. verify health;
12. promote it as stable;
13. expose the stable URL.

The browser may refresh at any time and must restore the same durable operation.

Refresh must never create or dispatch work.

Duplicate requests must produce one effective operation and one effective set of
external side effects.

HTTP requests must never start worker processes.

──────────────────────────────────────────────────────────────────────────────
COST POLICY
──────────────────────────────────────────────────────────────────────────────

Do not expose Terraform approval to developers.

Use an explicit policy:

- non-destructive first deployment below the configured workspace threshold:
  automatically approve internally;

- cost above the workspace threshold:
  show estimated cost and Approve Cost only to an authorized workspace owner;

- destructive or unusually broad infrastructure changes:
  require operator/admin approval;

- ordinary source-only redeployment:
  release-only and no Terraform.

Do not fabricate cost evidence or bypass an enforced cost policy.

──────────────────────────────────────────────────────────────────────────────
SUPPORTED STACK CONTRACT
──────────────────────────────────────────────────────────────────────────────

Audit every detected stack against real deployment capability.

A stack is supported only when DeployGuard can actually:

- detect it reliably;
- generate or use a valid Docker build;
- infer or obtain its build command;
- infer or obtain its start command;
- listen on 0.0.0.0;
- receive a platform-assigned port;
- perform a meaningful health check;
- deploy it through the normal release handler;
- display useful application logs.

Do not mark a repository deployable merely because its language/framework was
detected.

Create one authoritative supported-stack matrix in
RAILWAY_PRODUCT_CONTRACT.md or a directly referenced canonical file.

Initial supported candidates should be verified from current code, including
the actually implemented subset of:

- Node.js / Express;
- React / Vite static application;
- Next.js;
- Python / Flask;
- Python / FastAPI;
- Python / Streamlit;
- Django.

Do not claim support for a stack whose full adapter is incomplete.

Unsupported repositories must receive:

“This repository type is not yet supported.”

They must not see Terraform, Docker, ECS or cloud repair instructions.

──────────────────────────────────────────────────────────────────────────────
ENVIRONMENT VALUES AND SECRETS
──────────────────────────────────────────────────────────────────────────────

For applications requiring configuration:

- detect only genuinely required application variables;
- request them through a simple Environment form;
- isolate them by workspace/project/environment;
- encrypt them at rest using the existing supported mechanism;
- mask secret values;
- never return secrets in frontend responses;
- never put secret values in logs;
- never bake secrets into images;
- avoid secret values in queue payloads;
- freeze an immutable configuration identity per deployment;
- treat configuration identity changes as deployment changes;
- prevent cross-project and cross-workspace reuse.

Do not ask users for platform-owned AWS, Terraform, worker or Infracost
configuration.

──────────────────────────────────────────────────────────────────────────────
MULTI-USER AND MULTI-PROJECT CONTRACT
──────────────────────────────────────────────────────────────────────────────

The platform must remain reusable for multiple users and projects.

Every operation must remain bound to:

user/actor
→ workspace
→ project
→ environment
→ immutable operation.

Verify:

- users see only authorized workspaces/projects;
- cross-workspace project substitution fails;
- logs, secrets, deployments and stable URLs remain isolated;
- different projects can progress independently;
- same-project operations remain serialized;
- shared workers need no per-project restart or configuration;
- one user's requests cannot bypass another project's authorization;
- queue and concurrency controls prevent uncontrolled duplicate work.

Do not add hardcoded Smart Retail, Project-Tst or test-project exceptions.

──────────────────────────────────────────────────────────────────────────────
ITERATION PROGRAM
──────────────────────────────────────────────────────────────────────────────

Iteration 0 — Alignment and baseline only

- Read current code, schema, tests, runtime and all relevant MD/PDF reports.
- Create RAILWAY_PRODUCT_CONTRACT.md.
- Reclassify older documents as reference/historical in the canonical contract.
- Normalize REMAINING_WORK.md into the only active queue.
- Remove implementation tasks from FINAL_RESULT.md if it currently acts as a
  queue.
- Record the protected baseline:
  - test suites;
  - builds;
  - worker health;
  - shared-mode capability state;
  - queue/lease/owner/claim state.
- Do not change application source code in this iteration.

Iteration 1 — Developer/operator exposure audit

- Inventory every frontend page, route, button and API call.
- Inventory every developer-visible backend field and safe code.
- Classify each as developer, operator/admin, deprecated or unsupported.
- Add exact implementation tasks to REMAINING_WORK.md.

Iteration 2 — Canonical sanitized developer projection

- Implement the backend developerState/developerAction projection.
- Add authorization separation.
- Preserve detailed operator evidence separately.
- Add focused backend tests.

Iteration 3 — Automatic first-deployment orchestration

- Connect the one developer Deploy action to existing exact normal-v1 command
  boundaries.
- Implement automatic safe continuation and explicit cost-policy decisions.
- Preserve idempotency and immutable operation identity.

Iteration 4 — Existing-state adoption and reconciliation

- Implement valid/adoptable/recoverable/safe-residue/ambiguous classification.
- Remove cleanup and inventory internals from developer responses.
- Preserve Project-Tst and other historical resources until conclusively
  classified.

Iteration 5 — Railway-like Overview and Deployments

- Replace current operator-oriented Overview.
- Implement one Deploy/Redeploy experience.
- Show only simple progress, stable release, cost, logs and live URL.
- Remove Terraform/inventory/cleanup/internal terminology.

Iteration 6 — Operator/admin segregation

- Move cloud, infrastructure, recovery, cleanup and diagnostic functionality to
  protected operator/admin routes.
- Enforce authorization in backend.
- Remove dead or retired developer actions.

Iteration 7 — Environment, Logs, Metrics and Settings

- Use canonical project/operation identity.
- Implement simple environment management.
- Keep logs and metrics application-focused.
- Remove legacy status inconsistencies.

Iteration 8 — Multi-user/multi-project local launch acceptance

Use real PostgreSQL, Redis, backend, frontend and shared Docker workers.

Verify at minimum:

- three users or workspaces;
- at least two projects per workspace where practical;
- clean Express project;
- clean Python project;
- application requiring configuration;
- existing Smart Retail stable release;
- existing Project-Tst historical state;
- unchanged source NO_OP;
- changed source release-only behavior;
- automatic clean first-deployment workflow;
- different-project concurrency;
- same-project serialization;
- duplicate click/request;
- browser refresh;
- worker restart;
- cross-workspace denial;
- secret isolation;
- stable/latest separation;
- zero leaked leases, owners or claims;
- no developer page contains Terraform, AWS, ECS, ECR, ALB, IAM, BullMQ,
  worker, lease, outbox, cleanup, inventory error or raw NORMAL_* terminology.

Iteration 9 — Final evidence

- Update REMAINING_WORK.md.
- It must contain no unresolved P0/P1 launch blocker.
- Update FINAL_RESULT.md with:
  - implementation evidence;
  - isolated evidence;
  - local-runtime evidence;
  - live-AWS evidence;
  - deferred scope;
  - GO or precise NO-GO.
- Do not invent completion percentages.
- Stop before live AWS mutation.

──────────────────────────────────────────────────────────────────────────────
CHANGE CONTROL FOR EVERY ITERATION
──────────────────────────────────────────────────────────────────────────────

Before changing code:

- inspect the exact existing path;
- identify protected contracts;
- run the focused baseline.

Implement the smallest coherent change.

After changing code:

- run focused tests;
- run backend type-check and production build;
- run frontend tests and production build;
- inspect PostgreSQL and Redis residue;
- verify all shared workers remain healthy;
- verify no AWS mutation occurred;
- verify no unrelated protected contract regressed;
- update REMAINING_WORK.md with exact evidence.

If an iteration breaks an unrelated verified contract:

- revert or repair within that iteration;
- do not expand into an unrelated broad refactor;
- do not mark the iteration complete.

For stateful work use:

Validate exact scope and evidence → acquire ownership/lock → execute once →
verify state and external results → persist truthful evidence → release
ownership and stop.

After each iteration, respond only with:

1. iteration completed;
2. files/components changed;
3. verification evidence;
4. remaining blockers;
5. exact next iteration;
6. whether I should click Continue.

Stop only for:

- a genuine external credential/provider/IAM/quota blocker;
- an unresolved destructive or ambiguous state that cannot be safely handled;
- a direct conflict in the Railway product contract requiring product-owner
  choice.

Do not stop for routine approvals, local service startup, tests, builds,
database inspection or repository work that Codex can perform using its full
system access.

──────────────────────────────────────────────────────────────────────────────
FINAL DONE CONDITION
──────────────────────────────────────────────────────────────────────────────

Done only when:

- a clean supported repository shows one Deploy action;
- one action locally progresses through the full durable first-deployment state
  machine;
- ordinary source changes use release-only execution;
- unchanged source returns backend NO_OP;
- environment changes are handled through immutable configuration identity;
- developers see no cloud/DevOps internals;
- operator/admin controls are backend-authorized and separated;
- existing deployments are adopted/reconciled rather than automatically
  deleted;
- shared workers support projects without reconfiguration;
- multi-user/project isolation is locally verified;
- all protected normal-v1 tests and builds remain green;
- no unresolved P0/P1 launch blocker remains;
- FINAL_RESULT.md reports GO or one precise genuine blocker;
- no AWS mutation occurred.