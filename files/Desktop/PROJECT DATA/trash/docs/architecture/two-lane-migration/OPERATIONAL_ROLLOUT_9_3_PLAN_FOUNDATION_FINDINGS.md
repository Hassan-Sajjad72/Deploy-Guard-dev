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

They are documented as empty safe placeholders in `backend/.env.example`.

## Foundation resources and tags

The Terraform root now supports a minimum plan-only foundation:

- managed, immutable ECR repository and lifecycle policy;
- VPC, public/private subnets, security groups, ALB/target group, ECS cluster,
  task execution/task roles, and CloudWatch log group;
- no application task definition or ECS service. Those are release-lane
  resources and cannot be created before immutable image provenance exists;
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

## Previous operational blocker

The historical finding is superseded by the Project-Tst continuation below.
Image provenance remains a release-lane prerequisite, never an
infrastructure-plan prerequisite.

## Approval-ready plan review (continued)

`V1InfrastructurePlanReviewService` is an additional explicit, inactive
review boundary. It neither plans nor applies Terraform, and it does not create
a ReleaseManifest, deployment intent, outbox event, or queue job.

### Release provenance boundary

Infrastructure review no longer reads, hashes, or validates an image. A
syntactically valid digest is never treated as provenance. The later,
default-inactive release lane must prove an immutable ECR push checkpoint (or
an explicitly frozen operator provenance contract) before it creates a
ReleaseManifest, task definition, or service. Its persisted evidence remains
fingerprints only—never image URIs, digests, credentials, or raw responses.

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
instruction, and safe blocker codes. Infrastructure approval readiness requires
a real estimate for the same plan hash. Immutable image provenance is
independently required by the first release, not by infrastructure approval.

Source: `backend/src/orchestration-contracts/infrastructure/v1-infrastructure-plan-review.service.ts`.

### Current external-pricing result

**Blocked, not passed.** The local `infracost` CLI is not installed, and the
current demo FinOps configuration does not meet the real-estimate precondition.
No pricing request was attempted. This is deliberately reported as
`REAL_INFRACOST_UNAVAILABLE`; no mock/local estimate can be used for approval.

### Additional verification

| Check | Result |
| --- | --- |
| `npm run test:v1-infrastructure-plan-review:postgres` | Passed: isolated exact-plan cost persistence, replay, unavailable-estimator handling, and plan-hash mismatch |
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

## Project-Tst stateless canary qualification (continued)

### Approved source and runtime contract

The approved source `Hassan-Sajjad72/Project-Tst` was cloned read-only at
`main`, commit `3bfb85fa3b9e98becbe3cbace6b0f9fe0a78a21c`. DeployGuard's normal
detector selected the repository root as a Python Streamlit server using pip:

- install: `pip install --no-cache-dir -r requirements.txt`;
- start: `streamlit run app.py --server.address 0.0.0.0 --server.port
  ${PORT:-8000}`;
- runtime port: `8000`; generated template: `streamlit-server`; and
- health verification: Streamlit `/_stcore/health` returned healthy locally.

The generated project-specific Dockerfile was built locally, then run with a
platform `PORT`. Its process ran as the generated non-root `appuser`. The
local image's immutable content identifier was calculated, but it is a local
Docker artifact only; it is not represented as an ECR image or persisted as
release provenance.

No database, Redis, externally configured API, secret, persistent storage, or
private registry is required for application startup or the health endpoint.
The repository deliberately does not track its dataset or model artifacts.
Startup handles their absence without contacting the network. The dataset is
needed only for data-driven dashboard features, models only for ML prediction,
and NLTK packages are downloaded only if an NLP feature is invoked. Therefore
an uncontrolled NLTK download is not a startup dependency, and it cannot be
relied upon as a deployment-time runtime dependency.

Warnings retained from normal persisted pre-flight are truthful: no Python
lockfile/version pin, no explicit repository health endpoint, and a framework
default port. They do not block the local stateless startup contract.

