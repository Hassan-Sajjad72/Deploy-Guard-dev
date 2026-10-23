# DeployGuard Active Implementation Queue

Status: Iteration 2 canonical sanitized developer projection complete, 2026-08-01  
Authority: this is the sole active queue. `RAILWAY_PRODUCT_CONTRACT.md` defines
intended behavior; all other reports and trackers are historical evidence.

## Protected baseline

Do not redesign the shared normal-v1 workers, activation policy, immutable
intents/manifests, deterministic outbox/BullMQ identities, ownership, leases,
fencing, heartbeat, journals, reconciliation, isolation, stable/latest separation,
unchanged-source `NO_OP`, or durable history.

The audited local baseline remains three live shared `dev` capabilities with no
project binding, zero active production BullMQ work, and zero active operation
leases, cross-lane owners, or outbox claims. Stripe and SNS remain disabled and
deferred. Live AWS mutation remains outside this program.

## Iteration 1 authoritative exposure inventory

The inventory was rebuilt from `AppRoutes.jsx`, `Sidebar.jsx`, all 35 page
modules, routed child components, 135 frontend API exports, Nest controllers,
service authorization calls, and the 97-field current-state return object.
It is the pre-Iteration-2 exposure snapshot used to derive the remaining work,
not a statement that the raw current-state exposure still exists. The completed
Iteration 2 evidence below supersedes its current-state and developer-page
projection observations; dispositions scheduled for Iterations 3–7 remain active.

### Route and page classification

| Route/page | Current exposure and calls | Classification | Required disposition |
|---|---|---|---|
| `/`, `/login`, `/signup`, `/auth/github`, `/403` | Landing/authentication/authorization result | public/developer | keep; concise auth errors only |
| `/dashboard` — `Dashboard` | `getWorkspaceSummary`; project/release totals, Continue/Open links | developer | consume sanitized workspace developer summaries only |
| `/projects` — `Projects` | `getWorkspaceSummary`; status and next-action reconstruction | developer | consume canonical developer state/action only |
| `/projects/new` — `NewProject` | GitHub status/repositories/inspection, create, detection, preflight, workspace warnings, archive conflict | developer | keep repository selection/analyze; replace cloud-resource warnings/review links with platform attention |
| `/billing` — `Billing` | billing summary/provider actions plus workspace release summary/history | mixed | usage/release read model is developer-safe; provider mutations are workspace-owner/deferred; remove raw lifecycle code |
| `/activity` and `/audit-logs` — `AuditLogs` | raw audit categories, resource IDs, actor operations | operator/admin | remove from ordinary navigation and require admin/operator backend authorization |
| `/projects/:id` — `ProjectDetails` | project + 97-field current state; detection/preflight mutation; exact normal-v1 actions | mixed developer/operator | retain one developer action and stable/latest/progress; remove run IDs, cloud/resource state, modes, raw details and Terraform approval |
| `/projects/:id/pipeline` — `ProjectPipeline` | current state plus legacy `ProjectPipelineRun` fallback; exact normal-v1 actions | mixed developer/deprecated | make Deployments developer-safe and v1-authoritative; preserve legacy history only as sanitized read-only history |
| `/projects/:id/requirements` — `DeploymentRequirements` | project + get/resolve required application values | developer | canonical Environment page; retain masked app-owned values and managed/external DB choice without platform internals |
| `/projects/:id/env` — `ProjectEnvVars` | project plus environment CRUD through child component | developer compatibility | consolidate with Environment; preserve masked CRUD and immutable configuration identity |
| `/projects/:id/logs` — `ProjectPipelineLogs` | current state and legacy pipeline run/event APIs | deprecated implementation of developer Logs | replace with sanitized application logs; legacy events become read-only deployment history, not the Logs source |
| `/projects/:id/observability/metrics` — `ProjectMetrics` | current state + runtime metrics; exposes Prometheus/CloudWatch selector | mixed developer/operator | retain application metrics/ranges; remove provider selector and cloud terminology |
| `/projects/:id/settings` — `ProjectSettings` | project/repository/branch/overrides/env/current state/detection/preflight; notifications; admin-only cleanup child | mixed | retain app settings/archive; move detection internals, provider settings and cleanup to operator routes |
| `/projects/:id/recovery` — `ProjectRecovery` | raw recovery issue/evidence; configuration redirect or read-only recovery | deprecated developer route / operator evidence | developer-owned issues route to Environment/Settings; platform recovery becomes neutral `platform_attention`; detailed route admin-only |
| `/projects/:id/detection` — `ProjectDetection` | detailed detection profile and rerun | operator diagnostic / developer summary | expose only supported/unsupported/app-owned correction in developer state; protect details |
| `/projects/:id/preflight` — `ProjectPreflight` | detailed preflight, generated Docker evidence, rerun | operator diagnostic / developer summary | expose only configuration/build/start blockers; protect detailed report |
| `/admin/users` — `AdminUsers` | user listing and role mutation | operator/admin | keep backend and frontend admin-only |
| `/admin/cloud-cleanup` — `AdminCloudCleanup` | inventory refresh/export, destroy, cleanup, manual review, emergency cleanup | operator/admin | keep protected; never link from developer state |
| troubleshooting, infrastructure, orchestration, runtime, application-log, release, rollback, security, Terraform-state, storage, cost and scan-detail project routes | detailed cloud/runtime/security/cost evidence and mutations | operator/admin | retain only under admin routes and explicit backend authorization |
| wildcard redirect | navigation fallback | public compatibility | keep |

