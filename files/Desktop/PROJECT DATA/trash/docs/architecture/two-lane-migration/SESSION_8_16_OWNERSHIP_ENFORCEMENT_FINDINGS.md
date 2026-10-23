# Session 8.16 — Default-Off Cross-Lane Ownership Enforcement

## Status

Session 8.16 implements the frozen cross-lane ownership lifecycle behind the
single exact gate:

```text
TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED=true
```

Missing, malformed, differently cased, false, or unknown values keep the
boundary disabled. The gate was not enabled during implementation or
verification. With it disabled, acquisition returns before any ownership or
correlation database operation and existing queue, worker, cloud, Terraform,
Docker, ECR, ECS, endpoint, and frontend behavior is unchanged.

This session does not start the v1 consumer and does not claim production
mutual exclusion.

## Static regression repair

`verify-inactive-legacy-shadow-insertion.ts` previously rejected any occurrence
of the substring `bullmq`. Session 8.14 introduced the sanitized field name
`bullmqJobId`, causing a false failure despite the adapter importing no BullMQ
code.

The assertion now rejects actual BullMQ imports/requires, queue/worker
construction, and activation-style calls. Existing input-shape, sanitization,
and no-external-reachability assertions remain unchanged. The focused
regression passes.

## Ownership boundary

`CrossLaneOwnershipEnforcementService` composes the existing:

- `InactiveReleaseLaneOwnershipService`;
- `InactiveReleaseLaneCorrelationService`;
- `project_release_lane_ownerships` fence;
- nullable legacy run/rollback correlation columns; and
- independent v1 `project_operation_leases` fence.

It does not create a second lock table or general lease system.

Every logical operation receives a deterministic, domain-separated
cross-lane lease UUID, idempotency hash, and request fingerprint. Cross-lane
lease IDs are independently derived and are explicitly rejected if they ever
equal a v1 operation-lease ID.

The legacy scope is exactly `(projectId, dev)`. V1 uses its exact normalized
environment. Deletion envelopes return a disabled cross-lane claim and cannot
enter this release/infrastructure fence.

## V1 lifecycle and ordering

The implemented v1 order is:

1. Validate the frozen envelope, queue, message, capability, project,
   environment, intent, and allowlist.
2. Acquire the cross-lane owner using an independent deterministic lease ID.
3. Correlate the exact deployment intent.
4. Invoke the existing pre-execution boundary, which claims the independent
   operation lease and transitions the intent.
5. Attach that exact operation lease only after it exists.
6. Run both heartbeats; handler and side-effect trust requires the existing
   operation heartbeat and the cross-lane heartbeat.
7. Complete/fail/release the operation lease first.
8. Release the cross-lane fence only for durable completed, failed, retryable,
   cancelled-operation, terminal-intent, or superseded-intent results.
9. Clear v1 intent/operation correlation only after the exact fenced
   cross-lane release.

If pre-execution claim or correlation fails before handler execution, the
newly acquired cross-lane owner is fenced-released. Lost ownership or
uncertain invocation does not perform an unconditional release.

The consumer remains explicitly started, unregistered for automatic startup,
and inactive.

## Legacy lifecycle

When the gate is enabled, ownership is acquired before creating an executable
run or before the shared rollback mutation sequence. The generated operation
ID becomes the durable run/rollback ID only in enabled mode, preserving
disabled-mode persistence behavior.

The following paths participate in one `(projectId, dev)` fence:

| Path | Acquisition / correlation |
| --- | --- |
| new, retry, and full-recovery pipeline run | before run save; correlate before queue |
| stage-selective mutating resume | before recovery-run save; cleanup/read-only resume excluded |
| cost approval resume | reacquire existing run before queue |
| Terraform apply approval | acquire before approval-state transition and queue |
| Terraform state-lock resume | reacquire/correlate before resume queue |
| direct infrastructure deploy | before infrastructure run creation |
| direct Terraform plan/apply | before infrastructure run creation |
| storage provisioning | before storage/run transaction and queue |
| worker pickup | require exact persisted run fence and renew before route dispatch |
| first mutation-capable worker boundary | renew exact fence before Docker/ECR/Terraform/ECS/EFS path |
| shared manual/automatic rollback | acquire before rollback state mutation; correlate durable rollback record before ECS update |

The active legacy worker maintains a bounded heartbeat. Terminal run state is
persisted before release. Completed, failed, verified terminal, cost-approval,
apply-approval, and state-lock waiting transitions release using exact lease,
actor, and fencing identities, then clear the exact legacy correlation.