### Fresh project and persisted analysis

One fresh project was created through the normal authenticated project API for
the approved repository/branch/environment. Its only reported identity evidence
is project prefix `fc0d5f53` in `dev`; it is not the historical Project-Tst
record. Normal persisted stack detection succeeded and normal persisted
pre-flight returned `passed_with_warnings`. No environment values were supplied
or read.

The project then received one new desired InfrastructureManifest (identity
prefix `d4406e94`, revision `1`) in a serializable transaction. Its state key
is unique to the fresh project and uses the exact local-only v1 scope
`projects/<fresh-project>/dev/v1/1.tfstate`; it has no relationship to any
historical project state. It declares the minimal stateless foundation only:
managed immutable ECR repository, dedicated ECS foundation, HTTP ingress,
port `8000`, Streamlit health path, no NAT, database, storage, or discovery.
No ReleaseManifest exists for the project.

### Plan and approval review result

The explicit v1 plan service was invoked once. It failed safely before creating
a Terraform workspace or executing Terraform with:

`CANARY_PLAN_CONFIGURATION_INVALID`.

The real blocker is that an approval-ready plan requires an actual immutable
ECR reference in the required repository@sha256 form. The locally built image
does not meet that contract, and no ECR repository, digest, push checkpoint, or
operator-frozen ECR provenance was invented. Consequently there is no saved
plan hash, resource summary, cost estimate, approval-ready review, or scoped
destroy instruction. The review service was still invoked and returned
`PLAN_NOT_READY`, with unverified provenance and unavailable cost.

Installing or running Infracost cannot resolve this pre-plan provenance block,
so it was intentionally not installed or called. The next bounded prerequisite
is an operator-provided, real immutable ECR image reference plus its truthful
checkpoint or frozen provenance evidence. Only then may the plan service run
against isolated local state; a real matching Infracost estimate is separately
required before approval. This is not authorization for an apply.

### Verification

| Check | Result |
| --- | --- |
| Approved checkout identity and branch | Passed |
| Direct and persisted Streamlit detection/pre-flight | Passed with non-blocking warnings |
| Generated Docker image build | Passed locally |
| Non-root process and Streamlit health endpoint | Passed locally |
| Fresh project identity / no historical row reuse | Passed |
| Desired stateless InfrastructureManifest / no ReleaseManifest | Passed |
| Explicit v1 plan service | Blocked safely: `CANARY_PLAN_CONFIGURATION_INVALID` |
| Explicit v1 review service | Blocked safely: `PLAN_NOT_READY` |
| `npm run test:detection`, `test:deployability-preflight`, `test:docker-templates` | Passed |
| v1 planner/review PostgreSQL and two-lane migration suites | Passed in isolated schemas |
| TypeScript check, backend build, `git diff --check` | Passed |

No AWS service was contacted. No Terraform init, validate, plan, apply, or
destroy ran for this canary; no consumer, queue job, ReleaseManifest, or cloud
mutation was created.

## Project-Tst release-independent foundation plan (current continuation)

### Circular dependency removed

Revision 1 (`d4406e94`, retained as historical evidence) remains `failed` with
`CANARY_PLAN_CONFIGURATION_INVALID`: its old planner contract incorrectly
required an immutable application image before it could create the repository
that will receive that image. It was neither edited nor marked applied.

Revision 2 (`acba7acc`, parent revision 1) was created in the normal local
database through a serializable transaction and the project/environment
advisory scope. It has a new, isolated state key ending in `/v1/2.tfstate` and
the same stateless desired infrastructure specification. No ReleaseManifest,
ECR push checkpoint, deployment intent, job, consumer, or applied evidence was
created.