The selected-project sidebar already contains the six contractual labels. The
global sidebar additionally exposes Activity Log and Plan & usage; Activity Log
is operator-only, while Plan & usage is a mixed developer-read/workspace-owner
surface. Admin Cloud Cleanup and Operator modules are visually role-gated, but
backend field separation remains required.

### Meaningful button and command classification

| Action family | Current entry points | Classification |
|---|---|---|
| Sign in/out, GitHub connect, choose repo/branch, create project | auth pages, `NewProject`, Settings | developer |
| Save genuinely required values, managed/external database selection, masked env CRUD | Requirements, Environment | developer |
| Save project details/repository/branch/app directory/build/start/health overrides; archive | Settings | developer, subject to project manage authorization |
| Deploy/Redeploy, open stable app | Overview/Deployments | developer canonical action |
| Run detection/generate preflight | Overview, New Project, Detection, Preflight, Settings | automatic platform step; direct detailed controls move to operator, except app-owned re-analysis after a source-setting change |
| Plan infrastructure / Approve and apply / Deploy application / Deploy release | `NormalInfrastructurePlanningPanel` and `normalReleaseAction.js` | internal orchestration currently exposed; only Deploy/Redeploy and policy-based Approve Cost may remain developer actions |
| Terraform confirmation (`Apply this exact reviewed Terraform plan to AWS?`) | Overview and Deployments | prohibited developer action |
| Internal run IDs, lifecycle codes, outbox state, effect counts, provider modes and raw events | Developer Details/release panels | operator/admin |
| Audit filtering and raw audit rows | Activity Log | operator/admin |
| App-log filters and application metric range | Logs/Metrics | developer |
| Prometheus/CloudWatch source selection | Metrics | operator configuration |
| Billing checkout/portal/cancel | Plan & usage | deferred provider work; workspace-owner only if later productized |
| Cost estimate approve/reject/settings | Cost pages | workspace-owner cost approval only where policy permits; detailed estimate/settings operator |
| Security scan trigger/approve/findings | Security pages | operator/admin; sanitized application-owned finding may be developer guidance |
| Rollback/scaling, state validation/recovery/force unlock, storage provision/restore, Terraform export, troubleshooting | admin project modules | operator/admin |
| Destroy, cleanup, residue TTL/manual review/emergency cleanup | Settings admin child and Admin Cloud Cleanup | operator/admin only |
| `StartPipelineForm`, `ResumeDeploymentButton`, `DeploymentRecoveryCenter`, generic `CurrentStateAction` | currently unrouted/dead or historical components | deprecated until proven needed by a protected operator flow |