Cancelled active work, ownership loss, rollback mutation failure, crash, and
other uncertain outcomes do not perform an unconditional release. Their
leases expire and remain subject to the existing underlying-work stale
takeover checks.

## Failure and fencing behavior

- A blocked acquisition throws a sanitized cross-lane machine code before
  queue publication or cloud mutation.
- Identical logical replay derives the same lease and idempotency identity.
- Changed identity under the same key fails closed in the existing ownership
  service.
- Renewal, validation, release, and correlation use project, environment,
  lane, lease ID, actor ID, and fencing token.
- A stale token cannot renew, release, attach, clear, or overwrite a newer
  owner.
- Correlation failure releases a newly acquired owner when no handler or cloud
  mutation has begun.
- Cross-lane and v1 operation fencing tokens remain independent and both are
  validated before trusted v1 side effects.

## Verification

### Passed

| Command / suite | Result |
| --- | --- |
| `npm run test:inactive-legacy-shadow-insertion` | passed; false positive repaired without weakening sanitization |
| `npm run test:cross-lane-ownership-enforcement` | passed; default-off, exact gate, deterministic replay, independent lease, failure cleanup, static reachability |
| `npm run test:cross-lane-ownership-enforcement:postgres` | passed; legacy/v1 race, legacy/v1 duplicates, stale fencing, renew/release, rollback, infrastructure, storage, v1 dual-fence and correlation cleanup |
| ownership and correlation fixture/PostgreSQL suites | passed |
| v1 ownership/invocation PostgreSQL suites | passed |
| v1 consumer fixture and isolated PostgreSQL/Redis suite | passed |
| shadow observer and v1/legacy insertion suites | passed |
| rollback and cancellation fixture/PostgreSQL suites | passed |
| pipeline finality fixture/PostgreSQL/BullMQ 5.79.2 suites | passed |
| worker-terminal shadow fixture/PostgreSQL suites | passed |
| two-lane migration static and isolated legacy-shaped PostgreSQL suites | passed |
| automation, stage-selective resume, and Terraform approval regressions | passed |
| `npx tsc --noEmit --incremental false` | passed |
| `npm run build` | passed |
| `git diff --check` | passed |

The first build attempt encountered an `ENOTEMPTY` race while Nest cleaned a
generated `dist` subdirectory. A direct rerun passed without source changes.

All PostgreSQL suites used unique temporary schemas and removed them. Redis
and BullMQ suites used their existing isolated prefixes. No normal application
database, AWS service, Terraform process, Docker daemon, ECR registry, or
frontend was accessed.

### Failed

None in the final verification run.

### Not executed

None of the required focused Session 8.16 checks were left unexecuted.

## Files changed

- `backend/src/orchestration-contracts/release-lane/cross-lane-ownership-enforcement.service.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-release-lane-ownership.service.ts`
- `backend/src/orchestration-contracts/release-lane/inactive-release-lane-correlation.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-bullmq-consumer.service.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-fenced-invocation.service.ts`
- `backend/src/projects/pipeline/pipeline.service.ts`
- `backend/src/projects/pipeline/pipeline-worker.service.ts`
- `backend/src/projects/recovery/stage-selective-resume.service.ts`
- `backend/src/finops/finops.service.ts`
- `backend/src/infrastructure/infrastructure.service.ts`
- `backend/src/storage/storage.service.ts`
- `backend/src/orchestration/rollback.service.ts`
- `backend/scripts/verify-inactive-legacy-shadow-insertion.ts`
- `backend/scripts/verify-cross-lane-ownership-enforcement.ts`
- `backend/scripts/verify-cross-lane-ownership-enforcement-postgres.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_8_16_OWNERSHIP_ENFORCEMENT_FINDINGS.md`

## Remaining activation risks

1. The enforcement gate remains off and has not passed a controlled
   production-like activation exercise.
2. Deletion, destroy, central cleanup, orphan cleanup, and workspace cleanup
   remain outside this fence by design.
3. Active cancellation, process crash, stalled jobs, and uncertain rollback
   require expiry plus durable underlying-work evidence; no new reconciler was
   introduced.
4. Legacy compatibility remains `dev` only. No legacy environment inference
   was added.
5. The existing v1 consumer remains explicitly started and inactive; no public
   endpoint or scheduler enables it.

## Next bounded task

The next session should be a **controlled default-off activation verification
session**, not a feature expansion. It should exercise the exact gate in an
isolated PostgreSQL/Redis fixture with both real legacy worker entry adapters
and the inactive v1 consumer, prove release behavior across approval,
retryable, terminal, cancellation, and crash simulations, and verify that
deletion/destroy remains unreachable. It must not enable the gate in the
normal backend environment or call cloud services.