`V1InfrastructureManifestPlanService` no longer accepts or reads
`TWO_LANE_CANARY_PLAN_BASELINE_IMAGE`. `V1InfrastructurePlanReviewService`
also no longer reads an image/provenance source. The exact plan still requires
an immutable managed ECR repository, but it creates that repository as part of
the foundation rather than presuming an image already exists in it.

The release lane keeps the immutable-image boundary: a future, explicitly
inactive first release must prove a real ECR push digest before it creates a
ReleaseManifest or application task definition. This does not weaken image
provenance; it puts it on the only lane that can truthfully establish it.

### Plan result

The explicit plan service executed only local Terraform `init`, `validate`,
`plan`, and `show` in an isolated workspace. It used dummy offline-plan
credentials; no AWS endpoint was contacted.

| Field | Result |
| --- | --- |
| Manifest | revision `2` (sanitized ID prefix `acba7acc`) |
| State | `planned` |
| Plan hash | `cdd0d5c97a741f54985b0f319dc580c957179ff7deab517191e88204e997b883` |
| Changes | 25 create, 0 update, 0 replace, 0 delete, 1 no-op |
| Resource types | ECR repository/lifecycle policy; VPC, subnets, routes, internet gateway, security groups; ALB/listener/target group; ECS cluster; IAM roles/attachments; CloudWatch log group |
| Application task definition / ECS service | absent from the plan |
| Network | `natMode=none`; public-IP ECS egress contract retained |
| Destroy instruction | `terraform -chdir=v1-plan/<fresh-project>/acba7acc/terraform destroy -input=false -var-file=terraform.tfvars.json` — informational only, scoped to revision 2 local state, never executed |

The planner persisted the workspace reference, exact state key, input
fingerprint, plan hash, and sanitized summary on the immutable revision. The
shared Terraform state bucket is excluded from the destroy instruction.

### Exact-plan cost review

The review service rechecked the saved `tfplan` hash and attempted the real
Infracost path with mock and bypass disabled. It returned only
`REAL_INFRACOST_UNAVAILABLE`; it did not generate a local/mock estimate and
the manifest is not approval-ready. This is an external-pricing blocker, not a
Terraform or release-provenance failure.

### Frozen first-release bootstrap contract (default-inactive)

The existing inactive release handler remains deliberately limited to updating
an already existing service. Before this plan can support a first application
release, the following contract must be implemented and verified separately;
none of it was invoked here:

1. resolve the exact **applied** InfrastructureManifest outputs;
2. build and push the real immutable image to that foundation's managed ECR
   repository;
3. persist a truthful ECR push checkpoint/provenance record;
4. create the matching ReleaseManifest with that exact image digest;
5. register the release task definition; and
6. create the ECS service only when the exact infrastructure output proves no
   long-lived service exists; later releases update that same service.

Each step must preserve the release lane's existing idempotency, cross-lane
ownership, operation fencing, side-effect journal, and reconciliation rules.
No task-definition/service creation is authorized or reachable from the
infrastructure planner.

### Current verification

| Check | Result |
| --- | --- |
| Local Terraform `init`/`validate`/`plan`/`show` for revision 2 | Passed; no AWS access |
| Exact plan artifact hash and summary persisted | Passed |
| No task definition or ECS service in the foundation plan | Passed |
| Real Infracost review | Blocked safely: `REAL_INFRACOST_UNAVAILABLE` |
| `terraform fmt -recursive`, `terraform validate`, `terraform test` | Passed |
| `npm run test:v1-infrastructure-plan:postgres` | Passed |
| `npm run test:v1-infrastructure-plan-review:postgres` | Passed |
| `npx tsc --noEmit --incremental false`, `npm run build` | Passed |

No Terraform apply/destroy, AWS call, image push, release creation, consumer
start, queue publication, or other cloud mutation occurred. The only remaining
approval blocker for this plan is a real matching Infracost estimate; a later
release requires separate, truthful ECR image provenance and an applied
foundation.

## Pre-apply remote-plan preparation (awaiting operator approval)

