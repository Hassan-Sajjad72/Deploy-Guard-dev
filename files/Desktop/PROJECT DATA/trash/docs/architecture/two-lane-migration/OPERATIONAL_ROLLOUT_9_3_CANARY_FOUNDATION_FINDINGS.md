# Operational Rollout 9.3 — Controlled Canary Foundation

## Result

**BLOCKED BEFORE TERRAFORM PLAN OR AWS ACCESS.**

No project was selected, no InfrastructureManifest or ReleaseManifest was
created, no Terraform workspace or plan was generated, and no AWS request or
mutation was made. Terraform apply and destroy were not run.

The stop is required by the rollout safety rules. The controlled local database
contains two deployable `dev` projects, and both already have historical
Terraform-state/resource and deployment evidence. Neither project has a v1
InfrastructureManifest or ReleaseManifest. Selecting either project would
therefore reuse a historical state key without the exact evidence required to
prove that its existing resources belong to this canary.

## Controlled local inventory

The database host resolves to the configured local PostgreSQL instance. Only
aggregate and bounded project metadata were inspected.

| Evidence | Result |
| --- | --- |
| Active local projects | 15 |
| Local `dev` projects | 12 |
| Deployable contract plus current passing pre-flight | 2 |
| Idle eligible candidates | 2 |
| Candidates with an immutable image-digest checkpoint | 0 |
| Applied `dev` InfrastructureManifest rows | 0 |
| `dev` ReleaseManifest rows | 0 |
| Complete applied-manifest/release pairs | 0 |

The two candidates are:

- `846665b9-ce31-405d-a131-b84457d80932` (`project2/cattle form`);
- `0f7f9488-70a9-4767-881e-2ea4c9773a76` (`Project-Tst`).

Both have historical Terraform state metadata with non-zero resource counts,
legacy infrastructure rows, prior deployment records, and pipeline image-URI
history. That history is not an applied v1 manifest and cannot be promoted or
treated as canary evidence.

## Source-proven planning gaps

1. The transactional planner can create a versioned, immutable
   InfrastructureManifest in `desired` state
   (`transactional-deployment-planner.service.ts:343-367, 765-812`). A
   plan/apply-only request deliberately creates no ReleaseManifest.
2. The existing Terraform executor is the legacy
   `InfrastructureService.runInfrastructurePlan()` path
   (`infrastructure.service.ts:311-430`). It persists its plan and outputs to
   `ProjectInfrastructureEnvironment`; it does not advance the v1
   InfrastructureManifest through `planning`, `planned`, or `applied`.
3. The current Terraform root does not declare an ECR repository. ECR is
   created by the application pipeline through `EcrService`, outside the
   Terraform plan.
4. ECS and ALB are enabled only when the legacy pipeline run already has an ECR
   image and pinned commit
   (`infrastructure.service.ts:1808-1814, 1868-1871`;
   `terraform/base-network/main.tf:50-62, 92-127`). Without an application
   image, the existing plan cannot contain the required long-lived ECS
   service, task-definition baseline, or target group.
5. The current network module always plans at least one NAT gateway
   (`terraform/modules/network/main.tf:80-109`). It cannot express the
   manifest's `natMode = none`, so it is not the least-cost requested canary
   topology.
6. Terraform resource tags include the project/run identity, but not the exact
   release and infrastructure manifest tags required by Rollout 9.2. The
   preflight requires all eight frozen evidence tags
   (`disabled-v1-ecs-read-only-evidence.client.ts:34-42`) and an applied
   manifest/release pair
   (`production-v1-release-canary-preflight.service.ts:156-178`).
7. Neither eligible project has a real immutable image digest. Creating a
   ReleaseManifest or task-definition tag from a mutable image URI, invented
   digest, or historical unverified record would be false evidence.

These are implementation-boundary gaps, not configuration values that can be
safely patched into the database.

## State, cost, and rollback safety

- The local runtime has an S3 state bucket, region, project prefix, and native
  lockfile configuration present. `STATE_MOCK_MODE=false` and
  `TERRAFORM_STATE_USE_LOCKFILE=true`.
