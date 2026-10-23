# DeployGuard Extended Entity-Relationship Diagram

This document represents the current migrated PostgreSQL model. It covers 84 application tables and the 182 enforced foreign-key relationships present in the local schema. The diagrams are split by domain so the model remains readable.

Legend:

- `||` exactly one
- `o|` zero or one
- `o{` zero or many
- `|{` one or many
- Solid relationships represent database foreign keys.
- Relationships labelled `logical` describe identifier-based associations without a database foreign key.

## 1. Core project and deployment-generation lifecycle

```mermaid
erDiagram
    USERS ||--o{ PROJECTS : owns
    USERS ||--o{ PROJECT_PIPELINE_RUNS : triggers
    USERS ||--o{ PROJECT_USER_ACTIVITY : performs
    GITHUB_APP_INSTALLATIONS ||..o{ PROJECTS : "logical installation link"
    USERS ||--o{ GITHUB_APP_INSTALLATIONS : owns

    PROJECTS ||--o{ PROJECT_DETECTION_PROFILES : detects
    PROJECTS ||--o{ PROJECT_DEPLOYMENT_CONTRACTS : defines
    PROJECT_DETECTION_PROFILES o|--o{ PROJECT_DEPLOYMENT_CONTRACTS : supports
    PROJECTS ||--o{ PROJECT_PREFLIGHT_REPORTS : evaluates
    PROJECT_DETECTION_PROFILES o|--o{ PROJECT_PREFLIGHT_REPORTS : supplies
    PROJECTS ||--o| PROJECT_DEPLOYMENT_REQUIREMENTS : requires
    PROJECTS ||--o{ PROJECT_DEPLOYMENT_READINESS_SNAPSHOTS : snapshots
    USERS o|--o{ PROJECT_DEPLOYMENT_READINESS_SNAPSHOTS : creates

    PROJECTS ||--o{ PROJECT_DEPLOYMENT_GENERATIONS : partitions
    PROJECT_DEPLOYMENT_GENERATIONS ||--o{ PROJECT_PIPELINE_RUNS : scopes
    PROJECTS ||--o{ PROJECT_PIPELINE_RUNS : runs
    PROJECT_PIPELINE_RUNS ||--o{ PROJECT_PIPELINE_EVENTS : emits
    PROJECT_PIPELINE_RUNS ||--o| PROJECT_PIPELINE_JOB_FINALITIES : finalizes
    PROJECT_PIPELINE_RUNS ||--o{ PROJECT_STAGE_CHECKPOINTS : checkpoints
    PROJECT_PIPELINE_RUNS ||--o{ PROJECT_DEPLOYMENT_QUEUE_ITEMS : queues

    PROJECTS ||--o{ PROJECT_CONFIGURATION_SNAPSHOTS : owns
    PROJECT_PIPELINE_RUNS ||--o{ PROJECT_CONFIGURATION_SNAPSHOTS : freezes
    PROJECT_PIPELINE_RUNS o|--o| PROJECT_CONFIGURATION_SNAPSHOTS : selects
    PROJECTS ||--o{ PROJECT_ENVIRONMENT_VARIABLES : configures

    PROJECTS ||--o{ PROJECT_SERVICE_BINDINGS : binds
    PROJECT_DEPLOYMENT_GENERATIONS ||--o{ PROJECT_SERVICE_BINDINGS : isolates
    PROJECT_PIPELINE_RUNS ||--o{ PROJECT_SERVICE_BINDINGS : verifies
    PROJECT_SERVICE_BINDINGS o|--o{ PROJECT_ENVIRONMENT_VARIABLES : owns
    PROJECTS ||--o| PROJECT_DATABASE_TIERS : configures
    PROJECT_DEPLOYMENT_GENERATIONS o|--o{ PROJECT_DATABASE_TIERS : activates

    PROJECTS ||--o{ PROJECT_STABLE_RELEASES : releases
    PROJECT_DEPLOYMENT_GENERATIONS ||--o{ PROJECT_STABLE_RELEASES : contains
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_STABLE_RELEASES : establishes
    PROJECTS ||--o{ PROJECT_ENVIRONMENT_ROUTES : routes
    PROJECT_DEPLOYMENT_GENERATIONS o|--o{ PROJECT_ENVIRONMENT_ROUTES : live
    PROJECT_DEPLOYMENT_GENERATIONS o|--o{ PROJECT_ENVIRONMENT_ROUTES : candidate
    PROJECTS ||--o{ PROJECT_ROLLBACK_RECORDS : records
    PROJECTS ||--o{ PROJECT_DEPLOYMENTS : projects

    USERS {
      int id PK
      string github_id UK
      string role
      timestamptz disabled_at
    }
    PROJECTS {
      uuid id PK
      int owner_user_id FK
      string repository_full_name
      string target_branch
      uuid deletion_intent_id FK
    }
    PROJECT_DEPLOYMENT_GENERATIONS {
      uuid id PK
      uuid project_id FK
      string environment_name
      int ordinal
      string status
      string terraform_state_key
    }
    PROJECT_PIPELINE_RUNS {
      uuid id PK
      uuid project_id FK
      uuid generation_id FK
      uuid configuration_snapshot_id FK
      string commit_sha
      string status
      jsonb metadata
    }
    PROJECT_STABLE_RELEASES {
      uuid id PK
      uuid project_id FK
      uuid generation_id FK
      uuid deployed_by_pipeline_run_id FK
      string status
      string commit_sha
      string image_uri
    }
    PROJECT_ENVIRONMENT_ROUTES {
      uuid id PK
      uuid project_id FK
      uuid live_generation_id FK
      uuid candidate_generation_id FK
      int listener_priority
    }
```

