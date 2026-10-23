# DeployGuard Post-Dispatch Capability Map

## Purpose

This file prevents scope drift while preserving the exact integrations that must be verified after the current GitHub Actions pre-run 422 repair.

The dispatch repair remains the immediate gate. Do not combine the items below into that repair. Complete them as small, evidence-driven gates only after one real GitHub Actions run is created.

---

## Gate 0 — Current GitHub Actions Dispatch Repair

Source of truth:

```text
DEPLOYGUARD_GITHUB_ACTIONS_DISPATCH_REPAIR.md
```

Done when one Deploy click creates exactly one real GitHub Actions run and the correct run ID is persisted.

Do not declare the full deployment path complete at this point.

---

## Verified Capability Status

### 1. Gemini AI troubleshooting — active, but GitHub-Actions-only

Current backend activation:

```text
AiTroubleshootingModule is imported by AppModule.
```

Required runtime configuration:

```text
AI_ASSISTANT_ENABLED=true
GOOGLE_AI_API_KEY=<configured secret>
GEMINI_MODEL=<supported Gemini model>
```

Current evidence boundary:

```text
failed GitHub Actions operation
→ persisted safeLog/errorMessage
→ secret sanitization
→ Gemini analysis
```

It does not currently fetch or analyze CloudWatch application logs.
It also cannot analyze a pre-run dispatch rejection that has no GitHub workflow run ID.

Acceptance:

- provider status reports configured;
- only a truthfully failed GitHub Actions run can be selected;
- no environment values or secrets are sent to Gemini;
- the analysis states its evidence limitations;
- one real failed workflow can be analyzed from the Pipeline recovery panel.

### 2. CloudWatch logs — source code exists, live product path is not integrated

The backend contains CloudWatch Logs readers and sanitizers, but the current supported AppModule does not import ObservabilityModule, and ObservabilityModule does not register ObservabilityController.

The current reusable GitHub Actions workflow also does not:

- create an `aws_cloudwatch_log_group`;
- add ECS `awslogs` log configuration to the app/database task definitions;
- grant the ECS execution role `logs:CreateLogStream` and `logs:PutLogEvents`;
- return the log-group identity in the DeployGuard result artifact.

AWS account configuration alone is therefore insufficient to produce application logs.

Minimum mapped integration:

```text
Terraform workflow
→ create project log group with retention
→ ECS app/database task definitions use awslogs
→ execution role receives scoped CloudWatch Logs write permissions
→ result artifact contains sanitized log-group identity
→ backend reconciliation persists the identity
→ Observability API reads and sanitizes logs
→ frontend Monitoring page displays application logs
```

Never infer or guess a log-group name when the deployment result can return it.

### 3. CloudWatch metrics — provider code exists, current activation/gating is incomplete

CloudWatch metric queries for ECS and ALB exist and can serve as the fallback when Prometheus is disabled.

Current blockers:

- ObservabilityModule/API is not active in AppModule;
- ObservabilityController is not registered by ObservabilityModule;
- current-state marks monitoring available only when `PROMETHEUS_ENABLED=true`, so it incorrectly blocks CloudWatch-only monitoring;
- the frontend calls runtime metrics only when current-state says monitoring is available.

Required CloudWatch-only behavior:

```text
PROMETHEUS_ENABLED=false
CLOUDWATCH_METRICS_ENABLED=true
CLOUDWATCH_LOGS_ENABLED=true
→ Monitoring remains available
→ metrics source is cloudwatch
→ no Prometheus or Grafana dependency
```

The backend AWS identity must have only the required read permissions, including CloudWatch metric reads and CloudWatch Logs reads.

### 4. Prometheus and Grafana — safe to disable

For the current FYP/demo scope:

```text
PROMETHEUS_ENABLED=false
GRAFANA_URL unset
```

This is acceptable only after current-state and the Monitoring page recognize CloudWatch as a valid provider.

Do not provision Prometheus or Grafana merely to satisfy existing UI labels.
Remove or suppress misleading links/status when the provider is not configured.

