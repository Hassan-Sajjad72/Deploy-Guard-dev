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

First incomplete integration iteration: none; all four integration iterations are complete.

Status: Iterations 1, 2, 3 and 4 complete; the exact next authority step is the separate final certification prompt.

Completed work:

- added durable GitHub App installation ownership and project-to-installation mapping, including migration 1760000060000;
- added GitHub App JWT and short-lived installation-token generation without storing or requesting a PAT;
- added GitHub App installation connect/status endpoints and installation-scoped authorized repository listing;
- changed repository metadata, branch and commit access in the new-project journey to installation credentials;
- updated the new-project UI to install/connect the GitHub App and select only authorized repositories;
- fixed the known repository workflow at .github/workflows/deployguard.yml;
- added automatic generation of the thin workflow, pinned by DEPLOYGUARD_REUSABLE_WORKFLOW, when it is absent, and verification when it already exists;
- joined workflow verification to stack detection so Ready to Deploy is returned only when detection succeeds and deployguard.yml is verified;
- corrected repository cloning and remote-commit resolution to use the same short-lived GitHub App installation credential as repository and branch access;
- kept the disabled-feature list and later-iteration execution/retirement scope unchanged;
- added the centrally maintained reusable deployment workflow and pinned the repository thin workflow to immutable commit 98335060f116cd52c3a1eeb65d445c3754f15c6b;
- configured GitHub OIDC authorization to AWS role DeployGuardGitHubActionsProjectTst and encrypted, versioned S3 Terraform state in deployguard-terraform-state-563149050793;
- replaced the normal Deploy endpoint's execution call with a GitHub App installation-token deployment operation that dispatches the fixed deployguard.yml workflow;
- added GitHub Actions run discovery and polling synchronization, real workflow identifiers/status, final operation state, workflow URL and deployed URL persistence;
- added frontend polling and presentation for the GitHub Actions operation, workflow link and live deployment URL;
- made generated Streamlit containers honor the detected application port and use /_stcore/health for truthful lightweight health checks;
- made target-group replacement create-before-destroy so port or health-path corrections do not conflict with an active listener;
- persisted dispatch failures as failed operations instead of leaving them queued;
- completed the real Python/Streamlit first-deployment journey through checkout, immutable Docker image build, ECR push, Terraform plan/apply, ECS rollout, ALB health verification, result synchronization and live URL presentation;
- added project-scoped PostgreSQL advisory locking around GitHub Actions dispatch so concurrent Deploy clicks return one accepted operation and one no-op referencing the same workflow run;
- changed workflow-run discovery to exclude runs that existed before dispatch and added recovery discovery for accepted operations whose run ID was missed;
- reconciled every locally active GitHub Actions operation before idempotency decisions, including stale pre-restart operations, and truthfully failed dispatches that never expose a run after the recovery window;
- added GitHub job/step synchronization, precise failed-stage capture, secret-sanitized failed-job logs and preservation of the last healthy deployed URL during failures and active redeployments;
- added an explicit retry endpoint and frontend action that creates one new operation linked to the failed operation while retaining both history rows;
- added GitHub Actions deployment-history API and frontend presentation with attempt identity, status, commit, retry linkage, workflow link and safe failure evidence;
- completed the real failure, duplicate-click, polling recovery, retry and new-commit redeployment journeys without using a webhook, Redis, BullMQ or a custom deployment worker.
- added a confirmed GitHub Actions Terraform-destroy operation, preserved its operation type across retry, reconciled successful destroy to the truthful destroyed state and removed the deployed URL from the completed destroy response;
- published the deploy/destroy reusable workflow at immutable commit a55a2a8d1a8d28731520d38cad35e28d09cdc14d and updated the installed repository's thin workflow to forward deployment_action to that pin;
- added deterministic, secret-screened Terraform export from the same GitHub Actions Terraform template when no legacy local workspace exists;
- added the confirmed destroy control to the canonical deployment UI and kept deployment, retry, redeploy, history and destroy on the single fixed GitHub Actions workflow;
- removed the legacy normal-deployment mutation routes and command/worker providers from the backend application graph, removed normal worker startup commands, removed Redis and custom workers from Docker Compose, and removed normal-worker/Redis/outbox configuration;
- replaced pipeline activity's BullMQ inspection with PostgreSQL/GitHub Actions activity and made current-state availability authorize only the GitHub Actions execution mode;
- kept Trivy, usage/billing, notification delivery, Prometheus, CloudWatch logs and CloudWatch metrics disabled, including fail-closed disabled defaults for Trivy and CloudWatch;
- completed the cumulative real installed-GitHub-App journey through repository readiness, deployment, truthful failure/retry, immutable redeployment, retained history, Terraform export and confirmed infrastructure destroy.

Remaining defects:

- no Iteration 1, Iteration 2, Iteration 3 or Iteration 4 acceptance defect remains reproduced;
- no incomplete integration iteration remains;
- final migration certification remains a separate authority step and was not executed in this iteration.

Runtime and code evidence:

