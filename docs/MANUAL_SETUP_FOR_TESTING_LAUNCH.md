# DeployGuard Manual Setup for Testing Launch

## 1. What this file is for

This is the manual checklist required before testing DeployGuard modules 6.1-6.12 end to end. It lists local tools, local services, backend and frontend environment variables, GitHub setup, AWS setup, IAM permissions, Terraform safety settings, and the recommended test order.

Do not put real secrets in this file. Put local secrets in `backend/.env`, frontend-safe values in `frontend/.env`, and production secrets in a secret manager.

## 2. Local machine prerequisites

Install these tools on the machine that runs the backend and worker:

| Tool | Needed for | Verify |
| --- | --- | --- |
| Node.js | Backend and frontend runtime | `node -v` |
| npm | Package scripts | `npm -v` |
| Docker | Worker image build, tag, push, Trivy image scan | `docker --version` |
| Docker Compose | Local PostgreSQL and Redis | `docker compose version` |
| Git | Repo clone, stack detection, pipeline clone | `git --version` |
| Trivy | Security scans | `trivy --version` |
| Terraform | Infrastructure plan/apply | `terraform version` |
| Infracost | Real FinOps estimates when mock mode is off | `infracost --version` |
| AWS CLI | Terraform state helper commands and manual AWS checks | `aws --version` |

## 3. Local services

Start local PostgreSQL and Redis from the project root:

```bash
docker compose up -d postgres redis
docker compose ps
docker compose exec redis redis-cli ping
docker compose exec postgres pg_isready -U mini_paas_user -d mini_paas
```

PostgreSQL is mapped as host `localhost:5433` to container `5432`. Redis is mapped as `localhost:6379`.

## 4. Backend .env setup

Create `backend/.env` from `backend/.env.example` if it does not already exist.

### App/server

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `NODE_ENV` | Runtime mode | Yes | `development` | No |
| `PORT` | Backend port | Yes | `5000` | No |
| `FRONTEND_URL` | CORS and OAuth redirect base | Yes | `http://localhost:5173` | No |
| `BACKEND_URL` | Backend public URL | Yes | `http://localhost:5000` | No |

### Database

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `DATABASE_HOST` | Preferred DB host | Yes | `localhost` | No |
| `DATABASE_PORT` | Preferred DB port | Yes | `5433` | No |
| `DATABASE_USERNAME` | Preferred DB user | Yes | `mini_paas_user` | No |
| `DATABASE_PASSWORD` | Preferred DB password | Yes | `mini_paas_password` | Yes |
| `DATABASE_NAME` | Preferred DB name | Yes | `mini_paas` | No |
| `DATABASE_SSL` | DB SSL toggle | Yes | `false` | No |
| `DB_HOST` | Backward-compatible DB host | Yes | `localhost` | No |
| `DB_PORT` | Backward-compatible DB port | Yes | `5433` | No |
| `DB_USERNAME` | Backward-compatible DB user | Yes | `mini_paas_user` | No |
| `DB_PASSWORD` | Backward-compatible DB password | Yes | `mini_paas_password` | Yes |
| `DB_NAME` | Backward-compatible DB name | Yes | `mini_paas` | No |

### Redis

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `REDIS_HOST` | Redis host | Yes | `localhost` | No |
| `REDIS_PORT` | Redis port | Yes | `6379` | No |
| `REDIS_PASSWORD` | Redis password if used | Optional local | empty | Yes |
| `REDIS_TLS` | Redis TLS toggle | Optional local | `false` | No |

### Auth/session

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `AUTH_SESSION_SECRET` | Signed session cookie secret | Yes | `replace_with_long_random_value` | Yes |
| `ALLOW_INSECURE_USER_HEADER` | Local-only legacy test header; keep disabled | Yes | `false` | No |
| `JWT_SECRET` | Reserved auth secret | Optional | `replace_with_long_random_value` | Yes |
| `SESSION_SECRET` | Reserved auth secret | Optional | `replace_with_long_random_value` | Yes |

### GitHub OAuth

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `GITHUB_CLIENT_ID` | OAuth app client id | For GitHub login | `Ov23...` | No |
| `GITHUB_CLIENT_SECRET` | OAuth app secret | For GitHub login | `github_oauth_secret` | Yes |
| `GITHUB_CALLBACK_URL` | OAuth callback URL | For GitHub login | `http://localhost:5000/api/auth/github/callback` | No |