### 5. SNS notifications — implementation exists but is not active

Current source contains an SNS adapter, preferences, subscriptions, delivery records, retries, deduplication and lifecycle classification.

However, the current supported application does not activate it:

- NotificationsModule is not imported by AppModule;
- NotificationsController is not registered in NotificationsModule;
- notification entities are not registered in the active TypeORM entity list;
- the active GitHub Actions deployment service does not dispatch lifecycle notifications;
- the notification settings component is not mounted in the active frontend routes/pages.

AWS account configuration alone is not sufficient. Live SNS email also requires:

```text
NOTIFICATION_DELIVERY_ENABLED=true
SNS_TOPIC_ARN=<real topic ARN>
SNS_REGION=<topic region>
confirmed email subscription
```

Recommendation for the current deadline:

```text
NOTIFICATION_DELIVERY_ENABLED=false
```

Keep notifications explicitly disabled unless they are a mandatory presentation requirement. Activating them is a separate bounded gate and must not pull retired Billing/Observability modules back into the current product accidentally.

If activated later, map only canonical GitHub Actions operation events:

```text
dispatch failed
workflow failed
workflow succeeded
workflow destroyed
```

Each event must be deduplicated by deployment operation ID and must contain sanitized text only.

### 6. Infracost — intended UI exists, current deployment path does not generate results

The active frontend location is:

```text
Project → Infrastructure → FinOps / Deployment cost
/projects/:projectId/infrastructure
```

The old `/costs` route redirects to Infrastructure.

The current reusable workflow performs Terraform plan and immediately applies it. It does not execute Infracost, and the current AppModule does not import FinopsModule. Therefore the Infrastructure page will truthfully show:

```text
No verified Infracost estimate exists for this release.
```

Minimum mapped integration:

```text
terraform plan -out
→ terraform show -json
→ Infracost estimate using a secret, never a workflow input
→ persist monthly total + currency + service breakdown + plan hash
→ enforce/record cost decision before terraform apply
→ include sanitized cost evidence in the result artifact
→ backend reconciliation persists it
→ current-state exposes the same evidence
→ Infrastructure page displays it
```

The result must be tied to the exact Terraform plan hash. A stale estimate must not approve a changed plan.

Do not display a mock estimate as an Infracost result.

### 7. Application environment handoff — critical post-dispatch blocker

The current reusable workflow injects only:

```text
PORT
managed database runtime aliases
managed database secrets
```

It does not currently receive or inject the application-owned values that DeployGuard saved, such as `JWT_SECRET`, `JWT_EXPIRES_IN`, API keys, `NEXT_PUBLIC_*`, or `VITE_*` values.

This means successful `.env` classification does not yet prove the deployed application receives its configuration.

Required mapped integration:

```text
encrypted project values
→ immutable per-operation configuration snapshot
→ secure one-time or AWS secret handoff
→ build-time variables available only during image build
→ runtime plain values in ECS environment
→ runtime secrets in Secrets Manager/ECS secret references
→ no values in workflow inputs, logs, artifacts or UI
```

This gate is required before declaring a real application deployment successful.

---

## Required Execution Order

```text
1. Fix GitHub dispatch and create one real run.
2. Prove secure application configuration handoff.
3. Add CloudWatch log production and CloudWatch-only monitoring activation.
4. Prove Gemini analysis on one real failed GitHub Actions run.
5. Integrate Infracost before Terraform apply and expose its result on Infrastructure.
6. Keep Prometheus/Grafana disabled.
7. Keep SNS disabled unless mandatory; activate it only as a final isolated gate.
8. Repair terminal deploy/destroy reconciliation before final lifecycle certification.
```

Do not combine all gates into one prompt.

---

## Product Completion Rule

A capability is not complete because source files or UI components exist.

It is complete only when:

```text
configuration
→ provider/infrastructure
→ backend service and route
→ canonical persisted evidence
→ current-state projection
→ active frontend surface
→ focused regression
→ one live proof
```

All layers must agree. No feature may be marked configured from an environment flag alone.
