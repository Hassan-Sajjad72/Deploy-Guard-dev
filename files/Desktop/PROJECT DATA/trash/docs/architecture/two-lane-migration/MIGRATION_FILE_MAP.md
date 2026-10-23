# DeployGuard Two-Lane Migration File Map

## Classification

- **KEEP**: already suitable with limited compatibility work.
- **WRAP**: preserve implementation behind a new lane/controller contract.
- **MODIFY**: extend in place.
- **REFACTOR**: split ownership or remove coupling.
- **RETIRE**: stop new production use after migration; retain temporarily.
- **REMOVE**: deletion candidate after compatibility window.
- **UNKNOWN**: requires Session 2 proof before a decision.

No file in this map was changed in Session 1.

## Backend production map

| File / area | Decision | Future lane/owner | Milestone | Regression risk | Reason |
|---|---|---|---|---|---|
| `projects/pipeline/pipeline.service.ts` | REFACTOR | Planner + release request | M2 | Critical | Hard-codes `full_deploy` and `runTerraform:true` |
| `projects/pipeline/pipeline-worker.service.ts` | REFACTOR | Separate release/infra workers or explicit branches | M3–M4 | Critical | Combined sequence owns build, Terraform, and ECS |
| `projects/pipeline/pipeline.types.ts` | MODIFY | Versioned job contracts | M1 | High | Needs lane, schemaVersion, manifest IDs, idempotency key |
| `projects/pipeline/pipeline.queue.ts` | WRAP | Queue compatibility gateway | M1 | High | Current defaults are useful; job identity is inconsistent |
| `projects/projects.controller.ts` | REFACTOR | Thin intent API | M2 | High | Multiple start/retry/resume routes create overlapping intent |
| `projects/current-state/project-current-state.service.ts` | MODIFY | Canonical projector | M5 | Critical | Keep aggregation, replace heuristic ownership |
| `projects/current-state/*resolver*` | MODIFY | Canonical projector | M5 | High | Preserve pure decision helpers and strengthen precedence |
| `projects/recovery/recovery-issue.service.ts` | MODIFY | Run-scoped recovery planner | M5 | High | Must separate current-run and historical evidence |
| `projects/recovery/stage-selective-resume.service.ts` | WRAP | Planner/recovery lane | M4 | High | Real checkpoints useful; fallback currently returns to full Terraform deploy |
| `projects/recovery/deployment-checkpoint.service.ts` | KEEP/MODIFY | Release artifact cache | M3 | Medium | Fingerprint validation is reusable |
| `projects/recovery/project-stage-checkpoint.entity.ts` | KEEP/MODIFY | Release/infra checkpoint store | M1 | Medium | Add manifest/release linkage if needed |
| `projects/project-deployment-contract.entity.ts` | KEEP/MODIFY | Source deployability input | M1 | High | Useful but mutable one-row-per-project, not a release manifest |
| `projects/project-configuration-snapshot.entity.ts` | KEEP | Immutable run config | M1 | Medium | Strong basis for release manifest |
| `projects/project-deployment-requirements.entity.ts` | MODIFY | Planner inputs | M2 | Medium | Clarify ownership and revision relationship |
| `projects/project-detection-profile.entity.ts` | KEEP | Scanner output | M1 | Low | Source facts remain valid input |
| `projects/project-preflight-report.entity.ts` | KEEP/MODIFY | Pre-mutation gate | M2 | Medium | Bind to contract/source revision |
| `projects/project-pipeline-run.entity.ts` | MODIFY | Execution record | M1 | High | Add lane/manifest/idempotency/lease compatibility fields |
| `projects/project-pipeline-event.entity.ts` | KEEP/MODIFY | Unified event stream | M1 | Medium | Add lane/release/manifest/schema context |
| `projects/project-environment-variable.entity.ts` | KEEP | Configuration registry | M1 | High | Secret handling and scope are reusable |
| `projects/configuration-ownership.ts` | KEEP | Configuration authority | M1 | Low | Existing canonical ownership rules are reusable |
| `projects/project-service-binding.entity.ts` | KEEP/MODIFY | Infra→release binding | M3 | High | Must bind an applied infrastructure revision |
| `projects/project-database-tier.entity.ts` | KEEP/MODIFY | Infrastructure manifest input | M2 | High | Database is infrastructure, not release status |
| `projects/templates/*` | KEEP/MODIFY | Release build input | M2 | Medium | Generated Docker strategy is reusable |
| `projects/detection/*` | KEEP | Planner precondition | M2 | Medium | Strong scanner; continue fail-before-AWS behavior |
| `projects/pipeline/docker-build.service.ts` | KEEP | Release worker | M3 | Medium | Already accepts isolated context |
| `projects/pipeline/ecr.service.ts` | KEEP/MODIFY | Release worker | M3 | Medium | Add immutable digest ownership/idempotency |
| `projects/pipeline/security*` | KEEP | Release policy stage | M3 | Low | Preserve honest skipped/advisory semantics |
| `projects/pipeline/terraform.service.ts` | RETIRE then REMOVE | None | M4/M6 | Medium | Placeholder competes with real Terraform runner |
| `infrastructure/infrastructure.service.ts` | REFACTOR | Infrastructure controller | M2–M4 | Critical | Run creation, plan/apply, state, DB, and release coupling |
| `infrastructure/infrastructure.controller.ts` | WRAP/MODIFY | Infrastructure API | M2 | High | Preserve explicit plan/apply; route deploy through planner |
| `infrastructure/terraform-runner.service.ts` | KEEP | Infrastructure executor | M3 | Critical | Central safe Terraform subprocess adapter |
| `infrastructure/infrastructure.config.ts` | KEEP/MODIFY | Infrastructure config | M1 | Medium | Add explicit workspace/lane configuration |
| `infrastructure/project-infrastructure-environment.entity.ts` | MODIFY | Applied infrastructure projection | M1 | High | Link desired/planned/applied manifest revisions |
| `infrastructure/project-deployment-readiness-snapshot.entity.ts` | MODIFY | Planner precondition | M2 | Medium | Clarify snapshot authority/expiry |
| `infrastructure/database-service-binding.service.ts` | KEEP/MODIFY | Infrastructure reconciliation + release binding | M3 | High | Important pre-mutation and ECS secret safety |
| `infrastructure/project-service-discovery-record.entity.ts` | KEEP | Applied infra output | M3 | Low | Reusable binding evidence |
| `terraform/modules/**` | KEEP/MODIFY | Infrastructure lane | M3 | Critical | No redesign until manifest diff contract exists |
| `state-management/state-lock.service.ts` | KEEP/MODIFY | Shared mutation lock manager | M1 | Critical | Conditional lock and queue useful; formalize ordering/lease |
| `state-management/state-heartbeat.service.ts` | KEEP | Lock manager | M1 | High | Reusable worker lease signal |
| `state-management/terraform-state.service.ts` | KEEP | Infrastructure/state recovery | M3 | Critical | Project-scoped S3 state and native lockfile |
| `state-management/state-management.service.ts` | MODIFY | State-safety owner | M5 | High | Ensure projector invalidation and precedence |
| `state-management/current-state-invalidation.service.ts` | MODIFY | Projection cache invalidator | M5 | Medium | Expand to all authoritative transitions |
| `orchestration/ecs.service.ts` | KEEP/MODIFY | Release controller | M3 | Critical | Existing register/update/stability primitives |
| `orchestration/orchestration.service.ts` | REFACTOR | Release controller | M3 | Critical | Ordinary path reads task ARN from Terraform outputs |
| `orchestration/rollback.service.ts` | KEEP/MODIFY | Release controller | M3 | High | Existing direct ECS rollback is key reusable code |
| `orchestration/project-deployment.entity.ts` | MODIFY | Release projection | M1 | High | Link immutable release manifest/candidate |
| `orchestration/project-stable-release.entity.ts` | MODIFY | Stable pointer/history | M1 | High | Add supersession and promotion identity |
| `orchestration/project-orchestration-event.entity.ts` | KEEP/MODIFY | Release event stream | M5 | Medium | Decide whether to project into unified events |
| `infrastructure-lifecycle/infrastructure-lifecycle.service.ts` | KEEP/MODIFY | Deletion saga | M6 | Critical | Strong guardrails; integrate archive finalization |
| `infrastructure-lifecycle/infrastructure-lifecycle-worker.service.ts` | KEEP | Destructive infra lane | M6 | Critical | Project-state-scoped destroy and residue verification |
| `infrastructure-lifecycle/project-cloud-inventory.service.ts` | KEEP/MODIFY | Reconciler | M5 | High | Observation timestamp/proof needs canonical contract |
| `infrastructure-lifecycle/cloud-state-reconciliation.service.ts` | KEEP/MODIFY | Reconciler | M5 | High | Must not conflate resource existence and app health |
| `resource-registry/*` | KEEP/MODIFY | Resource ownership registry | M5–M6 | High | Central deletion/reconciliation evidence |
| `audit-log/*` | KEEP | Cross-lane audit | M1 | Medium | Add manifest/release/idempotency metadata |
| `observability/*` | KEEP/MODIFY | Release health projection | M5 | Medium | Tie metrics/logs to candidate release |
| `finops/*` | KEEP | Infrastructure policy | M2 | Low | Preserve disabled/mock truth |
| `storage/*` | KEEP/MODIFY | Infrastructure manifest | M2–M3 | High | Storage changes classify as infrastructure |
| `app.module.ts`, module wiring | MODIFY | Compatibility rollout | Every milestone | Critical | Dual worker registration and feature flags |
| migrations | UNKNOWN/new additive migrations likely | Persistence | M1 | Critical | No migration created in Session 1 |

