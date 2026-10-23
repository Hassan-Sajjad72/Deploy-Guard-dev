# DeployGuard Source-of-Truth Conflicts

## Decision

DeployGuard has useful persisted records, but no single immutable pair of
`InfrastructureManifest` and `ReleaseManifest` currently owns deployment
classification and runtime truth. `ProjectCurrentStateService` is an aggregator,
not yet the sole writer/owner. The conflicts below are migration inputs, not
changes made in Session 1.

## Principal conflicts

| # | Concept | Writers/readers competing today | Failure mode | Severity | Recommended future owner |
|---|---|---|---|---|---|
| 1 | Deployment intent | `PipelineService.startRun`, `InfrastructureService.deploy/queuePlan/queueApply`, recovery service | Same user intent can become different run types; ordinary release always becomes `full_deploy` | Critical | Transactional deployment planner |
| 2 | Whether Terraform is needed | Hard-coded `runTerraform:true`, job type, recovery stage map, UI action | Code-only release mutates infrastructure | Critical | Immutable diff between desired and applied `InfrastructureManifest` |
| 3 | Release definition | Deployment contract, config snapshot, image checkpoint, Terraform outputs, deployment record | No one immutable release object binds commit/image/task definition/config | Critical | `ReleaseManifest` revision |
| 4 | Infrastructure definition | Terraform variables, deployment contract ECS plan, database tier, storage, service bindings, project settings | Infrastructure facts are recomputed and scattered | Critical | `InfrastructureManifest` revision |
| 5 | Current run | Latest DB run, in-progress status, BullMQ job state, stale-run logic | A stale “running” DB row can expose cancel/running actions | High | Run projector with queue lease/heartbeat |
| 6 | Stage status/progress | Pipeline events, run status/currentStage, checkpoint rows, frontend stage-count fallback | Downstream stages or 100% can contradict a paused/failed gate | High | Server-owned ordered stage projection |
| 7 | App liveness | Project deployment row, stable release, ECS status, ALB health, CloudWatch, reconciliation | Provisioned infrastructure can be presented as a live app | Critical | Release health projection keyed by release/run |
| 8 | Infrastructure readiness | Infrastructure environment, readiness snapshot, Terraform state, Terraform outputs, cloud inventory | “Provisioned,” “stale,” and “manual review” can disagree | High | Applied infrastructure revision + reconciliation snapshot |
| 9 | Terraform state safety | Lock row, S3 lockfile, validation rows, state metadata, old pipeline events | Historical stale-lock evidence can outlive newer recovery | Critical | Timestamped state-safety snapshot |
| 10 | Recovery issue | Current run failure, previous deployment failure, requirements, state recovery, cached/current state | Historical health/state issue can override current apply approval | Critical | Current-run-scoped recovery decision |
| 11 | Runtime configuration | Project env rows, project settings, deployment contract arrays, service bindings, config snapshot | Detection and ECS can disagree about configured/missing values | High | Canonical configuration registry + immutable run snapshot |
| 12 | Database ownership | Detection requirements, project database tier, managed binding, Terraform module outputs, ECS task rendering | DB can exist without correct app binding, or be provisioned unnecessarily | High | Infrastructure manifest + explicit service binding |
| 13 | Timestamp/recency | Per-table `createdAt/updatedAt`, event timestamps, browser fallback | “Latest” depends on page and table | Medium | Server timestamp + precedence rules in projector |
| 14 | Project deletion | Project archive, Terraform destroy operation, registry cleanup, central inventory | Archived project may retain costly resources | Critical | Durable deletion saga |
| 15 | Queue identity | Run UUID, BullMQ auto ID, selective recovery job ID, apply job ID, lifecycle operation ID | Duplicate requests differ by route and can race | High | Idempotency key + unique intent constraint |
| 16 | Terraform implementation | Real InfrastructureService runner vs pipeline placeholder TerraformService | A “plan passed” event can mean real plan or placeholder | High | One infrastructure executor |
| 17 | ECS task definition | Terraform output task ARN vs unused direct registration renderer | Release-only components exist but normal deploy cannot use them | Critical | Release controller |
| 18 | Cloud resource truth | Terraform state, environment outputs, resource registry, cloud scans | Cleanup classification can lag actual cloud | High | Reconciled resource inventory with proof timestamp |