## 2. Immutable orchestration, manifests, and side-effect fencing

```mermaid
erDiagram
    PROJECTS ||--o{ DEPLOYMENT_INTENTS : requests
    USERS o|--o{ DEPLOYMENT_INTENTS : requests
    PROJECT_PIPELINE_RUNS o|--o{ DEPLOYMENT_INTENTS : executes
    PROJECT_PIPELINE_RUNS o|--o{ DEPLOYMENT_INTENTS : sources

    PROJECTS ||--o{ INFRASTRUCTURE_MANIFESTS : owns
    USERS o|--o{ INFRASTRUCTURE_MANIFESTS : creates
    DEPLOYMENT_INTENTS o|--o{ INFRASTRUCTURE_MANIFESTS : creates
    INFRASTRUCTURE_MANIFESTS o|--o{ INFRASTRUCTURE_MANIFESTS : parent
    INFRASTRUCTURE_MANIFESTS o|--o{ DEPLOYMENT_INTENTS : selected_by

    PROJECTS ||--o{ RELEASE_MANIFESTS : owns
    INFRASTRUCTURE_MANIFESTS ||--o{ RELEASE_MANIFESTS : supports
    RELEASE_MANIFESTS o|--o{ RELEASE_MANIFESTS : parent
    RELEASE_MANIFESTS o|--o{ RELEASE_MANIFESTS : previous_stable
    DEPLOYMENT_INTENTS o|--o{ RELEASE_MANIFESTS : creates
    PROJECT_DEPLOYMENT_CONTRACTS o|--o{ RELEASE_MANIFESTS : constrains
    PROJECT_CONFIGURATION_SNAPSHOTS o|--o{ RELEASE_MANIFESTS : configures
    PROJECT_PIPELINE_RUNS o|--o{ RELEASE_MANIFESTS : executes
    RELEASE_MANIFESTS o|--o{ DEPLOYMENT_INTENTS : selected_by

    PROJECTS ||--o{ INITIAL_RELEASE_DRAFTS : drafts
    DEPLOYMENT_INTENTS ||--o{ INITIAL_RELEASE_DRAFTS : plans
    INFRASTRUCTURE_MANIFESTS ||--o{ INITIAL_RELEASE_DRAFTS : targets
    DEPLOYMENT_INTENTS ||--o{ ORCHESTRATION_OUTBOX : emits

    PROJECTS ||--o{ PROJECT_OPERATION_LEASES : fences
    DEPLOYMENT_INTENTS ||--o{ PROJECT_OPERATION_LEASES : owns
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_OPERATION_LEASES : correlates

    PROJECTS ||--o{ DEPLOYMENT_SIDE_EFFECTS : journals
    DEPLOYMENT_INTENTS ||--o{ DEPLOYMENT_SIDE_EFFECTS : owns
    PROJECT_OPERATION_LEASES ||--o{ DEPLOYMENT_SIDE_EFFECTS : fences
    DEPLOYMENT_SIDE_EFFECTS ||--o{ DEPLOYMENT_SIDE_EFFECT_RECONCILIATIONS : reconciles
    DEPLOYMENT_INTENTS ||--o{ DEPLOYMENT_SIDE_EFFECT_RECONCILIATIONS : owns
    DEPLOYMENT_SIDE_EFFECT_RECONCILIATION_LEASES ||--o{ DEPLOYMENT_SIDE_EFFECT_RECONCILIATIONS : fences
    PROJECTS ||--o{ DEPLOYMENT_SIDE_EFFECT_RECONCILIATION_LEASES : owns
    DEPLOYMENT_INTENTS ||--o{ DEPLOYMENT_SIDE_EFFECT_RECONCILIATION_LEASES : owns
    DEPLOYMENT_SIDE_EFFECTS ||--o{ DEPLOYMENT_SIDE_EFFECT_RECONCILIATION_LEASES : leases

    PROJECTS ||--o{ PROJECT_STATE_REVISIONS : versions
    PROJECTS ||--o{ PROJECT_ORCHESTRATION_EVENTS : emits
    PROJECT_DEPLOYMENTS o|--o{ PROJECT_ORCHESTRATION_EVENTS : correlates
    USERS o|--o{ PROJECT_ORCHESTRATION_EVENTS : acts
    PROJECTS ||--o{ PROJECT_RELEASE_LANE_OWNERSHIPS : fences
    DEPLOYMENT_INTENTS ||--o{ PROJECT_RELEASE_LANE_OWNERSHIPS : owns
    PROJECT_OPERATION_LEASES ||--o{ PROJECT_RELEASE_LANE_OWNERSHIPS : leases
    PROJECT_RELEASE_LANE_OWNERSHIPS ||--o{ PROJECT_PIPELINE_RUNS : correlates
    PROJECT_RELEASE_LANE_OWNERSHIPS ||--o{ PROJECT_ROLLBACK_RECORDS : correlates
    PROJECTS ||--o{ PROJECT_RELEASE_LANE_SHADOW_OBSERVATIONS : observes

    PROJECTS ||--o{ RELEASE_IMAGE_PROVENANCES : proves
    DEPLOYMENT_INTENTS ||--o{ RELEASE_IMAGE_PROVENANCES : builds
    INFRASTRUCTURE_MANIFESTS ||--o{ RELEASE_IMAGE_PROVENANCES : targets
    RELEASE_MANIFESTS o|--o{ PROJECT_STABLE_RELEASES : projects
    WORKER_CAPABILITIES {
      uuid id PK
      string worker_id
      string capability
      string status
    }

    DEPLOYMENT_INTENTS {
      uuid id PK
      uuid project_id FK
      uuid pipeline_run_id FK
      string intent_type
      string status
      string idempotency_key
    }
    INFRASTRUCTURE_MANIFESTS {
      uuid id PK
      uuid project_id FK
      uuid parent_manifest_id FK
      int revision
      jsonb manifest
    }
    RELEASE_MANIFESTS {
      uuid id PK
      uuid project_id FK
      uuid infrastructure_manifest_id FK
      uuid parent_manifest_id FK
      string commit_sha
      string spec_hash
    }
```

