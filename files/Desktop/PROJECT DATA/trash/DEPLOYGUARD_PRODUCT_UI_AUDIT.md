# DeployGuard Product UI Audit

Audit date: 2026-08-05

Scope: current local product, authenticated UI, PostgreSQL records, GitHub App/GitHub Actions integration, and read-only AWS evidence

Method: source inspection, live API calls, authenticated browser inspection at desktop and 390 px mobile widths, read-only database queries, GitHub run/job inspection, read-only AWS CLI inspection, builds, and focused regression checks

Change policy: this document is the only repository file added by this audit. No product code, data, deployment, or external resource was changed.

## 1. Executive verdict

DeployGuard has a real, working core deployment path: an authenticated user can select a GitHub App-authorized repository, analyze it, pass pre-flight, dispatch a GitHub Actions workflow, authenticate to AWS with OIDC, build and push an immutable image to ECR, apply Terraform, deploy to ECS behind an ALB, verify health, reconcile the result, and display a live URL. The audited `react-pomodoro` release is supported by current GitHub Actions and AWS evidence, not mock data.

The broader product UI is not implementation-complete. Overview, Pipeline, Infrastructure, Monitoring, Projects, and Admin are reachable, but they do not yet provide a consistent professional representation of all evidence. Security, FinOps & Usage, Notifications, and platform Billing are either unreachable, disconnected, disabled, historical, or unsupported by the registered backend. The Pipeline page does not expose the actual GitHub job steps, stage timestamps, durations, skipped steps, and evidence requested by the product contract. Mobile navigation hides the selected-project sections, Admin navigation, and Logout. The current public Admin button starts GitHub OAuth; a GitHub-authenticated account can carry the `admin` role, which violates the required dedicated administrator credential boundary.

The next phase must preserve the verified GitHub Actions/AWS lifecycle and build new presentation and evidence projections around it. It must not reactivate the retired Redis/BullMQ/custom-worker path or present historical/mock rows as current product evidence.

Severity summary:

| Severity | Finding |
| --- | --- |
| Critical | Admin authentication is not segregated: `/` sends Admin through GitHub OAuth, `/admin` trusts the general user role, and the current GitHub identity is an administrator. |
| High | Pipeline omits the real GitHub job-step timeline and duplicates operation history; action buttons are partly reconstructed from loose frontend conditions. |
| High | Security, FinOps & Usage, Notifications, and Billing have no supported live route/API contract despite retained source and historical data. |
| High | Mobile hides project navigation, Admin navigation, account identity, and Logout; Infrastructure also overflows/clips at 390 px. |
| Medium | Cost is shown as `Pending` even though the active workflow performs no cost-estimation stage. |
| Medium | Audit logging does not cover the current GitHub Actions dispatch/reconciliation lifecycle and lacks first-class source, severity, project, and operation correlation. |
| Medium | Current-state freshness can report stale GitHub reconciliation while newly read AWS evidence is current; detection and deployed commits can differ without a prominent warning. |
| Medium | Monitoring is a point-in-time AWS health view only; CI/CD metrics and real runtime time series are absent. |

## 2. Current verified architecture and sources of truth

### Supported runtime

The only advertised startup path is root `npm run product:start`. `scripts/local-product.mjs` starts PostgreSQL with Docker Compose, runs migrations, builds backend and frontend, starts the Nest application on port 5000, and serves the Vite production preview on port 5173. `npm run product:verify` checks frontend serving, CORS, API/database readiness, GitHub OAuth entry, anonymous rejection, and retirement of public email/password endpoints.

The live process inspection found:

- frontend: Vite preview on `127.0.0.1:5173`;
- backend: `node dist/src/main` on port 5000;
- database: PostgreSQL on port 5433;
- no listener on Redis port 6379;
- no BullMQ consumer or custom deployment-worker process.

The root command surface advertises only `product:start`, `product:verify`, `product:build`, and `install:all`. The backend command surface has build/start, migrations, and verification scripts; it does not advertise normal-v1, outbox-dispatcher, Redis, BullMQ, or custom worker runtime commands. Historical scripts and source still exist in the worktree but are not supported command surfaces.

### Registered backend graph

`backend/src/app.module.ts` registers `AuthModule`, `UsersModule`, `AdminModule`, `AuditLogModule`, `ProjectsModule`, `TerraformExportModule`, and `AiTroubleshootingModule`. It registers many historical entities so old records remain readable, but it does not register the FinOps, Notifications, Billing, Observability, Orchestration, State Management, or full Infrastructure controller modules.

This distinction is decisive: source files or database rows from an unregistered module are not live product functionality.

### Migration baseline

The migration chain includes the original pipeline/security/cost/infrastructure/state/storage/orchestration/observability tables and later hardening. The migrations most relevant to this audit are `1760000011000-StoreEncryptedGithubAccessToken.ts`, `1760000015000-AddAuditLogCategory.ts`, `1760000018000-CreateProjectDeploymentContracts.ts`, `1760000019000-HardenProjectEnvironmentVariables.ts`, `1760000020000-EncryptLegacyProjectEnvironmentValues.ts`, `1760000029000-CanonicalDeploymentRequirements.ts`, `1760000030000-CanonicalProjectTimeAndRecency.ts`, `1760000031000-CanonicalModuleEventTimes.ts`, `1760000033000-CanonicalProjectConfiguration.ts`, `1760000042000-CanonicalStableReleaseProjection.ts`, `1760000058000-ReconcileVerifiedLifecycleIntegrity.ts`, `1760000060000-CreateGithubAppInstallations.ts`, `1760000061000-AllowSharedGithubAppInstallationLinks.ts`, and `1760000062000-AddUserDisabledAt.ts`. Later implementation must add forward migrations; it must not reinterpret the presence of legacy schema families as runtime activation.

### Current authority hierarchy

| Concern | Current authoritative source | Audit result |
| --- | --- | --- |
| User identity | signed HTTP-only session resolved to PostgreSQL `users` | Real; GitHub OAuth is the only public entry. Session lasts seven days, not one browser session. |
| Repository access | GitHub App installations plus GitHub repository APIs | Real; current installation-authorized repository selection works. |
| Detection/pre-flight | PostgreSQL detection profile, deployment requirements/contract, and pre-flight report derived from repository evidence | Real for the audited project; detection/pre-flight run before workflow dispatch. |
| Deployment operation | PostgreSQL GitHub Actions operation record plus GitHub run/job APIs | Real. API polling reconciles active/external completion. |
| Current product state | `GET /api/projects/:projectId/current-state`, especially `stateAuthority` | Intended canonical authority; some adjacent UI still uses separate history fields and loose conditions. |
| Detailed operator evidence | `GET /api/projects/:projectId/current-state/details` | Real but oversized; includes deployment-contract material beyond what the UI needs. |
| Image | ECR repository/tag/digest returned from GitHub/AWS evidence | Real and current for the audited live release. |
| Infrastructure | Terraform remote state plus ECS/ALB/ECR read-only checks | Real and current for the audited live release. |
| Health/live URL | GitHub Actions ALB health-verification result, reconciled into PostgreSQL and rechecked from AWS | Real; audited ALB target was healthy and endpoint returned HTTP 200. |
| Runtime metrics | Prometheus/CloudWatch/observability projections | Unavailable/disabled in the supported runtime. Historical metric rows are stale. |
| Cost | Infracost/FinOps | Unavailable in the active workflow. Historical estimates are largely mock and must not be displayed as current. |
| Image vulnerability gate | Retired | Removed from the active product and deployment path. |
| Notifications | notification service/provider | Module not registered; old deliveries are historical. |
| Platform billing | billing module/provider | Module not registered; account/invoice evidence is absent. |

