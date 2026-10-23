# Operational Rollout 9.3 — First-Release Identity Preflight

## Implemented boundary

`ProductionV1FirstReleaseIdentityPreflightService` is an explicit one-shot, read-only inspection for the exact Project-Tst `dev` foundation. It is gated by the existing default-off production-canary composition plus all of:

- `TWO_LANE_FIRST_RELEASE_BOOTSTRAP_ENABLED=true`
- `TWO_LANE_FIRST_RELEASE_PREFLIGHT_ENABLED=true`
- `TWO_LANE_FIRST_RELEASE_PREFLIGHT_MODE=read_only`
- one exact project allowlist, `dev`, applied InfrastructureManifest ID, and revision.

The default environment template keeps every new first-release setting disabled or empty.

The composition now exposes the bootstrap only in this exact production-canary gate. Its composition-time client is a mutation-disabled sentinel: build/push, task registration and service creation always fail closed. No consumer, route, planner, job publication, or handler invocation was added.

## Routing and checks

- The bootstrap probes the exact cluster and deterministic long-lived service identity before the image side effect. `present` or `ambiguous` evidence blocks before image provenance, ReleaseManifest, task definition, or service work.
- A replay with a persisted initial-service reference is idempotent; it does not reinterpret the existing service as a new conflict.
- The read-only verifier resolves only the exact applied manifest revision, recomputes its output hash, checks that no ReleaseManifest or image provenance exists, then verifies the ECR repository, ECS cluster, target group, roles, public subnets, application security group and log group.
- It also verifies that the exact service and deterministic first-release task-definition family are absent. It returns only sanitized state/codes.

## Controlled runtime result

The normal migration runner applied the pending ordered additive migrations and
records `CreateReleaseImageProvenances1760000047000` as applied. The controlled
local database verification confirmed the provenance table, both nullable
first-service columns on `release_manifests`, the three provenance indexes, and
the three expected check constraints.

The first preflight retry exposed one implementation defect: the provenance
entity was absent from the normal Nest TypeORM entity registry even though it
was present in the migration data source and feature module. Adding that entity
to the registry fixed the metadata lookup; it did not alter any cloud path.

The exact one-shot invocation for the allowlisted fresh project, `dev`, and
applied revision 4 then returned:

```json
{"state":"ready","safeCodes":["FIRST_RELEASE_IDENTITY_READY"]}
```

Only the preflight's permitted read-only foundation checks were performed. It
confirmed the exact applied-manifest identity and the absence of release
evidence, an application task definition, and an ECS service. No image build
or push, ReleaseManifest creation, task-definition registration, service
creation/update, Terraform operation, queue publication, consumer start, or
cloud mutation occurred.

## Passed verification

- `npm run test:inactive-v1-first-release-bootstrap`
- `npm run test:inactive-v1-release-lane-composition`
- `npm run test:production-v1-first-release-identity-preflight`
- `npm run test:operational-production-canary-preflight`
- `npm run test:two-lane-contracts`
- `npm run test:two-lane-migrations`
- `npm run test:inactive-v1-side-effect-safety:postgres`
- `npm run test:inactive-v1-ecs-release-mutation:postgres`
- `npx tsc --noEmit --incremental false`
- `npm run build`
- `git diff --check`

## Required next approval

A separate live-release approval is required for this exact scope only:
immutable image build and push to the revision-4 foundation ECR repository,
durable image-provenance persistence, matching ReleaseManifest creation,
initial task-definition registration, creation of the exact long-lived ECS
service, and rollout/health verification. It must retain the existing fencing,
idempotency, side-effect journal, and reconciliation controls. Terraform,
infrastructure changes, deletion, cleanup, and unrelated AWS mutations remain
outside that approval.
