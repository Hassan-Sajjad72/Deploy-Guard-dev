# DeployGuard complete architecture and improvement map

This document describes the repository as it operates now. It separates active production-path code from registered read models and from source that exists but is not composed into the current application.

Snapshot: 2026-08-10  
Control-plane runtime: Node.js 22, React/Vite, NestJS, PostgreSQL  
Deployment engine: GitHub Actions using an immutable reusable-workflow SHA  
Customer runtime: determined by each authoritative `BuildPlan`, not by the control-plane Node version

## Status legend

```mermaid
flowchart LR
    A[Active runtime path]:::active
    B[External managed dependency]:::external
    C[Registered historical/read evidence]:::readmodel
    D[Present in source, not composed into AppModule]:::inactive
    E[Improvement hotspot]:::hotspot

    classDef active fill:#d8f3dc,stroke:#2d6a4f,color:#081c15
    classDef external fill:#dbeafe,stroke:#2563eb,color:#172554
    classDef readmodel fill:#fef3c7,stroke:#d97706,color:#451a03
    classDef inactive fill:#e5e7eb,stroke:#6b7280,color:#111827,stroke-dasharray:5 5
    classDef hotspot fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

## 1. End-to-end system context

```mermaid
flowchart LR
    Operator[Operator browser]:::external

    subgraph ControlPlane[DeployGuard control plane]
        UI[React frontend<br/>Vite production preview]:::active
        API[NestJS API<br/>Node 22]:::active
        DB[(PostgreSQL<br/>control-plane state)]:::active
        Projection[Canonical current-state<br/>projection]:::active
        Reconciler[GitHub Actions<br/>reconciliation on API reads]:::active
    end

    subgraph GitHub[GitHub]
        OAuth[GitHub OAuth<br/>user identity]:::external
        App[GitHub App<br/>repository installation]:::external
        CustomerRepo[Customer repository<br/>selected branch]:::external
        Caller[Generated deployguard.yml<br/>workflow_dispatch caller]:::external
        Reusable[DeployGuard reusable workflow<br/>immutable SHA]:::external
        Run[GitHub Actions run<br/>deployment execution]:::external
        Logs[Jobs, steps and safe<br/>result markers]:::external
    end

    subgraph AWS[AWS test or customer account]
        OIDC[IAM OIDC role and<br/>repository trust]:::external
        State[(Encrypted S3<br/>Terraform state)]:::external
        ECR[ECR immutable image]:::external
        ECS[ECS Fargate<br/>application service]:::external
        ALB[Application Load Balancer<br/>target health]:::external
        OptionalDB[Optional managed database<br/>ECS + EFS + Cloud Map]:::external
        Secrets[AWS Secrets Manager]:::external
        LogsAWS[CloudWatch logs]:::external
        Backup[AWS Backup evidence<br/>when configured]:::external
    end

    Operator -->|HTTPS or local HTTP| UI
    UI -->|Cookie-authenticated JSON API| API
    API <--> DB
    API --> OAuth
    API --> App
    App --> CustomerRepo
    API -->|Create or update managed caller| Caller
    Caller -->|uses exact SHA| Reusable
    API -->|workflow_dispatch| Run
    Run --> Caller
    Run --> Reusable
    Run -->|OIDC token| OIDC
    OIDC --> Run
    Run --> State
    Run --> ECR
    Run --> ECS
    ECS --> ALB
    ECS --> LogsAWS
    Run --> OptionalDB
    OptionalDB --> Secrets
    OptionalDB --> Backup
    Run --> Logs
    Reconciler -->|poll run, jobs and logs| Logs
    API --> Reconciler
    Reconciler -->|validated result evidence| DB
    DB --> Projection
    Projection --> UI

    H1[H1: pull-driven completion<br/>and UI polling]:::hotspot
    H2[H2: customer-branch caller<br/>commit coupling]:::hotspot
    H3[H3: remote-state locking<br/>hardening]:::hotspot
    Reconciler -.-> H1
    Caller -.-> H2
    State -.-> H3

    classDef active fill:#d8f3dc,stroke:#2d6a4f,color:#081c15
    classDef external fill:#dbeafe,stroke:#2563eb,color:#172554
    classDef hotspot fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