### Optional External CI / GitHub Actions

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `GITHUB_TOKEN` | Token used for private repository access and optional workflow dispatch | Optional external CI/private repos | `github_pat_...` | Yes |
| `GITHUB_ACTIONS_WORKFLOW_FILE` | Optional external CI workflow file name | Optional | `deploy.yml` | No |
| `GITHUB_ACTIONS_REQUIRED` | Whether external CI blocks the internal worker | Optional | `false` | No |

### AWS core

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `AWS_REGION` | AWS region | For AWS modules | `us-east-1` | No |
| `AWS_ACCOUNT_ID` | DeployGuard AWS account id | For ECR/ECS | `123456789012` | No |
| `AWS_ACCESS_KEY_ID` | DeployGuard backend/worker AWS key | For AWS modules | `AKIA...` | Yes |
| `AWS_SECRET_ACCESS_KEY` | DeployGuard backend/worker AWS secret | For AWS modules | `...` | Yes |

### ECR

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `ECR_REPOSITORY_PREFIX` | ECR repository name prefix | Yes | `mini-paas` | No |

### Pipeline/Terraform

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `PIPELINE_WORKSPACE_DIR` | Worker clone/build directory | Yes | `.workspace/pipeline` | No |
| `PIPELINE_JOB_ATTEMPTS` | BullMQ attempts | Optional | `1` | No |
| `TERRAFORM_WORKSPACE_DIR` | Legacy pipeline Terraform workspace | Optional | `.workspace/terraform` | No |
| `TERRAFORM_BIN` | Terraform executable | Yes for 6.8+ | `terraform` | No |
| `TERRAFORM_WORKING_BASE_DIR` | Generated Terraform workspaces | Yes for 6.8+ | `./.deployguard/terraform-workspaces` | No |
| `TERRAFORM_NETWORK_TEMPLATE_DIR` | Terraform template dir | Yes for 6.8+ | `terraform/base-network` | No |
| `TERRAFORM_AUTO_APPROVE` | Adds `-auto-approve` when apply is enabled | Optional | `true` | No |
| `TERRAFORM_APPLY_ENABLED` | Allows real Terraform apply | Required for real apply | `false` first, then `true` | No |

### FinOps/Infracost

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `FINOPS_MOCK_MODE` | Use mock estimates | Yes | `true` | No |
| `INFRACOST_API_KEY` | Infracost API key | Required when mock mode is false | `ico-...` | Yes |
| `INFRACOST_CURRENCY` | Estimate currency | Yes | `USD` | No |
| `FINOPS_DEFAULT_WARNING_THRESHOLD_USD` | Cost approval threshold | Yes | `25` | No |
| `FINOPS_FREE_TIER_LIMIT_USD` | Free tier hard limit | Yes | `10` | No |
| `FINOPS_STARTER_TIER_LIMIT_USD` | Starter hard limit | Yes | `50` | No |
| `FINOPS_PRO_TIER_LIMIT_USD` | Pro hard limit | Yes | `200` | No |
| `FINOPS_ENTERPRISE_TIER_LIMIT_USD` | Enterprise hard limit | Yes | `999999` | No |
| `FINOPS_TERRAFORM_WORKDIR` | Optional real cost workdir | Optional | empty | No |
| `FINOPS_ENABLE_REAL_TERRAFORM` | Enable real Terraform plan for cost | Optional | `false` | No |

