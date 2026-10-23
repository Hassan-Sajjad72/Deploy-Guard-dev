# Operational Rollout 9.3 — v1 Plan-only Canary Foundation

## Result

**Implemented and verified in isolated fixtures only.** The new v1 planner is
explicitly callable and default-inactive: it has no controller, queue/outbox
publisher, consumer, apply, destroy, ReleaseManifest creation, or project
selection path. No AWS API call, Terraform apply/destroy, deployment, or normal
database write was performed.

## Manifest-to-plan lifecycle

`V1InfrastructureManifestPlanService` advances one existing immutable
InfrastructureManifest revision through:

`desired` (or a prior `failed` plan) → `planning` → `planned`.

It uses a serializable transaction, row lock, scoped PostgreSQL advisory lock,
and retry for PostgreSQL serialization conflicts. A completed revision replays
its stored artifact data; a concurrent caller observes `PLAN_ALREADY_IN_PROGRESS`.
Only an isolated `local_mock` state backend is accepted. A remote/S3 state
attempt is persisted as `failed` with `REMOTE_STATE_PLAN_NOT_ALLOWED` before
Terraform is run. Missing plan-only input is likewise persisted as
`CANARY_PLAN_CONFIGURATION_INVALID`.

The successful record contains the exact manifest revision's workspace
reference, state key, deterministic input fingerprint, SHA-256 plan artifact
hash, and sanitized resource-count/type summary. A failed Terraform command
records `TERRAFORM_PLAN_FAILED` and never sets `appliedAt`.

Source: `backend/src/orchestration-contracts/infrastructure/v1-infrastructure-manifest-plan.service.ts:53-197`.

## Isolated Terraform foundation

The planner creates a workspace below the existing configured Terraform work
root at:

`v1-plan/<project-id>/<infrastructure-manifest-id>/terraform`

It rewrites the copied root to local state, removes copied state/plan files,
uses dummy offline-plan credentials, and calls only `init`, `validate`, `plan`,
and `show`. The returned destroy instruction is scoped to the exact manifest
state key and explicitly excludes the shared state bucket; it is informational
only and was not executed.

The plan requires these non-secret operator inputs:

- `TWO_LANE_CANARY_PLAN_AVAILABILITY_ZONES`
- `TWO_LANE_CANARY_PLAN_PUBLIC_SUBNET_CIDRS`
- `TWO_LANE_CANARY_PLAN_PRIVATE_SUBNET_CIDRS`
- `TWO_LANE_CANARY_PLAN_VPC_CIDR`
- `TWO_LANE_CANARY_PLAN_BASELINE_IMAGE` (immutable ECR digest reference)

They are documented as empty safe placeholders in `backend/.env.example`.

## Foundation resources and tags

The Terraform root now supports a minimum plan-only foundation:

- managed, immutable ECR repository and lifecycle policy;
- VPC, public/private subnets, security groups, ALB/target group, ECS cluster,
  baseline task definition, and an existing-service foundation with desired
  count zero;
- no database, EFS, EventBridge rule, autoscaling, or ReleaseManifest;
- exact infrastructure evidence tags:
  `deployguard:project-id`, `deployguard:environment`,
  `deployguard:infrastructure-manifest-id`,
  `deployguard:infrastructure-revision`, and
  `deployguard:infrastructure-input-hash`.

The planner rejects a manifest that does not require a managed immutable ECR
repository, or that asks this minimum foundation to silently omit a database,
EFS, Cloud Map, or ingress requirement. It deliberately does **not** write
release-specific tags.

For `natMode = none`, the network module creates no NAT gateway and the ECS
foundation selects public subnets with `assign_public_ip = true`; the Terraform
test asserts both sides of that egress contract. Existing `single` and
`per_az` NAT behavior remains selectable through the new compatible `nat_mode`
input.

Sources: `backend/terraform/base-network/main.tf:1-160`,
`backend/terraform/modules/network/main.tf:1-127`,
`backend/terraform/modules/ecs-service/main.tf:1-261`, and
`backend/terraform/modules/registry/main.tf:1-31`.

## Verification

