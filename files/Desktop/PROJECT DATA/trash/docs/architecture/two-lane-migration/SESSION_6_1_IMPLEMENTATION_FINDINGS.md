# Session 6.1 Inactive v1 Worker Runtime Findings

## 1. Outcome

Session 6.1 adds an internal, inactive worker-runtime foundation for the frozen
`deployguard.worker` protocol v1. It can be called explicitly to register a
worker capability, maintain an explicitly started heartbeat session, validate a
queued envelope and its deployment intent, and route the request to one typed
non-executing placeholder.

It does not create a BullMQ `Worker`, subscribe to a queue, start from a Nest
lifecycle hook, expose an endpoint, or call Terraform, ECS, AWS, Docker,
deletion, or the legacy pipeline. Registering the Nest providers has no side
effect. The two-lane orchestrator remains inactive.

## 2. Runtime boundary

The executable frozen routes are:

| Message | Required role | Lane / operation | Queue | Placeholder |
| --- | --- | --- | --- | --- |
| `intent.release.execute` | `release` | `release / execute` | `deployguard-release-v1` | release execute |
| `intent.infrastructure.plan` | `infrastructure` | `infrastructure / plan` | `deployguard-infrastructure-v1` | infrastructure plan |
| `intent.infrastructure.apply` | `infrastructure` | `infrastructure / apply` | `deployguard-infrastructure-v1` | infrastructure apply |
| `intent.deletion.execute` | `deletion` | `deletion / destroy` | `deployguard-deletion-v1` | deletion execute |

`outbox.reconcile` remains fail-closed. The frozen Session 5 protocol does not
assign it an execution queue, and Session 6.1 does not invent one.

`InactiveV1WorkerRuntimeService.route()` is the only runtime entry method. Its
order is:

1. strict frozen v1 envelope validation and payload-hash recomputation;
2. exact message/lane/operation/queue validation;
3. live compatible worker-capability validation against PostgreSQL database
   time;
4. intent and project load;
5. exact project, environment, manifest, run, destroy-operation, and canonical
   idempotency identity comparison;
6. terminal or superseded intent idempotent no-op;
7. active-intent classification and required manifest validation;
8. deletion-fence validation;
9. one-to-one typed placeholder routing.

The runtime intentionally stops before operation-lease acquisition, intent/run
transition, or any execution stage.

## 3. Capability and heartbeat behavior

`V1WorkerCapabilityService`:

- accepts only explicit release, infrastructure, or deletion runtime roles;
- accepts only the executable message types owned by the declared role;
- persists protocol range `1..1`;
- validates worker ID, service version, Git SHA, TTL, and sanitized metadata;
- registers or explicitly re-registers with PostgreSQL `clock_timestamp()`;
- renews only an unexpired row whose role, protocol, message set, version,
  Git SHA, and metadata still match;
- treats `expires_at <= clock_timestamp()` as unavailable;
- does not let an expired row revive through heartbeat;
- offers `startHeartbeatSession()` only as an explicit caller action and returns
  a stop handle. No module/bootstrap code calls it.

The explicit session serializes heartbeat attempts, uses an unreferenced timer,
and stops renewing after `stop()`. A transient heartbeat error is represented
only by the sanitized `HEARTBEAT_FAILED` code; an expired ownership row becomes
`CAPABILITY_EXPIRED`.

## 4. Intent and supersession safety

The runtime compares every identity carried by the envelope with the persisted
intent. An active message must also match its release, infrastructure, or
deletion classification. Release execution requires both the exact release
manifest and its exact infrastructure manifest reference.

Terminal statuses (`completed`, `failed`, `cancelled`, `no_op`, `rejected`) are
idempotent no-ops. Supersession is also a no-op when:

- a newer accepted intent in the same lane exists;
- a newer deletion intent exists;
- the referenced release is superseded/cancelled/rolled back; or
- the referenced infrastructure revision is superseded/destroyed.

An allowed concurrent infrastructure-plan lane does not incorrectly supersede a
release lane. Non-deletion work fails closed while any deletion fence is
present. Deletion work requires a complete fence owned by the same intent.

## 5. Non-executing handler guarantee

The four handlers are frozen, zero-dependency objects. They accept an already
validated typed context and return only:

- disposition;
- handler/message type;
- worker ID;
- intent ID; and
- project ID.

They contain no Nest injection, database access, queue access, external SDK,
Terraform, ECS, AWS, Docker, deletion, or legacy-pipeline import. Registry
construction rejects duplicate, missing, and unexpected handlers, so one valid
message resolves to exactly one placeholder.

## 6. Verification evidence

| Check | Result |
| --- | --- |
| Runtime unit and architecture test | Passed |
| Isolated PostgreSQL/Redis runtime test | Passed |
| Explicit capability registration | Passed |
| Explicit periodic heartbeat renewal | Passed |
| Expired capability cannot heartbeat/revive | Passed |
| Stale, wrong-role, and unsupported-message capability checks | Passed fail-closed |
| Protocol, hash, route, queue, identity, classification, and fence checks | Passed |
| Four valid messages route exactly once | Passed |
| Redis jobs remain `waiting`; no consumer runs | Passed |
| Terminal and superseded intents | Passed idempotent no-op |
| Cross-lane non-supersession | Passed |
| No operation-lease table/write in runtime fixture | Passed |
| Session 3 contract/static migration tests | Passed |
| Session 3 isolated PostgreSQL migration test | Passed |
| Worker-envelope and manifest secret-safety tests | Passed |
| Session 4 planner unit/PostgreSQL tests | Passed |
| Session 5 dispatcher unit/PostgreSQL/Redis tests | Passed |
| TypeScript type-check | Passed |
| Backend production build | Passed |
| `git diff --check` | Passed |

PostgreSQL tests use unique schemas and remove them in `finally`. Redis tests use
a unique prefix, never create a BullMQ consumer, assert that physical jobs stay
waiting, and obliterate their isolated queues in `finally`. No normal
application migration was run.

## 7. Changed files

- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-worker-capability.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-worker-capability.service.ts`
- `backend/src/orchestration-contracts/worker-runtime/v1-placeholder-handlers.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-worker-runtime.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/scripts/verify-inactive-v1-worker-runtime.ts`
- `backend/scripts/verify-inactive-v1-worker-runtime-postgres-redis.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_6_1_IMPLEMENTATION_FINDINGS.md`

## 8. Remaining risks and explicit non-goals

- Capability ownership has no separate generation/fencing token because the
  frozen `worker_capabilities` schema has none. Runtime processes must use
  unique worker IDs; explicit re-registration intentionally replaces that ID.
- Envelope expiry uses the validated process clock, while capability liveness
  uses authoritative PostgreSQL time.
- Heartbeat failures are not yet connected to metrics or audit events.
- No operation lease, fencing token, intent transition, dead-letter writer,
  BullMQ consumer, execution handler, or external side effect exists.
- `outbox.reconcile` has no runtime route.
- The dispatcher is still not scheduled and this runtime is still not started.

## 9. Next bounded task

A separate Session 6.2 may add and verify the pre-execution operation-lease and
fenced intent-transition boundary behind explicit calls, still without
Terraform, ECS, AWS, Docker, deletion, frontend, public endpoint, or legacy
pipeline activation. Its contract should be reviewed before implementation.

Session 6.2 was not started.