## 2. Local product startup and runtime composition

`npm run product:start` is the supported integrated local launcher.

```mermaid
flowchart TD
    Start[npm run product:start]:::active --> NodeGate{Exactly Node 22?}:::active
    NodeGate -->|No| Stop[Fail before startup]:::active
    NodeGate -->|Yes| Ports{Ports 5000 and 5173 free?}:::active
    Ports -->|No| Conflict[Fail with explicit conflict]:::active
    Ports -->|Yes| Compose[docker compose up -d postgres]:::active
    Compose --> Migration[Run TypeORM migrations]:::active
    Migration --> BackendBuild[Build NestJS backend]:::active
    BackendBuild --> FrontendBuild[Build React frontend]:::active
    FrontendBuild --> API[NestJS dist/src/main<br/>port 5000]:::active
    FrontendBuild --> Web[Vite preview<br/>127.0.0.1:5173]:::active
    API --> Ready[/api/health/ready]:::active
    Web --> WebReady[Frontend root response]:::active
    Ready --> ProductReady[Integrated product ready]:::active
    WebReady --> ProductReady
    Signal[Ctrl-C or SIGTERM]:::external --> Shutdown[Terminate child process groups]:::active
    Shutdown --> StopOwned[Stop only dependencies<br/>started by this launcher]:::active

    NoRedis[No Redis in active compose]:::readmodel
    NoWorker[No local BullMQ pipeline worker<br/>GitHub Actions is the active engine]:::readmodel
    Compose -.-> NoRedis
    API -.-> NoWorker

    H4[H4: add .nvmrc and .node-version<br/>to align interactive shells]:::hotspot
    NodeGate -.-> H4

    classDef active fill:#d8f3dc,stroke:#2d6a4f,color:#081c15
    classDef external fill:#dbeafe,stroke:#2563eb,color:#172554
    classDef readmodel fill:#fef3c7,stroke:#d97706,color:#451a03
    classDef hotspot fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

### Active NestJS module graph

```mermaid
flowchart TD
    AppModule[AppModule]:::active
    Config[Global ConfigModule]:::active
    ORM[TypeORM PostgreSQL]:::active
    Health[HealthController and HealthService]:::active
    Auth[AuthModule]:::active
    Users[UsersModule]:::active
    Admin[AdminModule]:::active
    Audit[AuditLogModule]:::active
    Projects[ProjectsModule]:::active
    Infra[InfrastructureModule<br/>configuration and DB binding only]:::active
    State[StateManagementModule]:::active
    Export[TerraformExportModule]:::active
    AI[AI TroubleshootingModule]:::active

    AppModule --> Config
    AppModule --> ORM
    AppModule --> Health
    AppModule --> Auth
    AppModule --> Users
    AppModule --> Admin
    AppModule --> Audit
    AppModule --> Projects
    AppModule --> Export
    AppModule --> AI
    Auth --> Users
    Auth --> Audit
    Admin --> Users
    Admin --> Audit
    Projects --> Infra
    Projects --> State
    Projects --> Audit
    Projects --> Users

    Historical[Historical entities registered<br/>for read compatibility]:::readmodel
    ORM --> Historical

    Dormant[Source present but not imported by AppModule:<br/>Billing, Notifications, FinOps controllers,<br/>legacy Orchestration, Storage controllers,<br/>Observability controllers, lifecycle cleanup,<br/>two-lane worker composition]:::inactive
    AppModule -.-> Dormant

    H5[H5: publish a generated runtime/module manifest<br/>so active versus dormant capability is machine-checkable]:::hotspot
    Dormant -.-> H5

    classDef active fill:#d8f3dc,stroke:#2d6a4f,color:#081c15
    classDef readmodel fill:#fef3c7,stroke:#d97706,color:#451a03
    classDef inactive fill:#e5e7eb,stroke:#6b7280,color:#111827,stroke-dasharray:5 5
    classDef hotspot fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