### Real release evidence sampled

The live sample was project `4da59401-2847-4896-b1fa-54e8b649c4c6`, repository `Hassan-Sajjad72/react-pomodoro`, branch `master`.

- Canonical state: `LIVE`, 100%, healthy, one running ECS task out of one desired, zero pending.
- GitHub Actions run: `30977067526`, `workflow_dispatch`, successful, completed 2026-08-05; the caller uses the reusable DeployGuard workflow pinned to a commit.
- GitHub job steps: checkout; AWS OIDC; AWS identity check; ECR preparation; Dockerfile preparation; image build/push; Terraform installation; Terraform generation; combined Terraform plan/apply; ALB verification; result artifact. Destroy-only steps were correctly skipped.
- OIDC trust: supports `repo:Hassan-Sajjad72/*:*`, so the current repository is not restricted to the earlier acceptance repository. The trust also contains stale/malformed historical entries that should be cleaned separately.
- ECR: immutable deployed image evidence with tag and digest.
- ECS: service active, desired/running/pending `1/1/0`, task definition revision 2.
- ALB: active, healthy target, endpoint returned HTTP 200.
- Terraform state: project state object present in encrypted S3 storage and updated by the live run.

No secret, token, credential, environment value, bucket name, role ARN, or private-key content is included in this audit.

## 3. Route and navigation inventory

### Live frontend routes

| Route | Access | Actual result | Classification |
| --- | --- | --- | --- |
| `/` | Public | Simplified landing page; logged-out Admin and Deploy controls; authenticated avatar menu and Deploy | Working UI, but Admin target is wrong. |
| `/auth/github` | Public | OAuth completion/redirect bridge | Working. |
| `/403` | Public | Forbidden page | Working. |
| `/login`, `/signup`, `/dashboard` | Public | Redirect to `/` | Deliberately retired/consolidated. |
| `/projects` | Authenticated | Deployment-attempt-oriented project list | Working but incomplete as a complete project inventory and weak on mobile typography. |
| `/deploy` | Admin/Developer | GitHub App status, repository/branch selection, project analysis/configuration flow | Working core flow. |
| `/projects/:id` | Authenticated/authorized | Overview using canonical deployment view | Working with duplication/presentation defects. |
| `/projects/:id/pipeline` | Authenticated/authorized | Canonical view plus recovery/history | Partial; not an actual stage timeline. |
| `/projects/:id/infrastructure` | Authenticated/authorized | Canonical AWS/Terraform evidence | Working point-in-time evidence; responsive defects. |
| `/projects/:id/monitoring` | Authenticated/authorized | Health summary; Prometheus unavailable state | Partial. |
| `/admin` | `role=admin` | Overview, Users & Roles, Projects & Operations, Audit Log on one long page | Working data, wrong authentication boundary and navigation structure. |
| `/admin/users`, `/activity`, `/audit-logs` | Admin | Redirect to `/admin` | Consolidated. |
| Unknown route | Any | Redirect to `/` | Masks missing product routes as Home rather than a not-found state. |

### Legacy project redirects

`frontend/src/routes/AppRoutes.jsx` sends detection, pre-flight, environment, settings, state management, and release routes to Overview; costs/storage to Infrastructure; troubleshooting/logs/security/orchestration to Pipeline; observability to Monitoring. These redirects resolve in the browser, but some erase the semantic destination. In particular, Security and cost routes do not provide Security or FinOps pages.

### Missing supported routes

There is no supported route for:

- `/projects/:id/security`;
- `/projects/:id/finops` or `/projects/:id/usage`;
- `/projects/:id/notifications`;
- platform billing;
- a dedicated `/admin/login`;
- separate Admin section URLs or tabs.

The Sidebar contains only Overview, Pipeline, conditional Infrastructure, and conditional Monitoring. At widths at or below 900 px, CSS hides `.sidebar-section` and `.sidebar-footer`, removing all selected-project links, Admin, account identity, and Logout.

### Live backend route reality

Supported and verified endpoints include health, GitHub OAuth/session, projects, GitHub repository/install status, detection, requirements, environment configuration, pre-flight, current state/details, GitHub Actions deploy/status/history/retry/destroy, Terraform export, AI troubleshooting, Admin, and audit logs.

The following controller files exist but their modules are not registered, so live requests return 404: security scans, cost estimates/settings, infrastructure legacy endpoints, state management, orchestration, observability, notifications, and billing. Frontend API helpers that call these routes are dormant code, not evidence of support.

## 4. Page-by-page findings

### Home

The current simple visual design and single Deploy CTA are clear. Logged-out Deploy correctly begins GitHub OAuth and preserves `/deploy` as the return destination; authenticated Deploy goes directly to `/deploy`. The avatar menu retains Projects and Sign out.

Defect: logged-out Admin also points to `/auth/github`, preserving `/admin` as its destination. After GitHub authorization, a non-admin gets `/403`; a GitHub user already carrying `admin` reaches Admin. This is not the required dedicated administrator login and it permits the general GitHub identity realm to confer administrator access. After authorization the Admin button disappears, as designed by the latest landing requirement.

### Projects

The live page loads real canonical summaries and shows repository, status, meaningful activity, next action, and Continue. It emphasizes projects with deployment attempts and does not communicate the distinction from the full 28-project database inventory. On mobile, row cards stack, but adjacent label/value text is hard to scan and long repository/state content lacks a deliberate disclosure treatment.

Target: show all authorized, non-archived user projects; clearly label projects with no deployment attempt; use the canonical state and canonical actions only; retain filters; expose last reconciled time and stale evidence warnings.

### Deploy

The page uses the GitHub App, repository and branch APIs, and the real detection/requirements/pre-flight sequence. The verified `react-pomodoro` project has zero user-owned environment requirements and can proceed without AWS keys, role ARNs, GitHub tokens, workflow names, or infrastructure credentials.

Target: keep this one-page journey. Display repository/build-owned versus application-owned configuration explicitly, show exact evidence revision, prevent dispatch if detection/pre-flight revisions differ from selected head, and hand off to Pipeline after the single idempotent Deploy command.

### Overview

Overview consumes the canonical current-state projection and displays the real live URL, state, progress, release, infrastructure summary, and history. The live browser showed `Live` and 100%.

Defects:

- the canonical card includes a full GitHub history block, making Overview long and repetitive;
- action labels and status/progress values run together in text extraction (`Live100%`), indicating insufficient semantic spacing for assistive and narrow renderings;
- cost is `Pending` with “Estimated during deployment preparation” even though the active workflow has no estimator;
- the current source commit, detection/contract commit, and deployed commit can differ without a prominent evidence-drift warning;
- warnings remain prominent after a healthy live result without clear severity or applicability.

### Pipeline

Pipeline currently renders nearly the same canonical deployment card as Overview, then adds recovery/history content. Live reproduction showed `LiveLive` and two operation-history presentations. It does not render the actual GitHub job-step list, step status, start/end times, duration, skipped state, per-stage evidence, or current log availability.