| Check | Result |
| --- | --- |
| `terraform fmt -recursive` | Passed |
| `terraform validate -no-color` | Passed |
| `terraform test -no-color` | Passed: 1 mocked, no-AWS canary foundation plan |
| `npm run test:v1-infrastructure-plan:postgres` | Passed: isolated PostgreSQL lifecycle, concurrent duplicate planning, replay, changed revision, remote-state rejection, and failed-plan persistence |
| `npm run test:two-lane-contracts` | Passed |
| `npm run test:manifest-secret-safety` | Passed |
| `npm run test:two-lane-migrations` | Passed |
| `npm run test:two-lane-migrations:postgres` | Passed in an isolated legacy-shaped schema |
| `npm run test:transactional-planner` | Passed |
| `npm run test:transactional-planner:postgres` | Passed in an isolated schema |
| `npm run test:infrastructure-lifecycle` | Passed |
| `npm run test:s3-state-lockfile` | Passed with fixtures only |
| `npx tsc --noEmit --incremental false` | Passed |
| `npm run build` | Passed |
| `git diff --check` | Passed |

The `canary-foundation.tftest.hcl` fixture uses Terraform's mock AWS provider;
it validates a real Terraform plan graph without network access or cloud
mutation. The PostgreSQL verification uses a temporary schema and temporary
workspace, then drops/removes both.

## Intentionally not executed

- no live project was created or selected;
- no historical project state key was read or changed;
- no actual canary manifest was inserted into the normal database;
- no AWS service was contacted;
- no Terraform apply, destroy, or state operation was run;
- no ReleaseManifest, deployment intent, outbox event, queue job, consumer, or
  application release was created.

## Remaining operational blocker

The existing Rollout 9.3 finding remains valid: no approved fresh canary
project or operator-provided immutable baseline image/resource configuration
exists. The next task must stay plan-only until an operator supplies one new,
approved project/dev scope and the exact non-secret plan inputs. It may then
invoke this explicit service against an isolated local state key, review the
sanitized plan summary and cost externally, and stop for separate approval.

## Approval-ready plan review (continued)

`V1InfrastructurePlanReviewService` is an additional explicit, inactive
review boundary. It neither plans nor applies Terraform, and it does not create
a ReleaseManifest, deployment intent, outbox event, or queue job.

### Baseline-image provenance

The plan artifact now stores only a hash of the immutable baseline image
reference. Review accepts that reference only when its hash exactly matches the
planned artifact and one of these durable sources proves it:

- a passed/reused `ecr_push` checkpoint for the same project whose recorded
  immutable digest and repository match; or
- a structurally valid, explicitly frozen operator provenance contract with a
  contract ID, evidence SHA-256, and attestation timestamp.

Mutable tags, malformed/invented digests, cross-project checkpoints, missing
checkpoint evidence, and plan/reference mismatches return a safe blocker. The
persisted review contains provenance fingerprints only—never an image URI,
digest, checkpoint ID, contract ID, raw plan, or raw external response.

### Exact-plan Infracost estimate

The review rereads the isolated workspace's saved `tfplan`, recomputes its
SHA-256, and refuses cost processing if it differs from the manifest artifact
hash. When real Infracost is explicitly configured, it runs `terraform show`
against that exact plan and passes only the resulting JSON to the existing
Infracost adapter. It persists a sanitized result containing the plan hash,
currency, monthly total, resource count/types, and estimate fingerprint.

Mock, bypassed, disabled, missing, failed, stale, or mismatched estimates are
never approval-ready. A review package exposes only the manifest revision,
plan hash, plan summary, sanitized monthly estimate state, scoped destroy
instruction, and safe blocker codes. Approval readiness requires both verified
provenance and a real estimate for the same plan hash.

Source: `backend/src/orchestration-contracts/infrastructure/v1-infrastructure-plan-review.service.ts`.

### Current external-pricing result

**Blocked, not passed.** The local `infracost` CLI is not installed, and the
current demo FinOps configuration does not meet the real-estimate precondition.
No pricing request was attempted. This is deliberately reported as
`REAL_INFRACOST_UNAVAILABLE`; no mock/local estimate can be used for approval.