### Frontend API boundary classification

- **Developer read/write:** authentication; authorized project/workspace list;
  GitHub repository/branch inspection; project create/update/archive; requirements;
  masked environment values; sanitized current state; application logs/metrics;
  and one canonical Deploy/Redeploy command.
- **Operator/admin:** all `adminApi` calls; audit log; troubleshooting; detailed
  detection/preflight; infrastructure/readiness/events/discovery; Terraform state;
  storage operations; orchestration status/events/releases/rollback/scaling;
  security scans; detailed cost settings/estimates; cloud inventory/cleanup;
  Terraform export; internal notification delivery tests.
- **Retired/deprecated:** `/automation/start`, legacy pipeline start/cancel/retry/
  approve-apply, `/deploy`, `/infrastructure/plan`, `/infrastructure/apply`, and
  `/orchestration/deploy`. Backend mutation routes correctly return
  `LEGACY_DEPLOYMENT_EXECUTION_RETIRED`; frontend exports and legacy read fallback
  remain compatibility debt.
- **Internal exact normal-v1 commands:** prepare/release dispatch/infrastructure
  plan dispatch/infrastructure apply dispatch are valid protected boundaries, but
  the frontend must call them only through one canonical orchestration command.
  Direct developer apply dispatch is prohibited.

### API consumer inventory

The complete routed and routed-child API import inventory is below. Calls are
grouped by the component that can invoke them; page modules without an entry are
render-only. `developer`, `mixed`, `operator`, and `deprecated` use the route and
action decisions above.

- **developer:** `AuthContext` — `getCurrentUser`, `loginUser`, `logoutUser`,
  `signupUser`; `GithubConnecting` — `getGithubAuthUrl`; `AppLayout` —
  `recordProjectView`; `CommandPalette` — `getProjects`; `Dashboard` and
  `Projects` — `getWorkspaceSummary`; `DeploymentRequirements` —
  `getDeploymentRequirements`, `getProject`, `resolveDeploymentRequirements`;
  `ProjectEnvVars` — `getProject`; `EnvironmentVariablesPanel` —
  `bulkUpsertProjectEnvVars`, `createProjectEnvVar`, `deleteProjectEnvVar`,
  `getProjectEnvVars`, `updateProjectEnvVar`.
- **developer creation/analyze, with detailed diagnostics to sanitize:**
  `NewProject` — `archiveProject`, `createProject`, `generatePreflightReport`,
  `getGithubAuthUrl`, `getGithubConnectionStatus`, `getGithubRepositories`,
  `getWorkspaceSummary`, `inspectGithubRepository`, `runStackDetection`;
  `PreflightPanel` — `generatePreflightReport`, `getPreflightReport`;
  `StackDetectionPanel` — `getDetectionProfile`, `runStackDetection`.
- **mixed developer/operator:** `ProjectDetails` — `generatePreflightReport`,
  `getProject`, `getProjectCurrentState`, `runStackDetection`; `ProjectPipeline`
  — `getPipelineRuns`, `getProject`, `getProjectCurrentState`;
  `ProjectSettings` — `archiveProject`, `generatePreflightReport`,
  `getDetectionProfile`, `getPreflightReport`, `getProject`,
  `getProjectBranches`, `getProjectCurrentState`, `getProjectEnvVars`,
  `runStackDetection`, `updateProject`, `updateProjectBranch`,
  `updateProjectRepository`; `Billing` — `cancelBilling`,
  `createBillingCheckout`, `createBillingPortal`, `getBillingSummary`,
  `getWorkspaceSummary`; `DatabaseTierSettings` — `getProjectDatabaseTier`,
  `updateProjectDatabaseTier`; `NotificationSettingsPanel` —
  `getNotificationSettings`, `subscribeNotifications`, `testNotification`,
  `updateNotificationSettings`.
