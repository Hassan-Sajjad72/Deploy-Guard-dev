# DeployGuard Product Architecture

## Modules 6.13–6.17 extension boundary

Troubleshooting consumes sanitized persisted evidence and stores verifiable references. Lifecycle events use one deduplicating notification dispatcher. Destruction is a recent-auth/server-challenge API plus a BullMQ worker protected by the Terraform state lock. Terraform export is strict-root and allowlisted. Billing owns server-side entitlements and metering; verified Stripe webhooks are the live subscription authority.

```mermaid
flowchart LR
  UI[React UI] --> API[NestJS APIs]
  API --> DB[(PostgreSQL)]
  API --> Q[(Redis and BullMQ)]
  Q --> Worker[Pipeline and lifecycle worker]
  Worker --> Events[Persisted lifecycle events]
  Events --> Notify[Notification dispatcher]
  Events --> AI[Sanitized troubleshooting]
  Notify -. configured .-> SNS[AWS SNS]
  AI -. configured .-> Provider[AI provider]
  API --> Export[Allowlisted Terraform ZIP]
  Stripe[Stripe hosted billing] -->|signed raw webhook| API
```

Frontend interaction and design-system details are documented in [frontend-architecture.md](./frontend-architecture.md).

DeployGuard is a platform-managed deployment control plane. GitHub supplies source code; DeployGuard owns detection, templates, build, security, cost analysis, infrastructure, deployment, and runtime operations.

Application repositories do not need GitHub Actions, Dockerfiles, docker-compose, Terraform, or AWS credentials. Optional external CI is non-blocking unless an operator explicitly configures `GITHUB_ACTIONS_REQUIRED=true`.

An optional project application directory can constrain detection and builds to a repository-relative monorepo folder. The backend rejects absolute paths and traversal segments; leaving it blank keeps automatic manifest selection.

## Pipeline evidence and runtime logs

Pipeline and Logs have separate ownership. Pipeline presents lifecycle stages, current/failed stage, run controls, and recovery. `/projects/:projectId/logs` presents sanitized structured events for one selected pipeline run, with stage/status filtering. It is deliberately labelled **Pipeline Events** because raw worker stdout/stderr is not persisted. CloudWatch runtime logs remain under the advanced Runtime area and are available only after a real deployment.

## Security gate model

Trivy findings are normalized by origin (`app_dependency`, `base_image`, `os_package`, `unknown`), fixability, and policy effect. Recommended defaults block only fixable Critical application dependencies. High, base-image/OS, and no-fix findings remain visible warnings unless an operator enables stricter policy. Generated Node templates use multi-stage builds, production dependency pruning for server runtimes, non-root users, and an unprivileged nginx runtime for static applications. Python templates isolate installed dependencies in a virtual environment and run as a non-root user.

## High-Level Architecture

```mermaid
flowchart LR
    User["User / Developer"]
    subgraph Client["Frontend Layer"]
        Landing["Landing Page"]
        Dashboard["Dashboard"]
        ProjectUI["Project Overview / Deployment Control"]
        ModulePages["Module Pages"]
    end
    subgraph Backend["NestJS Backend"]
        Auth["Auth & RBAC"]
        Projects["Projects Service"]
        CurrentState["Current-State Engine"]
        Detection["Stack Detection API"]
        Preflight["Template & Pre-flight API"]
        PipelineAPI["Pipeline API"]
        SecurityAPI["Security API"]
        FinOpsAPI["FinOps API"]
        InfraAPI["Infrastructure API"]
        StateAPI["State API"]
        ObservabilityAPI["Observability API"]
        Audit["Audit Logging"]
    end
    subgraph Data["Data & Queue"]
        Postgres[("PostgreSQL")]
        Redis[("Redis + BullMQ")]
    end
    subgraph Worker["DeployGuard Worker Pipeline"]
        Clone["Clone Repository"]
        Build["Docker Build"]
        Scan["Trivy Scan"]
        ECRPush["Push to ECR"]
        TFPlan["Terraform Plan"]
        Cost["FinOps Estimate"]
        TFApply["Terraform Apply Gate / Apply"]
        ECSDeploy["ECS Deploy"]
        Health["ALB Health Check"]
    end
    subgraph GitHub["GitHub"]
        Repo["User Repository"]
        OptionalCI["Optional GitHub Actions"]
    end
    subgraph AWS["AWS"]
        ECR[("ECR")]
        S3[("S3 Terraform State + Native Lockfile")]
        VPC["VPC"]
        ALB["ALB"]
        ECS["ECS Fargate"]
        EFS["EFS Optional"]
        CW["CloudWatch"]
        CM["Cloud Map"]
    end
    subgraph External["External Services"]
        Infracost["Infracost"]
        AI["AI Troubleshooting"]
        Prometheus["Prometheus Optional"]
    end
    User --> Landing
    User --> Dashboard
    Dashboard --> ProjectUI
    ProjectUI --> ModulePages
    Landing --> Auth
    Dashboard --> CurrentState
    ProjectUI --> CurrentState
    ModulePages --> CurrentState
    Auth --> Postgres
    Projects --> Postgres
    CurrentState --> Postgres
    PipelineAPI --> Redis
    Redis --> Clone
    Clone --> Repo
    PipelineAPI -. optional .-> OptionalCI
    Clone --> Build --> Scan --> ECRPush --> TFPlan --> Cost --> TFApply --> ECSDeploy --> Health
    ECRPush --> ECR
    TFPlan --> S3
    TFApply --> VPC
    TFApply --> ALB
    TFApply --> ECS
    TFApply --> EFS
    ECS --> CW
    ECS --> CM
    Cost --> Infracost
    CW --> ObservabilityAPI
    ObservabilityAPI --> AI
    ObservabilityAPI --> Prometheus
    Auth --> Audit
    Projects --> Audit
    PipelineAPI --> Audit
```