### Additional verification

| Check | Result |
| --- | --- |
| `npm run test:v1-infrastructure-plan-review:postgres` | Passed: isolated checkpoint and frozen-contract provenance, exact-plan cost persistence, replay, invalid image rejection, disabled-estimator handling, and plan-hash mismatch |
| `npm run test:v1-infrastructure-plan:postgres` | Passed |
| `terraform validate -no-color` | Passed |
| `terraform test -no-color` | Passed: 1 mocked no-AWS plan |
| `npm run test:demo-configuration` | Passed; secret values withheld |
| relevant two-lane, migration, planner, lifecycle, and secret-safety tests | Passed |
| TypeScript check, backend build, `git diff --check` | Passed |

No AWS, Infracost, Terraform apply/destroy, normal-database mutation, project
selection, consumer, application deployment, or ReleaseManifest creation
occurred during this continuation.

## Approved repository qualification (continued)

The approved public source was cloned read-only at its declared branch and
inspected with the normal DeployGuard detection service. Repository access and
branch identity were confirmed for `232378taniakhawar/smart-retail-pro` on
`main` (commit `b91850a6e90d24a6f5fce3863b1930b2a0e6972b`). No source file was
modified.

### Detection and local build result

The normal detector selected the repository root and returned:

- JavaScript / Node.js; Next.js SSR; npm; `nextjs-ssr` template;
- install: `npm ci`; build: `npm run build`;
- runtime command: `next start -H 0.0.0.0 -p ${PORT:-3000}`; port `3000`;
- server runtime, `PORT`-aware public bind, root health path fallback; and
- PostgreSQL required.

`npm ci --ignore-scripts` and `npm run build` completed locally. Rendering the
same generated `nextjs-ssr` Docker template verified the expected install,
build, non-root runtime user, port `3000`, and production start command. This
means DeployGuard can generate the container contract without modifying the
approved repository. It is not evidence that the database-backed runtime is
deployable without PostgreSQL.

### Database and configuration decision

The repository has the `pg` dependency, a PostgreSQL schema/bootstrap path,
and application API routes that use the database module. Database construction
is lazy, so a process can start before its first query, but the core retail,
authentication, order, inventory, reporting, and administration features need
PostgreSQL at runtime. It is not a build-time dependency.

Detected user-owned runtime configuration names are `DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER`, `DB_PASSWORD`, `JWT_SECRET`, and `JWT_EXPIRES_IN`.
`PORT` is platform-provided. Values in `.env.example` are examples only and
were not treated as credentials or configuration evidence. DeployGuard's
normal configuration ownership/pre-flight path would additionally require a
managed PostgreSQL tier or a real externally supplied PostgreSQL endpoint; it
must not use the repository's local fallback assumptions.

### Result: blocked before project creation

The current minimum v1 canary foundation explicitly excludes database
provisioning and database bindings. It therefore cannot support this approved
repository truthfully. Per the project-creation guard in this rollout, **no
DeployGuard project, InfrastructureManifest, ReleaseManifest, queue job, or
consumer was created**.

The smallest truthful next decision is one of:

1. approve a separate database-capable canary foundation and the required
   managed PostgreSQL/secret-binding contract; or
2. select a genuinely stateless approved repository for the existing
   database-free foundation.

No AWS, Terraform plan/apply/destroy, baseline-image provenance, external
database, or cloud resource operation was performed.

### Qualification verification

| Check | Result |
| --- | --- |
| Exact repository clone and `main` branch inspection | Passed |
| Normal StackDetectionService on the approved checkout | Passed: Next.js SSR, PostgreSQL required |
| Local dependency install and Next production build | Passed |
| Rendered generated Next.js SSR Docker contract | Passed |
| `npm run test:detection` | Passed |
| `npm run test:deployability-preflight` | Passed |
| `npm run test:docker-templates` | Passed |
| `npm run test:deployment-requirements` | Passed |
| Project creation / normal persisted pre-flight | Not executed: the database-free foundation is incompatible |
| Terraform plan / baseline provenance | Not executed by explicit scope |