## 3. Frontend product journey

```mermaid
flowchart LR
    Landing[/]:::active --> OAuth[/auth/github]:::active
    OAuth --> Shell[Authenticated AppLayout]:::active
    Shell --> Projects[/projects<br/>workspace summary]:::active
    Shell --> Deploy[/deploy<br/>new deployment]:::active
    Shell --> Admin[/admin<br/>admin only]:::active
    Projects --> Overview[/projects/:id<br/>canonical overview]:::active
    Overview --> Pipeline[/projects/:id/pipeline<br/>attempts and recovery]:::active
    Overview --> Infrastructure[/projects/:id/infrastructure]:::active
    Overview --> Monitoring[/projects/:id/monitoring]:::active

    Legacy[Legacy routes:<br/>detection, preflight, env, settings,<br/>costs, troubleshooting, storage,<br/>orchestration, logs, security]:::inactive
    Legacy -->|redirect| Overview
    Legacy -->|redirect| Pipeline
    Legacy -->|redirect| Infrastructure
    Legacy -->|redirect| Monitoring

    Overview -->|poll every 5 s while active| CurrentState[GET current-state]:::active
    Pipeline -->|poll every 4 s while active| CurrentState
    Monitoring -->|poll every 30 s while live| CurrentState

    H6[H6: one shared event stream or query cache<br/>instead of page-specific polling]:::hotspot
    CurrentState -.-> H6

    classDef active fill:#d8f3dc,stroke:#2d6a4f,color:#081c15
    classDef inactive fill:#e5e7eb,stroke:#6b7280,color:#111827,stroke-dasharray:5 5
    classDef hotspot fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

### Repository analysis and readiness

```mermaid
sequenceDiagram
    actor User
    participant UI as NewProject.jsx
    participant API as ProjectsController
    participant App as GitHub App service
    participant GH as GitHub repository
    participant Detect as Detection services
    participant Contract as Deployment contract service
    participant DB as PostgreSQL

    User->>UI: Select repository
    UI->>API: List or inspect authorized repositories
    API->>App: Request installation-scoped repository access
    App->>GH: Installation-token API calls
    GH-->>UI: Repository, default branch and branches
    User->>UI: Select branch
    UI->>UI: Invalidate prior readiness immediately
    User->>UI: Review readiness
    UI->>API: Create or reuse project for repo and branch
    API->>DB: Persist repository identity
    UI->>API: POST detect-stack
    API->>GH: Resolve selected branch and commit SHA
    API->>Detect: Clone or inspect workspace
    Detect->>Detect: Stack, framework, runtime and deployability detection
    Detect->>Contract: Create authoritative BuildPlan
    Contract->>DB: Persist profile and contract keyed by repo, branch and commit
    API-->>UI: Detection profile
    opt Application environment supplied
        UI->>API: Encrypt and save application-owned values
        API->>DB: Store ciphertext and metadata
    end
    UI->>API: POST preflight
    API->>Contract: Require exact current profile and BuildPlan
    Contract-->>UI: Ready, warning or blocked
    UI->>UI: Discard stale asynchronous responses by selection ticket
