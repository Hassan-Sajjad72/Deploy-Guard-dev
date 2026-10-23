# DeployGuard Two-Lane Migration — Session 1 Findings

## A. Executive verdict

**Verdict: migration is feasible, but the current system is not a two-lane
orchestrator.** It is a capable combined deployment pipeline with strong
pre-mutation checks, project-scoped Terraform state, selective checkpoints, and
several reusable direct-ECS primitives. The safest migration is additive:
introduce immutable infrastructure/release manifests and one transactional
planner, wire a release controller, then make Terraform conditional on an
infrastructure diff.

## B. Exact reason Terraform runs on ordinary releases

`PipelineService.startRun()` hard-codes:

```ts
{ buildImage: true, pushToEcr: true, runTerraform: true }
```

and enqueues `jobType: "full_deploy"`
(`backend/src/projects/pipeline/pipeline.service.ts:131-150`, `:192-204`).
The worker explicitly calls infrastructure plan for `full_deploy`, then apply,
then ECS (`backend/src/projects/pipeline/pipeline-worker.service.ts:351-374`).
This is intentional current control flow, not an incidental Terraform module
bug.

## C. Current entry-point counts

- 3 overlapping normal deploy intentions:
  project automation, direct infrastructure deploy, orchestration deploy
  (the latter delegates to infrastructure deploy).
- 2 additional generic pipeline intentions: start and retry.
- 1 selective recovery intention with full-deploy fallback.
- 1 apply-approval resume path.
- 2 explicit infrastructure intentions: plan and apply.
- 1 rollback path.
- 2 project destroy route families plus central admin cleanup routes.
- 0 repository push/webhook deployment entry points found.

## D. Terraform call locations

One real Terraform adapter exposes eight operation groups: init, validate, plan,
show, apply/output, state pull, state list, and destroy
(`backend/src/infrastructure/terraform-runner.service.ts:22-117`).
Production execution enters it from three owning areas:

1. Infrastructure plan/apply/state validation
   (`backend/src/infrastructure/infrastructure.service.ts:300`, `:488`, `:1278`).
2. Lifecycle destroy
   (`backend/src/infrastructure-lifecycle/infrastructure-lifecycle-worker.service.ts:63-70`).
3. The worker indirectly through InfrastructureService
   (`backend/src/projects/pipeline/pipeline-worker.service.ts:1747-1830`).

The separate pipeline `TerraformService` is a placeholder, not a second real
runner (`backend/src/projects/pipeline/terraform.service.ts:43-80`).

## E. ECS release-only feasibility

**Partial but strong.** Existing code can register a task definition, update an
ECS service, wait for stability, verify health, record deployment/stable release,
and rollback (`backend/src/orchestration/ecs.service.ts:83-224`,
`backend/src/orchestration/rollback.service.ts:78-217`). The normal path,
however, reads a Terraform-created task-definition ARN
(`backend/src/orchestration/orchestration.service.ts:165-181`); direct task
registration has no ordinary-release caller, and direct service update is used
only by rollback.

Missing: immutable release manifest, candidate promotion/supersession, unique
release intent, direct task-definition wiring, and crash-safe release leases.

## F. Source-of-truth verdict

The deployment contract and configuration snapshot are valuable, but deployment
truth remains distributed. The top conflicts are:

1. deployment intent
2. Terraform necessity
3. release identity
4. infrastructure identity
5. current-run activity
6. ordered stage progress
7. app liveness
8. infrastructure readiness
9. Terraform state safety
10. current versus historical recovery issue

The full inventory and precedence rules are in
`SOURCE_OF_TRUTH_CONFLICTS.md`.

## G. Concurrency and idempotency verdict

Apply safety is stronger than request safety. Exact plan/config/task-definition
fingerprints and PostgreSQL advisory locks protect the final apply claim, while
state locks and S3 native lockfiles protect Terraform operations. However:

- automation active-run check and run creation are not atomic;
- direct infrastructure plan/apply/deploy has no equivalent active-run gate;
- normal BullMQ jobs lack deterministic IDs;
- worker concurrency `1` is global serialization, not per-project correctness;
- Terraform modules are copied to a project-shared path;
- no worker job-schema compatibility gate was found.

## H. Workspace verdict

Repository workspaces are run isolated and cleaned. Terraform plan/apply
workspaces are project/run isolated and retained for exact-plan reuse. State
reads use cleaned temp directories. The main gap is the project-shared copied
Terraform modules directory and reliance on a retained workspace path for later
destroy.

## I. Status/progress/time verdict

`ProjectCurrentStateService` is the intended broad source, but pages still read
module APIs and calculate fallbacks independently. Pipeline progress, state
safety, infrastructure readiness, orchestration health, and cleanup inventory
can therefore disagree. Future frontend pages should render a server-owned
projection; detailed module pages may add evidence but must not redefine the
primary state.

## J. Recovery verdict

Stage-selective recovery is genuine and checkpoint-aware. Runtime-only,
database, health, source, and cleanup cases can choose different paths, and
unsafe reuse falls back. The remaining problem is architectural classification:
fallback calls the Terraform-coupled full pipeline and some recovery maps cross
release/infrastructure ownership.

## K. Deletion verdict

Terraform destroy is the most mature mutation workflow: recent authentication,
short-lived challenge, exact phrase, active-run/destroy checks, state-version
backup, project state key validation, persisted lock/heartbeat, protected target
filter, shared bucket rejection, deterministic operation job ID, and post-destroy
inventory verification. Project archive remains separate, so one durable
delete-project saga is still required.

## L. Persistence assessment

Additive persistence is probable and justified:

- `infrastructure_manifests`
- `release_manifests`
- deployment intent/idempotency records or unique columns
- lane/schema-version/manifest/lease fields on pipeline runs/jobs
- release candidate/stable supersession links
- applied infrastructure revision link
- backfill/audit metadata

No destructive rewrite is needed. Existing contracts, snapshots, runs, events,
checkpoints, infrastructure environments, deployments, stable releases, state
metadata, and resource registry should be retained and linked.

## M. Recommended milestone sequence

1. Add versioned manifest/idempotency/worker-compatibility persistence.
2. Add a transactionally locked planner and route every start entry through it.
3. Implement the release-only controller using existing ECS primitives.
4. Restrict Terraform to infrastructure-manifest diffs and route recovery.
5. Make current state/reconciliation the sole lifecycle projection.
6. Join cloud cleanup and project archival; drain and retire duplicate paths.

## N. Primary blockers before Session 2

- No immutable desired/applied infrastructure revision.
- No immutable release manifest binding commit, image digest, config, and task ARN.
- Start routes are not unified behind an idempotent transaction.
- No queue payload schema/worker compatibility gate.
- Direct task-definition registration/update is not wired for ordinary releases.
- Lock ordering across planner/release/infrastructure/recovery/destroy is not formal.
- Current-state consumers still infer status independently.

## O. Verification record

Every executed check was local and fixture/static-analysis based. No script that
initializes PostgreSQL, Redis/BullMQ, Docker, Terraform, AWS, GitHub, or another
external service was run.

| Command | Duration | Exit | Fixture type | External contact |
|---|---:|---:|---|---|
| backend `npm run build` | 12.92s | 0 | TypeScript compile | None |
| backend `npm run test:detection` | 2.49s | 0 | Temporary local repository fixtures | None |
| backend `npm run test:pre-mutation-contract` | 2.41s | 0 | Mocks/static contract checks | None |
| backend `npm run test:configuration-ownership` | 1.56s | 0 | Static/local ownership checks | None |
| backend `npm run test:service-binding` | 3.41s | 0 | Mocks/static binding checks | None |
| backend `npm run test:task-definition-rendering` | 2.46s | 0 | Static renderer checks | None |
| backend `npm run test:automation` | 6.56s | 0 | Mocked automation controls | None |
| backend `npm run test:current-state-consistency` | 2.64s | 0 | Pure/local state cases | None |
| backend `npm run test:auth` | 2.49s | 0 | Mocked/static auth checks | None |
| frontend `npm run build` | 2.25s | 0 | Vite production compile | None |
| frontend `npm run test:current-state-ui` | 0.39s | 0 | Static UI verification | None |
| frontend `npm run test:recovery-ui` | 0.41s | 0 | Static UI verification | None |
| frontend `npm run test:time-recency-ui` | 0.43s | 0 | Static UI verification | None |

## P. Repository integrity baseline

- Branch: `master`
- HEAD: `a59bb18d3bbbf5c251df999afceea29c5dde882e`
- Pre-existing tracked modifications: 173 files
- Pre-existing tracked diff: 8,426 insertions, 2,121 deletions
- Baseline `git diff --check`: passed
- Status hash:
  `4b4d411299b865cec75378cd4b30dd0c419a7364f332a90b61110689e9331b95`
- Diff-stat hash:
  `0a12709109887f11975d9e4068c77b4914878b7edad9b7b61ac357602e0924f8`
- Tracked binary-diff hash:
  `063db6895f552281aa3ed938b558ccc94fa9178900cf0d8fbb330214bb0f8df4`
- Pre-existing untracked-path hash:
  `cb0e12f35268cb095d893abc30b1cb45dc47ba86193e0f48c489f359bd879aed`

Final hashes are recorded after the four authorized documents are complete.

Final integrity comparison:

- Branch and HEAD remained identical.
- Tracked diff-stat hash remained
  `0a12709109887f11975d9e4068c77b4914878b7edad9b7b61ac357602e0924f8`.
- Tracked binary-diff hash remained
  `063db6895f552281aa3ed938b558ccc94fa9178900cf0d8fbb330214bb0f8df4`.
- Untracked-path hash excluding the four authorized documents remained
  `cb0e12f35268cb095d893abc30b1cb45dc47ba86193e0f48c489f359bd879aed`.
- Raw final status hash is
  `a20e2ee3f0cbde7b823c8ace2b265a9ef5ec4bc77813b7fc107436126fdbce35`;
  its only authorized delta from the baseline is the new documentation path.
- Raw final untracked-path hash is
  `c0d38b932dd0daf2f49903d77c441e7f0b1312774ae77a36bb217c01596e148f`;
  filtering the four authorized files reproduces the baseline untracked hash.
- Final `git diff --check` passed; the four new Markdown files also contain no
  trailing whitespace.

## Q. Documents created

Only:

- `CURRENT_ORCHESTRATION_MAP.md`
- `SOURCE_OF_TRUTH_CONFLICTS.md`
- `MIGRATION_FILE_MAP.md`
- `SESSION_1_FINDINGS.md`

## R. Session 2 proposed scope

Session 2 should design, but not yet switch production traffic to:

- exact manifest schemas and additive migrations;
- intent classifier inputs/outputs;
- transactional idempotency and lock order;
- versioned BullMQ envelopes and worker compatibility;
- backfill/dual-read strategy;
- release-controller interfaces and failure semantics;
- rollout flags, observability, rollback, and acceptance tests.

Session 2 must be separately authorized.

## S. External/destructive-change confirmation

Session 1 performed no AWS call, Terraform command, database connection or
migration, Redis/BullMQ connection, GitHub call, deployment, approval, cleanup,
state restore, secret retrieval, or destructive filesystem/version-control
operation. Production source, public APIs, entities, migrations, interfaces,
frontend behavior, and runtime behavior were not changed.