- The remote bucket, versioning, encryption, public-access block, state object,
  and native lockfile were not inspected because no new canary project/state
  key exists and AWS was not contacted.
- Terraform CLI `1.15.8` is installed and the current Terraform root validates.
- Real cost estimation is unavailable: `FINOPS_MOCK_MODE=true`,
  `INFRACOST_ENABLED=false`, and `COST_GATE_MODE=bypass`. A mock estimate would
  not satisfy the required recurring-cost disclosure.
- The current template necessarily includes a NAT gateway and would include an
  ALB when ECS is enabled, so it cannot be presented as a verified minimum-cost
  canary plan.
- Live destroy is configured, and the destroy implementation restricts removal
  to the exact project state key, records the versioned state reference first,
  and rejects the shared state bucket. However, no rollback command can be
  truthfully issued until a new project UUID, plan workspace, state key, and
  exact planned resource set exist.

## Completion status

| Rollout check | Status |
| --- | --- |
| Exactly one approved project selected or created | **Blocked** — two historical candidates; no approved new repository/branch |
| Versioned InfrastructureManifest created normally | **Not executed** |
| Minimal Terraform plan generated | **Not executed** |
| Plan resource summary | **Not available** |
| Real recurring-cost estimate | **Blocked** — real estimator disabled and no plan |
| State and lock verified for exact canary key | **Not executed** |
| Rollback command scoped to the canary plan | **Not available before plan** |
| Explicit apply approval requested | **Not reached** |
| Terraform apply/destroy | **Not executed** |
| AWS verification | **Not executed** |
| Applied InfrastructureManifest persisted | **Not executed** |
| Matching truthful ReleaseManifest persisted | **Not executed** |
| Rollout 9.2 read-only preflight | **Not executed** |
| Consumer or release handler started | **No** |

## Verification evidence

| Command/check | Result |
| --- | --- |
| `terraform validate -no-color` in `backend/terraform/base-network` | Passed |
| `npm run test:two-lane-contracts` | Passed |
| `npm run test:manifest-secret-safety` | Passed |
| `npm run test:s3-state-lockfile` | Passed (fixture only; no AWS call) |
| `npm run test:infrastructure-lifecycle` | Passed |
| `npm run test:transactional-planner` | Passed |
| `npm run test:transactional-planner:postgres` | Passed in an isolated PostgreSQL schema |
| `npm run test:inactive-release-lane-ownership` | Passed |
| `npm run test:cross-lane-ownership-enforcement` | Passed |
| `npm run test:cross-lane-ownership-enforcement:postgres` | Passed in an isolated PostgreSQL schema |
| `npm run test:two-lane-migrations` | Passed |
| `npm run test:two-lane-migrations:postgres` | Passed apply-twice and rollback in an isolated legacy-shaped schema |
| `npx tsc --noEmit --incremental false` | Passed |
| `npm run build` | Passed |
| `git diff --check` for this findings document | Passed |

No migration was run against the normal database, no Redis job was published,
and no environment gate or consumer was enabled.

## Exact safe continuation

The operator must provide an approved repository URL/full name and branch for a
new, dedicated local canary project. Reusing either historical candidate
instead requires a separate read-only reconciliation proving its exact S3 state
and AWS resource ownership before any plan.

After a clean project is created through the normal project workflow, the next
bounded implementation must first close the source-proven infrastructure-lane
gaps:

1. connect a v1 InfrastructureManifest revision to Terraform plan artifacts and
   status transitions;
2. add the managed ECR repository to the infrastructure plan;
3. define a truthful baseline-image provenance path, without fabricating a
   ReleaseManifest or deploying an application;
4. make NAT optional while preserving valid ECS egress;
5. render exact manifest evidence tags;
6. produce a real cost estimate; and
7. generate the exact project-state-key destroy command/instructions.

Only then can a sanitized plan summary, real recurring cost, resource list, and
rollback command be presented for explicit operator approval. Terraform apply
must remain stopped until that approval is received.