```

## 4. Normal deployment orchestration

```mermaid
sequenceDiagram
    actor User
    participant UI as React UI
    participant API as GitHubActionsDeploymentService
    participant DB as PostgreSQL
    participant MDB as Managed DB reconciliation
    participant Contract as Detection contract and BuildPlan
    participant App as GitHub App service
    participant IAM as AWS IAM OIDC trust
    participant GH as Customer GitHub repository
    participant GHA as GitHub Actions

    User->>UI: Deploy, retry, rollback or destroy
    UI->>API: Authorized operation request
    API->>DB: Acquire per-project PostgreSQL advisory lock
    API->>API: Reconcile any active operation
    alt Active operation still running
        API-->>UI: Safe no-op with existing operation
    else No active operation
        opt Deploy or retry
            API->>MDB: Reconcile EFS, binding, secrets, state and backup evidence
            MDB-->>API: Managed database reconciliation report
            API->>API: Resolve FRESH, UPDATE, RETRY, RESTORE or RESET_FRESH
            API->>Contract: Require deployable exact BuildPlan
        end
        API->>App: Validate pinned reusable workflow
        App->>GH: Create or update managed deployguard.yml caller
        Note over App,GH: A caller update advances the selected branch commit
        API->>GH: Resolve branch head after caller update
        API->>Contract: Automatically refresh stale repository analysis
        API->>API: Validate repo, branch and commit identity
        API->>API: Build immutable configuration snapshot and secret references
        API->>IAM: Ensure repository-specific OIDC subject is authorized
        API->>DB: Persist queued attempt and immutable dispatch inputs
        API->>GHA: workflow_dispatch on selected branch
        GHA-->>API: Run ID when discovered
        API->>DB: Persist run identity and dispatch state
        API-->>UI: Accepted operation
    end
    API->>DB: Release advisory lock
```

### Recovery and persistence decision

```mermaid
stateDiagram-v2
    [*] --> Reconcile
    Reconcile: Read project contract, binding, EFS, access point,
    Reconcile: secret presence, Terraform addresses and backup metadata

    Reconcile --> ResetFresh: Explicit reset supersedes old generation
    ResetFresh: mode RESET_FRESH
    ResetFresh: persistentState NONE
    ResetFresh: recoveryRequired false
    ResetFresh --> Allowed

    Reconcile --> Fresh: No persistent generation was ever established
    Fresh: mode FRESH or RETRY
    Fresh: persistentState NONE
    Fresh: recoveryRequired false
    Fresh --> Allowed

    Reconcile --> Existing: Current owned persistent storage exists
    Existing: mode UPDATE, RETRY or RESTORE
    Existing: plan decides destructive risk
    Existing --> Allowed

    Reconcile --> MissingWithBackup: Previous persistent generation missing
    MissingWithBackup: verified recovery point exists
    MissingWithBackup: mode RESTORE
    MissingWithBackup --> RestoreRequired

    Reconcile --> MissingWithoutBackup: Previous persistent generation missing
    MissingWithoutBackup: no verified recovery point
    MissingWithoutBackup: recoveryState BLOCKED
    MissingWithoutBackup --> ResetRequired

    Allowed --> TerraformPolicy
    TerraformPolicy: Reject cross-project ownership changes
    TerraformPolicy: Protect retained EFS and secrets
    TerraformPolicy: Require recovery evidence for destructive persistent changes
    TerraformPolicy --> DispatchAllowed
    RestoreRequired --> [*]
    ResetRequired --> [*]
    DispatchAllowed --> [*]