## Timestamp precedence required

The future projector should compare evidence by semantic authority and timestamp,
not simply select the latest row from each table:

1. An active queue lease/worker heartbeat outranks a persisted `running` label.
2. A newer successful lock release/recovery outranks an older stale heartbeat.
3. A newer valid state validation outranks an older corrupt/warning result.
4. Current-run evidence outranks failures from previous runs.
5. Verified ECS/ALB health for the candidate release outranks an old deployment URL.
6. Applied infrastructure revision outranks a planned revision.
7. Cloud reconciliation is evidence about existence, not proof that the app is live.
8. Historical events remain history and never become active blockers by themselves.

## Candidate future contracts

### InfrastructureManifest

Documentation-only candidate:

```ts
interface InfrastructureManifest {
  id: string;
  projectId: string;
  revision: number;
  environment: string;
  inputHash: string;
  terraformModuleVersion: string;
  network: object;
  ecsCluster: object;
  loadBalancer: object;
  storage: object | null;
  database: object | null;
  secretsInfrastructure: object;
  observability: object;
  stateKey: string;
  status: "desired" | "planned" | "approved" | "applying" | "applied" | "failed";
  planArtifactHash: string | null;
  appliedAt: string | null;
  supersedesId: string | null;
}
```

Candidate inputs already exist in project settings, deployment contract,
deployment requirements, database tier, service bindings, storage, configuration
snapshot, and infrastructure environment. The gap is immutable revision
ownership and an explicit desired-versus-applied diff.

### ReleaseManifest

Documentation-only candidate:

```ts
interface ReleaseManifest {
  id: string;
  projectId: string;
  infrastructureManifestId: string;
  runId: string;
  commitSha: string;
  deploymentContractHash: string;
  configurationSnapshotId: string;
  buildFingerprint: string;
  imageUri: string;
  imageDigest: string;
  taskDefinitionArn: string | null;
  healthPath: string;
  status: "queued" | "building" | "deploying" | "healthy" | "failed" | "rolled_back";
  previousStableReleaseId: string | null;
  promotedAt: string | null;
}
```

Existing `ProjectDeployment`, `ProjectStableRelease`,
`ProjectConfigurationSnapshot`, deployment contract, and checkpoints provide
most ingredients. Missing are one immutable binding, candidate/stable
supersession, and a unique release request identity.

## Operation classification matrix

The classifier must compare immutable desired inputs against the applied
infrastructure and last released application. `CONTEXT_DEPENDENT` means the
change can be classified only after ownership/scope resolution.

