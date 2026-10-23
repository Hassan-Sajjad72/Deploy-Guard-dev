# Session 2 Backfill Strategy and Milestone 1 File Plan

## 1. Backfill principles

Backfill is an explicit, idempotent application command executed after schema
deployment. It is not embedded in a TypeORM DDL migration because existing
projects require multi-table evidence resolution, resumability, and manual-review
reporting.

Backfill performs no AWS, Terraform, Redis, Docker, GitHub, or network call.
It reads PostgreSQL only and writes new contract/link rows. It does not enqueue
jobs or change current production status.

## 2. Evidence inputs

Per project/environment:

- project repository/branch/environment
- latest deployment contract and detection profile
- latest pre-flight/deployment requirements
- latest configuration snapshot per run
- project service bindings and database tier
- persistent storage
- infrastructure environment and sanitized Terraform outputs
- Terraform state metadata/version/resource count
- pipeline runs/events/checkpoints
- project deployments
- stable releases
- cloud-state/resource-registry rows as historical evidence only
- destroy operation status

Current legacy structures are verified in:

- `backend/src/infrastructure/project-infrastructure-environment.entity.ts:39-149`
- `backend/src/orchestration/project-deployment.entity.ts:29-159`
- `backend/src/orchestration/project-stable-release.entity.ts:11-64`
- `backend/src/projects/recovery/project-stage-checkpoint.entity.ts:7-25`
- `backend/src/infrastructure-lifecycle/destroy-operation.entity.ts:2-26`

## 3. Confidence classes

| Class | Meaning | Allowed imported status |
|---|---|---|
| `verified` | Matching run, state metadata, outputs, deployment, and stable release evidence | `applied` infrastructure and `stable` release |
| `partial` | Strong identity but one non-secret artifact is absent | `imported_unverified` |
| `ambiguous` | Competing latest rows, missing ownership, contradictory runs, or unknown state | `manual_review` |
| `none` | No infrastructure/release evidence | No imported manifest |

Backfill never derives an image digest from an image tag, never assumes a
persisted URL is reachable, and never marks infrastructure applied from a
Terraform-plan event alone.

## 4. Infrastructure import algorithm

For each active or archived project environment:

1. Acquire
   `pg_advisory_xact_lock(hashtext("deployguard:backfill:<project>:<env>"))`.
2. If `legacy_source_key` already exists, skip.
3. Identify latest consistent infrastructure environment and Terraform state.
4. Build sanitized `InfrastructureSpecV1` from persisted desired settings and
   outputs. Unknown fields are explicit `null`/reason codes, not invented.
5. Calculate `spec_hash`.
6. Create one `legacy_import` intent with deterministic key:
   `sha256("legacy-infrastructure-v1:<project>:<env>:<sourceIds>")`.
7. Create revision `1`, or the next revision on resumed backfill.
8. Status:
   - `applied` only when environment is provisioned, state key matches project,
     state metadata is healthy/recovered, and required outputs exist;
   - `destroyed` when destroy proof and reconciliation agree;
   - otherwise `imported_unverified` or `manual_review`.
9. Set `project_infrastructure_environments.applied_manifest_id` only for
   verified `applied`/`destroyed` imports.
10. Increment project-state revision.

## 5. Release import algorithm

1. Select each stable release and its matching deployment/run.
2. Require matching project/environment/commit/task-definition identity.
3. Resolve exact infrastructure manifest:
   - verified applied import;
   - otherwise create release as `manual_review`.
4. Resolve contract/config snapshot/checkpoint evidence.
5. Use stored image digest only when present. Missing digest stays null.
6. Create deterministic legacy import intent/source key.
7. Create release revision in deployment chronology.
8. Mark only the newest evidence-complete, health-verified release `stable`.
   Earlier valid releases become `superseded` or rollback history.
9. Any record with only a historical URL or generic healthy label becomes
   `imported_unverified`, not `stable`.
10. Link legacy deployment/stable release rows to the imported manifest.

## 6. Resumability and reports

Command contract:

```text
npm run contracts:backfill -- --dry-run
npm run contracts:backfill -- --project <uuid>
npm run contracts:backfill -- --resume-after <projectId>
npm run contracts:backfill -- --apply --batch-size 100
```