```

## 5. Reusable workflow internals

```mermaid
flowchart TD
    Dispatch[workflow_dispatch caller]:::external --> Pin[Immutable reusable workflow SHA]:::active
    Pin --> Checkout[Checkout exact application commit]:::active
    Checkout --> OIDC[Configure AWS credentials through OIDC]:::active
    OIDC --> Validate[Validate immutable operation and BuildPlan contracts]:::active
    Validate --> Action{Operation}:::active

    Action -->|deploy| Identity[Derive immutable image and release identity]:::active
    Identity --> Repo[Ensure owned ECR repository]:::active
    Repo --> Container[Materialize Docker contract]:::active
    Container --> Build[Build and push digest-addressed image]:::active

    Action -->|destroy| Terraform
    Build --> Terraform[Install and generate Terraform]:::active
    Terraform --> Init[Initialize encrypted project and environment S3 state]:::active
    Init --> Reconcile[Reconcile or import owned resources and retained DB identity]:::active
    Reconcile --> Plan[terraform plan or plan -destroy]:::active
    Plan --> Policy[JSON plan ownership and persistence policy]:::active
    Policy --> Apply[Apply saved plan]:::active

    Apply -->|deploy| Health[Wait for ECS stability and healthy ALB target]:::active
    Apply -->|destroy| RemoveECR[Remove project image repository]:::active
    RemoveECR --> Absence[Verify bounded infrastructure absence]:::active

    Action -->|rollback| Rollback[Update ECS to immutable prior task definition]:::active
    Rollback --> Health

    Health --> ReleaseMarker[DEPLOYGUARD_RELEASE_RESULT]:::active
    Absence --> DestroyMarker[DEPLOYGUARD_DESTROY_RESULT]:::active
    ReleaseMarker --> Upload[Upload result artifact and preserve job log evidence]:::active
    DestroyMarker --> Upload

    DBPath[Optional managed database path:<br/>ECS database service, EFS, access point,<br/>Cloud Map and Secrets Manager]:::external
    Terraform --> DBPath

    H7[H7: split the 1,510-line workflow into<br/>versioned scripts or composite actions]:::hotspot
    H8[H8: use tested Terraform modules instead of<br/>generating a large main.tf inside YAML]:::hotspot
    H9[H9: add explicit S3 lockfile or DynamoDB locking<br/>as defense beyond control-plane advisory locks]:::hotspot
    H10[H10: add HTTPS listener, ACM certificate<br/>and HTTP-to-HTTPS redirect for non-local use]:::hotspot
    Pin -.-> H7
    Terraform -.-> H8
    Init -.-> H9
    Health -.-> H10

    classDef active fill:#d8f3dc,stroke:#2d6a4f,color:#081c15
    classDef external fill:#dbeafe,stroke:#2563eb,color:#172554
    classDef hotspot fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

### AWS resource topology per project and environment

```mermaid
flowchart TD
    Internet[Internet]:::external --> ALB[Internet-facing ALB<br/>listener and target group]:::active
    ALB --> AppSG[Application security group]:::active
    AppSG --> AppService[ECS application service<br/>desired count 1]:::active
    AppService --> AppTask[Immutable ECS task definition<br/>ECR image digest]:::active
    AppTask --> AppLogs[CloudWatch app log group]:::active
    AppTask --> AppRole[IAM execution and task roles]:::active
    AppTask --> AppSecrets[Application secret references]:::active

    subgraph OptionalManagedDatabase[Optional managed PostgreSQL database]
        Discovery[Cloud Map service]:::active
        DBService[ECS database service]:::active
        DBTask[Database task definition]:::active
        EFS[EFS filesystem]:::active
        AP[EFS access point]:::active
        DBSecrets[Password and URL secrets]:::active
        DBLogs[CloudWatch database logs]:::active
        Discovery --> DBService
        DBService --> DBTask
        DBTask --> AP
        AP --> EFS
        DBTask --> DBSecrets
        DBTask --> DBLogs
    end

    AppTask -.->|when BuildPlan requires database| Discovery
    AppTask -.-> DBSecrets

    S3[(S3 state key:<br/>projects/projectId/environment/terraform.tfstate)]:::external
    All[Terraform-owned resource graph]:::active --> S3
    All --> ALB
    All --> AppService
    All --> Discovery
    All --> DBService
    All --> EFS
    All --> DBSecrets

    classDef active fill:#d8f3dc,stroke:#2d6a4f,color:#081c15
    classDef external fill:#dbeafe,stroke:#2563eb,color:#172554
```

## 6. Result ingestion and canonical current state

