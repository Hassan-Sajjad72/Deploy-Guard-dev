# DeployGuard Product Architecture

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
        S3[("S3 Terraform State")]
        DDB[("DynamoDB Lock")]
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
    TFPlan --> DDB
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
    Validate["1 Validate Inputs"] --> Clone["2 Clone Repository"]
    Clone --> Detect["3 Stack Detection Snapshot"]
    Detect --> Template["4 Template Generation"]
    Template --> Build["5 Docker Build"]
    Build --> Trivy["6 Trivy Scan"]
    Trivy --> Security["7 Security Gate"]
    Security --> ECR["8 ECR Push"]
    ECR --> Plan["9 Terraform Plan"]
    Plan --> Estimate["10 FinOps Estimate"]
    Estimate --> CostGate["11 Cost Gate"]
    CostGate --> ApplyGate["12 Terraform Apply Gate"]
    ApplyGate --> Lock["13 State Lock"]
    Lock --> Apply["14 Terraform Apply"]
    Apply --> EFS["15 Optional EFS"]
    EFS --> ECS["16 ECS Deploy"]
    ECS --> ALB["17 ALB Health"]
    ALB --> Release["18 Stable Release"]
    Release --> Observe["19 Observability"]
    ExternalCI["Optional External CI"] -. non-blocking by default .-> Clone
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
| 6.9 Distributed State | State | S3 state, DynamoDB lock, lock lifecycle |
| 6.10 Persistent Storage | Storage | EFS requirement, mount configuration, backup/KMS |
| 6.11 ECS Orchestration | Orchestration, Pipeline | ECS, ALB, rollback, stable release |
| 6.12 Observability | Observability | Logs, metrics, CloudWatch, Prometheus, health |

## Private Repository Production Direction

The MVP can use a backend OAuth token or PAT. Production multi-user private repository support should use short-lived GitHub App installation tokens instead of one backend PAT. Tokens must remain backend-only and must never appear in current-state, event, audit, or frontend payloads.