### Local readiness

The real Infracost CLI is installed only in the current user's local bin
directory and verified as version `2.12.2`; it was not added to the repository.
The local environment has no `INFRACOST_API_KEY`. The review boundary now
returns `REAL_INFRACOST_AUTH_REQUIRED` before attempting a pricing request
when real pricing is enabled but authentication is absent. This is covered by
the isolated review PostgreSQL regression and stores neither key material nor
CLI output.

To price revision 2, an operator must make a valid Infracost API key available
to the one-shot local command environment only. It must not be committed,
printed, added to `.env.example`, or persisted in a manifest. The key is the
only currently known pricing prerequisite.

### Requested AWS planning scope

**No AWS call has been made.** Before creating the next immutable manifest or
running a remote Terraform plan, the requested scope is exactly:

- project scope: fresh Project-Tst project prefix `fc0d5f53`, environment
  `dev` only;
- state scope: the new revision-3 key
  `projects/fc0d5f53-8b6d-401a-b532-966dd4f7eff8/dev/v1/3.tfstate` and its
  native lockfile suffix `.tflock`, in the already configured DeployGuard
  state bucket and region only;
- bucket safety inspection: `HeadBucket`, `GetBucketVersioning`,
  `GetBucketEncryption`, and `GetPublicAccessBlock` against that configured
  state bucket; and `HeadObject` only for the exact revision-3 state/lock keys
  to prove that neither is already owned or locked;
- Terraform backend/plan activity: S3 backend reads plus the temporary native
  lockfile write/delete required by Terraform's exact key-scoped planning lock;
  no state-key reuse, no historical state read/write, no shared-bucket
  mutation, and no infrastructure apply/destroy;
- AWS provider planning reads only as Terraform requires to authenticate and
  validate the declared us-east-1 foundation graph. No ECR push, task
  definition registration, ECS service mutation, Terraform apply/destroy, or
  application release is within scope.

The remote planner has not been invoked, revision 3 has not been created, and
no remote state lock has been acquired. Explicit operator approval is required
before any of the above AWS calls or lockfile operations can occur.

### Pre-approval verification

| Check | Result |
| --- | --- |
| Infracost CLI installation checksum and version check | Passed locally |
| Missing authentication classification | Passed: `REAL_INFRACOST_AUTH_REQUIRED` |
| `npm run test:v1-infrastructure-plan-review:postgres` | Passed in isolated PostgreSQL |
| TypeScript check and backend build | Passed |
| `git diff --check` | Passed |
| AWS/S3/Terraform remote backend plan | Not executed — awaiting explicit operator approval |

## Remote pre-apply plan with cost deferred (current continuation)

### Scoped cost-deferred review

Cost estimation is intentionally deferred for this one canary. The normal
review path remains unchanged: it requires a real, matching Infracost estimate.
The only exception is the explicit, default-off `deferred_canary` mode, which
requires all of the following exact values at invocation time:

- `TWO_LANE_CANARY_COST_MODE=deferred_canary`;
- `TWO_LANE_CANARY_COST_DEFERRED_ACKNOWLEDGED=true`;
- the exact fresh Project-Tst project ID; and
- `TWO_LANE_CANARY_ENVIRONMENT=dev`.

Outside that exact project/dev scope, review remains unavailable/auth-required
and cannot become approval-ready. Deferred review persists no amount, currency,
resource pricing, estimate fingerprint, mock result, or zero value. It records
only `costState: deferred`, `costEstimate: unavailable`, and
`COST_ESTIMATE_DEFERRED`.

### Remote S3-backed plan result

After the approved, exact-scope bucket inspection, a new immutable
InfrastructureManifest revision 3 (sanitized ID prefix `2eb05634`) was created
as the child of local revision 2. Revisions 1 and 2 remain untouched historical
evidence. Revision 3 uses only its new state key ending in `/dev/v1/3.tfstate`.

