# Session 7.4 Implementation Findings

## Outcome

Session 7.4 adds a disabled, production-shaped ECS mutation client for the
inactive Session 7.1 release adapter. The client is constructor-injected with:

- `Pick<ECSClient, "send">`;
- a reference-only runtime configuration resolver; and
- one fixed AWS region.

It never constructs an AWS client, reads credentials, registers itself with
Nest, or starts automatically. No real AWS request was made.

The only AWS SDK commands reachable from the implementation are:

1. `DescribeTaskDefinitionCommand`;
2. `RegisterTaskDefinitionCommand`;
3. `DescribeServicesCommand`; and
4. `UpdateServiceCommand`.

There is no create-service, cluster, networking, IAM, ALB, database, storage,
delete, deregistration, Terraform, promotion, rollback, health, or stability
operation.

## Source task-definition boundary

Registration first describes the exact task-definition ARN supplied by the
applied `InfrastructureManifest`. It fails closed unless the response matches
the exact ARN, family, region, active status, managed task role, execution role,
`awsvpc` network mode, Fargate compatibility, container name, log group, and
log region.

The new revision explicitly preserves:

- task and execution role ARNs;
- network mode;
- volumes and EFS configuration;
- placement constraints;
- required compatibilities;
- PID and IPC modes;
- proxy and inference configuration;
- ephemeral storage;
- runtime platform;
- fault-injection setting;
- every non-release container;
- target-container logging, mounts, repository credentials, health checks, and
  other infrastructure-owned container settings; and
- unrelated non-reserved source tags.

Only release-owned fields are changed:

- target container image;
- target command;
- target container port and matching host port;
- task CPU and memory; and
- target environment and secret references.

The image must be an immutable ECR `repository@sha256` value in the configured
region. CPU and memory must form a valid Fargate size.

## Configuration and secret safety

The client request remains reference-only. A separately injected resolver
receives configuration snapshot and service-binding references only while the
same fenced ownership is trusted.

Resolved public values can enter the ECS `environment` list. Secret values
cannot: every secret must resolve to an ECS `valueFrom` reference for Secrets
Manager or SSM. Exact key sets are enforced, duplicates and unknown keys are
rejected, secret-like names cannot be classified as plaintext environment
values, and raw resolver or SDK errors are replaced with sanitized machine
codes.

No resolved value is returned, persisted, logged, tagged, or included in the
findings document.

## Reconciliation identity

The Session 7.1 registration request now carries the exact tags required by the
Session 7.3 read-only reconciliation adapter:

- `deployguard:project-id`
- `deployguard:environment`
- `deployguard:release-manifest-id`
- `deployguard:release-revision`
- `deployguard:infrastructure-manifest-id`
- `deployguard:infrastructure-revision`
- `deployguard:task-definition-input-hash`
- `deployguard:image-digest`

The task-definition input hash is calculated from the immutable manifest and
registration input before the derived evidence tag is attached, avoiding a
self-referential hash. Registration validates that AWS returned the exact
family, immutable image, CPU/memory, active status, and complete evidence tag
set.

## Existing service update boundary

Before mutation, the client describes the exact cluster and service from the
applied infrastructure outputs. It rejects missing, inactive, failed, duplicate,
or identity-mismatched evidence.

`UpdateServiceCommand` contains only:

- the exact existing cluster ARN;
- the exact existing service ARN;
- the newly registered task-definition ARN; and
- `forceNewDeployment: true`.

The result must return the same active cluster, service, and task definition.
The client does not modify desired count, networking, load balancers, service
discovery, capacity providers, deployment configuration, or other
infrastructure-owned service settings.

## Lease, cancellation, and uncertainty handling

The exact Session 6.6 ownership context is checked:

- before every read or mutation;
- after every AWS response;
- before and after reference resolution; and
- before returning a mutation result.

Cancellation blocks the next call. Lost or replaced lease trust blocks the next
mutation or finalization. An unexpected SDK error becomes
`ECS_MUTATION_RESULT_UNCERTAIN`; its raw message and response are not exposed.
The surrounding Session 6.6 journal remains responsible for logical
idempotency and uncertain-effect reconciliation.

## Files changed

- `backend/src/orchestration-contracts/worker-runtime/disabled-v1-ecs-mutation.client.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-mutation.pure.ts`
- `backend/scripts/verify-disabled-v1-ecs-mutation-client.ts`
- `backend/scripts/verify-inactive-v1-ecs-release-mutation.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_7_4_IMPLEMENTATION_FINDINGS.md`

All unrelated dirty-worktree content was preserved.

## Verification

| Command | Result |
|---|---|
| `npm run test:disabled-v1-ecs-mutation-client` | PASS |
| `npm run test:inactive-v1-ecs-release-mutation` | PASS |
| `npm run test:inactive-v1-ecs-release-reconciliation` | PASS |
| `npm run test:disabled-v1-ecs-read-only-evidence` | PASS |
| `npm run test:inactive-v1-side-effect-safety` | PASS |
| `npm run test:inactive-v1-side-effect-reconciliation` | PASS |
| `npm run test:inactive-v1-reconciliation-coordinator` | PASS |
| `npm run test:manifest-secret-safety` | PASS |
| `npm run test:inactive-v1-ecs-release-mutation:postgres` | PASS |
| `npm run test:inactive-v1-side-effect-safety:postgres` | PASS |
| `npm run test:inactive-v1-side-effect-reconciliation:postgres` | PASS |
| `npm run test:inactive-v1-reconciliation-coordinator:postgres` | PASS |
| `npx tsc --noEmit --incremental false` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

The PostgreSQL regressions used their existing isolated temporary schemas and
cleanup. Mocked AWS tests prove exact source copying, immutable image use,
evidence tags, exact service targeting, reference resolution, command allowlist,
identity rejection, malformed-source rejection, plaintext-secret rejection,
invalid Fargate-size rejection, cancellation, ownership loss, sanitized SDK
failure, and absence from Nest modules.

## Remaining risks

- The runtime reference resolver remains only an injected contract; no
  production resolver is registered.
- ECS task-definition registration has no native caller idempotency token.
  Session 6.6 journaling and Session 7.2/7.3 read-only reconciliation therefore
  remain mandatory after an uncertain result.
- The source validator deliberately supports DeployGuard's current managed
  Fargate/`awsvpc`/CloudWatch Logs shape and fails closed for other task shapes.
- Only mocked AWS SDK responses were used. No live IAM or ECS compatibility was
  exercised.
- The client does not wait for service stability, verify health, promote a
  stable release, roll back, or complete an intent.

The client remains unregistered and inactive. Session 7.5 was not started, and
the two-lane orchestrator is not active.