- npm run test:migration-iteration1: PASS; exercised signed App authentication, installation ownership persistence, authorized private-repository listing, short-lived installation credentials, missing-workflow generation, pinned reusable workflow content and existing-workflow verification through a deterministic GitHub API fixture;
- npm run test:detection: PASS; verified 14 JavaScript/Python fixtures plus application-root, environment, registry, lockfile, binding, runtime-dependency and Django safety gates;
- npm run test:deployability-preflight: PASS; verified deployment-contract consistency and blocker behavior;
- backend npm run build: PASS;
- frontend npm run build: PASS;
- npm run migration:run against the running local PostgreSQL service: PASS; CreateGithubAppInstallations1760000060000 committed successfully as migration 61;
- git diff --check: PASS;
- real GitHub App JWT and installation-token exchange: PASS for installation 150710066 owned by GitHub account Hassan-Sajjad72;
- real installation repository enumeration: PASS; 14 authorized repositories returned;
- real repository and branch access: PASS for Hassan-Sajjad72/Project-Tst on main;
- real installation-token repository clone and stack detection: PASS; Python/Streamlit detected and the successful profile persisted;
- real workflow creation: PASS; .github/workflows/deployguard.yml committed to main through the installation token;
- independent remote workflow read: PASS; workflow_dispatch and the pinned Hassan-Sajjad72/Deploy-Guard-dev reusable workflow at commit 98335060f116cd52c3a1eeb65d445c3754f15c6b were confirmed;
- installation ownership and project mapping persistence: PASS in PostgreSQL for owner user 3, installation 150710066 and project fc0d5f53-8b6d-401a-b532-966dd4f7eff8;
- truthful Ready to Deploy evaluation: PASS only after detectionStatus=success and workflow.verified=true;
- backend npm run build after the installation-token detection correction: PASS;
- npm run test:migration-iteration1 and npm run test:detection after the correction: PASS;
- Iteration 2 application-path dispatch: PASS; DeployGuard operation 3524bee7-4947-4a52-b99a-a1c3ae442ff6 created GitHub Actions run 30747932658 using the GitHub App installation credential and fixed deployguard.yml;
- central reusable workflow: PASS at immutable commit 98335060f116cd52c3a1eeb65d445c3754f15c6b in Hassan-Sajjad72/Deploy-Guard-dev;
- GitHub Actions run 30747932658: PASS with conclusion success; checkout, AWS OIDC, ECR repository, generated Dockerfile, immutable image build/push, Terraform plan/apply, ALB health verification and result artifact steps all completed;
- immutable ECR release: PASS; repository deployguard-fc0d5f53-8b6d-401a-b532-966d contains tag 1369ec2a5a8a at digest sha256:30587543092e110a48bef50d3af39085a2bac414062f777936d2e106ca6cdf76;
- Terraform remote state: PASS; encrypted AES256 object projects/fc0d5f53-8b6d-401a-b532-966dd4f7eff8/dev/terraform.tfstate persisted in the versioned state bucket at 2026-08-02T12:34:50Z;
- ECS rollout: PASS; cluster/service dg-fc0d5f53-8b6d-401a-b532-9 reached COMPLETED with desired=1, running=1 and pending=0 on task definition revision 4;
- ALB target verification: PASS; the active target is healthy on port 8000 with /_stcore/health;
- live application verification: PASS; http://dg-fc0d5f53-8b6d-401a-b532-9-1326986813.us-east-1.elb.amazonaws.com and its /_stcore/health endpoint both returned HTTP 200;
- DeployGuard synchronization: PASS; polling reconciled operation 3524bee7-4947-4a52-b99a-a1c3ae442ff6 to status=completed, stage=healthy, workflowStatus=completed, the correct workflow URL and the verified deployed URL;
- failed acceptance attempts 30747316331, 30747611640 and 30747782644 truthfully exposed the Streamlit health-path, generated-container port and target-group replacement-order defects; each defect was corrected before the successful run and none was recorded as success;
- backend npm run build after the final corrections: PASS;
- frontend npm run build after deployment-status and deployed-URL presentation wiring: PASS;
- npm run test:detection after the Streamlit health-path correction: PASS for all 14 JavaScript/Python fixtures and the additional safety gates;
- real duplicate-click acceptance: PASS; two concurrent Deploy calls produced one accepted operation caacbf37-7742-4e13-8db2-51fa668f7416 and one no-op, both referencing the single GitHub Actions run 30748575923;
- real workflow failure: PASS; run 30748575923 concluded failure after the intentionally invalid OIDC role was rejected, and DeployGuard persisted status=failed rather than success;
- failed-stage synchronization: PASS; a fresh API application context reconciled the missed completion to failedStage=configure_aws_credentials_through_oidc with the truthful user-facing error;
- safe GitHub Actions logs: PASS; DeployGuard fetched and sanitized 14,991 characters of failed-job output, and validation found no exposed AWS secret value;
- stable URL preservation on failure: PASS; the prior healthy ALB URL remained present on the failed operation and continued returning HTTP 200;
- stale active-operation recovery: PASS; polling reconciled historical GitHub runs 30747316331, 30747611640 and 30747782644 from local running to their real failed states, and a dispatch with no discoverable run was failed after the bounded recovery window rather than blocking forever;
- real retry acceptance: PASS; retry operation 0d69580e-864d-46b8-95c3-8e6466f00d82 linked retryOfOperationId=caacbf37-7742-4e13-8db2-51fa668f7416, dispatched run 30748636588, and a duplicate Deploy during the retry returned no-op for that same operation;
- retry workflow result: PASS; run 30748636588 concluded success, DeployGuard reconciled the linked retry to completed/healthy, and history retained the original failed operation followed by the successful retry;
- real new-commit redeployment: PASS; commit e10297e92ea1c067e7b1899a4a5d9ccc1acec85b dispatched as operation 2f3ebe7c-0452-48d6-9586-85900f068966 and GitHub Actions run 30748749440 concluded success;
- immutable redeploy image: PASS; ECR tag e10297e92ea1 resolved to digest sha256:48084b419c7284e458a5a1cd3b1ef8d5103ee02bba81ddfa5f53f6b18162ed65;
- ECS redeployment: PASS; the service advanced to task definition revision 5 with desired=1, running=1, pending=0 and rollout=COMPLETED using image tag e10297e92ea1;
- successful URL continuity: PASS; the same live URL and /_stcore/health both returned HTTP 200 after redeployment;
- deployment history truthfulness: PASS; the latest ordered history contained completed redeploy attempt 8, completed retry attempt 7 linked to failed attempt 6, and the failed attempt retained its failure stage and safe logs;
- backend npm run build after Iteration 3: PASS;
- frontend npm run build after retry, safe-log and history presentation: PASS;
- npm run test:detection after Iteration 3: PASS;
- git diff --check after Iteration 3: PASS.
- Terraform export through a production AppModule application context: PASS; artifact f3267d95-8821-419b-b573-88580080dda1 contained main.tf, README.md, MIGRATION_NOTES.md, backend.hcl.example and terraform.tfvars.example, declared executionEngine=github_actions, excluded state/plans/tfvars values/backend credentials/provider caches/symlinks, and passed credential-like literal screening;
- current reusable workflow pin: PASS; Hassan-Sajjad72/Project-Tst forwards deployment_action to Hassan-Sajjad72/Deploy-Guard-dev at immutable commit a55a2a8d1a8d28731520d38cad35e28d09cdc14d, proven by successful real destroy run 30750010076;
- confirmed real destroy dispatch: PASS; operation 80f3731d-7a90-4169-8c7a-574a86987606 created GitHub Actions run 30749672978 with deploymentAction=destroy and truthfully remained running while Terraform waited for ECS draining;
- destroy failure truthfulness: PASS; run 30749672978 failed at terraform_plan_and_apply when the OIDC role lacked iam:ListInstanceProfilesForRole, and DeployGuard persisted failed status, failed stage and sanitized failure evidence rather than reporting success;
- destroy defect correction: PASS; the OIDC role retained its existing deployment permissions and gained the required iam:ListInstanceProfilesForRole read permission;
- destroy retry preservation: PASS; operation f76462de-d98e-423b-a36c-3a3678299557 retained deploymentAction=destroy, linked retryOfOperationId to the failed destroy and created exactly one GitHub Actions run 30750010076;
- real confirmed destroy completion: PASS; run 30750010076 concluded success, including Terraform destroy, destroy-result creation and artifact upload, and DeployGuard polling reconciled it to status=completed, stage=destroyed, deployedUrl=null;
- AWS post-destroy verification: PASS; ECS cluster and service dg-fc0d5f53-8b6d-401a-b532-9 are INACTIVE with zero active services/running tasks, the ALB is absent, the Terraform-managed execution role is absent, and the former deployed hostname no longer resolves;
- remote state post-destroy verification: PASS; the encrypted AES256 S3 state object remains durable and contains zero resources;
- deployment-history preservation after destroy: PASS; history retains the successful destroy retry, its linked failed destroy, successful redeploy, successful deployment retry and original failed deployment in truthful order;
- old execution reachability verification via npm run test:automation: PASS; legacy deployment routes, custom mutation endpoints, worker startup scripts and Redis Docker Compose service are absent;
- normal deployment startup dependency scan: PASS; Docker Compose contains PostgreSQL only, normal worker scripts are absent, and the production GitHub Actions deploy/destroy services do not inject BullMQ, Redis or a custom worker;
- disabled-feature verification: PASS; TRIVY_SCAN_ENABLED, billing/usage enforcement, notification delivery, PROMETHEUS_ENABLED, CLOUDWATCH_LOGS_ENABLED and CLOUDWATCH_METRICS_ENABLED are false, with disabled defaults for Trivy, Prometheus and CloudWatch;
- backend npm run build after Iteration 4: PASS;
- frontend npm run build after the canonical confirmed-destroy integration: PASS;
- npm run test:migration-iteration1, npm run test:detection and npm run test:automation after Iteration 4: PASS;
- production AppModule application-context startup during Terraform export, destroy dispatch, polling reconciliation and history reads: PASS;
- git diff --check after Iteration 4: PASS.