The default-off remote-plan boundary accepted the revision only with its exact
project/dev allowlist, acknowledged deferred-cost mode, S3 backend, native
lockfile requirement, and revision-scoped state key. It ran only Terraform
`init`, `validate`, `plan`, and `show` with the configured S3 backend. No
Terraform apply/destroy, application release, ECR push, task definition, ECS
service, queue publication, or consumer action occurred.

| Package field | Result |
| --- | --- |
| Manifest revision | `3` |
| Plan hash | `2145f1b45c55a0064b98b218656ec93222dce07faa4517494a8b5fd58e95ffef` |
| Changes | 25 create, 0 update, 0 replace, 0 delete, 1 no-op |
| Resource types | ECR repository/lifecycle policy; VPC, subnets, routes, internet gateway, security groups; ALB/listener/target group; ECS cluster; IAM roles/attachments; CloudWatch log group |
| State / lock | bucket safety controls verified; exact revision-3 state key and lockfile absent before and after planning |
| Cost | deferred; `COST_ESTIMATE_DEFERRED`; no estimate amount was created |
| Local revision-2 comparison | exact count and resource-type match; no topology difference |
| Application task / ECS service | absent |
| Rollback instruction | `terraform -chdir=v1-remote-plan/<fresh-project>/2eb05634/terraform destroy -input=false -var-file=terraform.tfvars.json` — informational only, scoped to revision 3 state, never executed |

This package is **`PRE_APPLY_REVIEW_READY_WITH_COST_DEFERRED`**. It is not
cost-estimated, not fully production-approved, and is stopped before apply.

## Revision-3 approved apply outcome

**Result: failed safely before any managed foundation resource was created.**

The operator approved only revision 3 and its exact saved plan hash, with cost
explicitly deferred. Before mutation, DeployGuard revalidated the on-disk and
persisted hashes, the 25-create/zero-update/zero-replace/zero-delete summary,
the exact S3 backend key, bucket versioning/encryption/public-access controls,
an absent state/lock object, and an empty cross-lane/legacy/v1 work scope.

The first guarded invocation stopped before Terraform because its requested
ownership TTL exceeded the frozen ownership contract. It made no manifest,
state, ownership, or cloud change. The TTL was corrected to the contract's
five-minute maximum and all preconditions were revalidated before the only
Terraform invocation.

Terraform then failed before creating a managed resource. Reconciliation used
only the exact revision-3 state and bounded, read-only AWS evidence:

- the native `.tflock` was absent;
- the versioned state contained four read-only provider data sources and zero
  managed resources;
- the state contained no application task definition or ECS service;
- exact manifest evidence-tag lookup returned zero resources; and
- exact planned names returned zero ECR repositories, ECS clusters, ALBs,
  target groups, CloudWatch log groups, and IAM roles.

The exact cause was preserved in the saved plan: revision 3 had
`offline_plan_mode=true`, so the AWS provider used the planner's deliberately
invalid offline credentials during apply. This is safe for local/mock plans but
invalid for an S3-backed pre-apply plan. The planner now sets offline mode only
for `local_mock`; the apply boundary independently rejects any future remote
plan that does not record `offline_plan_mode=false`.

Revision 3 is durably `failed`, never `applied`, with zero managed resources,
versioned failure evidence, no Terraform outputs, and safe code
`TERRAFORM_APPLY_FAILED_OFFLINE_PROVIDER_PLAN`. The expired first fence was
reclaimed through the existing deterministic ownership operation with a higher
fencing token, the terminal failure was committed, and that exact replacement
fence was released. Revisions 1 and 2 were not changed.

No Terraform replan, second apply, destroy, cleanup, image build/push,
ReleaseManifest, task-definition registration, ECS service creation, queue
publication, consumer start, or Infracost call occurred. A future attempt needs
a new immutable manifest revision and new operator approval for its new plan
hash; revision 3 must not be retried.