## Frontend production map

| File / area | Decision | Owner/view | Milestone | Risk | Reason |
|---|---|---|---|---|---|
| `frontend/src/api/projectApi.js` | MODIFY | Intent/current-state client | M2/M5 | High | Exposes overlapping start/deploy/orchestration calls |
| `frontend/src/api/platformApi.js` | KEEP/MODIFY | Destruction/resources | M6 | High | Strong lifecycle endpoints; consolidate duplicates |
| `frontend/src/pages/ProjectDetails.jsx` | MODIFY | Canonical project projection | M5 | High | Render lane/action from server only |
| `frontend/src/pages/ProjectPipeline.jsx` | MODIFY | Execution detail | M5 | High | Remove client-derived canonical progress |
| `frontend/src/pages/ProjectPipelineLogs.jsx` | KEEP/MODIFY | Event history | M5 | Medium | Keep run-scoped historical context |
| `frontend/src/components/projects/ResumeDeploymentButton.jsx` | MODIFY | Recovery intent | M4 | Medium | Do not fallback directly to full automation in UI |
| `frontend/src/components/infrastructure/ProjectDeployPanel.jsx` | RETIRE/REPLACE | Planner action | M2 | High | Direct full deploy duplicates automation |
| `frontend/src/pages/ProjectOrchestration.jsx` | MODIFY | Release status | M3/M5 | Medium | Direct deploy action should become release action |
| `frontend/src/pages/ProjectInfrastructure.jsx` | MODIFY | Infrastructure status | M5 | Medium | Render applied manifest/reconciliation |
| `frontend/src/pages/ProjectState.jsx` | KEEP/MODIFY | State-safety status | M5 | Medium | Use same snapshot embedded in current state |
| `frontend/src/pages/ProjectRollback.jsx` | KEEP/MODIFY | Release rollback | M3 | Medium | Existing operation remains useful |
| `frontend/src/components/projects/DestroyInfrastructurePanel.jsx` | KEEP | Deletion saga | M6 | High | Existing safety UX is appropriate |
| Dashboard/workspace pages | MODIFY | Canonical summaries | M5 | Medium | Stop client-side status classification |
| Observability/security/cost/storage pages | KEEP/MODIFY | Module detail | M5 | Low–Medium | Tie status to manifest/release IDs |