## 3. Infrastructure, Terraform state, persistence, and cleanup

```mermaid
erDiagram
    PROJECTS ||--o{ PROJECT_INFRASTRUCTURE_ENVIRONMENTS : environments
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_INFRASTRUCTURE_ENVIRONMENTS : applies
    INFRASTRUCTURE_MANIFESTS o|--o{ PROJECT_INFRASTRUCTURE_ENVIRONMENTS : desired
    INFRASTRUCTURE_MANIFESTS o|--o{ PROJECT_INFRASTRUCTURE_ENVIRONMENTS : applied

    PROJECTS ||--o{ PROJECT_INFRASTRUCTURE_EVENTS : emits
    PROJECT_INFRASTRUCTURE_ENVIRONMENTS o|--o{ PROJECT_INFRASTRUCTURE_EVENTS : concerns
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_INFRASTRUCTURE_EVENTS : correlates
    USERS o|--o{ PROJECT_INFRASTRUCTURE_EVENTS : acts

    PROJECTS ||--o{ PROJECT_TERRAFORM_STATES : stores
    PROJECT_INFRASTRUCTURE_ENVIRONMENTS o|--o{ PROJECT_TERRAFORM_STATES : materializes
    PROJECTS ||--o{ PROJECT_TERRAFORM_LOCKS : locks
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_TERRAFORM_LOCKS : owns
    PROJECTS ||--o{ PROJECT_STATE_VALIDATION_RESULTS : validates
    PROJECT_INFRASTRUCTURE_ENVIRONMENTS o|--o{ PROJECT_STATE_VALIDATION_RESULTS : checks
    PROJECTS ||--o{ PROJECT_STATE_RECOVERY_REQUESTS : recovers
    PROJECTS ||--o| PROJECT_CLOUD_STATES : projects

    PROJECTS ||--o{ PROJECT_PERSISTENT_STORAGE : owns
    PROJECT_INFRASTRUCTURE_ENVIRONMENTS o|--o{ PROJECT_PERSISTENT_STORAGE : hosts
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_PERSISTENT_STORAGE : provisions
    PROJECT_PERSISTENT_STORAGE ||--o{ PROJECT_BACKUP_RECORDS : backs_up
    PROJECTS ||--o{ PROJECT_BACKUP_RECORDS : owns
    PROJECTS ||--o{ PROJECT_STORAGE_EVENTS : emits
    PROJECT_PERSISTENT_STORAGE o|--o{ PROJECT_STORAGE_EVENTS : concerns
    USERS o|--o{ PROJECT_STORAGE_EVENTS : acts
    PROJECTS ||--o{ PROJECT_STORAGE_RESTORE_REQUESTS : requests
    PROJECT_PERSISTENT_STORAGE ||--o{ PROJECT_STORAGE_RESTORE_REQUESTS : restores
    USERS o|--o{ PROJECT_STORAGE_RESTORE_REQUESTS : requests
    USERS o|--o{ PROJECT_STORAGE_RESTORE_REQUESTS : approves

    PROJECTS ||--o{ PROJECT_SERVICE_DISCOVERY_RECORDS : discovers
    PROJECT_INFRASTRUCTURE_ENVIRONMENTS ||--o{ PROJECT_SERVICE_DISCOVERY_RECORDS : contains
    PROJECTS ||--o{ CENTRAL_CLOUD_RESOURCES : registers
    PROJECTS ||--o{ CLOUD_INVENTORY_SCANS : scans
    PROJECTS ||--o{ PROJECT_LEGACY_RESOURCE_QUARANTINES : quarantines

    PROJECTS ||--o{ INFRASTRUCTURE_DESTROY_CHALLENGES : challenges
    PROJECTS ||--o{ INFRASTRUCTURE_DESTROY_OPERATIONS : destroys
    DEPLOYMENT_INTENTS o|--o{ INFRASTRUCTURE_DESTROY_OPERATIONS : requests
    INFRASTRUCTURE_MANIFESTS o|--o{ INFRASTRUCTURE_DESTROY_OPERATIONS : targets
    INFRASTRUCTURE_DESTROY_OPERATIONS o|--o{ DEPLOYMENT_INTENTS : selected_by
    INFRASTRUCTURE_DESTROY_OPERATIONS o|--o{ PROJECT_OPERATION_LEASES : fences
    CLOUD_CLEANUP_OPERATIONS {
      uuid id PK
      string scope
      string status
      jsonb evidence
    }
    EMERGENCY_CLEANUP_OPERATIONS {
      uuid id PK
      string scope
      string status
      jsonb evidence
    }
    CENTRAL_CLEANUP_CHALLENGES {
      uuid id PK
      string challenge_type
      timestamptz expires_at
    }
    PROJECTS ||--o{ TERRAFORM_EXPORT_ARTIFACTS : exports
```