Blockers:

- Iteration 1 has no blocker;
- Iteration 2 has no blocker;
- Iteration 3 has no blocker;
- Iteration 4 has no blocker;
- the separate final certification prompt has not been run and is not an integration-iteration blocker.

Exact next iteration:

- no integration iteration remains; the exact next authority step is the final certification prompt defined by the expected implementation sequence.

10. Final Product Certification

Certified: 2026-08-02

Overall verdict:

FINAL PRODUCT: YES

Final closure review (2026-08-02):

- the original ten defects below are preserved as historical findings. Certification Integrations 1–3 and the targeted final closure fixes resolve all ten across the supported root/backend command surfaces, PostgreSQL-only startup, authenticated product shell, GitHub App installation-token access, canonical GitHub Actions deployment/status/history/destroy path, database current-state projection, Terraform export, AWS/S3 reconciliation, disabled-feature boundary and credential-file hygiene;
- the current single startup command is `npm run product:start`. A fresh closure run started PostgreSQL only, reported no pending migration, rebuilt both applications, exposed only the supported controller table and reached ready state with deliberately unreachable Redis settings. `npm run product:verify` passed frontend/API/CORS/PostgreSQL readiness, signup/login/logout/session behavior and authenticated projects/templates access;
- the supported journey currently verified by the completed integrations is: signup/login → GitHub App installation/connect → installation-authorized repository and branch selection → project/environment configuration → stack detection → truthful pre-flight → Deploy → one idempotent GitHub Actions operation → Docker build → immutable ECR image → Terraform → ECS/ALB → live URL → truthful status/history → sanitized failure logs → linked retry → immutable redeployment → Terraform export → confirmed GitHub Actions destroy → reconciled zero-resource AWS/S3 state;
- builds, migration state, GitHub App onboarding, deployability/pre-flight, current-state consistency, authorization segregation, Terraform export and frontend current-state/application-surface regressions passed in the closure run. The prior real GitHub/AWS operations remain preserved as evidence and were not destructively repeated;
- targeted closure defect 1 is resolved: `AiTroubleshootingModule` and the authenticated admin/developer frontend/API route are restored with project ownership enforcement. Evidence collection now accepts only a failed operation with a GitHub Actions run ID and uses its synchronized, sanitized `safeLog`, failed stage and safe error; it has no CloudWatch, PAT/`GITHUB_TOKEN`, billing, Trivy, Redis, BullMQ or custom-worker dependency. Non-failed operations return HTTP 400. Provider failure falls back to an explicitly limited `evidence_only` result rather than claiming live-AI success or inventing a diagnosis;
- live troubleshooting acceptance passed against historical failed operation `bf69fb19-30ac-4f51-a714-7800689aa967` / workflow run `30751775790`: unauthenticated access returned 401, an authenticated non-owner returned 403, the developer owner listed sessions with HTTP 200, a completed operation was rejected with HTTP 400, analysis returned HTTP 201, session read returned HTTP 200, confidence was bounded, limitations and evidence references were present, and credential-pattern screening passed. The production frontend rendered the troubleshooting route without an error, one failed-operation option, the Analyze control, navigation link, evidence-only status, confidence, limitations and recommended recovery;
- targeted closure defect 2 is resolved: executable normal-v1/release-lane, outbox, inactive consumer, Redis/BullMQ, worker-runtime, infrastructure-plan/apply and PostgreSQL/Redis integration aliases were removed from `backend/package.json`. The source/history files remain unadvertised. The old local-demo document is explicitly marked historical and retired. Automated scans report zero legacy command aliases in both root and backend package surfaces and no supported documentation/startup command reference;
- post-certification GitHub App connection correction: the authenticated installation-connect route now receives the session middleware, and installation ownership is represented by a unique user/installation pair so an existing GitHub installation can be linked without transferring or removing another user's link. For local admins and users whose GitHub login matches the installation account, connection status discovers an already-installed App and the New Project page offers an in-product `Connect` action instead of requiring uninstall/reinstall. Migration `1760000061000` applied successfully. Live API verification linked installation `150710066` to the authenticated email admin while preserving the original user link, refreshed status to connected with 15 repositories, and returned `Hassan-Sajjad72/flask-hello-world`; the production frontend then rendered that repository in the selector with no `GitHub App required` state;
- post-certification environment-ownership correction: repository/build assignments are now first-class scanner evidence (`repository_build`) and remain distinct from unresolved user-owned build/runtime inputs through deployment-contract generation. Package-script assignments and static assignments in recognized webpack/Vite/Rollup/Next/Babel configuration cannot become user-required or optional Environment fields; genuinely unresolved application references remain user-owned and required. Regression coverage proves the combined case with script/config-owned `NODE_ENV` and unresolved `APPLICATION_API_URL`;
- real acceptance for project `bb24815d-bf77-44da-b5fa-188b3870db61` (`Hassan-Sajjad72/react-pomodoro`, `master`) re-cloned the repository through the installed GitHub App and regenerated detection, deployment contract and pre-flight. Detection succeeded, the workflow was verified, `NODE_ENV` evidence identifies `webpack.config.js` and `package.json#scripts.build` as repository/build owners, required and optional user-variable lists are empty, the contract has no required/optional/missing/build-time/runtime user variables or blockers, and pre-flight is `passed_with_warnings` with no errors. PostgreSQL projections agree and the project requires no environment row;
- authenticated production-browser acceptance rendered `/projects/bb24815d-bf77-44da-b5fa-188b3870db61/requirements` with “All required application configuration is complete,” no `NODE_ENV`, and no application environment-value input; Overview rendered the same project without `NODE_ENV`, missing-configuration or Not Ready state and retained its Deploy path. Backend `test:deployment-requirements`, `test:deployability-preflight`, `test:current-state-consistency`, backend/frontend production builds and the live API/frontend checks passed;
- post-certification current-state synchronization correction: the sanitized developer projector no longer lets the retired legacy release lane's `disabled` state override an authorized GitHub Actions project. When detection and the matching pre-flight contract are ready and no GitHub Actions attempt exists, current state is now `ready` with action `deploy`, message “No deployment has started yet,” label “Ready to Deploy,” no application error or missing configuration, and progress 40% from the two completed user-facing milestones (Analyze and Prepare) out of Analyze → Prepare → Build → Deploy → Verify. Existing operation-aware overrides continue to own queued/deploying/failed/live/retry/destroyed projections;
- live acceptance for `bb24815d-bf77-44da-b5fa-188b3870db61` confirmed detection `success`, pre-flight `passed_with_warnings` with zero errors/blockers, and exactly zero deployment operations before and after verification. `/current-state` returned `ready`, `deploy`, 40%, `latestAttempt=null`, and no Platform Attention. Authenticated production Chrome rendered both Overview and Deployments with “Ready to Deploy,” “No deployment has started yet,” a visible Deploy button, Analyze/Prepare passed and Build/Deploy/Verify waiting; the button was not clicked;
- current-state reads now opt out of browser caching. Detection and pre-flight mutations publish a project-scoped synchronization event, pre-flight refreshes its current-state projection immediately, and Overview/Deployments refresh on that event, focus, page-show and visibility restoration as well as their existing active-operation polling. Projector regression fixtures preserve configuration-required, unsupported, approval, active-phase, application-failure, stable/live, newer-source redeploy, platform-conflict and authorization behavior. Backend projector/current-state/deployability regressions, frontend current-state regression, backend/frontend builds, supported live product verification and `git diff --check` passed;
- intentionally disabled/out-of-scope features remain Trivy scanning/security blocking, subscription billing, usage tracking/tier enforcement, notifications/SNS, Prometheus, CloudWatch integration and ECS runtime log streaming. Infracost estimation remains separate and supported;
- rotation of the temporary local FYP credentials is a deferred, non-blocking pre-production recommendation. It is not an implementation blocker for the supported local journey;
- all Certification Integration iterations are complete, both targeted closure defects are resolved, no reproduced implementation defect or blocker remains for the supported local FYP journey, and no implementation iteration remains.