## Revision-4 corrected remote plan

**Result: `PRE_APPLY_REVIEW_READY_WITH_COST_DEFERRED`; stopped before apply.**

Revision 4 (sanitized manifest prefix `7903b524`) was created through the
internal serializable, project/dev advisory-locked manifest-revision workflow
as a child of the failed revision 3. Revisions 1–3 were not changed. Before
Terraform backend or provider access, the runner verified the authenticated
account matched the approved account, the exact revision-4 state key and its
native lockfile were absent, and the configured state bucket had versioning,
encryption, and all public-access-block controls enabled.

The corrected planner records `offline_plan_mode=false` and `providerMode:
real_aws` for an S3-backed plan. It now rejects any remote plan with offline
provider mode, a non-empty/reused state key, an active native lock, a topology
outside the release-independent 25-create foundation, a deletion, a
replacement, an ECS task definition, or an ECS service.

| Package field | Result |
| --- | --- |
| Manifest revision | `4` |
| Plan hash | `29b42cfaafa096ae5e2dc5d0c9e49d5f92a282b4ab30f8a4ccda8b6667c5e822` |
| Changes | 25 create, 0 update, 0 replace, 0 delete, 1 no-op |
| Resource types | ECR repository/lifecycle policy; VPC, subnets, routes, internet gateway, security groups; ALB/listener/target group; ECS cluster; IAM roles/attachments; CloudWatch log group |
| State / lock after planning | exact revision-4 state key absent; native lockfile absent |
| Provider mode | real AWS provider; `offline_plan_mode=false` |
| Cost | deferred; `COST_ESTIMATE_DEFERRED`; no pricing tool was invoked and no amount was stored |
| Application task / ECS service | absent |
| Destroy instruction | `terraform -chdir=v1-remote-plan/<fresh-project>/7903b524/terraform destroy -input=false -var-file=terraform.tfvars.json` — informational only, scoped to revision 4, never executed |

This is not an apply authorization. A separate approval must name revision 4
and the exact saved plan hash above. No Terraform apply/destroy, ECR push,
task-definition registration, ECS service creation, ReleaseManifest, queue
publication, consumer start, or application release occurred.

## Revision-4 approved foundation apply

**Result: applied and verified; stopped before the first application release.**

The operator approved only revision 4 and saved plan hash
`29b42cfaafa096ae5e2dc5d0c9e49d5f92a282b4ab30f8a4ccda8b6667c5e822`,
with cost explicitly deferred. The guarded apply independently revalidated the
artifact hash, exact S3 backend/state key, native lockfile mode, authenticated
account, `offline_plan_mode=false`, 25-create topology, zero destructive
actions, and absence of task-definition/service resources before invoking the
saved plan once.

Terraform completed the foundation mutation and released its native lock. The
first post-apply verifier conservatively returned uncertainty because it counted
five module-scoped Terraform data sources as managed resources. No second apply,
replan, destroy, or cleanup was attempted. Read-only state evidence proved 25
managed resources plus five data sources, a versioned exact state object, a
released lock, and zero release-lane resources. The verifier was corrected to
classify resources using Terraform state JSON `mode`, and a dedicated read-only
reconciliation path then verified the exact AWS foundation.

| Evidence | Result |
| --- | --- |
| Manifest | revision 4, `applied` |
| Managed foundation resources | 25 verified |
| State | exact key active and versioned |
| Native lock | released |
| Cross-lane ownership | exact fence released after durable terminal evidence |
| Cost | deferred; no amount or estimate persisted |
| Application task definition / ECS service | absent |
| ReleaseManifest | absent |
| Reconciliation code | `APPLY_RECONCILED_FROM_VERIFIED_STATE` |

No Terraform destroy, application image build/push, task-definition
registration, ECS service creation/update, ReleaseManifest, queue publication,
consumer start, deletion, cleanup, or unrelated AWS mutation occurred.