Default is dry-run. `--apply` must be explicit.

Each run prints counts only:

- projects scanned
- verified infrastructure imports
- unverified/manual-review infrastructure imports
- verified stable release imports
- unverified/manual-review release imports
- skipped idempotent imports
- errors

Detailed sanitized report is persisted in `contract_backfill_runs` and
`contract_backfill_items`. No secret/configuration values are logged.

Backfill tables are planned for the backfill milestone, not milestone 1:

- `contract_backfill_runs`
- `contract_backfill_items`

## 7. Backfill safety gates

- Refuse when schema version is not exactly supported.
- Refuse `--apply` when any new v1 worker publication flag is enabled.
- Use batches and independent transactions per project/environment.
- Never update legacy status fields.
- Never tighten nullable legacy foreign keys during initial backfill.
- Produce a manual-review CSV/JSON report without secrets.
- A second identical run must create zero new manifests/intents.

## 8. Exact milestone 1 migrations

Current highest migration is
`1760000033000-CanonicalProjectConfiguration.ts`. Session 3 milestone 1 should
add exactly these additive migrations, after confirming no timestamp collision:

### 8.1 `1760000034000-CreateTwoLaneManifestsAndStateRevisions.ts`

Creates:

- `infrastructure_manifests`
- `release_manifests`
- `project_state_revisions`

Creates all columns, `CHECK` constraints, unique/index definitions, self/project/
user/configuration/contract FKs that do not depend on deployment intents.
`created_by_intent_id` is initially nullable and unbound.

Down migration may drop these tables only if empty and no legacy link column
references them. It must not cascade or delete data.

### 8.2 `1760000035000-CreateDeploymentIntentsOutboxAndOperationLeases.ts`

Creates:

- `deployment_intents`
- `orchestration_outbox`
- `project_operation_leases`

Adds intent/manifest foreign keys after both sides exist.
Adds partial active-lease indexes and idempotency uniqueness.
Adds project deletion-fence columns:

- `projects.deletion_fence_token`
- `projects.deletion_intent_id`
- `projects.deletion_started_at`

Down migration refuses to remove non-empty intent/outbox/lease tables or a live
deletion fence.

### 8.3 `1760000036000-LinkLegacyExecutionToTwoLaneContracts.ts`

Adds nullable columns and FKs:

`project_pipeline_runs`:

- `deployment_intent_id`
- `execution_lane`
- `infrastructure_manifest_id`
- `release_manifest_id`
- `worker_protocol_version`
- `operation_fencing_token`

`project_deployments`:

- `release_manifest_id`

`project_stable_releases`:

- `release_manifest_id`

`project_infrastructure_environments`:

- `desired_manifest_id`
- `applied_manifest_id`

`infrastructure_destroy_operations`:

- `deployment_intent_id`
- `infrastructure_manifest_id`
- `operation_fencing_token`

All columns remain nullable until a separately authorized backfill and
verification milestone. No existing rows are updated by this migration.

### 8.4 `1760000037000-CreateWorkerCapabilityRegistry.ts`

Creates:

- `worker_capabilities`

Adds expiry and role/protocol indexes. No worker is registered by the migration.
No queue behavior changes.

### 8.5 SQL style

- Use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, named `CHECK`
  constraints guarded with `DO` blocks, and `CREATE INDEX IF NOT EXISTS`.
- Use `varchar + CHECK`, not PostgreSQL enum types.
- Use `timestamptz` and database `now()`.
- Never use `synchronize=true`.
- Never include application backfill in `up()`.
- Down migrations are conservative and data-preserving.

## 9. Exact milestone 1 production files

### New contract files