Historical initial-certification scope and evidence (superseded by Certification Integrations 1–3):

- the real GitHub App installation remains configured and usable: an application-context exchange returned 14 installation-authorized repositories and included Hassan-Sajjad72/Project-Tst;
- the previously recorded real GitHub Actions deployment, failure, retry, immutable redeployment, Terraform export and confirmed destroy evidence remains present in PostgreSQL/GitHub/AWS history;
- current AWS truth after the certified destroy remains an inactive ECS cluster/service, absent ALB and execution role, and encrypted Terraform state containing zero resources;
- a fresh email user was created through the production HTTP signup route, received an authenticated session, could call the projects API, and was denied another user's project with HTTP 403; unauthenticated project access returned HTTP 401;
- backend and frontend production builds pass, all database migrations are applied, and the authentication, automation-boundary, GitHub App onboarding, deployability-preflight, application-surface, operator-segregation and current-state regression suites pass;
- those passing checks do not establish a final product because the following defects were reproduced through the shipped startup, live HTTP API and reachable frontend code.

Historical reproduced product defects (all resolved; retained as evidence):

1. The one advertised startup command is broken. `npm run product:start` executes `docker compose up -d postgres redis`, while the shipped Docker Compose file defines only `postgres`; startup terminates with `no such service: redis` before the product becomes available.
2. Redis/outbox retirement is incomplete in the production application graph. The live readiness service directly creates an ioredis client and requires both Redis and `orchestration_outbox` health. `npm run product:verify` explicitly requires Redis and outbox. Infrastructure, storage, state-management, FinOps and infrastructure-lifecycle modules still register `pipelineQueueProvider`; the infrastructure-lifecycle module also starts BullMQ-backed lifecycle/emergency workers and schedulers.
3. Reachable legacy execution commands remain. Root scripts still expose the old local FYP deployment/recovery verification path, and backend package commands still expose normal-v1, outbox, BullMQ consumer, infrastructure plan/apply and worker-runtime executions. This is not one clear GitHub Actions-only product workflow.
4. The admin Orchestration page renders working-looking `Update Scaling` and `Rollback to Stable Release` controls, and the dedicated Rollback page renders the same rollback action, but the frontend calls `PATCH .../orchestration/scaling` and `POST .../orchestration/rollback`; both production HTTP calls returned 404 because those backend mutations were retired.
5. The admin Cloud Cleanup page still retries project destruction through `POST .../infrastructure/destroy/request`, and the API still registers the BullMQ-backed infrastructure-destroy challenge/request/cancel/retry controllers plus `POST .../:projectId/destroy`. An authenticated production call reached the old destroy route and returned validation HTTP 400, proving the legacy execution control is registered rather than unreachable. This conflicts with the canonical GitHub Actions `POST .../deploy/destroy` journey.
6. Deployment status/history authorization is not product-complete. A newly authenticated valid admin could read the existing project's current-state projection but `GET .../deploy/status` and `GET .../deploy/history`, which the canonical Deployments page requires, returned HTTP 401. Consequently the frontend and backend cannot present one consistent deployment state to every role the route advertises as supported.
7. Disabled and legacy surfaces remain in normal navigation and runtime routing. `Plan & usage` is a primary sidebar page while billing/usage is disabled; admin navigation still exposes Security, Runtime/CloudWatch, Cloud Cleanup and legacy Orchestration controls. Billing summary and notification APIs returned HTTP 200 while disabled, security-scan mutation routes remain registered, and observability code still has a `GITHUB_TOKEN`-based GitHub metrics fallback. The product therefore does not present one unambiguous supported feature set.
8. PAT retirement is incomplete outside the canonical deploy call. Settings copy still says private access depends on a backend token, repository workspace and GitHub Actions helpers retain `GITHUB_TOKEN` fallbacks, infrastructure readiness checks for `GITHUB_TOKEN`, and GitHub Actions metrics require it. The canonical deploy dispatch uses a short-lived GitHub App installation token, but the complete product is not PAT-free in its remaining reachable/read-model code.
9. Credential hygiene fails certification. The untracked file `backend/.env.backup-normal-v1-aws-20260801T0640Z` contains nonempty JWT secret, GitHub OAuth client secret, GitHub PAT, AWS access-key ID and AWS secret access key values. No value was printed during certification, but the plaintext backup is inside the product workspace and is not ignored. `backend/.env` also contains 27 malformed non-assignment continuation lines adjacent to its one-line GitHub App private-key configuration, so configuration is not cleanly normalized even though App JWT generation works.
10. The final new-user journey could not be executed from the documented product entry point because startup fails before signup. Manual backend/frontend startup allowed authentication and route checks, but that workaround is a second undocumented procedure and does not satisfy one supported startup procedure. Because of defects 2–9, repeating an AWS deployment would not establish an overall product YES.

