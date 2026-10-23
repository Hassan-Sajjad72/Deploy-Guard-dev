# Session 8.5 — Default-Off Cross-Lane Shadow Observer Findings

## Status

Session 8.5 adds a default-off, explicitly callable observer. It records what
an ownership attempt *would* decide, but does not acquire, renew, release,
replace, clear, or enforce ownership. Neither legacy nor v1 calls it yet.

No consumer, controller, frontend, planner, outbox, queue, Terraform, AWS,
Docker, ECR, or legacy execution path was activated or changed.

## Observation schema

Migration `1760000045000-CreateReleaseLaneShadowObservations` adds
`project_release_lane_shadow_observations`. It stores only:

- project ID and normalized environment;
- proposed lane, bounded operation class, and bounded insertion source;
- a SHA-256 canonical operation key, never the raw logical identity;
- one sanctioned decision;
- current owner lane/token only for non-stale, internally consistent evidence;
- a deterministic SHA-256 evidence hash; and
- observation/create/update timestamps.

The canonical operation key is globally unique. Replaying the same logical
identity with exactly the same project, environment, lane, operation class,
and source returns the existing observation. Reusing it with any changed scope
or classification returns a sanitized idempotency conflict and writes nothing.

## Read-only decision algorithm

`InactiveReleaseLaneShadowObserverService.observe()` returns immediately with
`{ enabled: false }` unless the environment value is exactly:

```
TWO_LANE_OWNERSHIP_SHADOW_MODE=true
```

Missing, false, whitespace-padded, capitalized, numeric, and unknown values
are disabled and cause no database read or write.

When enabled, it validates a UUID project ID, normalized environment, lane,
bounded operation class/source, and a bounded logical identity. Legacy is
accepted only for `dev`; non-dev legacy observation fails closed.

Within a read-only evidence transaction, it reads without locking ownership
rows for mutation:

1. current cross-lane ownership/correlation evidence;
2. active legacy pipeline and legacy-correlation evidence for `dev` only;
3. active v1 deployment intents; and
4. active unexpired v1 operation leases.

It decides exactly one of:

- `acquirable` when no conflicting evidence exists;
- `would_block_legacy` for active legacy owner/work evidence;
- `would_block_v1` for active v1 owner/intent/operation evidence;
- `unsafe_stale` for expired or internally inconsistent ownership evidence; or
- `insufficient_evidence` when the project cannot be proven present.

Evidence from another environment is never queried as a blocker. The service
does not import or invoke the ownership/correlation write services.

## Sanitization

The observer does not persist or return lease IDs, actor or worker identities,
repository details, manifests, cloud identifiers, environment values,
credentials, raw request payloads, SQL errors, SDK errors, or the raw logical
operation identity. A stale/inconsistent owner also has its lane/token withheld
from the durable observation; only its hash influences the safe decision.

## Verification evidence

Passed commands:

| Command | Result |
| --- | --- |
| `npm run test:inactive-release-lane-shadow-observer` | exact gate and static no-mutation/no-external-path checks passed |
| `npm run test:inactive-release-lane-shadow-observer:postgres` | isolated decision, idempotency, conflict, sanitization, concurrency, environment isolation, and rollback checks passed |
| `npm run test:two-lane-migrations` | passed |
| `npm run test:two-lane-migrations:postgres` | passed; additive migrations apply twice and roll back in an isolated legacy-shaped schema |
| `npm run test:inactive-release-lane-ownership` and `:postgres` | passed |
| `npm run test:inactive-release-lane-correlation` and `:postgres` | passed |
| `npm run test:inactive-v1-release-lane-composition` | passed |
| `npx tsc --noEmit --incremental false` | passed |
| `npm run build` | passed |
| `git diff --check` | passed |

All PostgreSQL tests use unique temporary schemas and remove them in `finally`.
The application database was not migrated or used.

## Remaining wiring risks

- Shadow mode is not called from any production entry point, by design. Its
  observations are therefore not yet representative of live lane contention.
- This observer is not mutual exclusion and must never be presented as such.
- Legacy remains `dev`-only until a separately reviewed legacy environment
  model is available.
- Future integration must remain observation-only until every legacy and v1
  mutation entry path can enforce the Session 8.3 protocol together.

## Exact Session 8.6 task

Implement a **default-off, explicitly called shadow-insertion adapter** at the
Session 8.3 mapped entry boundaries. It may call this observer and emit only a
sanitized durable observation; it must not acquire ownership, alter a decision,
block/queue/cancel work, or wire enforcement into either lane.