```text
backend/src/orchestration-contracts/orchestration-contracts.module.ts
backend/src/orchestration-contracts/contracts/version.ts
backend/src/orchestration-contracts/contracts/canonical-json.ts
backend/src/orchestration-contracts/contracts/infrastructure-manifest.types.ts
backend/src/orchestration-contracts/contracts/release-manifest.types.ts
backend/src/orchestration-contracts/contracts/deployment-intent.types.ts
backend/src/orchestration-contracts/contracts/canonical-project-state.types.ts
backend/src/orchestration-contracts/contracts/worker-envelope.types.ts
backend/src/orchestration-contracts/contracts/worker-envelope.validator.ts
backend/src/orchestration-contracts/entities/infrastructure-manifest.entity.ts
backend/src/orchestration-contracts/entities/release-manifest.entity.ts
backend/src/orchestration-contracts/entities/deployment-intent.entity.ts
backend/src/orchestration-contracts/entities/orchestration-outbox.entity.ts
backend/src/orchestration-contracts/entities/project-operation-lease.entity.ts
backend/src/orchestration-contracts/entities/project-state-revision.entity.ts
backend/src/orchestration-contracts/entities/worker-capability.entity.ts
```

The module exports repositories/types only. It has no controller, planner,
dispatcher, worker, release controller, or infrastructure executor.

### New migrations

```text
backend/src/migrations/1760000034000-CreateTwoLaneManifestsAndStateRevisions.ts
backend/src/migrations/1760000035000-CreateDeploymentIntentsOutboxAndOperationLeases.ts
backend/src/migrations/1760000036000-LinkLegacyExecutionToTwoLaneContracts.ts
backend/src/migrations/1760000037000-CreateWorkerCapabilityRegistry.ts
```

### Existing production files modified only for registration/nullable links

```text
backend/src/app.module.ts
backend/src/data-source.ts
backend/src/projects/project-pipeline-run.entity.ts
backend/src/orchestration/project-deployment.entity.ts
backend/src/orchestration/project-stable-release.entity.ts
backend/src/infrastructure/project-infrastructure-environment.entity.ts
backend/src/infrastructure-lifecycle/destroy-operation.entity.ts
```

`AppModule` and `data-source.ts` currently enumerate entities explicitly
(`backend/src/app.module.ts:158-224`,
`backend/src/data-source.ts:127-193`), so both must register the new entities.

### New verification files

```text
backend/scripts/verify-two-lane-contract-shapes.ts
backend/scripts/verify-two-lane-migration-safety.ts
backend/scripts/verify-worker-envelope-v1.ts
backend/scripts/verify-manifest-secret-safety.ts
```

`backend/package.json` adds scripts for those local/static checks.

### Explicitly untouched in milestone 1

```text
backend/src/projects/projects.controller.ts
backend/src/projects/pipeline/pipeline.service.ts
backend/src/projects/pipeline/pipeline-worker.service.ts
backend/src/projects/pipeline/pipeline.queue.ts
backend/src/infrastructure/infrastructure.service.ts
backend/src/orchestration/orchestration.service.ts
backend/src/orchestration/ecs.service.ts
backend/src/orchestration/rollback.service.ts
backend/src/infrastructure-lifecycle/infrastructure-lifecycle-worker.service.ts
frontend/**
backend/terraform/**
```

This prevents milestone 1 from implementing or activating the release
controller.

## 10. Milestone 1 acceptance criteria

1. Four additive migrations apply to an empty database and a representative
   legacy schema.
2. Migrations rerun safely where the repository's migration-safety convention
   permits.
3. Existing rows remain byte-for-byte semantically unchanged.
4. New tables are empty after migration.
5. No queue message is published.
6. No new worker starts.
7. No current-state/API/frontend response changes.
8. Contract hash fixtures are deterministic across object key order.
9. Envelope validator rejects unsupported version, mismatched hash, unknown
   message type, expired message, and any secret-like payload field.
10. Entity metadata matches migration columns, indexes, and foreign keys.
11. Backend build and all existing tests pass.
12. No Terraform, AWS, Docker, GitHub, database backfill, or destructive command
   is run as part of verification.

## 11. Later milestones

- **Session 3 / implementation milestone 1:** schema and pure contracts only.
- **Implementation milestone 2:** dry-run backfill tooling and read-only dual
  projection.
- **Implementation milestone 3:** transactional planner plus outbox, shadow mode
  only.
- **Implementation milestone 4:** release controller and release worker.
- **Implementation milestone 5:** infrastructure-lane routing and recovery.
- **Implementation milestone 6:** canonical UI switch and durable deletion saga.