The verified GitHub run contains precise step evidence, but the backend history response exposes only operation-level fields and a current/failed stage label. Friendly stage mapping exists in `backend/src/projects/pipeline/github-actions-stage-presentation.ts`, including “Connecting securely to AWS”, but the complete run step graph is not projected.

Failed-only sanitized troubleshooting is real and authorized. Live logs for an active run are not an in-product stream; the UI can only link to GitHub. It must say so rather than promise live logs it does not have.

### Infrastructure

The page shows real region, ECR repository/tag/digest, ECS cluster/service/task-definition revision and counts, ALB state/target health/endpoint, encrypted Terraform state, and persistent-storage state. Terraform export remains a supported action.

Desktop presentation uses dense definition lists with awkward indentation and insufficient hierarchy for long identifiers. At 390 px, the audited page clipped the heading/content and exceeded the viewport; long digests, resource identifiers, and the top-bar breadcrumbs contribute. Values need safe wrapping/truncation with accessible full disclosure.

### Security

The former image-vulnerability review surface has been removed from the active product. Repository and container-template safety checks remain part of pre-flight, while deployment proceeds directly from immutable image publication to infrastructure provisioning.

### FinOps & Usage

There is no route. Historical FinOps services and components include mock-mode fixed estimates and approval logic, but the module is not registered and the active workflow does not run Infracost. The current live project has no current cost estimate. Therefore `Pending` is misleading; the truthful status is `Unavailable — no cost estimator is configured for this workflow`.

AWS infrastructure cost and DeployGuard platform usage/billing must be separate sections. Existing billing entities have no current accounts/invoices, the Billing module is inactive, and its frontend is unreachable. Old subscription/usage rows are not evidence of a supported billing product.

### Monitoring

The page truthfully presents current ECS/ALB health from canonical AWS evidence and says Prometheus is not configured. It exposes the raw identifier `github_actions_health_verification`, has excessive empty space, and lacks charts/events. Historical runtime and stage metric tables were last populated by retired paths and are stale.

The required split is Infrastructure Monitoring and CI/CD Monitoring. Today only a point-in-time subset of the former exists. GitHub run/job/step timing can supply real CI/CD evidence without Prometheus; runtime CPU/memory/network/restarts require a real provider and must remain unavailable until configured.

### Notifications

There is no route and the module is not registered. Preference, subscription, and delivery entities and a settings panel exist, but the database has no active subscriptions and deliveries are historical. Delivery rows have provider status but no first-class user read/unread timestamp. The UI must not imply that email delivery is active.

### Admin

The live page returns real overview, user, project/operation, and audit APIs. Desktop cards and tables are substantially more readable than older raw layouts. However, the four sections are one very long page rather than individually navigable sections. Metric text can collapse in accessibility/text extraction (`PROJECTS28`, `ACTIVE OPERATIONS0`, `FAILED OPERATIONS16`). Long IDs require horizontal table scrolling; this is acceptable only inside a labelled focusable wrapper, not at document level.

At 390 px the table wrapper scrolls horizontally, but Admin navigation itself is hidden by the global mobile sidebar rule. Role and disable actions are immediately available in every row and need confirmation, target identity, and result feedback.

Most importantly, Admin is guarded only by the general authenticated user's role. There is no dedicated administrator login route/controller/session. The database contains an email-only administrator record, but no live email/password entry. `AuthService` retains PBKDF2 signup/login methods while the controller intentionally exposes neither endpoint. The general seven-day GitHub session is not the required per-browser admin session.

### Admin Audit Log

The current Admin table exposes time, actor, action, category, resource, project/run ID, status, and expandable details. The database has 6,473 historical rows at audit time.

Defects:

- current GitHub Actions dispatch, reconciliation success/failure, stable promotion, and destroy completion are not comprehensively recorded;
- source, severity, project ID, and operation/correlation ID are not first-class columns;
- actions/statuses are arbitrary strings rather than constrained vocabulary;
- category inference can classify an infrastructure approval as security because `approval` is matched before Terraform/infrastructure;
- key-name redaction is useful but does not reliably catch secret-shaped values under innocently named keys;
- legacy worker-era events dominate history without an execution-engine/source discriminator;
- audit writes catch and log failures, so a product mutation can succeed with no durable audit row.

## 5. Functional findings by module

### Authentication and authorization

- GitHub OAuth, CSRF state cookie, signed HTTP-only session, user disable check, project ownership, and role guards are implemented.
- Public signup/login endpoints are absent and their old frontend routes redirect Home.
- OAuth requests the `repo` scope and stores an encrypted user access token. Normal repository/deployment operations are intended to use the GitHub App installation; the product should audit whether the OAuth `repo` scope and stored PAT-like user token remain necessary.
- Project mutation is owner-scoped even for an administrator; cross-project Admin views are separate.
- Admin identity is not separated from GitHub identity and session lifetime.

### Detection, requirements, and pre-flight

- Real repository scanning and configuration ownership are implemented.
- Repository/build-owned variables are excluded from user requirements for the audited React project.
- A pre-flight ready result exists with zero blockers and zero required user environment variables.
- Contract freshness must be tied to the exact source SHA used by dispatch. The sampled profile/contract SHA differed from the deployed run SHA, so the UI needs an explicit freshness outcome rather than silently combining them.

### GitHub Actions deployment

- Real workflow dispatch, PostgreSQL advisory-lock idempotency, active-operation reuse, retry lineage, destroy confirmation, and restart reconciliation are implemented.
- Workflow failure logs are synchronized and sanitized; AI troubleshooting is available only for failed operations and project-authorized users.
- Poll-driven reconciliation means state becomes current when status/history/current-state requests occur; there is no GitHub webhook-driven completion path. This is acceptable for the local product if freshness and polling are explicit.
- The operation response is too coarse for the desired Pipeline experience.

### Infrastructure lifecycle

- OIDC, ECR, Terraform, ECS/ALB deploy, health verification, remote state, destroy, and export are the proven path.
- Terraform plan and apply are one workflow step, and ECS deployment occurs within Terraform apply. The UI must not invent separate timings unless the workflow emits them.
- Stable release is a backend projection after successful health verification, not a named GitHub step. It should be shown with that provenance.

### Security

- Repository and generated-container safety policy remains active.
- Neither is active in the supported workflow or backend graph.
- Current result: disabled/unavailable, not passed and not failed.

### FinOps, usage, and billing

- Historical mock and prospective Infracost code exists.
- No current estimator, policy gate, platform billing account, or invoices are supported.
- GitHub Actions durations and ECR image size/storage could become real usage evidence after a dedicated projection; they are not presently exposed as usage records.

### Monitoring

- Current AWS point-in-time state and GitHub job timing are available sources.
- Prometheus and CloudWatch integrations remain disabled. No current application log/metric stream is supported.
- Old observability rows must be labelled legacy and never merged with new GitHub/AWS samples without provenance.

### Notifications

- Schema and dormant service code exist, but no active API/provider/subscription journey exists.
- Read state, severity, related resource, and modern event taxonomy require schema work.

### Audit

- Authentication and Admin view/change events are recorded.
- Current deployment lifecycle coverage and structured correlation are incomplete.
- Metadata redaction must be shared with the proven failure-log sanitizer and backed by allowlists.

## 6. UI and responsive defects

The following were reproduced in the live browser at 1440 px desktop and 390 px mobile widths:

