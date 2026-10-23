# Operational Rollout 9.2 — Production Canary Preflight

## Result

**BLOCKED BEFORE CLOUD ACCESS.** The normal runtime composition and its
read-only preflight boundary are implemented and verified in isolated
PostgreSQL/Redis. The local `backend/.env` intentionally has none of the
production-canary gate or resource-identity variables, so this rollout did not
select a project, construct a cloud request, or contact AWS. This is the
required fail-closed result; it is not a cloud-readiness claim.

## Default-off composition

`InactiveV1ReleaseLaneCompositionService` now supports the existing `fixture`
mode and a `production_canary` mode. The latter is ready only when all values
are exact:

- `TWO_LANE_OWNERSHIP_ENFORCEMENT_ENABLED=true`
- `TWO_LANE_OWNERSHIP_ROLLOUT_ENABLED=true`
- `TWO_LANE_OPERATIONAL_ROLLOUT_ENABLED=true`
- `TWO_LANE_RELEASE_COMPOSITION_ENABLED=true`
- `TWO_LANE_RELEASE_COMPOSITION_MODE=production_canary`
- a syntactically valid worker id;
- exactly one identical release and ownership project allowlist entry;
- exactly the `dev` environment allowlist for both scopes;
- `TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_ENABLED=true`; and
- `TWO_LANE_PRODUCTION_CANARY_PREFLIGHT_MODE=read_only`.

Malformed, missing, multiple-project, non-`dev`, or mismatched configuration
returns a sanitized blocked status. Disabled mode constructs no AWS client.
There is no lifecycle hook, endpoint, dispatcher invocation, consumer start,
or handler invocation in this change.

`ProductionV1ReleaseCanaryAdapterFactory` constructs the already-existing
production-shaped ECS evidence reader, ECS mutation client, rollout verifier,
outcome coordinator, and complete release-only handler only after that gate.
The mutation client is composed but no mutation method is called. Its runtime
reference resolver is deliberately preflight-only and fails before a mutation
could obtain runtime values.

## Read-only preflight protocol

`ProductionV1ReleaseCanaryPreflightService.run()` is explicitly callable only;
it is never run during Nest bootstrap. After the above composition has reached
`ready`, it requires one configured ECR repository, ECS cluster, ECS service,
target group, region, and the one allowlisted project. It then reads only:

1. ECR `DescribeRepositories` to prove the authenticated registry account and
   repository;
2. ECS `DescribeClusters`, `DescribeServices`, and `DescribeTaskDefinition`
   to prove the long-lived foundation/current task definition;
3. ELBv2 `DescribeTargetGroups` to prove the single target group/load balancer;
4. the current applied InfrastructureManifest and matching ReleaseManifest;
5. exact DeployGuard release/infrastructure tags on the current task
   definition; and
6. when an explicitly configured IAM role ARN is supplied, AWS CLI
   `iam simulate-principal-policy` for `ecs:RegisterTaskDefinition`,
   `ecs:UpdateService`, and `iam:PassRole`.

The result retains only booleans and machine-safe codes. It does not persist or
log credentials, identifiers, raw AWS responses, ARN values, repository data,
or CLI/SDK errors. An absent IAM principal or a failed simulator produces
`CANARY_FUTURE_MUTATION_PERMISSION_UNPROVEN` and blocks readiness. No command
can register a task definition, update a service, create/delete infrastructure,
run Terraform, Docker, or ECR mutation.

## Current local preflight status

`backend/.env` contains no `TWO_LANE_*` canary/operational-rollout variables
and no scoped ECR/ECS/target-group identity. Therefore the real AWS read-only
preflight was **not executed**. This avoids accidentally probing a historical
or arbitrary project. Configure the exact single project/dev scope and
resource identifiers only in a controlled canary environment, then invoke the
explicit preflight service; do not start a consumer or submit an intent.

### Continuation execution — 2026-07-25

The explicit execution was re-attempted by validating the configured source of
truth, `backend/.env`, before creating a Nest application or AWS client. Every
required entry was **missing**: the two ownership flags, operational-rollout
flag, release-composition flag/mode/worker/scope, preflight flag/mode, ECR
repository, ECS cluster/service, target group, and IAM simulation principal.

Result: **BLOCKED — `CANARY_CONFIGURATION_INVALID` before AWS access.** There
is no configured project/dev scope that may be passed to
`ProductionV1ReleaseCanaryPreflightService`; no manifest, AWS resource, IAM
role, queue, consumer, ownership record, operation lease, or handler was
accessed. No code defect was established, so no production code was changed.

To proceed, a controlled environment owner must supply the exact values from
the template above for one approved project and its exact existing resources.
They must not be committed. Once present, the same explicit service will either
return `CANARY_READ_ONLY_PREFLIGHT_READY` or the relevant sanitized resource,
tag, manifest, or permission blocker.