```mermaid
sequenceDiagram
    participant UI as Overview or pipeline UI
    participant API as Current-state and deployment APIs
    participant GH as GitHub Actions API
    participant Log as Completed job log
    participant DB as PostgreSQL
    participant AWS as AWS evidence readers

    loop While the operation is active
        UI->>API: GET current-state, status or history
        API->>DB: Load latest active attempt
        API->>GH: Find run, read status, jobs and steps
        GH-->>API: Run status and stage evidence
        API->>DB: Persist current stage
        API-->>UI: Canonical projected state
    end

    GH-->>API: Run completed
    API->>Log: Download completed job log
    API->>API: Extract Terraform plan summary
    API->>API: Extract release or destroy result marker
    API->>API: Validate operation, commit, environment,
    API->>API: image digest, configuration fingerprint,
    API->>API: secret names and database binding identity
    opt Managed database
        API->>AWS: Validate task definition and Terraform DB outputs
        API->>DB: Mark database binding verified
    end
    alt Valid deploy or rollback evidence
        API->>DB: Complete attempt and promote stable release
        API->>DB: Demote prior stable release to rollback target
    else Valid destroy evidence
        API->>DB: Complete attempt as verified destroyed
    else Missing or mismatched evidence
        API->>DB: Fail attempt at evidence validation stage
    end
    API->>AWS: Project current-state evidence reads where configured
    API-->>UI: LIVE, DESTROYED, FAILED, BLOCKED or in-progress projection

    Note over UI,API: There is no active webhook or always-on reconciliation worker.
    Note over UI,API: A status read currently drives remote reconciliation.
```

## 7. Control-plane data architecture

```mermaid
flowchart LR
    subgraph Identity[Identity and authorization]
        Users[(users)]:::active
        Installations[(github_app_installations)]:::active
        Audit[(audit_logs)]:::active
    end

    subgraph ProjectDefinition[Project definition and analysis]
        Projects[(projects)]:::active
        Env[(project_environment_variables<br/>encrypted values)]:::active
        Profiles[(project_detection_profiles)]:::active
        Contracts[(project_deployment_contracts<br/>authoritative BuildPlan)]:::active
        Requirements[(project_deployment_requirements)]:::active
        Tiers[(project_database_tiers)]:::active
        Preflight[(project_preflight_reports)]:::active
    end

    subgraph Execution[Execution and immutable release evidence]
        Snapshots[(project_configuration_snapshots)]:::active
        Runs[(project_pipeline_runs)]:::active
        Events[(project_pipeline_events)]:::active
        Finality[(project_pipeline_job_finalities)]:::active
        Stable[(project_stable_releases)]:::active
        Bindings[(project_service_bindings)]:::active
    end

    subgraph StateRecovery[State and recovery]
        TFState[(project_terraform_states)]:::active
        TFLocks[(project_terraform_locks)]:::active
        Recovery[(project_state_recovery_requests)]:::active
        Backups[(project_backup_records)]:::active
        Persistent[(project_persistent_storage)]:::readmodel
    end

    Users --> Projects
    Users --> Installations
    Users --> Audit
    Projects --> Env
    Projects --> Profiles
    Profiles --> Contracts
    Projects --> Requirements
    Projects --> Tiers
    Projects --> Preflight
    Contracts --> Snapshots
    Projects --> Runs
    Runs --> Events
    Runs --> Finality
    Runs --> Stable
    Runs --> Bindings
    Projects --> TFState
    Projects --> TFLocks
    Projects --> Recovery
    Projects --> Backups
    Projects --> Persistent

    Historical[(Legacy infrastructure, cost, orchestration,<br/>storage and runtime metric rows remain readable)]:::readmodel
    Projects --> Historical

    NextGen[(Two-lane manifests, intents, outbox,<br/>leases, side effects and ownership entities<br/>exist in source and migrations but are not<br/>the active GitHub Actions product path)]:::inactive
    Projects -.-> NextGen

    H11[H11: document retention and ownership per table,<br/>then archive or isolate retired schemas]:::hotspot
    Historical -.-> H11
    NextGen -.-> H11

    classDef active fill:#d8f3dc,stroke:#2d6a4f,color:#081c15
    classDef readmodel fill:#fef3c7,stroke:#d97706,color:#451a03
    classDef inactive fill:#e5e7eb,stroke:#6b7280,color:#111827,stroke-dasharray:5 5
    classDef hotspot fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

## 8. Security and trust boundaries

```mermaid
flowchart LR
    Browser[Browser]:::external -->|HttpOnly signed session cookie| Auth[AuthenticatedUserMiddleware]:::active
    Auth -->|role guards| API[Protected NestJS routes]:::active
    API -->|RS256 app JWT| GitHubApp[GitHub App API]:::external
    GitHubApp -->|short-lived installation token| Repo[Authorized repositories only]:::external
    API -->|repository-specific trust subject| IAM[AWS OIDC role trust]:::external
    Workflow[GitHub workflow]:::external -->|short-lived OIDC credentials| IAM
    Workflow -->|secret ARNs, not secret values in evidence| Secrets[AWS Secrets Manager]:::external
    API -->|encrypted application values| DB[(PostgreSQL)]:::active
    Workflow -->|encrypted backend| S3[(Terraform state S3)]:::external
    Logs[GitHub job logs]:::external --> Sanitizer[Log sanitizer and bounded safe evidence]:::active
    Sanitizer --> DB

    H12[H12: productionize TLS, secret rotation,<br/>session-key rotation and audit alerting]:::hotspot
    H13[H13: continuously test OIDC subject customization<br/>and least-privilege IAM policy drift]:::hotspot
    Auth -.-> H12
    IAM -.-> H13

    classDef active fill:#d8f3dc,stroke:#2d6a4f,color:#081c15
    classDef external fill:#dbeafe,stroke:#2563eb,color:#172554
    classDef hotspot fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

