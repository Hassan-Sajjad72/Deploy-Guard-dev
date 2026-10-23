# Session 4 — Transactional Deployment Planner Findings

Date: 2026-07-23

## 1. Scope and boundary

Session 4 implements the internal v1 transactional planner and its unpublished
transactional outbox write. It does not register a controller, route an API
request through the planner, publish a BullMQ job, start a worker, invoke the
legacy pipeline, backfill data, or call Docker, Terraform, ECS, AWS, GitHub, or
another network service.

The two-lane orchestrator is **not active**. Session 5 has not started.

## 2. Implemented architecture

`TransactionalDeploymentPlannerService.plan()` is the single transaction
boundary. It:

1. validates the request shape;
2. opens a PostgreSQL `SERIALIZABLE` transaction;
3. acquires
   `pg_advisory_xact_lock(hashtext('deployguard:planner:<project>:<environment>'))`;
4. loads the project, deletion fence, deployment contract, pre-flight evidence,
   sanitized configuration metadata, service-binding revisions, database and
   storage intent, legacy infrastructure evidence, active leases, applied
   infrastructure manifest, and stable release manifest;
5. canonicalizes desired infrastructure and release specs;
6. calculates deterministic contract, configuration, build, runtime, request,
   infrastructure, and release-identity fingerprints;
7. validates both manifest candidates with the frozen Session 3 validators;
8. classifies the request;
9. creates or reuses immutable manifest revisions;
10. commits one idempotent deployment intent and, for an executable decision,
    one `pending` outbox event in the same transaction.

Serialization failures and deadlocks are retried up to three times. The advisory
lock is transaction-scoped, so commit or rollback always releases it.

## 3. Classification behavior

- `UNSAFE_OR_UNKNOWN`: missing/stale/non-deployable contract, stale or failed
  pre-flight, missing required configuration, unresolved database ownership,
  archive/deletion fence, unverified legacy foundation, active operation lease,
  active deployment intent, unauthorized read-only actor, or unsupported
  deletion/rollback/import request.
- `INFRASTRUCTURE_CHANGE`: no applied manifest or a different canonical
  infrastructure spec.
- `RELEASE_ONLY`: applied infrastructure matches but the immutable release
  identity differs. Release identity includes release spec, deployment contract,
  effective configuration, build, and runtime fingerprints, so value revision
  changes are not incorrectly treated as `NO_OP`.
- `NO_OP`: applied infrastructure and stable release exactly satisfy the desired
  immutable state.

`plan` and `apply` requests ignore release-only differences. Apply outbox
envelopes use `intent.infrastructure.apply`; infrastructure planning uses
`intent.infrastructure.plan`.

## 4. Idempotency and immutable revisions

The canonical key follows the frozen formula:

```text
sha256("v1\n" + projectId + "\n" + environmentName + "\n" +
       actorIdentity + "\n" + clientIdempotencyKey)
```

The request fingerprint contains only sanitized hashes and references. Same key
plus same fingerprint returns the committed intent and decision. Same key plus a
different fingerprint raises `IDEMPOTENCY_KEY_REUSED` with conflict status 409.

Manifest revision allocation uses `MAX(revision)+1` only while the advisory
transaction lock is held. An existing equal immutable manifest is reused.
Every release manifest references one exact infrastructure-manifest UUID.

## 5. Secret safety

The planner never selects `project_environment_variables.value`. It reads only
key, scope, secret classification, and configuration revision metadata.
Manifests contain variable names and secret reference names, never values.
Session 3 recursive secret-material validation is run before manifest insertion,
and intent request payloads contain only fingerprints and IDs.

## 6. Outbox status

Executable plans create a validated worker-envelope v1 and a `pending` outbox
row atomically with the intent. There is no dispatcher or queue publisher in
Session 4. `pipelineRunId` remains nullable and no legacy pipeline run is
created, preventing the internal planner from changing current UI/runtime
behavior before a later activation milestone.

## 7. PostgreSQL proof

The real database test creates a uniquely named isolated PostgreSQL schema,
applies the Session 3 manifest/intent migrations, seeds two projects, and drops
the schema afterward. It proves:

- eight concurrent identical requests create one intent, one infrastructure
  manifest, one release manifest, and one outbox event;
- replays return the same intent;
- same key with a changed request returns a conflict;
- release manifests reference the exact selected infrastructure revision;
- no-op creates no manifest or outbox row;
- a configuration revision change is classified release-only;
- a forced outbox insert exception rolls back intent and manifest inserts;
- an active deletion fence yields a rejected unsafe decision and no outbox row;
- persisted manifests and request payloads contain no plaintext secret.

No production data is read or changed.

## 8. Verification results

| Verification | Result |
|---|---|
| TypeScript no-emit type-check | Passed |
| Backend production build | Passed |
| Transactional planner pure tests | Passed |
| Transactional planner isolated PostgreSQL concurrency/rollback tests | Passed |
| Session 3 contract-shape tests | Passed |
| Session 3 static migration safety | Passed |
| Session 3 isolated PostgreSQL migration apply/rerun/rollback | Passed |
| Worker envelope v1 regression | Passed |
| Manifest secret-safety regression | Passed |
| Pre-mutation contract regression | Passed |
| Configuration ownership regression | Passed |
| Service binding regression | Passed |
| Final plan-integrity regression | Passed |
| `git diff --check` | Passed |

## 9. Files added or changed

Added:

- `backend/src/orchestration-contracts/planner/transactional-deployment-planner.types.ts`
- `backend/src/orchestration-contracts/planner/transactional-deployment-planner.pure.ts`
- `backend/src/orchestration-contracts/planner/transactional-deployment-planner.service.ts`
- `backend/scripts/verify-transactional-deployment-planner.ts`
- `backend/scripts/verify-transactional-deployment-planner-postgres.ts`
- `docs/architecture/two-lane-migration/SESSION_4_IMPLEMENTATION_FINDINGS.md`

Changed:

- `backend/src/orchestration-contracts/contracts/canonical-json.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/package.json`

No frontend, Terraform, worker, controller, legacy pipeline, or AWS integration
file was changed by Session 4.

## 10. Deferred boundary

A later session may design activation adapters, durable dispatcher ownership,
worker compatibility checks, pipeline-run/configuration-snapshot creation, and
release/infrastructure executors. None of those are implemented or implied by
this session.
