# Operational Rollout 9.3 — Inactive First-Release Bootstrap

## Scope and status

Implemented an explicitly constructed, unregistered v1 first-release bootstrap boundary. It is not a Nest provider, route, queue consumer, composition dependency, or scheduled task. No AWS, Terraform, Docker, ECR, BullMQ, or live release command was run.

The boundary is designed for the already applied fresh Project-Tst `dev` infrastructure revision 4. It resolves only an exact `applied` InfrastructureManifest and validates its immutable output hash. It does not change that manifest or make any claim about a live release.

## First-release sequence

1. Resolve the exact applied infrastructure revision and verify the output hash.
2. Execute the fenced, idempotent `ecr.build_push_immutable_image` side-effect boundary.
3. Persist immutable, credential-free image provenance before creating a ReleaseManifest.
4. Create or reuse exactly one ReleaseManifest for the matching intent and provenance.
5. Register one initial task-definition revision through a separate fenced side effect and persist its reference.
6. Read the exact ECS service identity. Only an explicit `absent` result permits the fenced initial-service creation side effect.
7. Persist the initial-service reference. Any failed, interrupted, or uncertain side effect remains in the existing side-effect journal for reconciliation; it is never blindly repeated.

Later releases stay on the existing update-only adapter, which requires the long-lived service and source task definition. The bootstrap does not alter that adapter.

## Persistence and safety

- Added `release_image_provenances`: immutable image URI/digest, source commit, build fingerprint and evidence hash. It has intent/operation and intent/idempotency unique indexes; it stores no credentials or build payload.
- Added nullable `initial_service_input_hash` and `initial_service_arn` to `release_manifests`. Legacy rows remain valid.
- Migration `1760000047000` is additive and idempotent. Its down migration refuses to erase provenance history.
- Every durable write requires an active matching v1 operation lease and fencing token. A replay must load pre-existing durable provenance; it cannot infer a digest from a side-effect result hash.
- Service creation rejects `present` and `ambiguous` service evidence. It cannot replace an existing service.
- The bootstrap accepts only release-independent foundation outputs: ECR repository, ECS cluster, task/execution roles, ALB target group, application security group, public subnets, log group and a verified public-IP egress strategy. It never requires a foundation task definition or service.

## Verification

Passed:

- `npm run test:inactive-v1-first-release-bootstrap` — fixture first run, idempotent replay, proof-required image provenance, service-absence rejection, and static no-queue/Terraform/AWS-SDK reachability check.
- `npm run test:two-lane-contracts`
- `npm run test:two-lane-migrations`
- `npm run test:two-lane-migrations:postgres` — isolated legacy-shaped PostgreSQL migration apply-twice and rollback safety.
- `npm run test:inactive-v1-side-effect-safety`
- `npm run test:inactive-v1-side-effect-safety:postgres`
- `npm run test:inactive-v1-ecs-release-mutation`
- `npm run test:inactive-v1-ecs-release-mutation:postgres`
- `npm run test:inactive-v1-ecs-release-reconciliation`
- `npx tsc --noEmit --incremental false`
- `npm run build`
- `git diff --check`

Redis is intentionally not involved in this boundary: it neither publishes nor consumes a job. Existing isolated PostgreSQL side-effect tests cover the durable execution journal that the bootstrap uses.

## Remaining approval for one live release

Before one live Project-Tst release can be authorized, an operator must separately approve an exact immutable image build/push, task-definition registration, initial ECS service creation, and rollout/health verification for the exact applied revision-4 scope. That activation must also wire this still-unregistered boundary through the existing gated v1 handler/consumer and verify production read-only identity evidence first. No such activation is included here.
