# Session 7.1 Inactive ECS Release Mutation Adapter Findings

## 1. Outcome

Session 7.1 adds an explicitly callable, unregistered ECS release mutation
adapter. It can:

1. load one exact release revision and its exact applied infrastructure
   revision;
2. build a reference-only ECS task-definition revision request;
3. register that revision through the Session 6.6 side-effect boundary;
4. conditionally record the returned task-definition ARN on the same release
   manifest while the execution fence is still active; and
5. update the existing ECS service through a second Session 6.6 side effect.

No real ECS client was added. Tests inject fixture clients. The adapter is not a
Nest provider, handler, endpoint, consumer, scheduler, bootstrap hook, or legacy
pipeline dependency.

It does not run Terraform, create infrastructure, wait for stability, run health
checks, promote a stable release, or complete a deployment intent. The
two-lane orchestrator remains inactive.

## 2. Existing primitives reused

The implementation reuses:

- frozen `ReleaseManifest` and `InfrastructureManifest` contracts;
- exact manifest IDs and independent revision numbers;
- sanitized Terraform output names already produced for the ECS cluster,
  service, base task definition, container, and log group;
- the immutable `image_uri` plus `image_digest` release metadata;
- the existing configuration snapshot and service-binding references; and
- the Session 6.6 `V1HandlerSideEffectBoundary`.

The legacy `EcsService` was not reused as an executor because it constructs real
AWS SDK clients internally and combines service mutations with legacy
deployment/rollback state writes. Calling it would violate the inactive and
two-lane boundaries.

## 3. Exact manifest and infrastructure boundary

`InactiveV1EcsReleaseManifestStore` loads:

- the requested project and environment;
- the exact release manifest ID and revision;
- the exact infrastructure manifest ID and revision;
- the release-to-infrastructure foreign-key relationship; and
- only an infrastructure manifest whose current status is `applied`.

The pure planner then revalidates both frozen manifest specifications and
requires:

- matching project, environment, IDs, and revisions;
- a matching infrastructure output hash;
- ECS cluster, service, and base task-definition ARNs from applied
  infrastructure outputs only;
- an infrastructure-owned service name matching the frozen desired spec;
- matching release and infrastructure ports; and
- a valid ECR URI plus immutable `sha256` image digest in the infrastructure
  region.

No caller-provided cluster, service, network, ALB, IAM, database, or storage
identity is accepted.

## 4. Task-definition request

The injected client receives:

- the existing Terraform-created task-definition ARN as its source;
- its family and container name;
- `repository@sha256:digest`, never a mutable image tag;
- CPU, memory, command, and container port from the release manifest;
- the existing log-group identity from applied infrastructure; and
- environment and service-binding references.

Environment data is reference-only:

```text
name + configurationSnapshotId + source
```

Plain runtime variables use `configuration_snapshot`; secret variables use
`secret_reference`. No value field exists in the client contract. Duplicate,
overlapping, malformed, or unbound variable names fail closed.

The future real client must resolve these references at execution time without
persisting or logging their values and must preserve infrastructure-owned task
roles, execution roles, volumes, networking mode, and logging configuration
from the source task definition.

## 5. Idempotent mutation sequence

One caller-supplied root idempotency key derives two independent keys:

```text
ecs.register_task_definition_revision
ecs.update_existing_service
```

Each operation has its own immutable UUID and deterministic input fingerprint.
Both calls go through `V1HandlerSideEffectBoundary.execute()`.

Behavior:

| Condition | Result |
| --- | --- |
| First identical request | Register once, then update once |
| Repeated identical request | Replay both journal results; no client mutation |
| Same operation/key with changed input | Session 6.6 idempotency conflict |
| Registration failed or uncertain | Service update is not attempted |
| Cancellation before registration | No mutation |
| Fence lost during registration | Result remains reconcilable; no service update |
| Stored task reference conflicts | Fail closed |
| Successful replay without a durable task ARN | Fail closed; registration is not repeated |

After successful task registration, the ARN and task-definition input hash are
recorded only when:

- the exact release and infrastructure revisions still match;
- the infrastructure is still `applied`;
- the exact operation lease ID, intent, worker, and fencing token remain active;
- the lease is unexpired; and
- the intent remains `running`.

The adapter never changes a release to `healthy` or `stable` and never changes
an intent to `completed`.

## 6. Injected client surface

The target client exposes only:

```text
registerTaskDefinitionRevision
updateExistingService
```

There is no method for creating or replacing a cluster, service, VPC, ALB,
database, storage, networking, IAM, or other infrastructure. No AWS SDK import
exists in the adapter, pure planner, manifest store, or client contract.

No real client implementation or provider registration was added.

## 7. Verification evidence

Focused checks passed:

- exact manifest ID and revision matching;
- applied-infrastructure requirement;
- infrastructure output-hash verification;
- cluster/service/task-definition identity extraction;
- immutable ECR digest rendering;
- port consistency;
- reference-only environment rendering;
- distinct derived side-effect keys;
- unregistered/no-activation source scan;
- no Terraform, AWS SDK, infrastructure-create, stable promotion, or intent
  completion path;
- first execution calls each fixture mutation once;
- identical replay calls neither mutation again;
- changed input under the same identity fails closed;
- cancellation invokes no mutation;
- lost ownership after registration prevents service update;
- exactly two successful journal rows for the successful release attempt; and
- no secret values in client requests or persisted journal evidence.

Regression checks passed:

- Session 3 contract, migration, worker-envelope, and secret-safety suites;
- Session 4 planner unit and PostgreSQL suites;
- Session 5 dispatcher unit suite;
- Session 6.1–6.8 unit suites;
- Session 6.3 invocation PostgreSQL suite;
- Session 6.6 side-effect safety PostgreSQL suite;
- Session 6.7 reconciliation PostgreSQL suite;
- Session 6.8 coordinator PostgreSQL suite;
- TypeScript type-check;
- backend production build; and
- `git diff --check`.

PostgreSQL tests use isolated temporary schemas and remove them in `finally`.
No normal application migration, AWS request, Terraform command, queue
publication, or external deployment operation was run.

## 8. Changed files

- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-manifest.store.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.adapter.ts`
- `backend/scripts/verify-inactive-v1-ecs-release-mutation.ts`
- `backend/scripts/verify-inactive-v1-ecs-release-mutation-postgres.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_7_1_IMPLEMENTATION_FINDINGS.md`

## 9. Remaining risks

- There is no production ECS client. The injected policy marker and static
  import checks do not prove a future implementation is safe.
- ECS task-definition registration has no native caller-provided idempotency
  token. If the external result is uncertain, reconciliation is required and
  the mutation is never automatically repeated.
- A crash after journaled registration but before the task ARN is recorded
  leaves the release safely blocked for reconciliation.
- The future client must copy and validate infrastructure-owned roles, volumes,
  network mode, and log configuration from the exact source task definition.
- Configuration references are intentionally unresolved in this session.
- No service-stability, target-health, release-promotion, rollback, metrics,
  audit-event, or operator-recovery behavior was added.

## 10. Next bounded task

A future inactive session may add a fixture-only ECS read adapter that reconciles
uncertain task-definition registration or service-update evidence. It must not
repeat mutations, activate a handler, or promote a release.