### S3 state and DynamoDB locks

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `DEPLOYGUARD_TF_STATE_BUCKET` | S3 bucket for remote Terraform state | Required when `STATE_MOCK_MODE=false` | `deployguard-tf-state-dev` | No |
| `DEPLOYGUARD_TF_STATE_PREFIX` | State key prefix | Yes | `deployguard/state` | No |
| `DEPLOYGUARD_TF_LOCK_TABLE` | DynamoDB table for Terraform backend locking | Yes | `deployguard-terraform-locks` | No |
| `STATE_LOCK_HEARTBEAT_INTERVAL_SECONDS` | App lock heartbeat interval | Yes | `30` | No |
| `STATE_LOCK_STALE_AFTER_SECONDS` | Stale lock threshold | Yes | `300` | No |
| `STATE_LOCK_MONITOR_INTERVAL_SECONDS` | Monitor interval | Yes | `60` | No |
| `STATE_RESOURCE_DROP_WARNING_PERCENT` | State validation warning threshold | Yes | `70` | No |
| `STATE_ENABLE_ORPHAN_AUTO_RECOVERY` | Orphan recovery toggle | Optional | `true` | No |
| `STATE_ENABLE_FORCE_RELEASE` | Admin force release toggle | Optional | `true` | No |
| `STATE_MOCK_MODE` | Use local/mock state backend | Yes | `true` first, `false` for remote | No |

### EFS/KMS/Backup

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `DEPLOYGUARD_ENABLE_EFS` | Enable EFS feature | Yes | `true` | No |
| `DEPLOYGUARD_EFS_DEFAULT_ENABLED` | Enable EFS by default | Yes | `false` | No |
| `DEPLOYGUARD_EFS_POSIX_UID` | EFS access point UID | Yes | `1000` | No |
| `DEPLOYGUARD_EFS_POSIX_GID` | EFS access point GID | Yes | `1000` | No |
| `DEPLOYGUARD_EFS_ROOT_PERMISSIONS` | EFS root permissions | Yes | `750` | No |
| `DEPLOYGUARD_EFS_ROOT_DIRECTORY_BASE` | Root directory base | Yes | `/deployguard` | No |
| `DEPLOYGUARD_EFS_PERFORMANCE_MODE` | EFS performance mode | Yes | `generalPurpose` | No |
| `DEPLOYGUARD_EFS_THROUGHPUT_MODE` | EFS throughput mode | Yes | `bursting` | No |
| `DEPLOYGUARD_EFS_TRANSITION_TO_IA` | EFS lifecycle policy | Yes | `AFTER_30_DAYS` | No |
| `DEPLOYGUARD_EFS_ENABLE_BACKUP` | AWS Backup toggle | Yes | `true` | No |
| `DEPLOYGUARD_EFS_BACKUP_RETENTION_DAYS` | Backup retention | Yes | `30` | No |
| `DEPLOYGUARD_EFS_BACKUP_SCHEDULE` | Backup schedule | Yes | `cron(0 3 * * ? *)` | No |

### ECS/ALB/Spot

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `DEPLOYGUARD_ECS_USE_FARGATE_SPOT` | Use Fargate Spot | Yes | `true` | No |
| `DEPLOYGUARD_ECS_ENABLE_FARGATE_FALLBACK` | Add Fargate fallback | Optional | `false` | No |
| `DEPLOYGUARD_ECS_MIN_TASKS` | Min tasks | Yes | `1` | No |
| `DEPLOYGUARD_ECS_MAX_TASKS` | Max tasks | Yes | `3` | No |
| `DEPLOYGUARD_ECS_CPU_TARGET_PERCENT` | CPU target tracking value | Yes | `60` | No |
| `DEPLOYGUARD_ECS_DEFAULT_CPU` | Default task CPU | Yes | `256` | No |
| `DEPLOYGUARD_ECS_DEFAULT_MEMORY` | Default task memory | Yes | `512` | No |
| `DEPLOYGUARD_ECS_LARGE_CPU` | Larger profile CPU | Yes | `512` | No |
| `DEPLOYGUARD_ECS_LARGE_MEMORY` | Larger profile memory | Yes | `1024` | No |
| `DEPLOYGUARD_ECS_HEALTHCHECK_GRACE_SECONDS` | ECS health grace period | Yes | `60` | No |
| `DEPLOYGUARD_ECS_CONTAINER_INSIGHTS` | ECS Container Insights toggle | Optional | `false` | No |
| `DEPLOYGUARD_ALB_HEALTHCHECK_PATH` | ALB health path | Yes | `/health` | No |
| `DEPLOYGUARD_ALLOW_HEALTHCHECK_FALLBACK` | Allow `/` fallback | Optional | `false` | No |
| `DEPLOYGUARD_ROLLBACK_STABILITY_TIMEOUT_SECONDS` | Rollback wait timeout | Yes | `600` | No |
| `DEPLOYGUARD_SERVICE_STABILITY_TIMEOUT_SECONDS` | ECS stability timeout | Yes | `600` | No |
| `DEPLOYGUARD_SERVICE_STABILITY_POLL_INTERVAL_SECONDS` | ECS polling interval | Yes | `15` | No |
| `DEPLOYGUARD_ALB_HEALTH_TIMEOUT_SECONDS` | ALB health timeout | Yes | `600` | No |
| `DEPLOYGUARD_ALB_HEALTH_POLL_INTERVAL_SECONDS` | ALB polling interval | Yes | `15` | No |
| `DEPLOYGUARD_SPOT_EVENT_WEBHOOK_SECRET` | Secret for Spot event endpoint | Required for Spot handler | `replace_with_long_random_value` | Yes |
| `DEPLOYGUARD_ENABLE_EVENTBRIDGE_SPOT_RULE` | EventBridge Spot rule and optional API destination | Yes | `true` | No |
| `DEPLOYGUARD_ENABLE_AUTO_ROLLBACK` | Auto rollback toggle | Yes | `true` | No |
| `DEPLOYGUARD_SPOT_RECOVERY_COOLDOWN_SECONDS` | Spot recovery cooldown | Yes | `120` | No |