## Proposed milestone order

1. **M1 – Additive persistence and versioned contracts.** Add manifests,
   idempotency, lane, queue schema version, lease metadata, and compatibility
   fields. No path switch.
2. **M2 – Transactional planner.** Classify `NO_OP`, `RELEASE_ONLY`,
   `INFRASTRUCTURE_CHANGE`, and unsafe/unknown; make all start routes delegate.
3. **M3 – Release controller.** Wire image digest → task definition → ECS update →
   stability → ALB health → promote/rollback without Terraform.
4. **M4 – Infrastructure lane and recovery.** Terraform only for manifest diffs;
   route selective recovery to the correct lane.
5. **M5 – Canonical state projection/reconciliation.** One server projection for
   status, progress, time, action, state safety, and health.
6. **M6 – Durable deletion and retirement.** Cloud cleanup before archive; remove
   placeholder and duplicate entry paths after compatibility proof.

## Compatibility and retirement gates

- New jobs must carry a schema version, and workers must advertise supported
  versions before new payloads are enqueued.
- Old `full_deploy` jobs must drain or be explicitly translated; never let a new
  worker reinterpret an old payload.
- Keep current tables readable throughout backfill.
- Feature-flag planner decisions per project/environment.
- Do not retire combined worker branches until release-only and infrastructure
  parity tests cover rollback, approval, crash recovery, deletion, and stale jobs.
- Remove `projects/pipeline/terraform.service.ts` only after no production import
  or historical replay requires it.

