# Operational Rollout 9.1 — Normal Non-Cloud Backend Verification

## Result

**PASS for the isolated non-cloud rollout scope.**

The normal Nest `AppModule` started twice against one temporary PostgreSQL
schema and local Redis:

1. ownership enforcement enabled for exactly one fixture project in `dev`;
2. ownership enforcement disabled after restart against the same retained
   database state.

Only the explicitly requested inactive v1 fixture consumer was started. The
legacy pipeline worker, infrastructure lifecycle worker, emergency cleanup
worker, TTL cleanup scheduler, and every cloud-capable handler remained
stopped. No AWS, Terraform, Docker, ECR, ECS, deletion, destroy, cleanup, or
frontend operation ran.

This result does not establish live-cloud or production readiness.

## Rollout boundary

The existing exact enforcement gate remains:

```text
TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED=true
```

Operational allowlisting additionally requires:

```text
TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED=true
TWO_LANE_OWNERSHIP_PROJECT_ALLOWLIST=<one exact UUID>
TWO_LANE_OWNERSHIP_ENVIRONMENT_ALLOWLIST=dev
```

In rollout mode, malformed, empty, multi-project, multi-environment, or
non-`dev` allowlists fail closed. The verifier proved that the one allowed
fixture scope wrote ownership state while a second project produced no
ownership write. These flags remain disabled/empty in `.env.example`; no
normal `.env` was enabled.

The pre-existing Session 8.16 behavior remains compatible when rollout mode is
not selected. Operational use must set both exact flags and both allowlists.

## Normal-runtime composition defects found and fixed

The first normal Nest start exposed a real dependency-injection defect hidden
by direct-construction tests. Both shadow insertion adapters typed their
constructor dependency as a `Pick<...>` alias, so TypeScript emitted
`Object` metadata. Their constructors now use the concrete
`InactiveReleaseLaneShadowObserverService` runtime class.

The inactive v1 consumer is now a provider/export of
`OrchestrationContractsModule`, making explicit internal startup possible from
the normal Nest container. It has no lifecycle hook, scheduler, controller, or
automatic start.

No ownership contract, queue envelope, cloud adapter, frontend, or legacy
pipeline behavior was changed.

## Sanitized diagnostics

`CrossLaneOwnershipEnforcementService` now exposes an internal, read-only
inspection result for an allowed scope:

- owner lane and status;
- fencing token;
- acquired, heartbeat, expiry, and release timestamps;
- intent and operation correlation presence;
- legacy run and rollback correlation presence.

The service emits bounded lifecycle logs for acquire/block, correlation,
heartbeat, release, and recovery. Logs include only event, project ID,
normalized environment, lane, and sanitized disposition. The verifier rejects
passwords, credentials, lease IDs, actor IDs, queue payloads, repository
details, and AWS ARNs in these diagnostics.

No controller or public diagnostic endpoint was added.

## Retained-state recovery

`recoverLegacyRunAfterDurableFinality()` is explicitly callable and performs a
serializable, advisory-locked recovery using the exact:

- project and `dev` scope;
- legacy ownership lease ID;
- actor identity;
- fencing token;
- correlated pipeline run.

An expired owner is released and its run correlation cleared only when the run
has matching durable `project_pipeline_job_finalities` evidence:

- `completed`; or
- `failed_after_retries_exhausted`.

Run status alone is insufficient. The rollout proved:

- completed run plus durable finality recovered once and replayed
  idempotently;
- a cancelled, expired run without finality remained retained;
- a wrong or replaced fence cannot perform recovery.

This is not crash/orphan automation and is not scheduled.

## Operational evidence

The isolated verifier:

- created `operational_9_1_<suffix>` and set it as the normal AppModule search
  path;
- used `TYPEORM_SYNCHRONIZE=true` only for that empty temporary schema;
- started the normal HTTP Nest application on an ephemeral loopback port;
- created one allowlisted fixture project and one non-allowlisted project;
- acquired, correlated, heartbeated, inspected, and released one legacy owner;
- explicitly started one frozen v1 consumer under a unique Redis prefix;
- proved the v1 fixture job was blocked while the legacy owner remained the
  single active owner;
- proved no v1 operation lease was created after that conflict;
- restarted the same normal backend with the gate disabled;
- proved ownership history remained unchanged and disabled inspection made no
  ownership read/write;
- stopped the consumer and queues, obliterated the unique Redis prefix, and
  dropped the temporary schema.

One schema left by an intentionally interrupted diagnostic run was separately
identified by the strict `operational_9_1_*` prefix and removed. The final
verifier exits cleanly and removes its own resources.

## Verification results

### Passed

| Check | Result |
| --- | --- |
| `npm run test:operational-ownership-rollout` | normal Nest start/restart, allowlist, explicit v1 conflict, diagnostics, recovery, rollback, cleanup passed |
| cross-lane enforcement fixture + PostgreSQL | passed |
| Session 8.17 controlled activation PostgreSQL/Redis | passed |
| ownership fixture + PostgreSQL | passed |
| correlation fixture + PostgreSQL | passed |
| pipeline finality fixture + PostgreSQL + BullMQ 5.79.2 | passed |
| inactive v1 consumer fixture + PostgreSQL/Redis | passed |
| inactive worker runtime fixture + PostgreSQL/Redis | passed |
| worker-terminal shadow fixture + PostgreSQL | passed |
| v1/legacy shadow insertion fixtures | passed |
| two-lane migration static + PostgreSQL | passed |
| automation control regression | passed |
| `npx tsc --noEmit --incremental false` | passed |
| `npm run build` | passed |
| `git diff --check` | passed |

### Failed

None in the final verification matrix.

The engineering loop initially exposed the runtime DI issue described above,
then two fixture defects: an invalid test lease TTL and sequential fixture
records that remained active. Those were corrected without weakening
production fencing or finality requirements.

### Not executed

- live AWS, Terraform, Docker, ECR, ECS, deployment, rollback, destroy, or
  cleanup operations;
- the cloud-capable legacy pipeline worker;
- automatic or globally enabled v1 consumer startup;
- public endpoint or frontend flows;
- normal application database or normal Redis queue namespace;
- automated crash/orphan recovery.

These omissions are deliberate constraints, not passed checks.

## Files changed

- `backend/.env.example`
- `backend/package.json`
- `backend/scripts/verify-operational-ownership-rollout-postgres-redis.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/src/orchestration-contracts/release-lane/cross-lane-ownership-enforcement.service.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-legacy-shadow-insertion.adapter.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-v1-shadow-insertion.adapter.ts`
- `docs/architecture/two-lane-migration/OPERATIONAL_ROLLOUT_9_1_FINDINGS.md`

The repository was already heavily dirty. Existing unrelated tracked and
untracked work was not reset, reformatted, staged, or discarded.

## Remaining risks

1. The operational gate remains default-off and was not enabled in the normal
   application environment.
2. The real legacy cloud-capable worker was intentionally not started; normal
   composition was verified without cloud mutation.
3. V1 outbox publication still precedes consumer ownership acquisition by the
   frozen contract. A conflict prevents operation-lease claim and handler
   execution, not the already-durable v1 queue record.
4. Cancelled, retrying, crashed, stalled, and uncertain work remains retained
   unless exact durable finality and fencing evidence permits recovery.
5. Legacy compatibility remains exactly project plus environment `dev`.
6. Deletion, destroy, and central cleanup remain deliberately outside this
   release/infrastructure ownership fence.

No production enablement is recommended from this session alone.