### Observability/Prometheus/CloudWatch

| Variable | Description | Required | Example | Secret |
| --- | --- | --- | --- | --- |
| `PROMETHEUS_ENABLED` | Prometheus runtime metrics toggle | Optional | `false` | No |
| `PROMETHEUS_BASE_URL` | Prometheus base URL | Optional | `http://localhost:9090` | No |
| `PROMETHEUS_QUERY_TIMEOUT_SECONDS` | Prometheus timeout | Optional | `10` | No |
| `PROMETHEUS_CPU_QUERY` | Optional CPU query override | Optional | `rate(container_cpu_usage_seconds_total[5m])` | No |
| `PROMETHEUS_MEMORY_QUERY` | Optional memory query override | Optional | `container_memory_working_set_bytes` | No |
| `PROMETHEUS_HTTP_LATENCY_QUERY` | Optional latency query override | Optional | `histogram_quantile(...)` | No |
| `PROMETHEUS_REQUEST_RATE_QUERY` | Optional request rate query override | Optional | `rate(http_requests_total[5m])` | No |
| `CLOUDWATCH_LOGS_ENABLED` | CloudWatch Logs toggle | Optional | `true` | No |
| `CLOUDWATCH_METRICS_ENABLED` | CloudWatch Metrics fallback toggle | Optional | `true` | No |
| `CLOUDWATCH_LOG_GROUP_NAME` | Optional default log group | Optional | `/deployguard/<project>/dev/app` | No |
| `OBSERVABILITY_LOG_STREAM_POLL_INTERVAL_SECONDS` | SSE polling interval | Optional | `5` | No |
| `OBSERVABILITY_LOG_STREAM_MAX_EVENTS` | SSE events per poll | Optional | `100` | No |
| `OBSERVABILITY_LOG_STREAM_HEARTBEAT_SECONDS` | SSE heartbeat interval | Optional | `15` | No |
| `OBSERVABILITY_MASK_SECRETS` | Log sanitizer toggle | Optional | `true` | No |
| `OBSERVABILITY_DEFAULT_RANGE` | Default metrics range | Optional | `1h` | No |

## 5. Frontend .env setup

Create `frontend/.env` with frontend-safe variables only:

```bash
VITE_API_BASE_URL=http://localhost:5000
```

Do not put AWS keys in frontend. Do not put `GITHUB_TOKEN` in frontend. Do not put `INFRACOST_API_KEY` in frontend. Do not put session or cookie secrets in frontend.

## 6. GitHub OAuth App setup

Create a GitHub OAuth App:

| Field | Local testing value |
| --- | --- |
| Homepage URL | `http://localhost:5173` |
| Authorization callback URL | `http://localhost:5000/api/auth/github/callback` |

Set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `GITHUB_CALLBACK_URL` in `backend/.env`.

Common mistakes:

- Callback URL mismatch between GitHub and `backend/.env`.
- Backend running on `5000` but callback still set to `4000`.
- Frontend running on `5173` but `FRONTEND_URL` still set to `3000`.
- Missing `AUTH_SESSION_SECRET`.