- **deprecated developer implementation/operator evidence:**
  `ProjectPipelineLogs` — `getPipelineRun`, `getPipelineRunEvents`,
  `getPipelineRuns`, `getProject`, `getProjectCurrentState`; `ProjectRecovery` —
  `getProject`, `getProjectCurrentState`; `ResumeDeploymentButton` —
  `getRecoveryResumePreview`, `resumeProjectRecovery`; `normalReleaseAction` —
  `dispatchNormalFirstReleaseInfrastructureApply`,
  `dispatchNormalFirstReleaseInfrastructurePlan`, `dispatchNormalReleaseLane`,
  `prepareNormalReleaseLane`.
- **developer read after provider/detail sanitization:** `ProjectLogs` —
  `getObservabilityLogs`, `getProjectCurrentState`; `ProjectMetrics` —
  `getObservabilityRuntimeMetrics`, `getProjectCurrentState`;
  `EcsLogsStream` — `getObservabilityLogStreamUrl`; `ProjectModuleStatusStrip` —
  `getProjectCurrentState`.
- **operator diagnostic:** `AuditLogs` — `getAuditLogs`; `ProjectDetection` —
  `getDetectionProfile`, `getProject`, `runStackDetection`; `ProjectPreflight` —
  `generatePreflightReport`, `getPreflightReport`, `getProject`,
  `getProjectCurrentState`; `ProjectInfrastructure` — `createTerraformExport`,
  `downloadTerraformExport`, `getProject`; `ProjectDeployPanel` —
  `getDeploymentReadiness`, `getInfrastructure`, `getInfrastructureEvents`,
  `getServiceDiscovery`; `ProjectObservability` — `getObservabilityHealth`,
  `getObservabilityRuntimeMetrics`, `getObservabilitySummary`,
  `getProjectCurrentState`; `ProjectTroubleshooting` —
  `followUpTroubleshooting`, `getProjectCurrentState`,
  `getTroubleshootingSession`, `getTroubleshootingSessions`,
  `startTroubleshooting`; `ProjectSecurity` — `getProject`,
  `getProjectCurrentState`, `getSecurityScans`; `SecurityScanDetails` —
  `getProject`, `getSecurityScan`, `getSecurityScanFindings`.
- **operator cloud/state/history:** `ProjectOrchestration` —
  `getOrchestrationEvents`, `getOrchestrationStatus`, `rollbackOrchestration`,
  `updateOrchestrationScaling`; `ProjectReleases` — `getOrchestrationReleases`;
  `ProjectRollback` — `rollbackOrchestration`; `ProjectStateManagement` —
  `clearStaleTerraformLockfile`, `forceReleaseTerraformLock`, `getProject`,
  `getTerraformState`, `getTerraformStateLocks`,
  `getTerraformStateSafetySnapshot`, `getTerraformStateValidation`,
  `getTerraformStateVersions`, `recoverTerraformState`,
  `validateTerraformState`; `ProjectStorage` — `getBackups`, `getProject`,
  `getProjectStorage`, `getStorageEvents`, `getStorageMountConfig`,
  `getStorageRecommendation`, `provisionStorage`, `requestBackupRestore`,
  `updateStorageSettings`; `DestroyInfrastructurePanel` — `cancelDestroy`,
  `createCloudCleanupChallenge`, `createDestroyChallenge`,
  `downloadProjectCleanupReport`, `getDestroyReview`, `getDestroyStatus`,
  `getProjectResources`, `markCloudResourcesManualReview`,
  `refreshProjectResources`, `requestCloudCleanup`, `requestDestroy`,
  `retryDestroy`, `updateProjectResourceTtl`.