## 4. Security, cost, observability, notifications, and AI evidence

```mermaid
erDiagram
    PROJECTS ||--o{ PROJECT_SECURITY_FINDINGS : owns
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_SECURITY_FINDINGS : correlates

    PROJECTS ||--o| PROJECT_COST_SETTINGS : configures
    USERS o|--o{ PROJECT_COST_SETTINGS : updates
    PROJECTS ||--o{ PROJECT_COST_ESTIMATES : estimates
    PROJECT_DEPLOYMENT_GENERATIONS ||--o{ PROJECT_COST_ESTIMATES : scopes
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_COST_ESTIMATES : correlates
    USERS o|--o{ PROJECT_COST_ESTIMATES : creates
    USERS o|--o{ PROJECT_COST_ESTIMATES : approves
    USERS o|--o{ PROJECT_COST_ESTIMATES : rejects
    PROJECT_COST_ESTIMATES ||--o{ PROJECT_COST_RESOURCE_BREAKDOWNS : contains
    PROJECTS ||--o{ PROJECT_COST_RESOURCE_BREAKDOWNS : owns
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_COST_RESOURCE_BREAKDOWNS : correlates

    PROJECTS ||--o| NOTIFICATION_PREFERENCES : configures
    PROJECTS ||--o{ NOTIFICATION_SUBSCRIPTIONS : subscribes
    PROJECTS ||--o{ NOTIFICATION_DELIVERIES : delivers

    PROJECTS ||--o{ AI_ANALYSIS_SESSIONS : troubleshoots
    AI_ANALYSIS_SESSIONS ||--o{ AI_ANALYSIS_MESSAGES : contains
    AI_ANALYSIS_SESSIONS ||--o{ AI_ANALYSIS_RESULTS : produces

    PROJECTS ||--o{ PROJECT_LOG_STREAM_SESSIONS : streams
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_LOG_STREAM_SESSIONS : correlates
    PROJECT_DEPLOYMENTS o|--o{ PROJECT_LOG_STREAM_SESSIONS : observes
    USERS o|--o{ PROJECT_LOG_STREAM_SESSIONS : opens

    PROJECTS ||--o{ PROJECT_OBSERVABILITY_EVENTS : emits
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_OBSERVABILITY_EVENTS : correlates
    PROJECT_DEPLOYMENTS o|--o{ PROJECT_OBSERVABILITY_EVENTS : observes
    USERS o|--o{ PROJECT_OBSERVABILITY_EVENTS : acts

    PROJECTS ||--o{ PROJECT_PIPELINE_METRIC_SUMMARIES : summarizes
    PROJECT_PIPELINE_RUNS ||--o{ PROJECT_PIPELINE_METRIC_SUMMARIES : measures
    PROJECTS ||--o{ PROJECT_RUNTIME_METRIC_SNAPSHOTS : samples
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_RUNTIME_METRIC_SNAPSHOTS : correlates
    PROJECT_DEPLOYMENTS o|--o{ PROJECT_RUNTIME_METRIC_SNAPSHOTS : measures
    PROJECTS ||--o{ PROJECT_STAGE_METRICS : measures
    PROJECT_PIPELINE_RUNS o|--o{ PROJECT_STAGE_METRICS : correlates
    PROJECT_DEPLOYMENTS o|--o{ PROJECT_STAGE_METRICS : measures
    PROJECTS ||--o{ PROJECT_SPOT_INTERRUPTION_EVENTS : records
```