## 7. Optional GitHub Actions setup

DeployGuard does not require GitHub Actions, a Dockerfile, docker-compose, Terraform, or AWS credentials in target repositories. The platform worker provides those deployment capabilities.

Only repositories opting into external CI validation need a workflow file:

```text
.github/workflows/deploy.yml
```

The workflow must include:

```yaml
on:
  workflow_dispatch:
```

Recommended optional inputs for future expansion:

```yaml
on:
  workflow_dispatch:
    inputs:
      projectId:
        required: false
      pipelineRunId:
        required: false
      commitSha:
        required: false
```

Create a fine-grained GitHub token with:

- Selected target repository access.
- Actions read/write.
- Contents read.
- Metadata read.

Put the token only in `backend/.env` as `GITHUB_TOKEN`.

## 8. AWS account setup

Use a test AWS account or a tightly limited IAM user. Set:

- `AWS_REGION`
- `AWS_ACCOUNT_ID`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

DeployGuard owns the AWS account. User GitHub repos should not need AWS credentials.

## 9. IAM permissions

Required permission checklist:

| Service | Actions |
| --- | --- |
| ECR | `ecr:GetAuthorizationToken`, `ecr:CreateRepository`, `ecr:DescribeRepositories`, `ecr:PutLifecyclePolicy`, `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage` |
| ECS | `ecs:CreateCluster`, `ecs:DescribeServices`, `ecs:DescribeClusters`, `ecs:RegisterTaskDefinition`, `ecs:CreateService`, `ecs:UpdateService`, `ecs:DescribeTaskDefinition`, `ecs:ListTasks`, `ecs:DescribeTasks` |
| EC2/VPC/ALB | `ec2:*Vpc*`, `ec2:*Subnet*`, `ec2:*Route*`, `ec2:*InternetGateway*`, `ec2:*NatGateway*`, `ec2:*SecurityGroup*`, `ec2:DescribeAvailabilityZones`, `elasticloadbalancing:*LoadBalancer*`, `elasticloadbalancing:*TargetGroup*`, `elasticloadbalancing:*Listener*`, `elasticloadbalancing:DescribeTargetHealth` |
| Application Auto Scaling | `application-autoscaling:RegisterScalableTarget`, `application-autoscaling:PutScalingPolicy`, `application-autoscaling:DescribeScalableTargets`, `application-autoscaling:DescribeScalingPolicies` |
| EventBridge | `events:PutRule`, `events:PutTargets`, `events:DescribeRule`, `events:ListTargetsByRule`, `events:CreateConnection`, `events:UpdateConnection`, `events:CreateApiDestination`, `events:UpdateApiDestination`, `events:InvokeApiDestination` |
| CloudWatch Logs | `logs:CreateLogGroup`, `logs:CreateLogStream`, `logs:PutLogEvents`, `logs:DescribeLogGroups`, `logs:DescribeLogStreams`, `logs:GetLogEvents`, `logs:FilterLogEvents`, `logs:PutResourcePolicy` |
| CloudWatch Metrics | `cloudwatch:GetMetricData`, `cloudwatch:GetMetricStatistics`, `cloudwatch:ListMetrics` |
| Cloud Map | `servicediscovery:CreatePrivateDnsNamespace`, `servicediscovery:GetNamespace`, `servicediscovery:CreateService`, `servicediscovery:GetService`, `servicediscovery:ListServices` |
| S3 Terraform State | `s3:HeadBucket`, `s3:GetObject`, `s3:PutObject`, `s3:CopyObject`, `s3:ListBucket`, `s3:ListBucketVersions`, `s3:PutBucketVersioning`, `s3:PutBucketEncryption`, `s3:PutPublicAccessBlock` |
| DynamoDB | `dynamodb:DescribeTable`, `dynamodb:GetItem`, `dynamodb:PutItem`, `dynamodb:UpdateItem`, `dynamodb:DeleteItem` |
| EFS | `elasticfilesystem:CreateFileSystem`, `elasticfilesystem:DescribeFileSystems`, `elasticfilesystem:CreateMountTarget`, `elasticfilesystem:DescribeMountTargets`, `elasticfilesystem:CreateAccessPoint`, `elasticfilesystem:DescribeAccessPoints`, `elasticfilesystem:TagResource` |
| KMS | `kms:CreateKey`, `kms:CreateAlias`, `kms:EnableKeyRotation`, `kms:TagResource`, `kms:DescribeKey` |
| AWS Backup | `backup:CreateBackupVault`, `backup:CreateBackupPlan`, `backup:CreateBackupSelection`, `backup:ListRecoveryPointsByBackupVault` |
| IAM role creation/pass role | `iam:CreateRole`, `iam:PutRolePolicy`, `iam:AttachRolePolicy`, `iam:PassRole`, `iam:GetRole` |
| STS | `sts:GetCallerIdentity`, `sts:AssumeRole` where role assumption is used |