1. Pipeline renders `LiveLive` in its textual/accessible presentation.
2. Overview and Pipeline duplicate GitHub Actions operation history.
3. Admin metric labels and values collapse (`PROJECTS28`, `ACTIVE OPERATIONS0`, `FAILED OPERATIONS16`).
4. Infrastructure content clips/overflows at 390 px; long identifiers are not consistently contained.
5. Mobile hides all project-section links, Admin navigation, account identity, and Logout.
6. Breadcrumbs display raw lowercase route segments such as `pipeline`, `infrastructure`, and `monitoring`.
7. The shell says “Cloud delivery ready” statically even when a provider is unavailable or project evidence is stale.
8. Monitoring prints raw `github_actions_health_verification` rather than “GitHub Actions health verification”.
9. Dense `<dl>` blocks and long IDs lack copy controls, truncation, and accessible full-value disclosure.
10. Pipeline and Overview have weak page differentiation and excessive vertical repetition.
11. Monitoring has large empty regions and no purposeful unavailable-provider card hierarchy.
12. Unknown/missing routes redirect silently to Home, hiding navigation defects.

Required responsive behavior:

- replace the mobile-hidden sidebar sections with a labelled project-section menu or horizontally scrollable tab list;
- keep Projects, project pages, Admin (when authorized), account identity, and Logout keyboard-accessible at 390 px;
- prevent document-level horizontal overflow; permit it only inside genuinely wide, focusable tables;
- use `overflow-wrap:anywhere` for identifiers, bounded monospace blocks for technical evidence, and copy/full-value controls;
- give every status icon a text label, every expandable row a keyboard control, and every live refresh an unobtrusive accessible announcement;
- preserve the existing light tokens and visible focus styles.

## 7. Data-contract and state-management defects

### Two overlapping state contracts

`DeveloperProjectCurrentState` exposes both `developerState/developerAction` and `stateAuthority.state`. `projectStatePresentation.js` prefers `stateAuthority`, while `CanonicalDeploymentView.jsx` uses `developerState`, `developerAction`, a separately fetched GitHub history, and extra local conditions. This permits contradictory labels/actions.

Examples:

- Redeploy appears whenever `developerState === "live"`, independent of the requested live action contract.
- Destroy appears when the latest history object has a URL, not from a canonical available-actions list.
- Retry appears when the separately fetched latest operation is failed.
- the canonical developer projection maps an application failure to `deploy`/`redeploy`, while the required label is Retry Failed Deployment.

Required correction: one backend response must contain the authoritative state plus an ordered `availableActions` array with type, label, method, enabled flag, disabled reason, confirmation requirement, and target. The frontend must render that array and must not infer actions from URLs, state strings, or history.

### Stage model is not the workflow model

The browser reduces deployment to Analyze, Prepare, Build, Deploy, Verify. A historical stage registry contains many internal stages, but the current GitHub operation API does not return the real job-step execution graph. A stage shown to the user must cite one of: repository analysis, pre-flight report, GitHub job/step, AWS observation, or backend stable-promotion event. No synthetic stage may be labelled passed.

### Freshness and commit identity

The sampled response reported GitHub reconciliation freshness as stale based on the operation timestamp while AWS infrastructure evidence was freshly observed. These are different clocks and need separate fields: `operationReconciledAt`, `githubObservedAt`, `awsObservedAt`, and an overall `freshnessReason`.

Detection/contract, workflow head SHA, image digest, Terraform state update, and stable release must be linked in a release-evidence identity. If SHAs differ, the UI must say whether the difference is expected or blocks deploy.

### Oversized details response

The detailed current-state response includes a complete deployment contract, including generated Dockerfile content. Although authorized and not itself a secret, this exceeds what ordinary UI views require. Return a sanitized summary by default and put technical artifacts behind an Admin-only, audited endpoint with size limits.

### Historical-row contamination

Historical pipeline events, security scans, cost estimates, infrastructure events, metrics, notifications, billing usage, and releases remain in PostgreSQL. Their existence does not establish current support. Every new projection needs `source`, `executionEngine`, `observedAt`, `releaseIdentity`, and `freshness` so legacy rows cannot silently populate current pages.

## 8. Missing, partial, mocked, stale, and broken functionality

Database snapshot at audit time:

| Area | Evidence | Classification |
| --- | --- | --- |
| Users/projects | 11 users, 28 projects, 2 GitHub App installation rows | Real/current platform data. |
| Detection/pre-flight | 26 profiles, 24 reports | Real, but each row must be commit-scoped. |
| GitHub deployment operations | 107 pipeline-run rows; latest current release on 2026-08-05 | Current GHA operations mixed with legacy history. |
| Pipeline events | 1,535; latest 2026-07-23 | Stale legacy path, not current GitHub step evidence. |
| Security | 23 scans, 3,590 findings; latest 2026-07-16 | Stale/historical; current workflow disabled. |
| FinOps | 22 estimates and 128 breakdowns; historical actions include mock generation | Mock/stale; current live project has none. |
| Infrastructure events | 558; latest 2026-07-23 | Historical; current page uses direct canonical AWS evidence instead. |
| Runtime/pipeline metrics | 81 runtime snapshots, 255 stage metrics, 58 summaries; latest 2026-07-23 | Stale legacy observations. |
| Log streams/observability events | zero | Missing. |
| Notifications | 11 preferences, zero subscriptions, 66 old deliveries | Partial schema, inactive provider/API. |
| Billing | zero accounts, zero invoices, historical subscriptions/three usage events/one counter | Unsupported, not a live billing product. |
| Audit logs | 6,473 | Real history but incomplete for current GHA lifecycle and mixed with legacy sources. |

Live endpoint classification:

- **Working:** current state/details/history, deploy/retry/destroy, detection, pre-flight, environment requirements, Terraform export, AI troubleshooting, Admin overview/users/projects, audit logs.
- **Partial:** Pipeline evidence, Infrastructure presentation, Monitoring, project list, Admin information architecture.
- **Missing/unreachable:** Security, FinOps & Usage, Notifications, dedicated Admin login.
- **404 despite retained controller source:** security, cost, legacy infrastructure, orchestration, state, observability, notifications, billing.
- **Mock/stale:** historical mock cost estimates and retired-path metric/security/notification records.
- **Broken regression check:** `frontend test:visual-system` expects `role === "admin"` in Home and fails against the current logged-out-only Admin control. All other focused checks run in this audit passed.

## 9. Canonical deployment-state model

The backend must publish one state enum, one reason, one evidence revision, and one ordered action list. Internal GitHub and Terraform states remain available in diagnostics but cannot drive independent frontend decisions.