## Product Journey and Phase Model

```mermaid
stateDiagram-v2
    [*] --> setup
    setup --> detection: repository and branch connected
    detection --> preflight: stack detection passed
    detection --> failed: detection failed
    preflight --> pipeline: pre-flight passed
    preflight --> failed: validation failed
    pipeline --> failed: required stage failed
    pipeline --> apply_gate: apply disabled and gate reached
    pipeline --> deployment: apply enabled and provisioning starts
    deployment --> runtime: real ECS deployment recorded
    deployment --> failed: ECS or ALB unhealthy
    apply_gate --> pipeline: operator enables apply and starts or resumes run
    failed --> detection: retry detection
    failed --> preflight: retry pre-flight
    failed --> pipeline: retry pipeline
```

The current-state endpoint determines the user-visible phase. A future disabled stage never changes the present phase. `terraform_apply_gate` becomes a pause only after a real pipeline run reaches it.

## Internal Pipeline and Optional External CI

```mermaid
flowchart TD
    Validate["1 Validate Inputs"] --> ExternalCI["2 Optional External CI"]
    ExternalCI --> Clone["3 Clone Repository"]
    Clone --> Detect["4 Stack Detection Snapshot"]
    Detect --> Template["5 Generate and Check Container Configuration"]
    Template --> Build["6 Docker Build"]
    Build --> Trivy["7 Trivy Image Scan and Security Gate"]
    Trivy --> ECR["8 ECR Push"]
    ECR --> PlanLock["9 Plan Lock + Terraform Plan"]
    PlanLock --> Estimate["10 FinOps Estimate and Cost Gate"]
    Estimate --> ApplyGate["11 Terraform Apply Gate"]
    ApplyGate --> ApplyLock["12 Apply Lock + Terraform Apply"]
    ApplyLock --> EFS["13 Optional EFS"]
    EFS --> ECS["14 ECS Deploy"]
    ECS --> ALB["15 ALB / Application Health"]
    ALB --> Release["16 Stable Release"]
    Release --> Observe["17 Observability Readiness"]
    Observe --> Complete["18 Complete"]
    ExternalCI -. skipped or warning when not required .-> Clone
```

## Module-to-Product Mapping

| Module | Product surfaces | Authoritative data |
| --- | --- | --- |
| 6.1 Auth & Audit | Landing, auth pages, Audit Logs | Identity, role, login/logout, audited actions |
| 6.2 Projects & Workspace | Dashboard, Create Project, Project Overview | Project, repository, branch, environment variables |
| 6.3 Stack Detection | Project Overview, Detection & Pre-flight | Language, framework, commands, ports, confidence |
| 6.4 Templates & Pre-flight | Detection & Pre-flight, Project Overview | Generated Dockerfile/template and validation |
| 6.5 CI/CD Queue | Pipeline, Project Overview | Queue, runs, stages, events |
| 6.6 Security Scan | Security, Pipeline | Trivy findings and security gate |
| 6.7 FinOps | FinOps, Project Overview | Estimate, tier, approval, mock/real mode |
| 6.8 Infrastructure | Infrastructure | Terraform plan and AWS resource outputs |
| 6.9 Distributed State | State | S3 state, S3 native lockfile, DeployGuard coordination lock lifecycle |
| 6.10 Persistent Storage | Storage | EFS requirement, mount configuration, backup/KMS |
| 6.11 ECS Orchestration | Orchestration, Pipeline | ECS, ALB, rollback, stable release |
| 6.12 Observability | Observability | Logs, metrics, CloudWatch, Prometheus, health |

## Three-tier Database Topology

Database requirements are part of the persisted deployment contract. A PostgreSQL/MySQL application cannot pass pre-flight until it selects either a DeployGuard-managed database or a reachable external endpoint. Repository values that point to `localhost`, `127.0.0.1`, or `0.0.0.0` are never used as cross-container endpoints.

```mermaid
flowchart LR
    Internet --> ALB
    ALB --> App["Application ECS task"]
    App -->|"DB_HOST=db.project-id.deployguard.local<br/>5432 or 3306"| DB["Private database ECS service"]
    DB -->|"NFS 2049 from DB security group only"| DBEFS["Project database EFS"]
    App -->|"optional /app/uploads"| AppEFS["Separate app-file EFS"]
    Secrets["AWS Secrets Manager"] --> App
    Secrets --> DB
    CloudMap["Private Cloud Map namespace"] --> App
    CloudMap --> DB
```

Database EFS uses a dedicated KMS key, private-subnet mount targets, an access point with UID/GID `999` and `700` root permissions, lifecycle transition, and optional AWS Backup. It is never mounted into the application task. Normal Terraform destroy preserves database EFS, its credentials, encryption key, and backup metadata; permanent removal requires the exact additional confirmation `DELETE PERSISTENT DATABASE DATA`.

## Private Repository Production Direction

The MVP can use a backend OAuth token or PAT. Production multi-user private repository support should use short-lived GitHub App installation tokens instead of one backend PAT. Tokens must remain backend-only and must never appear in current-state, event, audit, or frontend payloads.