## 10. Terraform setup

Verify Terraform:

```bash
terraform version
```

Keep `TERRAFORM_APPLY_ENABLED=false` for first local testing. Enable real apply only after AWS credentials, IAM permissions, state bucket, lock table, and cost expectations are ready.

Warning: NAT Gateway, ALB, ECS tasks, EFS, CloudWatch Logs, and backups can cost money. A cleanup/destroy workflow should be handled separately and intentionally.

Remote state setup when `STATE_MOCK_MODE=false`:

- Create or provide an S3 bucket for `DEPLOYGUARD_TF_STATE_BUCKET`.
- Enable S3 versioning, encryption, and public access block.
- Create or provide DynamoDB table `DEPLOYGUARD_TF_LOCK_TABLE`.
- Use hierarchical state keys: `deployguard/state/user-<owner>/project-<projectId>/dev/terraform.tfstate`.

## 11. Infracost setup

Start with:

```bash
FINOPS_MOCK_MODE=true
FINOPS_ENABLE_REAL_TERRAFORM=false
```

For real Infracost:

```bash
FINOPS_MOCK_MODE=false
FINOPS_ENABLE_REAL_TERRAFORM=true
INFRACOST_API_KEY=<your-key>
```

Verify:

```bash
infracost --version
```

## 12. ECR setup

The worker:

1. Computes an immutable full Git commit SHA image tag.
2. Creates/checks the ECR repository.
3. Logs Docker into ECR.
4. Tags and pushes the image.
5. Applies an ECR lifecycle policy expiring untagged images older than 30 days.

Manual setup:

- Set AWS credentials in `backend/.env`.
- Ensure Docker is running.
- Ensure IAM has ECR permissions.

## 13. ECS/ALB setup

ECS uses Fargate Spot by default. The ALB health path defaults to `/health`.

Target apps should expose:

```text
GET /health
```

Stable release rule:

```text
ECS service stable + ALB targets healthy = save ProjectStableRelease
```

## 14. EFS setup

EFS is needed when stack detection finds persistent storage needs or a developer enables storage.

The Terraform module configures:

- KMS key.
- EFS encryption at rest.
- Mount targets in private subnets.
- Security group restricted to NFS `2049` from app/internal security groups.
- Access point.
- POSIX UID/GID.
- Root directory creation.
- Lifecycle transition to IA.
- Optional AWS Backup.
- `prevent_destroy` on the EFS file system.

Persistent storage can cost money and should not be destroyed casually.

## 15. Observability setup

CloudWatch Logs:

- ECS task definitions use the `awslogs` driver.
- Backend reads CloudWatch log events and streams them through authenticated SSE.
- Log lines are sanitized before frontend delivery.

CloudWatch Metrics:

- Used as fallback when Prometheus is disabled.
- Requires CloudWatch metric IAM permissions.

Prometheus:

- Optional.
- Enable with `PROMETHEUS_ENABLED=true`.
- Set `PROMETHEUS_BASE_URL`.
- If disabled, runtime metrics fall back to CloudWatch where configured.

For automatic Spot interruption recovery, `BACKEND_URL` must be a publicly reachable
HTTPS URL and `DEPLOYGUARD_SPOT_EVENT_WEBHOOK_SECRET` must be set. Terraform then creates
an EventBridge API Destination using the secret-protected backend endpoint. With a local
`http://localhost` backend, interruption events are retained in the EventBridge log target
and the protected endpoint can be tested manually, but AWS cannot call localhost.