| Canonical state | Entry evidence | Primary presentation | Allowed actions |
| --- | --- | --- | --- |
| `ANALYSIS_REQUIRED` | No current detection/pre-flight for selected repo/branch/SHA | Analysis has not run | Run Analysis |
| `ANALYZING` | Current analysis/pre-flight request active | Analyzing repository | View analysis status only |
| `CONFIGURATION_REQUIRED` | Current requirements contain unresolved application-owned values | Configuration required | Provide Configuration |
| `READY_TO_DEPLOY` | Detection successful, pre-flight ready, zero unresolved requirements, no active operation | Ready to Deploy; no deployment has started or newer revision ready | Deploy once |
| `DEPLOYING` | Accepted deploy/retry operation is queued/running/reconciling | Current truthful stage and percent | View Live Logs/Workflow; all mutating actions disabled |
| `FAILED` | Latest relevant operation terminal failed and not superseded | Failure owner, stage, sanitized evidence | Retry Failed Deployment; View Failure Logs |
| `LIVE` | Latest release health verified and stable promotion matches release identity | Live URL and verified time | Open Application; Destroy Infrastructure |
| `DESTROYING` | Accepted destroy operation queued/running/reconciling | Destroy stage/status | View Live Logs/Workflow; mutation disabled |
| `DESTROYED` | GitHub destroy succeeded and AWS/state reconciliation confirms removal | Destroyed; history retained | Deploy Again |
| `PLATFORM_BLOCKED` | GitHub App/OIDC/workflow/AWS/platform evidence prevents safe execution | Platform configuration defect; no user credential request | View details; operator remediation only |
| `UNSUPPORTED` | Current repository profile is genuinely unsupported | Unsupported with evidence | No deploy; return to repository selection |

Rules:

1. Historical failures never override a newer active/successful/destroyed operation.
2. A workflow conclusion alone cannot produce `LIVE`; ALB health verification and stable-release identity must match.
3. A successful destroy workflow cannot produce `DESTROYED` until canonical AWS/state evidence confirms the expected result or explicitly records what could not be observed.
4. `FAILED` preserves any previous stable release separately; the latest attempt can fail while the prior live URL remains stable.
5. Duplicate deploy/retry/destroy requests return the existing active operation and identical action state.
6. Every response includes `revision`, `computedAt`, per-source observed times, and a reconciliation freshness reason.
7. Action labels and confirmation requirements come only from `availableActions`.

## 10. Target information architecture

Authenticated project navigation must be stable and visible on desktop and mobile:

1. Overview
2. Pipeline
3. Infrastructure
4. Security
5. FinOps & Usage
6. Monitoring
7. Notifications

Do not conditionally remove sections based on lifecycle state. A section without evidence should show why it is unavailable, disabled, not applicable, or not started. Conditional disappearance makes the product feel broken and removes discoverability.

Global authenticated navigation:

- Home
- Projects
- Deploy
- selected project section menu
- account menu with Projects and Sign out
- Admin only inside a dedicated administrator session

Admin information architecture:

- `/admin/login` — separate administrator authentication;
- `/admin` — overview;
- `/admin/users` — users and roles;
- `/admin/projects` — projects and operations;
- `/admin/audit-logs` — audit logs.

Security, FinOps, Monitoring, Notifications, and Billing must show explicit provider capability states. “Unavailable” is a valid state; empty successful cards are not.

## 11. Detailed target specification for every page

### Home

- Preserve one visible primary Deploy button.
- Logged-out Admin opens `/admin/login`, not GitHub OAuth.
- Authenticated GitHub users see only the existing avatar menu and Deploy; no Admin shortcut.
- Successful GitHub OAuth returns to the originally requested normal-user route only; it must never create an admin session.

### Projects

- Card/table fields: project name, repository/branch, canonical state badge, last meaningful activity, last reconciliation/freshness, canonical next action.
- Filters: canonical state and sort; explicitly include “No deployment yet”.
- Use repository-safe wrapping and copy buttons; no raw IDs as primary labels.
- Mobile: stacked semantic cards, no concatenated labels/values, no document overflow.

### Deploy

- Steps: GitHub App connection, repository, branch, analysis, genuine application-owned environment values, pre-flight summary, one Deploy action.
- Show repository/build-owned variables as satisfied evidence, not editable user requirements.
- Never request AWS keys, AWS secrets, role ARN, workflow name, GitHub token, state bucket, or infrastructure credentials.
- Pin detection, requirements, pre-flight, and dispatch to one commit SHA. Refresh or block on mismatch.
- Duplicate clicks reuse the active operation and immediately open Pipeline.

### Overview

- Hero: canonical state, concise message, progress, freshness.
- Actions: render canonical `availableActions` only.
- Cards: repository/revision, latest attempt, stable release/live URL, compact infrastructure health, current configuration readiness.
- Do not show full operation history or detailed stage logs.
- Cost card says Unavailable when no estimator is configured; it links to FinOps & Usage.
- Prominent warnings only when actionable or safety relevant; advisories use severity and source.

### Pipeline

- Header: operation number/type, canonical state, commit, workflow link, trigger, retry lineage, created/started/completed times, total duration, reconciliation freshness.
- Timeline rows for every applicable stage. Each row shows friendly name, internal identifier in expandable diagnostics, status, source, start/end, duration, evidence, skipped reason, failure owner, and log availability.
- Required stage mapping for the current architecture:
  - Repository checkout — GitHub job step.
  - Stack detection — backend detection profile, before dispatch.
  - Pre-flight validation — backend pre-flight report, before dispatch.
  - Dockerfile preparation — GitHub job step.
  - Docker build — GitHub job step.
  - Dockerfile security validation — Disabled until a real workflow step/artifact exists.
  - Image vulnerability review — Retired from this product version.
  - ECR push — current combined build/push step; use the same timing unless split in workflow.
  - Terraform initialization — derived only if separate workflow timing is emitted; otherwise part of combined plan/apply.
  - Terraform plan — current combined plan/apply step; do not invent a separate duration.
  - FinOps estimation — Disabled until real Infracost evidence exists.
  - Policy/approval — Not applicable while FinOps gate is disabled.
  - Terraform apply — current combined plan/apply step.
  - ECS deployment — Terraform/AWS evidence, with no fabricated independent time.
  - ALB health verification — GitHub health step plus target-health evidence.
  - Stable-release promotion — backend projection event after verified health.
- Active run: poll GitHub through backend and offer “View GitHub Actions” as the truthful live-log action. Add an in-product stream only if the backend actually proxies sanitized logs.
- Failed run: show synchronized sanitized failure excerpt, evidence sufficiency, AI troubleshooting, retry action, and prior stable-release status.
- History appears once, with pagination and deploy/destroy/retry lineage.

### Infrastructure

- Summary cards: region, lifecycle/destroy status, evidence source, last observed.
- ECS: cluster, service, task definition revision, desired/running/pending, rollout state.
- ALB: name, status, target health, endpoint, health observation time.
- ECR: repository, immutable tag, digest, pushed time.
- Terraform state: encrypted S3 status, scoped key, last apply/destroy, export action. Do not reveal infrastructure credentials.
- Resource identifiers use human labels, copy buttons, safe truncation, and expandable full values.
- Destroy state and confirmation use the canonical operation/action contract.

### Security

- Always reachable.
- Retired capability: do not infer a passed vulnerability result from pre-flight or the absence of findings.
- Enabled target: release/image digest, scan time, scanner/database version, policy decision, severity counts, vulnerability table, package/fixed version, remediation, suppressed findings with authorized rationale, technical artifact details.
- Scan evidence must match the exact deployed image digest and operation. Old scans are History only.

### FinOps & Usage

- Section A, AWS infrastructure estimate: status/capability, source, Terraform plan identity, currency, hourly/daily/monthly totals, service/resource breakdown, delta, estimate time, budget/policy decision.
- Section B, DeployGuard usage: workflow runs, successes/failures, queue/build/deploy durations, artifact/image storage if actually measurable, period and source.
- Section C, platform billing: separate disabled/not-configured card unless a real billing account/provider exists. Never infer charges from AWS estimates.
- Current truthful default: cost estimation unavailable and platform billing disabled.

### Monitoring