- **operator cost/admin:** `ProjectCost` — `createCostEstimate`,
  `getCostEstimates`, `getCostSettings`, `getProject`, `updateCostSettings`;
  `CostEstimateDetails` — `approveCostEstimate`, `getCostEstimate`, `getProject`,
  `getProjectCurrentState`, `rejectCostEstimate`; `AdminUsers` — `getUsers`,
  `updateUserRole`; `AdminCloudCleanup` — `cleanupSafeOrphans`,
  `cleanupSelectedCloudResources`, `createCentralCleanupChallenge`,
  `createEmergencyCleanupChallenge`, `downloadCloudCleanupReport`,
  `executeEmergencyCleanup`, `getCloudCleanupResources`,
  `getCloudCleanupSummary`, `getEmergencyCleanupOperations`,
  `getEmergencyCleanupPreview`, `markCloudResourcesManualReview`,
  `markProjectCleanupComplete`, `refreshCloudCleanupInventory`,
  `refreshProjectResources`, `requestDestroy`, `retryCentralProjectDestroy`.

### Current-state field classification

`ProjectCurrentStateService.getCurrentState()` returns 97 top-level fields to
admin, developer, and eligible readonly users. Every field is classified below.

**Inputs containing developer-safe facts only after explicit projection (15):**
`projectName`, `repositoryFullName`, `branch`, `releaseLane`, `userFacingStatus`,
`deploymentRequirements`, `time`, `progressPercentage`, `progress`,
`liveDeployment`, `existingStableDeployment`, `repository`, `database`,
`stackDetection`, `recentActivity`.

These objects are not safe wholesale. The new mapper may take only repository/
branch/commit, masked missing configuration, simple progress, latest attempt,
verified stable release/URL, estimated cost, and application error facts. It must
drop release intent references, outbox state, lifecycle codes, provider/internal
database identity, raw warnings, and unverified/historical URLs.

**Developer compatibility fields to replace with the canonical projection (26):**
`phase`, `overallStatus`, `currentStep`, `currentStepLabel`, `currentStage`,
`failedStage`, `blockedBy`, `blockedByStage`, `nextAction`, `continueAction`,
`currentRunState`, `lifecycleStatus`, `currentStageStatus`, `statusExplanation`,
`deploymentStatus`, `healthStatus`, `latestPipelineStatus`, `latestRunStatus`,
`activeRunCount`, `activeRun`, `appLiveVerified`, `latestPipeline`, `failureClass`,
`hasStackDetection`, `hasPreflight`, `hasPipelineRun`.

**Operator/admin-only evidence (56):** `projectId`, `runId`, `approvalRequired`,
`approvalEligible`, `approvalBlockedReason`, `terraformApproval`,
`currentRecoveryIssue`, `previousDeploymentIssue`, `recoveryIssue`,
`databaseServiceBinding`, `setupRequired`, `terraformStateSafety`,
`activitySnapshot`, `lastFailureAt`, `lastMeaningfulActivityAt`, `continueHref`,
`failedProjectContinuity`, `stateStatus`, `lockStatus`, `hasTerraformPlan`,
`hasRealDeployment`, `showFullLifecycle`, `automationStatus`, `approvalState`,
`runControls`, `infrastructureStatus`, `resourceStatus`, `cleanupStatus`,
`cloudVerificationStatus`, `inventoryStatus`, `adminActionRequired`,
`cloudNextAction`, `lastCloudVerifiedAt`, `cloudState`,
`deploymentReconciliation`, `currentDeployment`, `historicalHealthIssue`,
`deployButtonEnabled`, `deployDisabledReasons`, `latestPipelineRunId`,
`isDeploymentJobActive`, `activePipelineRunId`, `latestRunIsStale`,
`infrastructureProvisioned`, `safeMode`, `applyEnabled`, `modes`,
`environmentModes`, `normalV1Availability`, `deploymentContract`, `preflight`,
`modules`, `stages`, `lifecycle`, `lifecycleVersion`, `externalCi`.

### Code-bearing field classification

All currently developer-accessible code fields are internal mapper inputs, never
finished developer output:

- `releaseLane.safeCodes[]`, `intent.lifecycleCode`, `history[].code`;
- operation preflight/security/service-health/event/log `safeCode` values;
- `normalV1Availability.safeCode`;
- recovery `code`, stage `diagnosticCode`, `failureClass` and legacy failure code;
- workspace release-history `lifecycleCode`;
- retired endpoint `LEGACY_DEPLOYMENT_EXECUTION_RETIRED` codes.

