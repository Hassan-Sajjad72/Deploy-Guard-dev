# Session 7.5 Implementation Findings

## Outcome

Session 7.5 adds an explicitly callable, unregistered ECS rollout and ALB
health verifier. It performs one read-only evidence snapshot and returns only:

- `healthy`, `progressing`, `failed`, `timed_out`, or `ambiguous`;
- one sanitized machine code; and
- one deterministic evidence hash.

It is constructor-injected with `Pick<ECSClient, "send">` and
`Pick<ElasticLoadBalancingV2Client, "send">`. It does not construct an AWS
client, read credentials, poll automatically, register with Nest, or start from
any worker, endpoint, scheduler, consumer, frontend, or legacy pipeline.

## Exact identity boundary

Before reading AWS, the verifier loads one exact release revision and its exact
applied infrastructure revision through the Session 7.1 manifest store
contract. It rebuilds the deterministic Session 7.1 mutation plan and requires:

- exact project and environment;
- exact release and infrastructure manifest IDs and revisions;
- the stored task-definition input hash to match the rebuilt hash;
- the stored candidate task-definition ARN;
- cluster and service ARNs from applied infrastructure outputs;
- target-group ARN and container port from applied infrastructure outputs; and
- matching AWS partition, region, and account across every ARN.

An identity or revision mismatch returns ambiguous evidence before an AWS read.

## Read-only AWS command surface

The verifier can construct only:

### ECS

- `DescribeTaskDefinitionCommand`
- `DescribeServicesCommand`
- `ListTasksCommand`
- `DescribeTasksCommand`

### ELBv2

- `DescribeTargetGroupsCommand`
- `DescribeTargetHealthCommand`

There is no task registration, service update, target registration, target
deregistration, target-group modification, infrastructure creation, deletion,
Terraform, rollback, promotion, or other mutation command.

## Candidate task-definition proof

The exact candidate task definition must be active and match:

- the release manifest's stored ARN;
- family and container name;
- immutable ECR image digest;
- container port;
- project and environment tags;
- release manifest ID and revision;
- infrastructure manifest ID and revision;
- task-definition input hash; and
- image digest tag.

Missing, duplicate, malformed, or mismatched evidence fails closed as
`ECS_ROLLOUT_EVIDENCE_AMBIGUOUS`.

## ECS rollout evidence

The exact service must be active in the exact cluster and reference the exact
candidate task definition. Exactly one candidate `PRIMARY` deployment must
exist.

The verifier evaluates:

- ECS rollout state;
- desired, running, and pending deployment counts;
- exact running task count;
- task definition and service group for each candidate task;
- target container running state;
- candidate task ENI address;
- stopped candidate task stop codes;
- stopped-task reasons; and
- non-zero container exit codes.

Raw stop reasons and container diagnostics are never returned or hashed.
Known startup failure reasons are reduced to `ECS_TASK_START_FAILED`.

Running tasks from older task-definition revisions are ignored as candidate
evidence. Their target health cannot make the new release healthy.

## Exact ALB target evidence

The target group is described by the exact infrastructure output ARN. It must
use the exact release container port, IP targets, and HTTP or HTTPS.

Target health is joined to candidate tasks by the exact candidate ENI IP and
container port. Old target registrations are ignored. Duplicate, malformed,
wrong-port, unavailable, or otherwise ambiguous evidence fails closed.

## Classification

| Result | Conditions |
|---|---|
| `healthy` | Candidate rollout completed, pending count is zero, exact desired number of candidate tasks is running, and every candidate target is healthy |
| `progressing` | Candidate rollout or target registration is still valid and incomplete before the deadline |
| `failed` | ECS rollout failed, a needed candidate task failed to start, or an exact candidate ALB target is unhealthy/unused |
| `timed_out` | Otherwise valid progress remains incomplete at or after the supplied deadline |
| `ambiguous` | Identity, revision, count, task, target-group, target-health, response, pagination, or SDK evidence is missing, malformed, duplicated, or inconsistent |

The verifier is one-shot. A future explicitly invoked coordinator may call it
again, but this session adds no loop, timer, scheduler, or activation path.

## Ownership and sanitization

Cancellation and lease trust are checked before and after every ECS or ELBv2
read. Lost ownership stops all later reads. Unexpected SDK exceptions become
ambiguous evidence without exposing raw names, messages, payloads, credentials,
task reasons, target descriptions, or AWS responses.

The returned evidence hash is built from sanitized classifications, counts,
revision identity, and hashes of resource/task ARNs. The raw evidence is not
returned or persisted.

## Files changed

- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-rollout-health.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/disabled-v1-ecs-rollout-health.verifier.ts`
- `backend/scripts/verify-disabled-v1-ecs-rollout-health.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_7_5_IMPLEMENTATION_FINDINGS.md`

All unrelated dirty-worktree content was preserved.

## Verification

| Command | Result |
|---|---|
| `npm run test:disabled-v1-ecs-rollout-health` | PASS |
| `npm run test:disabled-v1-ecs-mutation-client` | PASS |
| `npm run test:disabled-v1-ecs-read-only-evidence` | PASS |
| `npm run test:inactive-v1-ecs-release-mutation` | PASS |
| `npm run test:inactive-v1-ecs-release-reconciliation` | PASS |
| `npm run test:inactive-v1-side-effect-safety` | PASS |
| `npm run test:inactive-v1-side-effect-reconciliation` | PASS |
| `npm run test:inactive-v1-reconciliation-coordinator` | PASS |
| `npm run test:manifest-secret-safety` | PASS |
| `npm run test:inactive-v1-ecs-release-mutation:postgres` | PASS |
| `npx tsc --noEmit --incremental false` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

The PostgreSQL regression used its isolated temporary schema and cleanup.
Mocked AWS coverage includes all five classifications, exact command inputs,
revision and fingerprint mismatch, task-definition tags, container port,
target-group identity, target health, stale tasks and targets, stopped-task
codes and reasons, wrong-port evidence, cancellation, ownership loss,
malformed evidence, raw SDK failure sanitization, and the read-only command
allowlist.

No real AWS, Terraform, queue, deployment, rollback, promotion, or external
operation was run.

## Remaining risks

- Only mocked AWS SDK shapes were exercised.
- The verifier supports DeployGuard's current Fargate `awsvpc` service with an
  IP target group; other ECS/ALB architectures fail closed.
- ECS exposes stopped tasks for a limited period, so an absent historical task
  cannot be treated as positive evidence.
- The verifier intentionally does not inspect application response bodies or
  CloudWatch logs.
- It does not persist results, advance a release, complete an intent, promote a
  stable release, or initiate rollback.

The verifier remains unregistered and inactive. Session 7.6 was not started,
and the two-lane orchestrator remains inactive.