Historical manual-action blockers (interactive installation was subsequently verified; credential rotation remains deferred and non-blocking for local FYP use):

- revoke and rotate the GitHub PAT and AWS access key represented in the plaintext backup; rotate the GitHub OAuth client secret and JWT secret if that backup has left this trusted machine or has been shared;
- confirm deletion of the plaintext backup after any evidence that must be retained is moved to a secret-safe location;
- for the next clean new-user acceptance, complete the interactive GitHub App installation/authorization in GitHub for the certification user and selected repository. Codex cannot truthfully impersonate that user consent.

Historical remediation plan (completed by Certification Integrations 1–3):

- make the single root startup and verification commands match PostgreSQL-only GitHub Actions production wiring;
- remove Redis/outbox readiness, production queue providers, worker/scheduler startup registration and executable legacy commands from the supported application graph;
- remove or reconnect every dead frontend control and align navigation with the authority's supported and disabled feature lists;
- make deployment status/history authorization and installation-token access consistent for supported roles;
- remove PAT fallbacks and legacy token wording from supported product paths;
- retire the old lifecycle destroy route in favor of the canonical confirmed GitHub Actions destroy journey;
- normalize local configuration safely, add secret-backup ignore rules, and add regression checks that fail on route mismatches, retired dependencies and credential-like backup files.