## 9. Improvement roadmap

These are architectural opportunities discovered from the active composition. They are not claims that the successful bounded deployment is broken.

| ID | Priority | Current evidence | Potential improvement | Expected benefit |
|---|---:|---|---|---|
| H1 | P1 | `latest()` and `history()` reconcile GitHub state during API reads; completion can wait for a user poll. | Add an authenticated GitHub `workflow_run` webhook or a small bounded server-side reconciler. Keep read-time reconciliation as fallback. | Deterministic completion, less UI dependence, faster stable-release promotion. |
| H2 | P1 | `ensureWorkflow()` commits the managed caller to the selected customer branch, then detection must refresh because the commit changed. | Install/update the caller once during project connection, expose caller drift separately, and avoid updating it inside every deployment transaction. | Cleaner source identity, fewer surprise commits, simpler retry semantics. |
| H3/H9 | P1 | Terraform uses an encrypted S3 backend, while the backend advisory lock ends after dispatch. The backend command shown does not enable S3 lockfiles or a DynamoDB lock table. | Enable Terraform S3 lockfile support or DynamoDB locking and test lock contention from two independent executors. | Defense against concurrent state mutation outside the control-plane process. |
| H6 | P1 | Overview and pipeline poll every 5 s and 4 s; each poll may call GitHub APIs. | Centralize server reconciliation and publish state through SSE/WebSocket or a shared query cache with backoff and ETags. | Lower GitHub rate usage, fewer duplicate requests, smoother UI. |
| H7 | P1 | `deployguard-reusable.yml` is about 1,510 lines and contains shell, policy, Terraform generation and evidence logic. | Extract pinned scripts/composite actions with unit tests and checksums while preserving the immutable workflow entry contract. | Easier review, safer changes, clearer failures. |
| H8 | P1 | A large Terraform configuration is generated inline by workflow shell. | Move the resource graph into versioned Terraform modules and make the workflow only materialize inputs and run policy. | Native Terraform validation, smaller workflow diffs, reusable plans. |
| H14 | P1 | The live test showed Prometheus monitoring unavailable; monitoring currently relies on deployment-time ECS/ALB evidence. | Add CloudWatch-native CPU, memory, task count, ALB 5xx/latency alarms first; make Prometheus/Grafana optional. | Useful default operations without another monitoring stack. |
| H15 | P1 | Applications without an explicit health endpoint use `/`; ECS container health can remain `UNKNOWN` even when ALB is healthy. | Extend BuildPlan certification with a health endpoint contract and generate an ECS container health check when supported. | Earlier runtime failure detection and consistent ECS/ALB health semantics. |
| H10 | P1 before public production | Current generated ALB path is HTTP. | Add ACM-managed HTTPS, HTTP-to-HTTPS redirect, configurable DNS, secure headers and optional WAF. | Production-grade transport security. |
| H11 | P2 | Many historical and next-generation entities coexist with the smaller active module graph. | Publish a schema ownership catalog and move inactive models behind explicit feature modules or archival migrations. | Lower cognitive load and migration risk. |
| H5 | P2 | Source presence does not mean runtime activation; this is currently learned by reading `AppModule`. | Generate a startup capability manifest and expose it through an admin/readiness endpoint. | Operators can see exactly which engine and modules are active. |
| H4 | P2 | Package engines require Node 22, but no `.nvmrc` or `.node-version` exists and a normal shell selected Node 20. | Add both version-manager files and a shell/CI verification test. | Fewer local runtime mismatches. |
| H12/H13 | P2 | Strong trust boundaries exist, but production hardening is operational rather than visible in one policy plane. | Add scheduled key/secret rotation checks, IAM drift tests, session-key rotation procedure and alerting for sensitive audit events. | Better long-lived security posture. |
| H16 | P2 | Managed persistence safety depends on EFS identity plus recoverable AWS Backup evidence. | Automate backup-plan enrollment, retention verification and periodic restore drills before calling a database tier production-ready. | Proven recoverability rather than metadata-only confidence. |
| H17 | P3 | The active product is optimized around canonical `dev` deployment and one small ECS service. | Add explicit environment promotion, quotas, scaling policy and cost guardrails only when multi-environment use becomes a requirement. | Controlled growth without weakening the current simple path. |