- Two tabs/views.
- Infrastructure Monitoring: ECS counts/restarts/deployments, ALB target health/availability, CPU, memory, network, application errors, and infrastructure events. Point-in-time fields remain available; charts only appear with timestamped provider samples.
- CI/CD Monitoring: current workflow, queue time, job/stage durations, total duration, success/failure rate, failed stages, scan timing when enabled, and workflow history.
- Every metric shows source, sample window, last observed, timezone, and unavailable reason. Raw identifiers are humanized.

### Notifications

- Always reachable with a clear Disabled state until a provider is configured.
- Event inbox fields: read state, severity, category, project, timestamp, related operation/resource, concise message, details link.
- Preferences: deployment, infrastructure, security, cost, and administrative categories; severity threshold; supported destinations; provider verification state.
- Add read/unread operations and pagination. Never expose destination secrets or provider credentials.

### Administrator login

- Public Admin control opens `/admin/login`.
- Form accepts the operator-supplied administrator email and password over same-origin TLS in production.
- The password is never embedded in source, frontend configuration, Markdown, fixtures, logs, audit metadata, shell output, or API responses.
- Initial provisioning is an explicit protected CLI or one-time bootstrap using out-of-band secret input. Store an Argon2id hash with per-password salt and versioned parameters; do not store recoverable password material.
- Use a separate admin session cookie/realm, HTTP-only, Secure in production, SameSite Lax or Strict, short idle/absolute lifetime, CSRF protection on mutations, rate limiting, and session rotation after login.
- Use a session cookie without persistent `Max-Age` for the “login in each new browser session” requirement. Logout clears it server-side and client-side.
- A GitHub OAuth user never becomes an administrator by OAuth completion, email match, or landing-page intent. Existing GitHub-linked admin roles must be migrated/revoked or excluded from the admin guard.
- Log success/failure/logout without passwords; use generic failure messages and rate-limit metadata.

### Admin Overview

- Dedicated route with metric cards, capability/provider status, current active/failed operations, stale evidence warning, and links to the other Admin sections.
- Humanize labels and separate label/value nodes. Static “ready” language must reflect real readiness evidence.

### Admin Users & Roles

- Search/filter/pagination, GitHub identity versus admin identity clearly separated.
- Role/disable changes require confirmation naming the target and desired state; prevent disabling the last administrator.
- Show result feedback and correlated audit ID; never expose tokens or hashes.

### Admin Projects & Operations

- Project, owner, repository/branch, canonical state, active/latest operation, workflow link, release identity, last reconciliation, stale indicator.
- Read-only evidence by default. Any mutation uses the canonical service and idempotency protections; no legacy worker controls.

### Admin Audit Logs

- Columns: timestamp, actor, action, resource, project, result, source, severity, operation/correlation ID, details.
- Filters for each first-class field and time range; pagination; accessible expandable sanitized metadata.
- Required event coverage: admin login success/failure/logout, GitHub OAuth success/failure/logout, project creation/archive, repository/branch changes, environment variable name/ownership changes (never values), analysis/pre-flight, deploy/retry/redeploy/destroy request and idempotent reuse, workflow reconciliation success/failure, stable release, security decision, role/access changes, cost policy, notification preferences, export.

## 12. Backend/API/database changes required

### Canonical projection

Extend `GET /api/projects/:projectId/current-state` with:

- a versioned canonical enum and `availableActions`;
- release-evidence identity linking repository SHA, detection/pre-flight, operation, workflow run, image digest, Terraform state, and stable release;
- distinct GitHub/AWS/database observation timestamps and freshness reasons;
- capability flags for Security, FinOps, Monitoring providers, Notifications, and Billing.

Add a project-authorized Pipeline evidence endpoint, for example `GET /api/projects/:projectId/deploy/operations/:operationId/evidence`, that normalizes GitHub run, job, and step evidence. Cache it in PostgreSQL or reconcile on read; do not introduce Redis/BullMQ/custom workers.

### New/activated page contracts

Do not simply register every historical module. Define read models first:

- Security summary/history bound to operation and image digest;
- FinOps estimate bound to Terraform plan/release identity plus a separate platform-usage summary;
- Monitoring infrastructure samples and GitHub CI/CD aggregates with provenance;
- Notifications inbox/preferences/read-state capability;
- Admin capability and audit projections.

Return `200` with explicit capability state for a supported-but-disabled page. Reserve `404` for a missing resource, not a disabled provider.

### Database changes

- Add operation stage evidence: operation ID, workflow run/job/step IDs, internal/friendly keys, status, source, timestamps, duration, conclusion, skipped reason, failure owner, sanitized evidence reference, observed time.
- Add a release-evidence identity/fingerprint and foreign-key/correlation fields across detection, pre-flight, operation, image, Terraform, health, stable release, security, and cost records.
- Add first-class audit `project_id`, `operation_id`, `correlation_id`, `source`, `severity`, `execution_engine`, and constrained result/status fields.
- Add notification inbox read timestamp, severity, category, related resource/operation, and source.
- Add provider-capability/configuration state without storing provider secrets in user-visible rows.
- Mark historical rows with a migration-derived legacy source where deterministically possible; otherwise display them as unknown legacy evidence.
- Add dedicated administrator credential/session entities or an equivalent isolated identity realm. Credential hash and sessions must never be returned by general user APIs.

### Audit integration

Inject the audit service into GitHub Actions dispatch/retry/destroy and reconciliation/stable-promotion paths. Record accepted, reused/no-op, succeeded, failed, and destroyed outcomes idempotently. Use a PostgreSQL transaction/outbox if durable audit completion is required; do not reactivate the retired deployment outbox or Redis worker.

Replace arbitrary metadata with event-specific allowlisted DTOs and the shared log secret sanitizer. Store references/digests rather than large raw payloads.

## 13. Frontend changes required

Primary files/components likely to change are identified in section 18. Architectural requirements:

1. Introduce one `useProjectCurrentState` cache/polling layer with invalidation after detection, pre-flight, deploy, retry, destroy, and reconciliation changes.
2. Render `availableActions` centrally; remove `currentState.developerState === "live"`, `githubDeployment.status === "failed"`, and `deployedUrl` button predicates from `CanonicalDeploymentView.jsx`.
3. Split Overview and Pipeline. Overview stays concise; Pipeline owns timeline, evidence, logs, troubleshooting, and the single history list.
4. Add stable routes/pages for Security, FinOps & Usage, Notifications, and the two Monitoring views, including explicit disabled/unavailable states.
5. Replace the mobile-hidden sidebar sections with a responsive project/Admin navigation control and preserve Logout.
6. Humanize all raw identifiers through one label registry; show internal identifiers only in technical details.
7. Add copy/disclosure components for long IDs, URLs, digests, ARNs, and state keys.
8. Provide distinct loading, empty, disabled, stale, error, and permission states. A failed fetch must never become an empty-success card.
9. Make the Admin areas separately addressable and restore section-specific focus/heading behavior.
10. Replace Home Admin OAuth routing with dedicated admin login while preserving the single Deploy CTA and authenticated avatar menu.

## 14. GitHub Actions and AWS evidence requirements

### Preserve without redesign

- GitHub App-authorized repository selection;
- reusable caller workflow model;
- AWS OIDC temporary credentials;
- immutable ECR image identity;
- Terraform remote state and scoped state key;
- ECS/ALB deployment and health verification;
- destroy and Terraform export;
- PostgreSQL idempotency/reconciliation.