Historical closure integrations (all completed):

Certification Integration 1 — Clean startup, authentication and truthful product shell

Journey:

clean checkout/configuration
→ one documented startup command
→ PostgreSQL migration
→ API/frontend ready without Redis, BullMQ, outbox drain or workers
→ signup/login/logout
→ dashboard/projects
→ GitHub App install/connect
→ authorized repository and branch selection
→ every visible navigation page loads from a real supported backend contract

Done when: the root startup succeeds on the shipped Compose services; readiness depends only on required production services; no worker/queue process or legacy execution command starts or is advertised; authentication and project authorization pass through live HTTP; all visible buttons have live backend routes; disabled features are absent or clearly non-actionable; and a new user reaches project creation with an installation-authorized repository without a PAT.

Progress (completed 2026-08-02):

- completed the configuration boundary without exposing values: `backend/.env` has exactly one active assignment for every required database, authentication, GitHub OAuth, GitHub App, GitHub Actions and AWS deployment setting; it has zero malformed lines; the normalized one-line `GITHUB_APP_PRIVATE_KEY` parses as an RSA private key and signs a GitHub App JWT;
- deleted `backend/.env.backup-normal-v1-aws-20260801T0640Z`; repository-wide ignore rules now cover environment variants/backups, PEM/private-key files, credential files and secret JSON files while retaining example environment files. The removed backup is absent and the active environment, backup-name and private-key-name probes are ignored;
- credential rotation is deferred as an operator security risk, not an implementation blocker. The current values are temporary local FYP test credentials and were not printed during cleanup or verification;
- `npm run product:start` now starts the shipped PostgreSQL service, applies all migrations, builds both applications and serves the API/frontend. It completed with `REDIS_URL=redis://127.0.0.1:1` and `REDIS_PORT=1`, while the old Redis container was stopped; readiness reported only PostgreSQL and no Redis, BullMQ, outbox drain, custom worker or legacy normal-v1 process was running;
- the root package now advertises only the supported start, verify, build and install procedures. Root demo/recovery/dev launchers and backend executable normal-v1/outbox/one-shot infrastructure execution commands were removed from the supported command surface;
- `npm run product:verify` passed against that live startup: frontend serving and CORS, PostgreSQL readiness, signup/login session, logout cookie clearing, unauthenticated rejection, and authenticated projects/templates calls all passed;
- live authorization evidence passed: the GitHub App project owner could read the project and an unrelated project returned HTTP 403. Missing authentication returned HTTP 401. The deployment status/history middleware gap was fixed and both canonical endpoints returned HTTP 200 for the authorized Project-Tst owner;
- real GitHub evidence passed using a short-lived installation token: App JWT exchange, installation `150710066`, repository `Hassan-Sajjad72/Project-Tst`, branch `main`, and `.github/workflows/deployguard.yml` all verified; the connected product API returned 14 installation-authorized repositories and the selected repository branch without reading a PAT;
- the visible product shell is now limited to supported contracts. Billing/usage, Cloud Cleanup, Security/Trivy, Terraform-state/storage, legacy Orchestration/rollback/releases, Runtime/CloudWatch, Prometheus metrics and notification surfaces were removed from navigation/routing; billing, notification, observability and security-scan controllers are not registered and representative production HTTP probes returned 404;
- active repository workspace cloning, GitHub Actions dispatch and infrastructure-readiness checks now use GitHub App configuration/installation tokens only; their `GITHUB_TOKEN` fallbacks and the settings-page backend-token wording were removed;
- backend and frontend production builds passed after the final surface changes. Certification Integration 1 has no remaining implementation defect or manual-action blocker. Interactive GitHub consent was not repeated because the operator had already created, configured and installed the real App; its resulting installation, repositories, branch and workflow were verified directly.

Remaining defects after this iteration:

- Certification Integration 2 has not yet executed a new project through stack detection, truthful pre-flight, duplicate-click idempotency, live AWS deployment, restart reconciliation, injected failure, retry and immutable redeployment from the cleaned product startup;
- Certification Integration 3 has not yet repeated Terraform export, canonical destroy, post-destroy AWS/S3 reconciliation and the final exhaustive route/control/security audit. Unadvertised legacy read/support modules and their routes remain subject to that retirement audit;
- the temporary local FYP credentials still require operator rotation before any non-local, shared or production use.