Project environment values are always masked in API/frontend responses. They are currently
stored as plaintext in PostgreSQL. Only variables marked non-secret are passed to the ECS
task definition; applications that need secret runtime variables require a backend-side AWS
Secrets Manager/SSM injection path before real launch.

## 16. Exact local startup commands

From project root:

```bash
docker compose up -d postgres redis
docker compose ps
```

From backend:

```bash
npm run migration:run
npm run start:dev
npm run worker:pipeline
```

From frontend:

```bash
npm run dev
```

Common full sequence:

```bash
cd /home/hassan-sajjad/Deploy-Guard-dev
docker compose up -d postgres redis
cd backend
npm run migration:run
npm run start:dev
```

In a second backend terminal:

```bash
cd /home/hassan-sajjad/Deploy-Guard-dev/backend
npm run worker:pipeline
```

In a frontend terminal:

```bash
cd /home/hassan-sajjad/Deploy-Guard-dev/frontend
npm run dev
```

## 17. End-to-end testing order

1. Login/signup.
2. GitHub OAuth test.
3. Create project.
4. Link repo.
5. Select branch.
6. Run stack detection.
7. Generate pre-flight.
8. Start deploy/pipeline.
9. Optional external CI validation (skipped/warning must remain non-blocking by default).
10. DeployGuard repository clone, template generation, and Docker build.
11. Trivy scan.
12. ECR push.
13. FinOps estimate.
14. Approve cost if required; the worker automatically resumes the queued pipeline.
15. Terraform plan.
16. Terraform apply.
17. State lock.
18. EFS if needed.
19. ECS deploy.
20. ALB health.
21. Stable release.
22. Rollback test.
23. Logs/metrics test.

## 18. Cost warnings

- NAT Gateway costs money.
- ALB costs money.
- ECS tasks cost money.
- EFS costs money.
- CloudWatch Logs and metrics can cost money.
- AWS Backup costs money.
- Infracost helps estimate but is not perfect.
- Destroy/cleanup should be a separate, explicit workflow.

## 19. Common errors and fixes

| Error | Fix |
| --- | --- |
| TypeScript config error | Run `cd backend && npm run build`; inspect `backend/tsconfig.json` if it fails. |
| Database port `5432` vs `5433` | Local Compose host port is `5433`; set `DATABASE_PORT=5433` and `DB_PORT=5433`. |
| Redis not running | `docker compose up -d redis`; verify `docker compose exec redis redis-cli ping`. |
| GitHub callback mismatch | Match GitHub OAuth App callback to `http://localhost:5000/api/auth/github/callback`. |
| Optional GitHub workflow 404 | No action is required for the internal pipeline. Add a dispatchable workflow only if external CI validation is desired. |
| Trivy missing | Install Trivy and verify `trivy --version`. |
| Terraform missing | Install Terraform and verify `terraform version`. |
| Infracost missing | Keep mock mode on or install Infracost and set `INFRACOST_API_KEY`. |
| AWS credentials missing | Set backend-only AWS env vars. |
| IAM AccessDenied | Add the missing grouped IAM permission from section 9. |
| ALB health check failing | Ensure app exposes `/health` or configure `DEPLOYGUARD_ALB_HEALTHCHECK_PATH`. |
| ECS task cannot pull image | Check ECR image URI, task execution role, ECR permissions, and subnet/NAT egress. |
| EFS mount permission issue | Check POSIX UID/GID, access point, NFS security group, and task role EFS permissions. |
| CloudWatch logs empty | Verify ECS task log driver, log group, task startup, and CloudWatch Logs permissions. |
| Prometheus disabled | This is okay; CloudWatch fallback should be used when enabled. |

## 20. Final pre-launch checklist

- [ ] Backend builds.
- [ ] Frontend builds.
- [ ] Migrations run.
- [ ] GitHub OAuth works.
- [ ] Optional external CI skips calmly when no workflow exists.
- [ ] AWS credentials configured backend/worker-side only.
- [ ] IAM permissions configured.
- [ ] Terraform plan works.
- [ ] FinOps works.
- [ ] ECR push works.
- [ ] ECS deploy works.
- [ ] ALB health works.
- [ ] Rollback works.
- [ ] Observability works.
- [ ] Secrets are not exposed.