## 5. Identity-adjacent billing and audit data

These tables currently use identifier columns for several logical associations without enforcing all of them as PostgreSQL foreign keys. They are shown separately to distinguish that fact from the enforced project lifecycle graph.

```mermaid
erDiagram
    USERS ||..o{ BILLING_ACCOUNTS : "logical account owner"
    BILLING_ACCOUNTS ||..o{ BILLING_SUBSCRIPTIONS : "logical subscription"
    BILLING_ACCOUNTS ||..o{ BILLING_CHECKOUT_SESSIONS : "logical checkout"
    BILLING_ACCOUNTS ||..o{ BILLING_INVOICES : "logical invoice"
    BILLING_ACCOUNTS ||..o{ BILLING_USAGE_COUNTERS : "logical aggregate"
    BILLING_ACCOUNTS ||..o{ BILLING_USAGE_EVENTS : "logical usage"
    BILLING_WEBHOOK_EVENTS {
      uuid id PK
      string provider_event_id UK
      string status
      jsonb payload
    }
    AUDIT_LOGS {
      uuid id PK
      int user_id
      string category
      string action
      string resource_type
      string resource_id
      jsonb metadata
    }
```

## 6. Authoritative lifecycle interpretation

```mermaid
flowchart LR
    P[Project] --> G[Active generation]
    G --> O[Immutable operation / attempt]
    O --> C[Configuration snapshot]
    O --> R[Candidate release]
    R -->|health + promotion verified| S[Stable release]
    S -->|update or rollback| O2[New operation in same generation]
    G -->|successful generation destroy| GR[Retired generation]
    GR -->|normal deploy| G2[New generation]

    O -. retryOfOperationId .-> OP[Previous failed operation]
    S -. release lineage .-> RM[Release manifest]
    G -. persistence scope .-> B[Service binding / storage]
    O -. state and side-effect fencing .-> I[Intent + lease + journals]
```

Key boundaries:

- `project_id + environment_name + generation_id` isolates generation-owned infrastructure and persistence evidence.
- A Deploy, Retry, or Rollback creates a new immutable operation; it does not rewrite prior operations.
- Stable release authority changes only after verified candidate promotion.
- Destroy retires a generation only after verified cleanup. A subsequent Deploy creates a new generation.
- Project extinction relies on the project-rooted `ON DELETE CASCADE` graph, while provider resources and external artifacts require separately verified cleanup before the project row is removed.