Certification Integration 2 — New project through resilient live deployment

Journey:

project creation
→ branch and environment configuration
→ stack detection
→ pre-flight Ready to Deploy
→ duplicate Deploy clicks
→ one GitHub Actions run
→ Docker build/ECR/Terraform/ECS/ALB
→ live URL
→ API restart/missed-status polling recovery
→ truthful injected failure and sanitized logs
→ linked retry
→ new-commit immutable redeployment
→ consistent current state and history for every supported role

Done when: the journey is executed from the frontend against production wiring; one duplicate click is a no-op; a fresh API process recovers remote status; the failed run remains failed with safe logs; retry and redeploy succeed; the live URL is healthy; deployment status/history never return an authentication error for an authorized supported user; historical failures do not alter the current healthy projection; and no step reads a PAT, Redis queue or custom worker.

Progress (completed 2026-08-02):

- created fresh project `d8815c11-3bd0-4b99-a3b8-696c06353c2a` through the live production API for the installation-authorized `Hassan-Sajjad72/Project-Tst` repository; created and selected isolated branch `deployguard-certification-2`, saved non-secret `APP_ENV` environment configuration, detected Streamlit, verified `.github/workflows/deployguard.yml`, and generated a `passed_with_warnings` pre-flight report whose readiness decision was `ready` with zero blockers;
- dispatched initial operation `e0f9aa1b-19cc-4799-91b3-67227195ba6f` to GitHub Actions run `30751492852`. An immediate second Deploy request returned `no_op` and the same operation ID, proving duplicate-click idempotency and a single remote workflow run;
- observed that run progress through immutable Docker build/ECR push and Terraform apply without a local queue or worker. GitHub Actions created the project-scoped Terraform state, ECR repository/image, ECS/Fargate service and ALB; ECS reached one running task with zero pending tasks, the ALB became active, and `http://dg-d8815c11-3bd0-4b99-a3b8-6-2122498967.us-east-1.elb.amazonaws.com/_stcore/health` returned success;
- injected an isolated failure commit `4ebbc9f0d81e1979b000be4e7acb1b2d7ddd17d7` on the certification branch and dispatched operation `bf69fb19-30ac-4f51-a714-7800689aa967` / GitHub Actions run `30751775790`. The API process was stopped while the workflow ran, then restarted through `npm run product:start`; the fresh process reconciled the missed remote result as `failed` at `build_and_push_immutable_image`, retained the prior healthy URL, and did not report success;
- the stored safe failure log was nonempty and passed exact-value comparison against configured GitHub/AWS/authentication secrets plus GitHub-token, AWS-key and PEM credential-pattern scans. The failed history row remains failed;
- repaired the branch in commit `6a8867f295baa1595fa4408554d03842b15de4c7` and dispatched retry operation `c6b095e8-9e7a-44ae-ae3d-a6fc0f290c6b` / run `30751829087`. The retry retained `retryOfOperationId=bf69fb19-30ac-4f51-a714-7800689aa967`, completed healthy, and produced immutable ECR tag `6a8867f295ba`;
- created distinct subsequent commit `d59bfcead535e0e8edb259212d934a951d095c5d`, repeated detection and pre-flight, and dispatched redeployment operation `81fcb858-aa17-4620-8d51-bb2789ef2e8d` / run `30752023599`. It completed healthy at the same stable URL and produced distinct immutable ECR tag `d59bfcead535`;
- reproduced and fixed a product projection defect found by the journey: `/deploy/status` and `/deploy/history` were healthy while `/current-state` still exposed legacy `platform_attention`, no latest attempt and no stable URL. The developer current-state projection now gives canonical GitHub Actions operations precedence, represents active/failed/completed/destroyed states, preserves the latest successful URL across a later failure, and prevents historical failures from corrupting the current healthy state;
- live developer and admin requests now all return HTTP 200 for deployment status, deployment history and current state. Both roles receive `live`, the same stable URL and latest commit `d59bfcead535…`; history contains four truthful attempts, preserves the injected failure, preserves the linked successful retry, and identifies the final redeployment as current;
- a headless Chrome session authenticated against the production frontend and rendered the actual project page. It displayed `GitHub Actions deployment: completed`, the live URL, all deployment attempts, `Attempt 4: completed`, and the historical `Attempt 2: failed`, establishing frontend/backend agreement rather than API-only evidence;
- active detection, workflow dispatch, GitHub App and readiness paths contain no `GITHUB_TOKEN` fallback; no Redis, BullMQ, normal-v1 or custom-worker process was running. The run used GitHub App installation credentials and GitHub Actions OIDC only;
- backend GitHub App onboarding, deployability pre-flight, current-state consistency and operator-segregation regressions passed; frontend application-surface, current-state and operator-segregation regressions passed; backend/frontend production builds and `npm run product:verify` passed after the projection fix.

Remaining defects after this iteration:

- Certification Integration 3 has not yet exported and secret-scanned this healthy deployment's Terraform package, executed the canonical confirmed GitHub Actions destroy, reconciled AWS/S3 to zero managed resources, or completed the final exhaustive route/control/security audit;
- the Certification Integration 2 ECS/ALB infrastructure is intentionally still live so Certification Integration 3 can begin from the required healthy deployment history and prove confirmed destruction;
- temporary local FYP credentials remain a deferred operator rotation risk before non-local, shared or production use.

Certification Integration 3 — Portability, confirmed destruction and final surface/security audit

Journey:

healthy deployment history
→ Terraform export download and secret scan
→ canonical `DESTROY` confirmation
→ one GitHub Actions Terraform destroy
→ polling reconciliation
→ no live URL or managed AWS resources
→ retained truthful deployment/destroy history
→ navigate and activate every remaining intended page/control
→ stop and restart using the single supported procedure

Done when: export contains the GitHub Actions Terraform configuration but no state/credentials; only the canonical GitHub Actions destroy endpoint is reachable; AWS and S3 state agree with destroyed status; all intended pages are nonempty and backend-connected; all retired/disabled controls and PAT fallbacks are absent; credential scans find no plaintext backup or exposed value; builds, migrations and relevant regression suites pass; and a complete clean-start product certification returns no reproduced defect.

Progress (completed 2026-08-02):

- created and downloaded Terraform export `4c3d81c3-2eb0-4da1-9a32-75a9eeaaf893` through the authenticated production API. The mode-0600 ZIP was 5,965 bytes and contained `main.tf`, `MANIFEST.json`, `README.md`, `MIGRATION_NOTES.md`, `backend.hcl.example` and `terraform.tfvars.example`; checksum verification and the declared `github_actions` execution engine passed;
- the exported configuration retained the S3 backend and ECS/ALB deployment resources. Archive policy and content scans found no Terraform state, plan, real tfvars/backend configuration, provider cache, PEM/private key, credential, token or secret-like literal;
- rejected an invalid lowercase destroy confirmation with HTTP 400, then dispatched canonical `DESTROY` operation `83c2261c-36c7-4adf-9a1a-7ba9a11ffa06` to GitHub Actions run `30752683153`. DeployGuard reported running until GitHub/Terraform completed and then reconciled to `completed` / `destroyed` with no deployed URL;
- the first post-destroy AWS reconciliation found a real defect: Terraform correctly removed ECS, ALB and the execution role and left encrypted S3 state at serial 5 with zero resources, but the ECR repository created outside Terraform remained. The workflow now deletes that immutable-image repository on destroy, tolerates only an already-absent repository, and fails on other cleanup errors;
- published the corrected reusable workflow at immutable commit `a54f863a13f5ebe0fb3e83c3b52515ba61461cd8`, updated the local configured pin and the certification repository caller at commit `cc50955859c4b055da127b4fafdd446e6e9c1b6f`, and repeated the canonical product destroy as operation `3ebd0467-ddd0-41e4-9e0b-01b26815b054` / run `30753087625`;
- final AWS/S3 reconciliation passed: the project ECS cluster/service, ALB, execution role and ECR repository are absent; the encrypted S3 state remains durable with zero resources. Deployment status and current state are destroyed/ready with no live URL, while all six deployment/retry/redeployment/destroy history records remain truthfully ordered, including the historical failure;
- authenticated HTTP probes after a production restart returned 404 for billing, notifications, observability, security scans, storage, Terraform-state controls, orchestration controls, old infrastructure destroy/cleanup and old project-destroy routes. Only `/deploy/destroy` remains as the canonical confirmed mutation, and invalid confirmation remains fail-closed;
- removed the remaining reachable broken AI troubleshooting route and backend registration. Removed dormant client helpers for billing, notification, troubleshooting, legacy destroy/cleanup/resource and central cloud-cleanup controls. The operator-segregation regression now asserts that the retired troubleshooting route is absent;
- removed controller registration for legacy storage, state-management and orchestration support modules; removed the observability GitHub PAT request path; removed the legacy pipeline worker's environment-token fallback; and corrected remaining visible/read-model `deployguard_worker` terminology to GitHub Actions;
- headless Chrome exercised the production frontend as an authenticated admin. Dashboard, projects, new project, overview, requirements/environment, pipeline/history, logs, settings, detection, pre-flight, infrastructure, costs, users and activity all rendered nonempty without an error state; their visible buttons/links contained no rollback, security scan, notification, billing, Prometheus, CloudWatch, cloud-cleanup, force-release, backup or scaling control. The retired troubleshooting URL redirected to the public landing page without an error;
- the restarted Nest route table contains no controller for billing, notification, observability, security scanning, storage, state management, orchestration or legacy lifecycle destroy. Source/runtime probes found no active `GITHUB_TOKEN` read, Redis/BullMQ queue registration in the production graph, or running Redis, BullMQ, worker or consumer process. Trivy scanning, billing/usage, notification delivery, Prometheus and CloudWatch remain disabled;
- `npm run product:start` applied the database with no pending migration, rebuilt and served both applications, and `npm run product:verify` passed frontend/CORS/API/PostgreSQL readiness, signup/login/logout/session behavior and authenticated API access. Backend and frontend production builds passed;
- backend `test:migration-iteration1`, `test:deployability-preflight`, `test:current-state-consistency`, `test:operator-segregation` and `test:terraform-export` passed. Frontend `test:current-state-ui`, `test:operator-segregation-ui` and `test:application-surfaces` passed. `git diff --check` passed;
- workspace credential-file scans found no private-key or environment-backup file, and no secret value was printed. Rotation of the temporary local FYP credentials remains a deferred operator security risk before shared or production use, not an implementation blocker.

Remaining defects after this iteration:

- the two closure-review defects were resolved by the targeted final fixes recorded in the Final Product Certification section;
- no reproduced implementation defect remains for the supported local FYP journey;
- no incomplete certification integration remains;
- temporary local FYP credentials still require operator rotation before non-local, shared or production use.

Blockers:

- none for the supported local FYP product journey;
- credential rotation is a deferred operator security risk, not an implementation blocker.

Exact first incomplete iteration:

- none — all certification integration iterations are complete.