## 10. Suggested implementation order

```mermaid
flowchart LR
    A[1. Push-driven reconciliation<br/>H1 + H6]:::hotspot --> B[2. Remote state locking<br/>H3 + H9]:::hotspot
    B --> C[3. Workflow and Terraform decomposition<br/>H7 + H8]:::hotspot
    C --> D[4. Default observability and health contract<br/>H14 + H15]:::hotspot
    D --> E[5. Caller lifecycle and schema clarity<br/>H2 + H5 + H11]:::hotspot
    E --> F[6. Production security and recovery drills<br/>H10 + H12 + H13 + H16]:::hotspot
    F --> G[7. Multi-environment expansion<br/>H17]:::hotspot

    classDef hotspot fill:#fee2e2,stroke:#dc2626,color:#450a0a
```

The first two steps improve correctness and operational independence without redesigning the deployment contract. Workflow decomposition should follow only after the current immutable workflow has a frozen compatibility test suite, because it is the highest-change surface in the system.

## 11. Source-of-truth map

| Concern | Primary source |
|---|---|
| Local integrated startup | `scripts/local-product.mjs` |
| Active backend composition | `backend/src/app.module.ts` |
| Frontend route composition | `frontend/src/routes/AppRoutes.jsx` |
| New repository deployment journey | `frontend/src/pages/NewProject.jsx` |
| Project HTTP API | `backend/src/projects/projects.controller.ts` |
| Detection and BuildPlan creation | `backend/src/projects/detection/` and `backend/src/projects/deployment-contract.service.ts` |
| State-aware deploy/retry/reset/destroy | `backend/src/projects/github-actions-deployment.service.ts` |
| Recovery state machine | `backend/src/projects/deployment-recovery-decision.ts` |
| Managed database drift classification | `backend/src/projects/managed-database-reconciliation.ts` |
| GitHub App and generated caller | `backend/src/projects/github-app.service.ts` |
| GitHub dispatch and evidence API | `backend/src/projects/pipeline/github-actions.service.ts` |
| Reusable workflow and Terraform policy | `.github/workflows/deployguard-reusable.yml` |
| Canonical current-state projection | `backend/src/projects/current-state/project-current-state.service.ts` |
| Overview and pipeline presentation | `frontend/src/components/projects/ProjectOverviewLifecycle.jsx` and `frontend/src/components/projects/PipelineExecution.jsx` |
