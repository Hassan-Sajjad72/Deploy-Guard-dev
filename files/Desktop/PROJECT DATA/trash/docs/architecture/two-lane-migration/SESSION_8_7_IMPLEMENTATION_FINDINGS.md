# Session 8.7 — Legacy Shadow Insertion Findings

## Status

Session 8.7 adds default-off, best-effort shadow observation to the legacy
run-creation and resume-enqueue boundaries only. It does not acquire,
renew, release, correlate, or enforce cross-lane ownership. It does not alter
worker, rollback, cancellation, queue, Terraform, ECS, AWS, frontend, or v1
behavior.

Cross-lane mutual exclusion remains inactive.

## Adapter contract

`InactiveLegacyShadowInsertionAdapter` is the single legacy insertion surface.
Every public method accepts only:

- `projectId`;
- a deterministic legacy logical operation identifier; and
- an internally fixed operation class and insertion source.

The adapter fixes the environment to `dev` and proposed lane to `legacy`. It
domain-separates the logical identity before passing it to the existing
Session 8.5 observer. The observer stores only its canonical hash; no raw run
payload, user/actor identity, repository data, variable value, credential,
cloud identifier, queue payload, or error is passed to it.

Calls are detached with both synchronous and asynchronous failure containment.
An observer timeout, exception, idempotency conflict, or database failure
cannot change a legacy return value, queue operation, exception, or
transaction.

`TWO_LANE_OWNERSHIP_SHADOW_MODE` remains exact-value default-off. With any
value other than `true`, the existing observer returns before a database read
or write.

## Exact legacy insertion points

| Boundary | Source | Operation class | Logical identity |
| --- | --- | --- | --- |
| New full deployment run | `PipelineService.startRun()` | `legacy_full_deployment_run` | new pipeline run ID |
| Retry-created run | retry controller → `startAutomation()` → `startRun()` | `legacy_retry` | newly created retry run ID |
| Full recovery resume | `StageSelectiveResumeService.execute()` mode `full` → `startRun()` | `legacy_full_recovery_resume` | newly created full-recovery run ID |
| Stage-selective resume | `StageSelectiveResumeService.createSelectiveRun()` | `legacy_stage_selective_resume` | recovery run ID |
| Cost approval resume | `FinopsService.resumePipelineAfterCostApproval()` | `legacy_cost_approval_resume` | pipeline run ID |
| Terraform apply approval resume | `PipelineService.approveTerraformApply()` | `legacy_apply_approval_resume` | pipeline run ID |
| State-lock resume enqueue | `InfrastructureService.releaseStateLock()` | `legacy_state_lock_resume` | queued run ID |
| Direct infrastructure deploy | `InfrastructureService.deploy()` | `legacy_infrastructure_deploy` | infrastructure run ID |
| Direct plan enqueue | `InfrastructureService.queuePlan()` | `legacy_infrastructure_plan` | infrastructure run ID |
| Direct apply enqueue | `InfrastructureService.queueApply()` | `legacy_infrastructure_apply` | infrastructure run ID |
| Storage provisioning enqueue | `StorageService.provision()` | `legacy_storage_provision` | storage run ID |

All calls occur after the durable legacy run exists and immediately before the
existing queue enqueue. No queue options, job names, job IDs, data, attempts,
return values, or error paths were changed.

## Shared-path deduplication

Retry uses the existing `startAutomation()` wrapper. An internal bounded
origin is passed to `PipelineService.startRun()` so that it emits only
`legacy_retry`, rather than a second generic start observation. Full recovery
uses the same mechanism and emits only `legacy_full_recovery_resume`.

Stage-selective recovery emits only when its rerun stages can reach a legacy
mutation. Pure repository/detection/pre-flight and cleanup-only recovery do
not emit a release-mutation observation. Direct infrastructure and storage
paths bypass `PipelineService`, so each observes at its own run-creation
chokepoint and is explicitly classified as infrastructure, never
release-only.

## Verification evidence

Passed:

| Command | Result |
| --- | --- |
| `npx tsc --noEmit --incremental false` | passed |
| `npm run build` | passed |
| `npm run test:inactive-legacy-shadow-insertion` | passed; all mappings, sanitization, detached failure isolation, cleanup exclusion, and static insertion checks |
| `npm run test:automation` | passed |
| `npm run test:stage-selective-resume` | passed |
| `npm run test:two-lane-contracts` | passed |
| `npm run test:manifest-secret-safety` | passed |
| `npm run test:transactional-planner` | passed |
| `npm run test:outbox-dispatcher` | passed |
| `npm run test:inactive-v1-consumer` | passed |
| `npm run test:inactive-v1-ownership` | passed |
| `npm run test:inactive-v1-shadow-insertion` | passed |
| `npm run test:inactive-release-lane-ownership` | passed |
| `npm run test:inactive-release-lane-correlation` | passed |
| `npm run test:inactive-release-lane-shadow-observer` | passed |
| `npm run test:inactive-v1-release-lane-composition` | passed |
| `npm run test:two-lane-migrations` | passed |
| `git diff --check` | passed |

The requested isolated PostgreSQL checks were attempted using their existing
temporary-schema cleanup scripts. The sandbox denied local port `5433`; the
required escalation then failed with an external approval-service HTTP 503.
They were therefore not run, and no normal application database was touched.

## Remaining risks

- This is observation only, not active mutual exclusion. Both lanes must
  enforce the frozen Session 8.3 guard protocol before that claim is valid.
- Legacy worker pickup, manual rollback, automatic rollback, cancellation
  finalization, and crash cleanup are intentionally outside Session 8.7.
- Detached observations are best effort and cannot serve as execution proof.
- The isolated PostgreSQL observation/correlation regression suite remains to
  be re-run when local test-database permission is available.

## Exact Session 8.8 task

Implement **legacy shadow observation at the remaining rollback and
worker-side mutation boundaries only**, still default-off and non-blocking.
First freeze and test duplicate suppression between the Session 8.7 enqueue
observations and worker pickup. Do not enforce ownership, alter cancellation,
or activate either lane.