### Evidence contract

For each operation, persist or project:

- repository, branch, exact SHA, workflow file/ref, run ID/attempt, URL, event, actor;
- queue, job start/end, conclusion, total duration;
- every GitHub step name/number/status/conclusion/start/end/duration/skipped reason;
- friendly label plus raw identifier;
- image URI/tag/digest and push evidence;
- Terraform plan/apply/destroy evidence and state observation without secrets;
- ECS service/task revision/counts and ALB target-health observation;
- health-check URL/status without confidential headers;
- stable promotion identity and timestamp;
- failure owner (`application`, `platform`, `external`) and sanitized log reference.

If one GitHub step combines multiple conceptual stages, the UI must show shared evidence/timing or the workflow must be safely split. It must not divide a duration by assumption.

OIDC failure is a platform configuration defect. The UI must never request that a project user paste AWS credentials or role configuration. Trust-policy maintenance should remove malformed/stale entries while preserving the safe reusable owner/repository onboarding rule.

## 15. Security and credential-handling requirements

- Never print or return GitHub App private keys, OAuth client secrets, user access tokens, installation tokens, AWS credentials, role session tokens, Terraform secrets, environment values, admin passwords, hashes, session cookies, or provider keys.
- Keep project environment values encrypted at rest and write-only/masked in API responses. Audit names/ownership/change outcome only.
- Continue sanitizing synchronized GitHub failure logs before storage and before AI input. Report insufficient evidence rather than fabricating a diagnosis.
- Apply the same value-pattern and key-pattern sanitizer to audit metadata, notifications, downloadable evidence, and Admin detail views.
- Reduce GitHub OAuth scope and stored user-token use if the GitHub App can supply every required repository operation. A normal path must not depend on a PAT.
- Admin credentials use dedicated identity/session storage and rate limiting. Provisioning consumes the operator-supplied secret out of band and never echoes it.
- Technical evidence endpoints require project authorization; cross-project Admin inspection requires a valid dedicated admin session and creates an audit event.
- Use CSP, secure production cookies, CSRF protection for cookie-authenticated mutations, bounded payload/log sizes, and no credentials in URLs.
- Security/FinOps/Monitoring/Notification capability flags default disabled and fail closed.

## 16. Prioritized implementation batches

Each batch is vertical and independently verifiable. Do not start a later batch until the earlier batch's acceptance criteria pass in the live browser/API/database.

### Batch 1 — Administrator identity boundary

Implement dedicated Admin login/session/logout/provisioning, remove GitHub-role access to Admin, migrate/revoke GitHub-linked admin authority, route the public Admin control to `/admin/login`, and preserve normal GitHub OAuth. Add login/role/session audit events.

Done when a fresh browser requires administrator credentials; a GitHub user cannot enter Admin regardless of OAuth return target/email; logout invalidates the admin session; no secret is present in source, bundle, logs, fixtures, Markdown, or responses.

### Batch 2 — Canonical action and evidence contract

Version current state, add release identity/freshness/available actions, add GitHub job-step evidence, and integrate current deployment audit events. Keep workflow semantics unchanged.

Done when Overview, Projects, Pipeline, Infrastructure, Monitoring, and Admin derive the same state/actions from one revision; duplicate commands reuse an operation; restart/external completion reconciles; current deploy/destroy outcomes create correlated sanitized audit rows.

### Batch 3 — Overview/Pipeline separation and responsive shell

Make Overview concise, build the real Pipeline timeline/history/log presentation, remove duplicate history and loose button logic, and fix project/Admin/account mobile navigation and overflow.

Done when all canonical states render correct actions, every real current-workflow stage is truthfully sourced, 390 px has no document overflow or hidden navigation/logout, keyboard operation passes, and `LiveLive`/joined values are absent.

### Batch 4 — Infrastructure and Monitoring evidence UI

Polish Infrastructure and split Monitoring into Infrastructure and CI/CD views using current AWS and GitHub evidence. Keep unavailable runtime providers explicit.

Done when current values match API/AWS evidence, long values are accessible, GitHub timing is real, Prometheus/CloudWatch absence is truthful, and no stale legacy metric is presented as current.

### Batch 5 — Security capability

Keep repository and generated-container policy evidence truthful and scoped to the active deployment contract.

Done when disabled means disabled; enabled scans match the exact image digest/run; severity totals equal findings; failure gates deployment according to an explicit policy; secrets/logs remain sanitized.

### Batch 6 — FinOps & Usage

Ship separate capability states, then add real plan-bound Infracost and GitHub/AWS usage projections. Keep platform Billing disabled until a real account/provider exists.

Done when no mock row appears as current, `Pending` is absent without an active estimate, totals equal breakdowns, plan/release identity is visible, and AWS cost is never labelled a DeployGuard charge.

### Batch 7 — Notifications

Add reachable disabled state, inbox/read model/preferences, then activate a real provider only with confirmed subscriptions and delivery evidence.

Done when events are project-authorized, deduplicated, categorized, readable/unreadable, provider state is truthful, failures are not successes, and no destination/credential secret leaks.

### Batch 8 — Admin information architecture and audit completeness

Split Admin routes, improve confirmations/responsiveness, finish structured audit filters/details, and distinguish legacy from current execution sources.

Done when all required events are covered, current GitHub lifecycle is correlated, metadata passes secret-pattern tests, long rows are usable at 390 px, and historical source is unmistakable.

## 17. Exact acceptance criteria

### Global and navigation

- All seven project sections are directly reachable at desktop and 390 px.
- No page has document-level horizontal overflow at 390 px.
- Admin and Logout remain reachable on mobile when authorized.
- All controls are keyboard operable with visible focus; dialogs trap/restore focus and expose accessible names.
- Unknown routes show a not-found page or an intentional documented redirect, never silently hide a missing feature.

### State and actions

- One API revision produces identical canonical state on Projects, Overview, Pipeline, Infrastructure, Monitoring, and Admin.
- Live shows only Open Application and Destroy Infrastructure.
- Destroyed shows Deploy Again.
- Failed shows Retry Failed Deployment and View Failure Logs.
- Deploying/Destroying shows View Live Logs/Workflow and disables mutations.
- Duplicate deploy/retry/destroy produces one operation.
- Backend restart and externally completed GitHub run reconcile without a false success/failure.
- Older failures never replace a newer current result.

### Pipeline

- The audited run's step statuses/times/durations match GitHub job API evidence within timestamp precision.
- Disabled/unimplemented stages are labelled Disabled or Not applicable, never Passed.
- Combined Terraform plan/apply and build/push timings are not fabricated into independent durations.
- Failure logs are sanitized, project-authorized, and shown only for failed operations.
- AI output states evidence insufficiency when no grounded diagnosis exists.

### Infrastructure and monitoring

- ECR digest/tag, ECS counts/revision, ALB target health/URL, region, and Terraform state match current read-only AWS evidence.
- Destroyed state does not retain active-resource claims.
- Every metric identifies source, observation time, window, and availability.
- Prometheus/CloudWatch disabled states do not render empty charts or success badges.

### Security, FinOps, usage, notifications, billing

- Each page is reachable even when disabled.
- Historical/mock evidence is clearly segregated and never selected as current.
- Security evidence matches operation and image digest.
- FinOps evidence matches Terraform plan/release identity and totals reconcile.
- Platform usage/billing is separate from AWS estimate.
- Notification provider state and delivery result are truthful; read state persists.

