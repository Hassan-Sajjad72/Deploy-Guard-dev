DeployGuard GitHub Actions Migration Remedy

1. Final decision

Use DeployGuard as the control plane and GitHub Actions as the only deployment execution engine.

The FYP document already places GitHub Actions inside Module 6.5 for CI/CD automation, while Redis/BullMQ was introduced to queue long-running deployment work. If GitHub Actions performs the actual build, Terraform, ECR, ECS and verification work, Redis/BullMQ and the custom deployment workers are no longer required in the critical deployment path.

2. Simplified final architecture

User installs DeployGuard GitHub App once
→ user connects a repository
→ DeployGuard detects stack and prepares deployment inputs
→ user clicks Deploy
→ DeployGuard creates one deployment operation
→ DeployGuard generates a short-lived GitHub App installation token
→ DeployGuard dispatches one known GitHub Actions workflow
→ GitHub Actions builds, provisions and deploys
→ GitHub webhook/status polling updates DeployGuard
→ DeployGuard shows success, failure, logs and deployed URL

Workflow ownership

Each connected user repository contains one thin workflow:

.github/workflows/deployguard.yml

That workflow calls a centrally maintained reusable DeployGuard workflow pinned to a fixed version.

The user does not select a workflow for every deployment. DeployGuard stores and dispatches the known workflow path automatically.

3. What remains in DeployGuard

email/password and GitHub authentication;

GitHub App installation and repository access;

project and branch selection;

environment-variable management;

deterministic stack detection;

Docker/template generation;

pre-flight validation;

deployment readiness;

deployment operation and history;

Infracost cost estimation and approval, when required;

Terraform generation and export;

GitHub Actions dispatch;

workflow status synchronization;

ECS deployment URL;

audit logging;

AI troubleshooting from GitHub Actions failure logs.

4. What leaves the deployment path

Retire these from normal deployment execution:

deployment outbox drain;

BullMQ deployment queues;

infrastructure-plan worker;

infrastructure-apply worker;

release worker;

worker capability registration;

deployment leases and worker fencing;

Redis-based deployment recovery;

internal plan/apply/release routing.

Redis and BullMQ may be removed completely unless a separate, non-deployment background feature genuinely needs them.

5. Disabled scope

Keep the following disabled throughout migration and final verification:

Trivy scanning and security blocking;

subscription billing;

usage tracking and tier enforcement;

notifications and SNS;

Prometheus;

CloudWatch integration.

Because CloudWatch is disabled, DeployGuard will show GitHub Actions execution logs only. ECS runtime log streaming is outside this migration.

Infracost cost estimation is separate from subscription billing and may remain enabled.

6. Complete integration iterations

Each iteration must finish one full working user journey. No iteration may be accepted only because individual services, classes or tests exist.

Iteration 1 — GitHub App onboarding to deployment readiness

Complete journey:

Sign in
→ install GitHub App
→ select an authorized repository
→ create project
→ select branch
→ detect stack
→ generate/confirm deployguard.yml
→ show Ready to Deploy

Done when: a new user can connect one repository without entering a PAT, DeployGuard stores the installation/repository mapping, verifies the workflow, and shows a truthful deployment-ready state.

Iteration 2 — First deployment from click to live URL

Complete journey:

Deploy click
→ deployment operation created
→ workflow dispatched
→ checkout
→ Docker build
→ immutable image tag
→ ECR push
→ Terraform plan/apply
→ ECS deployment
→ ALB health verification
→ result synchronized
→ deployed URL shown

Done when: one clean JavaScript or Python repository deploys through the real GitHub Actions path to AWS and DeployGuard shows the correct final state and URL.

Iteration 3 — Failure, retry, redeploy and status recovery

Complete journeys:

workflow failure
→ failed stage and safe logs shown
→ retry creates one new attempt
→ workflow runs again
→ history remains correct

API restart or missed webhook
→ status polling finds the GitHub run
→ deployment state reconciles correctly

new commit
→ redeploy
→ new immutable image
→ ECS update
→ successful URL remains available

Done when: duplicate clicks do not create duplicate effective deployments, retries are auditable, missed webhooks are recovered, and failed runs never appear successful.

Iteration 4 — Final product integration and retirement

Complete journey:

new user
→ GitHub App installation
→ repository connection
→ configuration
→ deployment
→ failure/retry
→ successful redeployment
→ deployment history
→ Terraform export
→ destroy with confirmation

Retire the old custom deployment-worker route and remove it from the frontend, backend commands, configuration and startup scripts.

Done when: the complete product uses one GitHub Actions execution path, no normal deployment depends on Redis/BullMQ or custom workers, disabled modules remain disabled, and all real vertical acceptance scenarios pass.

7. Final acceptance

The migration is complete only when all of the following work using real production wiring:

no PAT is requested during normal deployment;

GitHub App installation grants repository access;

one known workflow is selected automatically;

first deployment succeeds;

Terraform and ECR/ECS stages execute through GitHub Actions;

failure and retry work;

API restart or missed webhook does not lose status;

duplicate Deploy clicks are idempotent;

deployment history remains truthful;

deployed URL is shown;

old worker/BullMQ deployment execution is no longer reachable;

Trivy, usage/billing, notifications, Prometheus and CloudWatch remain disabled.

8. Expected implementation sequence

Use four integration implementation prompts, one for each iteration, followed by one final certification prompt.

Every prompt must require the complete journey to execute before the iteration is marked complete.
i just press continue after each for next

9. Progress ledger

Updated: 2026-08-02

First incomplete integration iteration: Iteration 1 — GitHub App onboarding to deployment readiness.

Status: implementation complete; deterministic end-to-end verification passes; real GitHub App acceptance remains blocked by missing local GitHub App credentials and installation.

Completed work:

- added durable GitHub App installation ownership and project-to-installation mapping, including migration 1760000060000;
- added GitHub App JWT and short-lived installation-token generation without storing or requesting a PAT;
- added GitHub App installation connect/status endpoints and installation-scoped authorized repository listing;
- changed repository metadata, branch and commit access in the new-project journey to installation credentials;
- updated the new-project UI to install/connect the GitHub App and select only authorized repositories;
- fixed the known repository workflow at .github/workflows/deployguard.yml;
- added automatic generation of the thin workflow, pinned by DEPLOYGUARD_REUSABLE_WORKFLOW, when it is absent, and verification when it already exists;
- joined workflow verification to stack detection so Ready to Deploy is returned only when detection succeeds and deployguard.yml is verified;
- kept the disabled-feature list and later-iteration execution/retirement scope unchanged.

Remaining defects:

- no code defect is currently reproduced by the Iteration 1 deterministic journey, backend build, frontend build, stack-detection suite or deployability-preflight suite;
- real GitHub API permissions, GitHub setup callback behavior and a real private-repository workflow commit have not been exercised in this workspace;
- the GitHub App must be configured with Repository metadata read, Contents read/write and Actions write permissions, and its setup URL must return to /projects/new so GitHub supplies installation_id;
- Iterations 2, 3 and 4 remain incomplete and were not changed in this iteration.

Runtime and code evidence:

- npm run test:migration-iteration1: PASS; exercised signed App authentication, installation ownership persistence, authorized private-repository listing, short-lived installation credentials, missing-workflow generation, pinned reusable workflow content and existing-workflow verification through a deterministic GitHub API fixture;
- npm run test:detection: PASS; verified 14 JavaScript/Python fixtures plus application-root, environment, registry, lockfile, binding, runtime-dependency and Django safety gates;
- npm run test:deployability-preflight: PASS; verified deployment-contract consistency and blocker behavior;
- backend npm run build: PASS;
- frontend npm run build: PASS;
- npm run migration:run against the running local PostgreSQL service: PASS; CreateGithubAppInstallations1760000060000 committed successfully as migration 61;
- git diff --check: PASS;
- backend/.env inspection: GITHUB_APP_ID, GITHUB_APP_SLUG and GITHUB_APP_PRIVATE_KEY are absent, so no claim of real GitHub production wiring is made.

Blockers:

- real vertical acceptance requires a configured GitHub App, its private key, and an installation on a test repository; those external credentials and installation are not present in this workspace.

Exact next iteration:

- Iteration 1 remains the next acceptance iteration: configure and install the GitHub App, then execute sign in → install GitHub App → select an authorized repository → create project → select branch → detect stack → generate/confirm deployguard.yml → show Ready to Deploy against the real GitHub API. Only after that passes is Iteration 2 the next implementation iteration.