### Controlled runner execution — 2026-07-25

The explicit runner was executed once:

```text
npm run preflight:operational-production-canary
```

Sanitized result: `state=blocked`,
`safeCodes=[CANARY_CONFIGURATION_INVALID]`, exit status `2`.

The runner validated configuration before creating Nest or AWS clients. At the
time of execution, `AWS_REGION` was present but all canary gates, the exact
single project/dev allowlists, resource identifiers, and IAM simulation
principal were absent. Consequently, the matching InfrastructureManifest and
ReleaseManifest were **not queried**, and no ECR, ECS, ELBv2, or IAM call was
made. This is an external operator-configuration blocker, not an
implementation defect. No production code was changed.

### Environment-source and eligibility audit — 2026-07-25

The one-shot runner calls `resolveBackendEnvFile()` before constructing Nest.
When invoked from `backend/`, it resolves `backend/.env`; process-environment
values take precedence. `AppModule` uses the same resolver through
`ConfigModule.forRoot`, and `data-source.ts` uses the same file with the same
process-environment precedence. There is no separate repository canary file,
Compose mapping, VS Code mapping, shell variable, or package-script alias
containing the required `TWO_LANE_*` / `TWO_LANE_CANARY_*` values.

Configuration audit result: `AWS_REGION` is present, but every canary gate,
single-scope allowlist, worker identity, ECR/ECS/target-group identifier, and
IAM simulator principal remains absent from both `backend/.env` and the local
process environment. The existing AWS profile metadata contains profile and
credential files, so the saved state is **AWS authentication only**, not
complete application/canary configuration.

The controlled local database was queried read-only using aggregate counts
only. It contains `0` applied `dev` InfrastructureManifest/ReleaseManifest
pairs, `0` eligible projects, and `0` complete release identities. Therefore
there is no exact project from which resource configuration may be derived.
The preflight was **not executed** in this audit: no AWS call was permitted or
made, and no production code was changed. Required next prerequisite: an
operator must supply one approved project/dev scope with a persisted applied
infrastructure manifest and matching release manifest, plus the exact existing
resource and IAM-principal inputs.

## Verification

| Check | Result |
| --- | --- |
| `npm run test:operational-production-canary-preflight` | Passed: gate matrix, production-shaped composition, no mutation command in preflight source, disabled mode does no DB I/O. |
| `npm run test:operational-production-canary-runtime` | Passed with an isolated PostgreSQL schema: normal Nest DI resolved the production composition, handler/outcomes/mutation graph, and both consumers remained stopped. Preflight stopped before resource inspection and created zero ownership rows. |
| `npm run test:operational-ownership-rollout` | Passed: two isolated normal Nest boots, no cloud-capable worker start, one explicitly-started fixture consumer only. |
| `npm run test:cross-lane-ownership-enforcement:postgres` | Passed. |
| `npm run test:two-lane-migrations:postgres` | Passed: isolated legacy-shaped schema, apply twice and rollback. |
| ECS adapter/handler regressions | Passed: read-only evidence, mutation client, rollout verifier, and release handler. |
| `npm run test:two-lane-contracts`, `npm run test:worker-envelope-v1`, `npm run test:inactive-v1-consumer` | Passed. |
| `npx tsc --noEmit --incremental false`, `npm run build`, `git diff --check` | Passed. |

The continuation configuration validation is **blocked**, not passed: all
required canary values are absent from the local runtime environment, so no
AWS/IAM call was permitted or attempted.

The AWS SDK emitted its upstream Node 20 future-support warning during local
construction; no AWS request was made by those tests.

## Files

- `backend/src/orchestration-contracts/release-lane/inactive-v1-release-lane-composition.ts`
- `backend/src/orchestration-contracts/release-lane/production-v1-release-canary-adapter.factory.ts`
- `backend/src/orchestration-contracts/release-lane/production-v1-release-canary-preflight.service.ts`
- `backend/src/orchestration-contracts/orchestration-contracts.module.ts`
- `backend/.env.example`
- `backend/scripts/verify-operational-production-canary-preflight.ts`
- `backend/scripts/verify-operational-production-canary-runtime.ts`
- `backend/package.json`

## Remaining blockers and next bounded task

1. Supply the exact canary gate values and one explicit project/dev resource
   identity in a controlled non-production environment.
2. Ensure the project has an applied InfrastructureManifest and a matching
   ReleaseManifest with exact evidence tags.
3. Supply a role ARN permitted to run IAM policy simulation, or treat permission
   proof as blocked.
4. Run only the explicit read-only preflight and resolve every safe code.

The next bounded task is a controlled, read-only resource/permission
preflight using that exact configuration. It must not enable a consumer,
publish a job, or perform a live deployment canary.