### Admin and audit

- A new browser has no Admin access until dedicated administrator login.
- GitHub OAuth cannot create/elevate an admin session.
- Admin logout invalidates the server/client session.
- Credential hash and supplied password never appear in repository, frontend bundle, API, logs, audit rows, fixtures, screenshots, or documentation.
- Audit logs contain every event listed in section 11 with source, severity, project, result, and correlation.
- Sanitizer tests cover credential-shaped values under non-sensitive keys.

### Required verification suite

- backend and frontend production builds;
- migration up/down safety in a disposable database plus migration run against the supported local database;
- auth/admin segregation and rate-limit/session tests;
- project authorization tests for every new endpoint;
- canonical state/action matrix and restart/reconciliation tests;
- GitHub job-step fixture plus one live read-only run comparison;
- responsive browser checks at 1440 px and 390 px for every route;
- keyboard/accessibility scan;
- secret scanning of git diff, built frontend, API fixtures, logs, and audit metadata;
- `git diff --check`.

Audit-run test evidence: `product:verify` passed; backend and frontend production builds passed; application-surface, GitHub Home, Admin readability, current-state UI, deploy journey, unified lifecycle, Pipeline recovery, frontend operator segregation, backend auth/operator segregation/current-state/GitHub Actions/immutable release/legacy retirement/AI troubleshooting/manifest secret-safety checks passed. `test:visual-system` failed on its stale Home admin-role assertion. These source-oriented checks supplement but do not replace the live browser/API/external evidence above.

## 18. Files likely to be changed

This is a forecast for the implementation phase, not a change list from this audit.

### Frontend

- `frontend/src/routes/AppRoutes.jsx`
- `frontend/src/pages/Landing.jsx`
- `frontend/src/pages/Projects.jsx`
- `frontend/src/pages/NewProject.jsx`
- `frontend/src/pages/ProjectDetails.jsx`
- `frontend/src/pages/ProjectPipeline.jsx`
- `frontend/src/pages/ProjectInfrastructure.jsx`
- `frontend/src/pages/ProjectMetrics.jsx`
- `frontend/src/pages/ProjectSecurity.jsx`
- new FinOps & Usage, Notifications, and Admin Login pages
- `frontend/src/pages/AdminUsers.jsx` or replacement Admin section pages
- `frontend/src/components/layout/Sidebar.jsx`
- `frontend/src/components/layout/Navbar.jsx`
- `frontend/src/components/projects/CanonicalDeploymentView.jsx`
- `frontend/src/components/projects/PipelineRecoveryPanel.jsx`
- Security, FinOps, observability, notification, audit, and Admin components
- `frontend/src/api/projectApi.js`, `adminApi.js`, and possibly a dedicated admin-auth API module
- `frontend/src/utils/developerDeploymentPresentation.js`
- `frontend/src/utils/projectStatePresentation.js`
- a new canonical project-state hook/cache
- `frontend/src/styles.css`
- focused scripts under `frontend/scripts/`, especially `verify-visual-system.mjs`

### Backend

- `backend/src/auth/*` only for separation/cleanup of normal GitHub auth
- a new dedicated admin-auth module/controller/service/guards/DTOs/entities
- `backend/src/admin/*`
- `backend/src/audit-log/*`
- `backend/src/projects/current-state/project-current-state.service.ts`
- `backend/src/projects/current-state/project-current-state.types.ts`
- `backend/src/projects/current-state/project-developer-current-state.ts`
- `backend/src/projects/github-actions-deployment.service.ts`
- `backend/src/projects/pipeline/github-actions-stage-presentation.ts`
- `backend/src/projects/projects.controller.ts` and `projects.module.ts`
- Security/FinOps/Monitoring/Notification read-model modules after removing retired worker dependencies
- new TypeORM migrations for admin identity/session, stage evidence, release correlation, audit fields, and notification read state
- `.github/workflows/deployguard-reusable.yml` only when adding real machine-readable stage/security/FinOps evidence; preserve existing deploy/destroy behavior
- backend verification scripts and sanitized GitHub fixtures

Do not restore `backend/src/pipeline.worker.ts`, Redis/BullMQ queue activation, old pipeline mutation controllers, or retired normal-v1 command surfaces.

## 19. Risks and regression protections

| Risk | Protection |
| --- | --- |
| UI work changes deployment semantics | Treat workflow dispatch/reconcile services as protected; add read-model APIs around them and compare a known live run. |
| Historical rows appear current | Require release identity, source, observed time, execution engine, and freshness in every projection. |
| New stage UI fabricates granularity | Use GitHub job-step IDs/timestamps; show combined stages when evidence is combined. |
| Admin migration locks out the operator | Provision and verify the dedicated admin identity before revoking GitHub-admin access; keep a recovery CLI that consumes out-of-band input. |
| Admin migration elevates GitHub users | Separate cookies/guards/identity tables and test email collision/OAuth return-target cases. |
| Secret leakage through audit/log/details | Shared sanitizer, allowlisted DTOs, negative fixtures, bundle/diff/log scans, size limits. |
| Polling races create duplicate actions | Preserve advisory lock/idempotency keys; render server actions; test concurrent clicks and restart. |
| Monitoring provider absence becomes error noise | Capability contract and stable Disabled/Unavailable UI states. |
| Security/FinOps reactivation pulls in retired worker dependencies | Implement GHA artifact ingestion and PostgreSQL read models only; dependency graph test rejects Redis/BullMQ/custom worker imports. |
| Mobile fixes regress desktop | Route-by-route visual and keyboard matrix at 390, 768, 900, and 1440 px. |
| AWS trust cleanup blocks repositories | Inspect and simulate trust subjects before change; retain the approved reusable repository pattern; verify OIDC with non-mutating identity first. |
| Audit failure is silent | Monitor audit persistence and use transaction/PostgreSQL outbox for required security events without coupling deployment execution to Redis. |

## 20. Genuine external/operator blockers

There is no blocker to implementing the first four batches with the current repository, database, GitHub, and AWS access. The following are genuine operator/external decisions or credentials needed only for the corresponding optional provider activation:

| Item | Needed when | Blocker status |
| --- | --- | --- |
| Administrator password supplied out of band | Batch 1 provisioning | Operator input is required at provisioning time. It must not be placed in code, Markdown, fixtures, logs, or command output. The administrator email is already operator-supplied and must likewise not be repeated in this document. |
| Image vulnerability policy thresholds/exceptions | Retired capability | Not part of the active deployment path. |
| Infracost API credential and budget/approval policy | Enabling real FinOps | External credential/policy; not needed to show Unavailable truthfully. |
| Metrics/log provider choice and permissions | Runtime CPU/memory/network/application-log charts | External integration; GitHub CI/CD timing and current AWS health can be implemented without it. |
| Notification provider/domain/destination verification | Sending notifications | External provider setup; inbox and Disabled state can be implemented first. |
| Billing provider/account/product configuration | Activating platform Billing | External commercial decision; Billing must remain explicitly disabled until supplied. |

Credential rotation remains a non-blocking pre-production recommendation for temporary local FYP credentials. It does not invalidate the read-only evidence in this audit, but production launch must rotate temporary credentials, clean stale IAM trust entries, verify least privilege, and rerun the no-secret acceptance checks.
