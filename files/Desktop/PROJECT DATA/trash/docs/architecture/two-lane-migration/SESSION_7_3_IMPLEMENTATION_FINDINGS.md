# Session 7.3 Implementation Findings

## Outcome

Session 7.3 adds a disabled, production-shaped ECS read-only evidence client for
the inactive Session 7.2 reconciliation adapter. It uses an injected AWS ECS
client and only constructs these commands:

- `ListTaskDefinitionsCommand`
- `DescribeTaskDefinitionCommand`
- `DescribeServicesCommand`

No AWS client is constructed, no provider is registered, and no command can
register, update, delete, deregister, promote, or roll back anything.

## Contract Changes

The Session 7.2 query now includes the infrastructure-owned task-definition
family and container name. Evidence also carries these values, the exact
task-definition input hash, and the task-definition status used by service
reconciliation.

The read-only client contract now accepts two explicit policies:

- the existing fixture policy;
- `deployguard.ecs-release-reconciliation/disabled-aws-read-only-v1`.

The Session 7.2 adapter rejects every other client policy. Existing fixture
tests remain compatible.

## Task-Definition Evidence

For a known task-definition ARN, the client describes that exact ARN with
`include: ["TAGS"]`.

When an uncertain registration has no recorded ARN, it:

1. lists the exact task-definition family;
2. checks both `ACTIVE` and `INACTIVE` definitions;
3. follows bounded pagination;
4. describes each candidate with tags;
5. selects only evidence relevant to the exact release ID, input hash, or
   immutable image; and
6. lets the Session 7.2 exact-shape classifier reject duplicate or mismatched
   candidates.

Required task-definition tags are:

- `deployguard:project-id`
- `deployguard:environment`
- `deployguard:release-manifest-id`
- `deployguard:release-revision`
- `deployguard:infrastructure-manifest-id`
- `deployguard:infrastructure-revision`
- `deployguard:task-definition-input-hash`
- `deployguard:image-digest`

The selected container must match the manifest-derived container name. Its
observed image must equal the immutable ECR `repository@sha256:digest`.

## Service-Update Evidence

The client describes exactly one applied-infrastructure cluster and service.
It accepts only a deployment referencing the exact expected task-definition
ARN. It then describes that task definition and rechecks its release tags,
family, container, immutable image digest, and status.

Classification remains in the Session 7.2 pure boundary:

| Evidence | Classification |
|---|---|
| Exact active task definition | `succeeded` |
| Exact active service with completed rollout | `succeeded` |
| Missing task, service, or expected deployment | `pending` |
| Throttling exhausted after bounded retries | `pending` |
| Inactive task/service or failed rollout | `failed` |
| Duplicate, malformed, ambiguous, or identity-mismatched evidence | `manual_review` |

No health, stability, target-group, promotion, or rollback decision was added.

## Pagination, Throttling, and Sanitization

- Pagination is bounded to configurable limits, with a maximum of 20 pages and
  100 results per page.
- Repeated, malformed, or over-limit continuation tokens fail closed.
- Throttling retries use bounded exponential backoff, at most five attempts,
  and the existing cancellation signal.
- A missing ECS resource becomes empty evidence.
- Exhausted throttling becomes pending evidence.
- Other AWS failures and malformed responses become deliberately invalid,
  sanitized evidence that the Session 7.2 classifier maps to manual review.

Raw SDK errors, failure messages, task events, IAM role ARNs, environment
values, credentials, and unrelated response fields never enter the evidence
contract. Only the required cluster, service, and task-definition ARNs remain.

## Inactive Boundary Proof

- `DisabledV1EcsReadOnlyEvidenceClient` is absent from every Nest module.
- It has no lifecycle hook, endpoint, scheduler, BullMQ worker, or consumer.
- The constructor receives `Pick<ECSClient, "send">`; it never creates an AWS
  client or reads credentials.
- Static tests reject mutating ECS command imports.
- No Terraform, frontend, legacy pipeline, promotion, rollback, or deployment
  activation file was changed.

## Files Changed

- `backend/src/orchestration-contracts/worker-runtime/disabled-v1-ecs-read-only-evidence.client.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-reconciliation.types.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-reconciliation.pure.ts`
- `backend/src/orchestration-contracts/worker-runtime/inactive-v1-ecs-release-reconciliation.adapter.ts`
- `backend/scripts/verify-disabled-v1-ecs-read-only-evidence.ts`
- `backend/scripts/verify-inactive-v1-ecs-release-reconciliation.ts`
- `backend/package.json`
- `docs/architecture/two-lane-migration/SESSION_7_3_IMPLEMENTATION_FINDINGS.md`

All unrelated dirty-worktree content was preserved.

## Verification

| Command | Result |
|---|---|
| `npm run test:disabled-v1-ecs-read-only-evidence` | PASS |
| `npm run test:inactive-v1-ecs-release-reconciliation` | PASS |
| `npm run test:inactive-v1-ecs-release-mutation` | PASS |
| `npm run test:inactive-v1-side-effect-safety` | PASS |
| `npm run test:inactive-v1-side-effect-reconciliation` | PASS |
| `npm run test:inactive-v1-reconciliation-coordinator` | PASS |
| `npm run test:inactive-v1-side-effect-reconciliation:postgres` | PASS |
| `npm run test:inactive-v1-reconciliation-coordinator:postgres` | PASS |
| `npm run test:inactive-v1-ecs-release-mutation:postgres` | PASS |
| `npx tsc --noEmit --incremental false` | PASS |
| `npm run build` | PASS |
| `git diff --check` | PASS |

The PostgreSQL tests used their existing isolated schemas and cleanup. No
normal application schema or external AWS endpoint was contacted.

Mocked AWS coverage includes paginated discovery, exact tags and image digest,
direct ARN lookup, missing resources, inactive task definitions, duplicate
candidates, identity mismatch, malformed responses, service completion,
pending/failed/inactive service evidence, duplicate deployments, bounded
throttling retry and exhaustion, token-loop rejection, query rejection before
client invocation, and raw-response/error sanitization.

## Remaining Risks

- Session 7.1 has no production ECS mutation client. Its abstract registration
  request does not yet require these evidence tags. A future production
  mutation implementation must apply the exact tag set atomically with task
  registration; untagged uncertain registrations remain pending or manual
  review rather than being guessed.
- The injected ECS client must be constructed for the same region declared in
  the adapter options. The reader rejects a query for another region.
- No runtime wiring, real credentials, real AWS response, or live throttling
  behavior was exercised.

The adapter remains disabled and unregistered. Session 7.4 was not started, and
the two-lane orchestrator remains inactive.