Developer-owned auth/source/configuration/build/runtime/health/cost conditions may
map to a sanctioned `developerState`, `developerAction`, and concise message, but
their raw code remains hidden. All `NORMAL_*`, `FIRST_RELEASE_*`, `RELEASE_LANE_*`,
Terraform/state/cloud/residue/worker/ownership/lease/outbox/IAM/provider codes map
to `platform_attention` or an operator projection. Unsupported detection maps only
to “This repository type is not yet supported.”

## P0 — exact next implementation packages

### Completed Iteration 2 evidence — canonical sanitized developer projection

The closed `DeveloperProjectCurrentState` type, pure fail-closed projector,
ordinary sanitized current-state route, admin-only detailed route, shared
workspace projection, authorization/project-isolation checks, exhaustive mapper
fixtures, and sanitized frontend consumers are implemented and verified. The
projector preserves stable/latest separation, rejects conflicting identity and
unverified URLs, and emits no raw lifecycle, cloud, Terraform, queue, ownership,
lease, fence, journal, worker, or recovery evidence. Focused backend/frontend
tests, type-checks/builds, and `git diff --check` pass; see `FINAL_RESULT.md`.

### Iteration 3 — one automatic Deploy command and cost policy

1. Add one authenticated, idempotent developer command that composes the existing
   exact prepare/plan/apply/release dispatch boundaries without starting workers.
2. Keep the now-removed direct developer infrastructure-apply dispatch and
   Terraform confirmation absent; only authorized workspace-owner Approve Cost
   may pause server-side automatic continuation.
3. Preserve one immutable operation across refresh, duplicate click, retry,
   reconciliation and process restart; inspect durable evidence before uncertainty
   recovery.
4. Enforce below-threshold auto-approval, above-threshold workspace-owner approval,
   destructive/broad operator approval, and release-only source changes.

### Iteration 4 — existing-state adoption and reconciliation

Implement operator-only valid/adoptable/recoverable/safe-residue/ambiguous
classification. Preserve Project-Tst and truthful resources/history; project only
stable Redeploy or neutral platform attention to developers.

### Iteration 5 — Railway-like Overview and Deployments

Render only the canonical projection, simple progress/cost/logs/latest/stable/URL,
and one action. Remove Developer Details, Terraform planning/apply panels, run IDs,
provider modes, raw codes, legacy pipeline fallback, and recovery/cloud wording.

## P1 — remaining launch packages

### Iteration 6 — operator/admin segregation

Move Activity Log and all detailed cloud/infrastructure/recovery/cleanup/security/
cost/state routes behind backend admin authorization. Remove retired frontend API
exports/components after operator reachability is proven. Replace the stale
`test:automation` fixture, which still calls `PipelineService.startRun()` and
expects legacy `full_deploy` execution, with an explicit retirement guard that
requires `410 LEGACY_DEPLOYMENT_EXECUTION_RETIRED` and proves no legacy run or
queue publication is created.

### Iteration 7 — Environment, Logs, Metrics and Settings

Consolidate Environment routes, masked configuration and immutable identity;
replace pipeline-event Logs with application logs; hide metric providers; keep
settings application-focused.

### Iteration 8 — local launch acceptance

Run the complete multi-user/workspace/project, stack, configuration, concurrency,
deduplication, refresh, restart, isolation and terminology matrix on real local
PostgreSQL/Redis/backend/frontend/shared workers.

### Iteration 9 — final evidence

Require no unresolved P0/P1 launch blocker and publish only a precise GO/NO-GO
verdict in `FINAL_RESULT.md`.

## Deferred, non-blocking scope

Stripe provider billing, SNS delivery, optional provider/security integrations,
and live AWS deployment mutation are outside this local launch program. Their
gates remain disabled and their absence is not represented as passing evidence.