| Change/request | Classification | Minimum execution |
|---|---|---|
| Same commit and same config, healthy release | `NO_OP` | Return existing release |
| Source commit/code only | `RELEASE_ONLY` | Clone/build/scan/ECR/task rev/ECS/health/promote |
| Runtime env value only | `RELEASE_ONLY` | New task revision/ECS/health; no image rebuild |
| Build-time env value | `RELEASE_ONLY` | Build/scan/ECR/task rev/ECS/health |
| Start command/container command | `RELEASE_ONLY` | Task revision, or rebuild when Docker strategy embeds command |
| Health path only | `CONTEXT_DEPENDENT` | ECS/task health only unless ALB target-group config is Terraform-owned |
| CPU/memory within existing ECS design | `RELEASE_ONLY` | Task revision/ECS |
| Desired count/autoscaling settings | `CONTEXT_DEPENDENT` | ECS API if release-owned; Terraform if infrastructure-owned |
| New database tier/service | `INFRASTRUCTURE_CHANGE` | Terraform plan/approval/apply, bind, then release |
| Database credentials rotation | `CONTEXT_DEPENDENT` | Secret/task revision if secret exists; infra lane if resource changes |
| Add/remove EFS storage | `INFRASTRUCTURE_CHANGE` | Terraform then task revision/release |
| EFS mount path only | `CONTEXT_DEPENDENT` | Task revision if volume already exists |
| VPC/subnet/NAT/security-group change | `INFRASTRUCTURE_CHANGE` | Terraform plan/approval/apply |
| ALB/listener/target-group topology | `INFRASTRUCTURE_CHANGE` | Terraform plan/approval/apply |
| ECR repository creation/policy | `INFRASTRUCTURE_CHANGE` | Terraform |
| New repository branch/commit | `RELEASE_ONLY` | New release |
| App root/Dockerfile/build command | `RELEASE_ONLY` | Full build release path |
| Deployment contract stale against source | `UNSAFE_OR_UNKNOWN` | Re-detect/pre-flight before classification |
| Missing required env value | `UNSAFE_OR_UNKNOWN` | Block before mutation |
| Infrastructure manifest differs but cause unknown | `UNSAFE_OR_UNKNOWN` | Block and regenerate auditable plan |
| Security policy only | `RELEASE_ONLY` | Re-scan candidate; deploy only on pass/advisory policy |
| FinOps policy only | `NO_OP` or `CONTEXT_DEPENDENT` | Re-evaluate; no infrastructure mutation unless desired infra changes |
| Manual rollback | `RELEASE_ONLY` | Update ECS to stable task ARN, health verify |
| Cleanup inventory refresh | `NO_OP` | Read/reconcile only |
| Safe orphan cleanup | `CONTEXT_DEPENDENT` | Dedicated cleanup lane, never deployment |
| Project destroy | `INFRASTRUCTURE_CHANGE` (destructive lane) | Challenge/backup/lock/Terraform destroy/reconcile |
| Terraform state recovery | `INFRASTRUCTURE_CHANGE` (recovery lane) | State-only recovery/validation; no release build |

## False-failure and false-success risks

- A successful Terraform apply proves infrastructure mutation, not application
  liveness.
- A 100% frontend stage calculation does not prove a healthy release.
- A persisted deployment URL does not prove current reachability.
- A historical failure should not control a new run paused at apply approval.
- A placeholder Terraform event should not be treated as a real plan artifact.
- A cloud inventory scan proves observed resources at its timestamp, not their
  desired ownership or current application health.
- “Skipped” security/FinOps/external CI must remain skipped/advisory, never
  production-passed.

## Status consumer conflicts

| Page | Primary source | Competing inference |
|---|---|---|
| Dashboard | Current-state/workspace summaries | Client grouping and recency |
| Project Overview | Current-state | Recovery UI and action-specific fallbacks |
| Pipeline | Current-state + run/events | Client stage-count progress fallback |
| Pipeline Events | Run events | Historical events can look current without run context |
| Infrastructure | Infrastructure readiness/environment/events | Can say provisioned while Overview says app running/live |
| State | State safety snapshot | Has stronger lock/validation evidence than generic current-state if projector is stale |
| Orchestration | Orchestration status/releases | Separate runtime health authority |
| Observability | Runtime/log/metric APIs | Availability inferred independently |
| Resources/Cleanup | Reconciliation/resource registry | Existence/cleanup is not release health |

## Recommended ownership hierarchy

1. Planner owns intent classification and creates exactly one immutable request.
2. Infrastructure controller owns desired/applied infrastructure revisions.
3. Release controller owns image/task/ECS/health/promotion and rollback.
4. State controller owns state/lock safety.
5. Reconciler supplies timestamped observations, never silently changes intent.
6. Current-state projector reads those authorities and exposes one page-neutral
   projection.
7. Frontend renders the projection and does not infer lifecycle truth.

