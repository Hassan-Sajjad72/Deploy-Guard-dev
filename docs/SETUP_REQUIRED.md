# Deploy Guard Setup Required

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the integrated product journey, phase model, worker pipeline, optional external CI boundary, and module mapping.

This document is the setup readiness checklist for the current Deploy Guard codebase. It lists the local services, environment variables, external credentials, commands, endpoint map, and known setup blockers needed to run the existing auth, RBAC, audit, project management, stack detection, pre-flight, pipeline, and security scanning modules.

Local development can use `TYPEORM_SYNCHRONIZE=true`. Production must set `TYPEORM_SYNCHRONIZE=false` and run reviewed migrations; the backend defaults synchronization off whenever `NODE_ENV=production`.

Do not put real secrets in this document, tickets, screenshots, or chat. Put secrets only in `backend/.env` or your deployment secret manager.

## Runtime Summary

| Area | Current value |
| --- | --- |
| Backend framework | NestJS |
| Backend local URL | `http://localhost:5000` |
| Backend command | `cd backend && npm run start:dev` |
| Worker command | `cd backend && npm run worker:pipeline` |
| Migration command | `cd backend && npm run migration:run` |
| Frontend framework | Vite + React |
| Frontend local URL | `http://localhost:5173` |
| Frontend command | `cd frontend && npm run dev` |
| PostgreSQL | Docker Compose `postgres`, host `localhost`, port `5433`, container port `5432` |
| Redis | Docker Compose `redis`, host `localhost`, port `6379` |
| GitHub OAuth callback URL | `http://localhost:5000/api/auth/github/callback` |
| Frontend API base URL | `VITE_API_BASE_URL=http://localhost:5000` |

## Required Local Services

| Service | Required for | Check command | Notes |
| --- | --- | --- | --- |
| Docker daemon | Docker build, Trivy image scan, required ECR push | `docker ps` | Worker uses Docker CLI for image build/tag/push. |
| PostgreSQL | Auth, RBAC, audit logs, projects, migrations, scans, pipeline runs | `docker compose ps` | Compose maps host `5433` to container `5432`. |
| Redis | BullMQ pipeline queue and worker | `docker compose exec redis redis-cli ping` | Required before triggering pipeline runs. |
| Trivy CLI | Security scan stage after Docker build | `trivy --version` | Missing Trivy should fail cleanly; it still blocks security gate execution. |
| Git CLI | Stack detection, pre-flight, repository clone workflows | `git --version` | Public repository flows are available; private clone support is still limited. |

## Environment Variable Checklist

| Variable name | Required for module | Required now or optional | Example value | Where to get it | File location | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | Backend runtime | Required now | `development` | Local choice | `backend/.env` | Controls secure cookie flag when set to production. |
| `PORT` | Backend runtime | Required now | `5000` | Local choice | `backend/.env` | Frontend expects backend on this port by default. |
| `FRONTEND_URL` | CORS and OAuth redirect | Required now | `http://localhost:5173` | Local frontend URL | `backend/.env` | Must match Vite dev server URL. |
| `BACKEND_URL` | Runtime integration and EventBridge API destination | Required for automatic Spot recovery | `https://backend.example.com` | Public backend URL | `backend/.env` | Must be public HTTPS for EventBridge; localhost remains local-only. |
| `DATABASE_HOST` | PostgreSQL | Required now | `localhost` | Docker Compose | `backend/.env` | Preferred database env name. |
| `DATABASE_PORT` | PostgreSQL | Required now | `5433` | Docker Compose port mapping | `backend/.env` | Host port is `5433`, not `5432`. |
| `DATABASE_USERNAME` | PostgreSQL | Required now | `mini_paas_user` | Docker Compose | `backend/.env` | Preferred database env name. |
| `DATABASE_PASSWORD` | PostgreSQL | Required now | `mini_paas_password` | Docker Compose or secret manager | `backend/.env` | Do not log or share real values. |
| `DATABASE_NAME` | PostgreSQL | Required now | `mini_paas` | Docker Compose | `backend/.env` | Preferred database env name. |
| `DATABASE_SSL` | PostgreSQL | Required now | `false` | Local choice or DB provider | `backend/.env` | Keep `false` for local Docker Compose. |
| `TYPEORM_SYNCHRONIZE` | PostgreSQL schema | Local-only convenience | `true` locally / `false` production | Deployment policy | `backend/.env` | Production defaults to false; run reviewed migrations instead. |
| `DB_HOST` | PostgreSQL compatibility | Required now | `localhost` | Docker Compose | `backend/.env` | Backward-compatible alias. |
| `DB_PORT` | PostgreSQL compatibility | Required now | `5433` | Docker Compose port mapping | `backend/.env` | Backward-compatible alias. |
| `DB_USERNAME` | PostgreSQL compatibility | Required now | `mini_paas_user` | Docker Compose | `backend/.env` | Backward-compatible alias. |
| `DB_PASSWORD` | PostgreSQL compatibility | Required now | `mini_paas_password` | Docker Compose or secret manager | `backend/.env` | Backward-compatible alias. |
| `DB_NAME` | PostgreSQL compatibility | Required now | `mini_paas` | Docker Compose | `backend/.env` | Backward-compatible alias. |
| `AUTH_SESSION_SECRET` | Cookie session auth | Required now | `replace_with_long_random_value` | Generate locally | `backend/.env` | Current auth code signs sessions with this value. |
| `ALLOW_INSECURE_USER_HEADER` | Legacy local test header | Required safe default | `false` | Local policy | `backend/.env` | Keep false; it is ignored in production even if enabled. |
| `JWT_SECRET` | Reserved auth config | Optional | `replace_with_long_random_value` | Generate locally | `backend/.env` | Present in example; current auth does not issue JWTs. |
| `SESSION_SECRET` | Reserved auth config | Optional | `replace_with_long_random_value` | Generate locally | `backend/.env` | Present in example; current auth uses `AUTH_SESSION_SECRET`. |
| `GITHUB_CLIENT_ID` | GitHub OAuth login | Required for GitHub OAuth | `<github-oauth-client-id>` | GitHub OAuth App | `backend/.env` | Email/password auth works without it. |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth login | Required for GitHub OAuth | `<github-oauth-client-secret>` | GitHub OAuth App | `backend/.env` | Do not expose to frontend. |
| `GITHUB_CALLBACK_URL` | GitHub OAuth login | Required for GitHub OAuth | `http://localhost:5000/api/auth/github/callback` | Local backend route | `backend/.env` | Must exactly match the GitHub OAuth App callback URL. |
| `REDIS_HOST` | BullMQ pipeline queue | Required for pipeline | `localhost` | Docker Compose | `backend/.env` | Worker and backend both use this. |
| `REDIS_PORT` | BullMQ pipeline queue | Required for pipeline | `6379` | Docker Compose | `backend/.env` | Parsed as a number. |
| `REDIS_PASSWORD` | BullMQ pipeline queue | Optional local | `<empty>` | Redis provider | `backend/.env` | Empty for local Compose. |
| `REDIS_TLS` | BullMQ pipeline queue | Optional local | `false` | Redis provider | `backend/.env` | Use only for TLS Redis providers. |
| `PIPELINE_WORKSPACE_DIR` | Pipeline worker | Required for pipeline | `.workspace/pipeline` | Local choice | `backend/.env` | Worker clone/build workspace. |
| `PIPELINE_JOB_ATTEMPTS` | Pipeline queue | Optional | `1` | Local choice | `backend/.env` | BullMQ job attempts. |
| `TERRAFORM_WORKSPACE_DIR` | Legacy pipeline Terraform stage | Optional | `.workspace/terraform` | Local choice | `backend/.env` | Full deploys use module 6.8 generated workspaces; build-only runs may emit `terraform_plan_skipped_not_configured`. |
| `PIPELINE_DOCKER_NETWORK` | Pipeline worker | Optional, not used by current code | `<network-name>` | Local Docker setup | `backend/.env` | Listed for planning only; current code does not read it. |
| `GITHUB_TOKEN` | Optional external CI and private repository access | Optional | `<github-token>` | GitHub token settings | `backend/.env` | Backend/worker only. The internal DeployGuard pipeline does not require a workflow file. |
| `GITHUB_ACTIONS_WORKFLOW_FILE` | GitHub Actions dispatch | Optional | `deploy.yml` | Repository workflow file | `backend/.env` | Workflow file passed to GitHub dispatch API. |
| `GITHUB_ACTIONS_REQUIRED` | Optional external CI gate | Optional | `false` | DeployGuard configuration | `backend/.env` | Keep false for platform-managed deployments. Only true makes external CI block internal stages. |
| `AUTOMATION_MANUAL_APPROVALS_ENABLED` | Legacy security/cost approval pauses | Optional | `false` | DeployGuard configuration | `backend/.env` | Keep false for the fully automated product flow. Policy failures require remediation and retry instead of an approval click. |
| `AWS_REGION` | ECR push | Required for ECR push | `us-east-1` | AWS account | `backend/.env` | Used by AWS SDK and Docker login target. |
| `AWS_ACCOUNT_ID` | ECR push | Required for ECR push | `<12-digit-account-id>` | AWS account | `backend/.env` | Needed to build registry URL. |
| `AWS_ACCESS_KEY_ID` | ECR push | Required for ECR push | `<aws-access-key-id>` | AWS IAM | `backend/.env` | Backend only. |
| `AWS_SECRET_ACCESS_KEY` | ECR push | Required for ECR push | `<aws-secret-access-key>` | AWS IAM | `backend/.env` | Never log or expose. |
| `ECR_REPOSITORY_PREFIX` | ECR push | Optional | `mini-paas` | Local naming choice | `backend/.env` | Repository name is prefix plus sanitized project name. |
| `TRIVY_TIMEOUT_SECONDS` | Security scanning | Required for scans | `300` | Local choice | `backend/.env` | Trivy process timeout. |
| `SECURITY_BLOCK_CRITICAL` | Security policy | Required for scans | `true` | Security policy decision | `backend/.env` | Blocks fixable Critical application dependencies by default. |
| `SECURITY_BLOCK_HIGH` | Security policy | Required for scans | `false` | Security policy decision | `backend/.env` | High application-dependency findings warn unless explicitly enabled. |
| `SECURITY_BLOCK_BASE_IMAGE_CRITICAL` | Security policy | Required for scans | `false` | Security policy decision | `backend/.env` | Base-image/OS Critical findings warn unless explicitly enabled. |
| `SECURITY_REQUIRE_FIX_AVAILABLE_TO_BLOCK` | Security policy | Required for scans | `true` | Security policy decision | `backend/.env` | No-fix findings warn rather than making a deployment permanently unrecoverable. |
| `SECURITY_MEDIUM_APPROVAL_THRESHOLD` | Security policy | Optional | `5` | Security policy decision | `backend/.env` | Used only when medium approval is explicitly enabled. |
| `SECURITY_LOW_BLOCKING` | Security policy | Optional | `false` | Security policy decision | `backend/.env` | Current code reads this; now present in `.env.example`. |
| `SECURITY_ALLOW_HIGH_CRITICAL_OVERRIDE` | Security approval | Optional | `false` | Security policy decision | `backend/.env` | Leave false unless explicitly allowing high/critical approval. |
| `SECURITY_ALLOW_MEDIUM_APPROVAL` | Security approval | Optional | `false` | Security policy decision | `backend/.env` | Enables an optional manual medium-threshold gate when explicitly required. |
| `CORS_ORIGIN` | CORS | Optional, not used by current code | `http://localhost:5173` | Local frontend URL | `backend/.env` | Current code uses `FRONTEND_URL` instead. |
| `COOKIE_SECRET` | Auth | Optional, not used by current code | `replace_with_long_random_value` | Generate locally | `backend/.env` | Current code uses `AUTH_SESSION_SECRET`. |
| `ACCESS_TOKEN_EXPIRES_IN` | Auth | Optional, not used by current code | `15m` | Local policy | `backend/.env` | Current code uses signed cookie sessions. |
| `REFRESH_TOKEN_EXPIRES_IN` | Auth | Optional, not used by current code | `7d` | Local policy | `backend/.env` | Current code uses signed cookie sessions. |
| `VITE_API_BASE_URL` | Frontend API client | Required now | `http://localhost:5000` | Local backend URL | `frontend/.env` | Public frontend variable; do not put secrets here. |

## External Credential Checklist

### GitHub OAuth

Create a GitHub OAuth App in GitHub Developer Settings.

| Field | Value |
| --- | --- |
| Homepage URL | `http://localhost:5173` |
| Authorization callback URL | `http://localhost:5000/api/auth/github/callback` |
| Backend variables | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_CALLBACK_URL` |
| OAuth scopes requested by code | `read:user user:email` |

Email/password signup and login do not need GitHub OAuth credentials.

### Optional GitHub Actions Token

DeployGuard does not require user repositories to contain GitHub Actions workflows, Dockerfiles, docker-compose files, Terraform files, or AWS credentials. Repository cloning, stack detection, template generation, image build, scanning, infrastructure, and deployment are handled by the platform worker.

GitHub Actions is optional external CI validation. When `GITHUB_ACTIONS_REQUIRED=false`, a missing workflow, missing `workflow_dispatch`, or insufficient dispatch permission produces a skipped/warning result and the internal pipeline continues.

Recommended token permissions:

| Repository type | Required access |
| --- | --- |
| Fine-grained token | Target repository selected, Actions read/write, Contents read, Metadata read |
| Classic token for private repos | `repo` |
| Classic token for public-only repos | `public_repo` may be enough for repository access, but workflow dispatch commonly needs Actions write access |

When external CI is used, dispatch uses `GITHUB_ACTIONS_WORKFLOW_FILE` and the selected branch. For private multi-user repositories, implement GitHub App installation access tokens instead of relying on a single backend personal access token.

### AWS and ECR

The backend uses AWS SDK credentials from environment variables and Docker CLI for registry login/tag/push.

Required IAM permissions for the ECR flow:

| Permission |
| --- |
| `ecr:GetAuthorizationToken` |
| `ecr:CreateRepository` |
| `ecr:DescribeRepositories` |
| `ecr:PutLifecyclePolicy` |
| `ecr:BatchCheckLayerAvailability` |
| `ecr:InitiateLayerUpload` |
| `ecr:UploadLayerPart` |
| `ecr:CompleteLayerUpload` |
| `ecr:PutImage` |

Repository names are built from `ECR_REPOSITORY_PREFIX` and the sanitized project name, for example `mini-paas-my-app`. The lifecycle policy expires untagged images older than 30 days.

ECR push is part of the default full 6.5 pipeline. Missing AWS config fails the worker with a clear pipeline event; AWS credentials stay only in the Deploy Guard backend/worker environment.

### Persistent Storage and AWS EFS

Module 6.10 provisions optional EFS storage through the Deploy Guard worker and Terraform infrastructure flow. EFS is not enabled by default for every app; it is enabled when stack detection recommends persistent storage or a developer enables storage settings for a project.

Backend variables:

| Variable | Example |
| --- | --- |
| `DEPLOYGUARD_ENABLE_EFS` | `true` |
| `DEPLOYGUARD_EFS_DEFAULT_ENABLED` | `false` |
| `DEPLOYGUARD_EFS_POSIX_UID` | `1000` |
| `DEPLOYGUARD_EFS_POSIX_GID` | `1000` |
| `DEPLOYGUARD_EFS_ROOT_PERMISSIONS` | `750` |
| `DEPLOYGUARD_EFS_ROOT_DIRECTORY_BASE` | `/deployguard` |
| `DEPLOYGUARD_EFS_PERFORMANCE_MODE` | `generalPurpose` |
| `DEPLOYGUARD_EFS_THROUGHPUT_MODE` | `bursting` |
| `DEPLOYGUARD_EFS_TRANSITION_TO_IA` | `AFTER_30_DAYS` |
| `DEPLOYGUARD_EFS_ENABLE_BACKUP` | `true` |
| `DEPLOYGUARD_EFS_BACKUP_RETENTION_DAYS` | `30` |
| `DEPLOYGUARD_EFS_BACKUP_SCHEDULE` | `cron(0 3 * * ? *)` |

Additional IAM permissions for EFS/KMS/Backup provisioning:

| Permission |
| --- |
| `elasticfilesystem:CreateFileSystem` |
| `elasticfilesystem:DescribeFileSystems` |
| `elasticfilesystem:CreateMountTarget` |
| `elasticfilesystem:DescribeMountTargets` |
| `elasticfilesystem:CreateAccessPoint` |
| `elasticfilesystem:DescribeAccessPoints` |
| `elasticfilesystem:TagResource` |
| `ec2:CreateSecurityGroup` |
| `ec2:AuthorizeSecurityGroupIngress` |
| `ec2:AuthorizeSecurityGroupEgress` |
| `ec2:DescribeSecurityGroups` |
| `kms:CreateKey` |
| `kms:CreateAlias` |
| `kms:EnableKeyRotation` |
| `kms:TagResource` |
| `backup:CreateBackupVault` |
| `backup:CreateBackupPlan` |
| `backup:CreateBackupSelection` |
| `iam:CreateRole` |
| `iam:AttachRolePolicy` |
| `iam:PassRole` |

Storage endpoints:

| Method | Path |
| --- | --- |
| `GET` | `/api/projects/:projectId/storage/recommendation` |
| `GET` | `/api/projects/:projectId/storage` |
| `PATCH` | `/api/projects/:projectId/storage/settings` |
| `POST` | `/api/projects/:projectId/storage/provision` |
| `GET` | `/api/projects/:projectId/storage/events` |
| `GET` | `/api/projects/:projectId/storage/mount-config` |
| `GET` | `/api/projects/:projectId/backups` |
| `POST` | `/api/projects/:projectId/backups/restore-request` |

### Trivy

Trivy must be installed on the machine running the worker.

Check command:

```bash
trivy --version
```

The worker runs Trivy after Docker image build and before ECR push. Missing Trivy, missing Docker image, invalid Trivy JSON, and policy failures are expected to fail cleanly and record scan state.

### Terraform Stage

Module 6.5 includes a queued Terraform stage in the BullMQ worker flow. Full production Terraform provisioning belongs to module 6.8. Until Terraform modules are configured under `TERRAFORM_WORKSPACE_DIR`, the worker emits `terraform_plan_skipped_not_configured`, records audit metadata, and continues after ECR lifecycle policy enforcement.

### Docker

Docker is required on the worker host for build/tag/push and for Trivy image scans.

Check command:

```bash
docker ps
```

### PostgreSQL

Local PostgreSQL is provided by Docker Compose.

Expected values:

| Setting | Value |
| --- | --- |
| Host | `localhost` |
| Host port | `5433` |
| Container port | `5432` |
| Database | `mini_paas` |
| Username | `mini_paas_user` |
| Password | `mini_paas_password` |

### Redis

Local Redis is provided by Docker Compose on `localhost:6379`. BullMQ uses Redis for queueing pipeline runs between the backend API and separate worker process.

## Endpoint Map

All protected routes require the signed auth cookie created by login, signup, or GitHub OAuth.

### Auth

| Method | Path | Auth | Role | Body | Response | Setup dependency |
| --- | --- | --- | --- | --- | --- | --- |
| `POST` | `/auth/signup`, `/api/auth/signup` | No | Public | `{ name, email, password }` | `{ user }` | PostgreSQL |
| `POST` | `/auth/login`, `/api/auth/login` | No | Public | `{ email, password }` | `{ user }` | PostgreSQL |
| `GET` | `/auth/me`, `/api/auth/me` | Yes | Any signed-in user | None | `{ user }` | PostgreSQL |
| `POST` | `/auth/logout`, `/api/auth/logout` | Cookie clear | Any signed-in user | None | `{ message }` | None |
| `GET` | `/auth/github`, `/api/auth/github` | No | Public | None | Redirect | GitHub OAuth credentials |
| `GET` | `/auth/github/callback`, `/api/auth/github/callback` | OAuth state | Public | Query `code`, `state` | Redirect to frontend | GitHub OAuth credentials |
| `POST` | `/auth/github/callback`, `/api/auth/github/callback` | No | Legacy public callback | GitHub profile DTO | Success payload | PostgreSQL |

### Admin and RBAC

| Method | Path | Auth | Role | Body | Response | Setup dependency |
| --- | --- | --- | --- | --- | --- | --- |
| `GET` | `/api/admin/users` | Yes | Admin | None | `{ users }` | PostgreSQL |
| `PATCH` | `/api/admin/users/:userId/role` | Yes | Admin | `{ role }` | `{ user }` | PostgreSQL |

### Audit Logs

| Method | Path | Auth | Role | Body | Response | Setup dependency |
| --- | --- | --- | --- | --- | --- | --- |
| `GET` | `/api/audit-logs` | Yes | Admin, Developer, Readonly | Query filters | Paginated audit logs | PostgreSQL |

Supported filters include page, limit, action, resource type, status, and date range.

### Project Management

| Method | Path | Auth | Role | Body | Response | Setup dependency |
| --- | --- | --- | --- | --- | --- | --- |
| `GET` | `/api/projects` | Yes | Admin, Developer, Readonly | None | `{ projects }` | PostgreSQL |
| `POST` | `/api/projects` | Yes | Admin, Developer | Project DTO | `{ project }` | PostgreSQL |
| `GET` | `/api/projects/:projectId` | Yes | Admin, Developer, Readonly | None | `{ project }` | PostgreSQL |
| `PATCH` | `/api/projects/:projectId` | Yes | Admin, Developer, owner rules | Project update DTO | `{ project }` | PostgreSQL |
| `DELETE` | `/api/projects/:projectId` | Yes | Admin, Developer, owner rules | None | `{ message }` | PostgreSQL |
| `PATCH` | `/api/projects/:projectId/repository` | Yes | Admin, Developer, owner rules | Repository DTO | `{ project }` | Git for some follow-up checks |
| `GET` | `/api/projects/:projectId/branches` | Yes | Admin, Developer, Readonly | None | `{ branches }` | Git and reachable repo |
| `PATCH` | `/api/projects/:projectId/branch` | Yes | Admin, Developer, owner rules | `{ branch }` | `{ project }` | PostgreSQL |
| `GET` | `/api/projects/:projectId/env` | Yes | Admin, Developer, Readonly | None | `{ variables }` | PostgreSQL |
| `POST` | `/api/projects/:projectId/env` | Yes | Admin, Developer, owner rules | Env var DTO | `{ variable }` | PostgreSQL |
| `PATCH` | `/api/projects/:projectId/env/:envId` | Yes | Admin, Developer, owner rules | Env var update DTO | `{ variable }` | PostgreSQL |
| `DELETE` | `/api/projects/:projectId/env/:envId` | Yes | Admin, Developer, owner rules | None | `{ message }` | PostgreSQL |

### Stack Detection and Pre-flight

| Method | Path | Auth | Role | Body | Response | Setup dependency |
| --- | --- | --- | --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/detect-stack` | Yes | Admin, Developer, Readonly | None | `{ profile }` | Git and reachable repo |
| `GET` | `/api/projects/:projectId/detection-profile` | Yes | Admin, Developer, Readonly | None | `{ profile }` | PostgreSQL |
| `POST` | `/api/projects/:projectId/preflight` | Yes | Admin, Developer, Readonly | None | `{ report }` | Git and reachable repo |
| `GET` | `/api/projects/:projectId/preflight` | Yes | Admin, Developer, Readonly | None | `{ report }` | PostgreSQL |
| `GET` | `/api/templates` | Yes | Admin, Developer, Readonly | None | `{ templates }` | PostgreSQL/auth only |

### Pipeline Queue and Worker

| Method | Path | Auth | Role | Body | Response | Setup dependency |
| --- | --- | --- | --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/automation/start` | Yes | Admin, Developer, owner rules | None | `{ automation }`; idempotently detects, generates pre-flight, and queues the worker | Git, Redis, worker |
| `POST` | `/api/projects/:projectId/pipeline/runs` | Yes | Admin, Developer, owner rules | Optional external-CI flag; internal build stages remain platform-managed | `{ pipelineRun }` after queueing | Redis, worker, Docker, Trivy, AWS ECR |
| `GET` | `/api/projects/:projectId/pipeline/runs` | Yes | Admin, Developer, Readonly | None | `{ pipelineRuns }` | PostgreSQL |
| `GET` | `/api/projects/:projectId/pipeline/runs/:runId` | Yes | Admin, Developer, Readonly | None | `{ pipelineRun }` | PostgreSQL |
| `GET` | `/api/projects/:projectId/pipeline/runs/:runId/events` | Yes | Admin, Developer, Readonly | None | `{ events }` | PostgreSQL |
| `POST` | `/api/projects/:projectId/pipeline/runs/:runId/cancel` | Yes | Admin, Developer, owner rules | None | `{ pipelineRun }` with `cancelled` status | PostgreSQL, Redis |
| `POST` | `/api/projects/:projectId/pipeline/runs/:runId/retry` | Yes | Admin, Developer, owner rules | None | `{ pipelineRun }` for the new queued run | Redis, worker |

The backend API only queues work. The worker must be started separately with `cd backend && npm run worker:pipeline`. The internal worker is the primary deployment engine: validate, clone, snapshot detection, generate templates, build, scan, enforce security, push to ECR, plan, estimate cost, stop at the apply gate when disabled, and deploy when explicitly enabled. Optional external CI is a side validation and is not a dependency by default.

Authoritative internal stage order:

1. Validate inputs
2. Clone repository
3. Stack detection snapshot
4. Template generation
5. Docker build
6. Trivy scan
7. Security gate
8. ECR push
9. Terraform plan
10. FinOps estimate
11. Cost gate
12. Terraform apply gate
13. State lock
14. Terraform apply
15. Optional EFS
16. ECS deploy
17. ALB health
18. Stable release
19. Observability

`Optional External CI` is reported separately from this critical path. It blocks internal stages only when `GITHUB_ACTIONS_REQUIRED=true`.

### Security Scanning

| Method | Path | Auth | Role | Body | Response | Setup dependency |
| --- | --- | --- | --- | --- | --- | --- |
| `POST` | `/api/projects/:projectId/security-scans` | Yes | Admin, Developer, owner rules | `{ imageName, source }` or related DTO fields | `{ scan }` | Docker image and Trivy |
| `GET` | `/api/projects/:projectId/security-scans` | Yes | Admin, Developer, Readonly | None | `{ scans }` | PostgreSQL |
| `GET` | `/api/projects/:projectId/security-scans/:scanId` | Yes | Admin, Developer, Readonly | None | `{ scan }` | PostgreSQL |
| `GET` | `/api/projects/:projectId/security-scans/:scanId/findings` | Yes | Admin, Developer, Readonly | Query filters | Findings payload | PostgreSQL |
| `POST` | `/api/projects/:projectId/security-scans/:scanId/approve` | Yes | Admin, Developer, owner rules | Approval DTO | `{ scan }` | Existing scan requiring approval |

Readonly users cannot trigger or approve scans through the backend service rules.

## Setup Status Report

### Ready With Local PostgreSQL, Redis, and `.env`

| Feature | Status | Notes |
| --- | --- | --- |
| Email/password auth | Ready | Requires migrations/tables and `AUTH_SESSION_SECRET`. |
| RBAC | Ready | Roles are persisted on users. |
| Audit logs | Ready | Requires database connection. |
| Project CRUD | Ready | Requires database connection. |
| Environment variable management | Ready | Values must not be logged or exposed. |
| Templates | Ready | Requires authenticated user. |
| Pipeline queue submission | Ready | Requires Redis. Worker processing is separate. |
| Security scan history/details | Ready | Requires database and existing scan records. |

### Needs GitHub OAuth Credentials

| Feature | Blocked by |
| --- | --- |
| GitHub browser login | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and matching `GITHUB_CALLBACK_URL` |

### Needs GitHub Token

| Feature | Blocked by |
| --- | --- |
| Optional GitHub Actions workflow dispatch | `GITHUB_TOKEN` with Actions write access and a dispatchable workflow, only when external CI is desired |
| Private repository clone access | Backend token or future GitHub App installation token with repository access |

### Needs Docker Daemon

| Feature | Blocked by |
| --- | --- |
| Worker Docker build | Running Docker daemon |
| Docker image tag using commit hash | Successful clone and build |
| ECR tag/push | Running Docker daemon plus AWS credentials |
| Trivy image scan | Running Docker daemon and local image availability |

### Needs Trivy

| Feature | Blocked by |
| --- | --- |
| Security gate after Docker build | Trivy CLI installed on worker host |
| Manual security scan trigger | Trivy CLI and target Docker image |

### Needs AWS Credentials

| Feature | Blocked by |
| --- | --- |
| ECR repository creation | AWS account credentials and IAM permissions |
| ECR lifecycle policy | AWS account credentials and IAM permissions |
| ECR image push | AWS account credentials, IAM permissions, Docker daemon |

### Needs Private Repo Token Support

| Feature | Current limitation |
| --- | --- |
| Clone private repositories for detection/build | Current clone flows are best suited to public repositories unless tokenized clone support is added. |
| Fetch branches for private repositories | Requires repository access strategy beyond a public URL. |

### URL Alignment

| Setting | Expected value | Notes |
| --- | --- | --- |
| `FRONTEND_URL` | `http://localhost:5173` | Used by CORS and OAuth redirect. |
| `VITE_API_BASE_URL` | `http://localhost:5000` | Used by frontend API client. |
| `PORT` | `5000` | Backend port. |
| `GITHUB_CALLBACK_URL` | `http://localhost:5000/api/auth/github/callback` | Must match GitHub OAuth App exactly. |

The code now uses these same local defaults when environment variables are missing. Keep `backend/.env` populated so deployment-specific URLs still override local fallbacks.

## Local Setup Commands

From project root:

```bash
docker compose up -d postgres redis
docker compose ps
docker compose logs -f postgres redis
```

Backend:

```bash
cd backend
npm install
npm run migration:run
npm run start:dev
```

Worker in a separate terminal:

```bash
cd backend
npm run worker:pipeline
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

Build checks:

```bash
cd backend
npm run build
```

```bash
cd frontend
npm run build
```

Service checks:

```bash
docker ps
trivy --version
docker compose exec redis redis-cli ping
pg_isready -h localhost -p 5433 -U mini_paas_user
docker compose exec postgres psql -U mini_paas_user -d mini_paas -c '\dt'
```

If you need a clean local database:

```bash
docker compose down -v
docker compose up -d postgres redis
cd backend
npm run migration:run
```

## End-to-End Manual Test Checklist

1. Copy `backend/.env.example` to `backend/.env` if missing, then fill only local placeholders and real credentials you intend to test.
2. Copy `frontend/.env.example` to `frontend/.env` if missing.
3. Start PostgreSQL and Redis with `docker compose up -d postgres redis`.
4. Confirm PostgreSQL is on host port `5433` and Redis is on `6379` with `docker compose ps`.
5. Run migrations from `backend` with `npm run migration:run`.
6. Start backend with `npm run start:dev`.
7. Start worker separately with `npm run worker:pipeline`.
8. Start frontend with `npm run dev`.
9. Sign up with email/password and confirm `/api/auth/me` returns the current user.
10. As admin, list users and change a user's role.
11. Confirm readonly users can view allowed resources but cannot create projects, trigger pipeline runs, or approve scans.
12. Create a project with a reachable repository URL.
13. Run stack detection and verify a detection profile is saved.
14. Run pre-flight validation and verify a report is saved.
15. Start a pipeline run and verify the API returns quickly with a queued run.
16. Watch the worker process the queued run and emit pipeline events.
17. Verify missing GitHub Actions workflow resolves as skipped and clone/build continue.
18. Verify Docker image tag and ECR image tag use the full commit SHA.
19. Verify Trivy runs after Docker build and before ECR push.
20. Verify ECR repository creation/checking, Docker login, image push, and lifecycle policy.
21. Verify Terraform emits `terraform_plan_skipped_not_configured` when modules are absent.
18. Verify low-only scans pass policy.
19. Verify high or critical findings block policy.
20. Verify medium findings above the threshold require approval when medium approval is enabled.
21. Verify approval only works for scans in `requires_approval`.
22. Verify auth signup/login/logout/OAuth audit logs are recorded.
23. Verify audit metadata, pipeline events, and scan findings do not contain secrets.
24. Run backend and frontend builds.

## Remaining Limitations

| Limitation | Impact |
| --- | --- |
| Private repository clone support is limited | Stack detection, pre-flight, and Docker build are easiest to test with public repositories. |
| Optional external CI needs a token and workflow to dispatch | Missing workflow or permission is non-blocking while `GITHUB_ACTIONS_REQUIRED=false`. |
| ECR push requires real AWS credentials and Docker daemon access | Full 6.5 pipeline success requires ECR config; missing config fails clearly. |
| Terraform apply is disabled | Set `TERRAFORM_APPLY_ENABLED=true` only after plan, FinOps, state, IAM, and cost review gates pass. |
| Trivy must be installed outside the app | Security scanning cannot pass until the worker host has Trivy. |
| `CORS_ORIGIN`, `COOKIE_SECRET`, token expiry envs, and `PIPELINE_DOCKER_NETWORK` are not used by current code | Do not rely on them until the code implements them. |

## Module 6.7 Predictive Cost Analysis / FinOps

### Environment Variables

| Setting | Local/mock value | Notes |
| --- | --- | --- |
| `FINOPS_MOCK_MODE` | `true` | Uses deterministic estimates from the saved project detection profile. |
| `FINOPS_ENFORCE_TIER_LIMITS` | `false` | When false, tier overages are warnings and do not block deployment. Approval thresholds remain separate. |
| `INFRACOST_API_KEY` | empty locally | Required only when `FINOPS_MOCK_MODE=false`. Keep backend/worker-side only. |
| `INFRACOST_CURRENCY` | `USD` | Display and persisted estimate currency. |
| `FINOPS_DEFAULT_WARNING_THRESHOLD_USD` | `25` | Default project approval threshold. |
| `FINOPS_FREE_TIER_LIMIT_USD` | `10` | Free-tier limit; enforced only when `FINOPS_ENFORCE_TIER_LIMITS=true`. |
| `FINOPS_STARTER_TIER_LIMIT_USD` | `50` | Starter-tier limit; enforced only when `FINOPS_ENFORCE_TIER_LIMITS=true`. |
| `FINOPS_PRO_TIER_LIMIT_USD` | `200` | Pro-tier limit; enforced only when `FINOPS_ENFORCE_TIER_LIMITS=true`. |
| `FINOPS_ENTERPRISE_TIER_LIMIT_USD` | `999999` | Enterprise-tier limit; enforced only when `FINOPS_ENFORCE_TIER_LIMITS=true`. |
| `FINOPS_TERRAFORM_WORKDIR` | empty locally | Base directory for per-project Terraform workdirs in real mode. |
| `FINOPS_ENABLE_REAL_TERRAFORM` | `false` | Reserved switch for real Terraform cost planning. |

### API Endpoints

| Method | Path | Access |
| --- | --- | --- |
| `POST` | `/api/projects/:projectId/cost-estimates` | Admin/developer project managers. |
| `GET` | `/api/projects/:projectId/cost-estimates` | Project viewers. |
| `GET` | `/api/projects/:projectId/cost-estimates/latest` | Project viewers. |
| `GET` | `/api/projects/:projectId/cost-estimates/:estimateId` | Project viewers. |
| `POST` | `/api/projects/:projectId/cost-estimates/:estimateId/approve` | Admin/developer project managers. |
| `POST` | `/api/projects/:projectId/cost-estimates/:estimateId/reject` | Admin/developer project managers. |
| `GET` | `/api/projects/:projectId/cost-settings` | Project viewers. |
| `PATCH` | `/api/projects/:projectId/cost-settings` | Admin/developer project managers. |

### Pipeline Behavior

The worker now runs a FinOps gate after the Terraform planning stage. In mock mode it records a deterministic monthly AWS estimate, normalized resource breakdown rows, cost policy events, and audit logs. Estimates above the warning threshold pause the run at `waiting_for_cost_approval`. Estimates above the subscription tier limit stop the run at `blocked_by_cost_limit`. If the cost gate passes, the current MVP records `provisioning_skipped_not_configured` because module 6.8 provisioning is not implemented yet.

Real mode runs Terraform plan JSON through Infracost. It requires Terraform, Infracost, configured Terraform work directories, and `INFRACOST_API_KEY` in the backend/worker environment only.

### Manual FinOps Test

1. Set `FINOPS_MOCK_MODE=true` in `backend/.env`.
2. Start PostgreSQL and Redis with `docker compose up -d postgres redis`.
3. Run migrations from `backend` with `npm run migration:run`.
4. Start backend with `npm run start:dev`.
5. Start worker separately with `npm run worker:pipeline`.
6. Start frontend with `npm run dev`.
7. Create or open a project, run stack detection, and run pre-flight validation.
8. Open `/projects/:projectId/costs`.
9. Generate a cost estimate and verify summary, resource breakdown, status, and settings.
10. Lower the warning threshold and generate another estimate to verify approval-required behavior.
11. Set the project tier to `free` and verify over-limit estimates are blocked.
12. Confirm readonly users can view estimates but cannot generate, approve, reject, or update settings.
13. Start a pipeline run and verify cost-analysis events appear after Terraform events.
14. Confirm audit logs contain cost actions without API keys, tokens, secrets, cookies, or credentials.

## Module 6.8 Infrastructure Provisioning & Service Discovery

### Overview

Module 6.8 adds a Deploy button flow that queues deployment work through BullMQ and the backend worker. The worker owns the deployment path: clone, template generation, Docker build, Trivy gate, ECR push, infrastructure Terraform plan, FinOps gate, and Terraform apply. Optional external CI runs as side validation. Terraform apply is disabled by default for safety.

### Deploy Button Behavior

The Deploy panel lives on the project pipeline page. It calls `GET /api/projects/:projectId/deployment-readiness` and enables Deploy only when required gates pass. Readonly users can view readiness and infrastructure status, but cannot deploy.

The button shows blocking reasons such as missing stack detection, failed pre-flight validation, blocked security scans, missing cost approval, missing AWS configuration, missing Terraform templates, or an in-progress deployment.

Before queueing deployment, the UI shows a charge warning:

```text
This will create AWS resources and may incur charges.
```

### Backend Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/:projectId/deployment-readiness` | Return Deploy button readiness checks. |
| `POST` | `/api/projects/:projectId/deploy` | Queue full deployment job. |
| `POST` | `/api/projects/:projectId/infrastructure/plan` | Queue Terraform plan-only job. |
| `POST` | `/api/projects/:projectId/infrastructure/apply` | Queue Terraform apply-only job after cost gate. |
| `GET` | `/api/projects/:projectId/infrastructure` | Return latest infrastructure environment/status/outputs. |
| `GET` | `/api/projects/:projectId/infrastructure/events` | Return infrastructure event timeline. |
| `GET` | `/api/projects/:projectId/service-discovery` | Return Cloud Map service discovery records. |

### Terraform Directory Structure

```text
backend/terraform/
  base-network/
    versions.tf
    main.tf
    variables.tf
    outputs.tf
    terraform.tfvars.example
  modules/
    network/
      main.tf
      variables.tf
      outputs.tf
    cloud-map/
      main.tf
      variables.tf
      outputs.tf
```

### AWS Resources Created

Plan/apply provisions a base AWS network:

- VPC with DNS support and DNS hostnames enabled
- Two public subnets
- Two private subnets
- Internet Gateway
- Public route table and associations
- Elastic IP and single NAT Gateway by default
- Private route table and associations
- ALB security group
- App security group allowing app port only from ALB SG
- Internal service security group for VPC/service-to-service traffic
- AWS Cloud Map private DNS namespace
- Default Cloud Map service placeholder for future ECS registration

### Environment Variables

```bash
TERRAFORM_BIN=terraform
TERRAFORM_WORKING_BASE_DIR=./.deployguard/terraform-workspaces
TERRAFORM_NETWORK_TEMPLATE_DIR=terraform/base-network
TERRAFORM_AUTO_APPROVE=true
TERRAFORM_APPLY_ENABLED=false
DEPLOYGUARD_DEFAULT_VPC_CIDR=10.0.0.0/16
DEPLOYGUARD_PUBLIC_SUBNET_CIDRS=10.0.1.0/24,10.0.2.0/24
DEPLOYGUARD_PRIVATE_SUBNET_CIDRS=10.0.101.0/24,10.0.102.0/24
DEPLOYGUARD_SINGLE_NAT_GATEWAY=true
DEPLOYGUARD_CLOUDMAP_NAMESPACE=deployguard.local
DEPLOYGUARD_ENABLE_HTTPS=false
DEPLOYGUARD_DEFAULT_APP_PORT=3000
```

Keep `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, and `INFRACOST_API_KEY` backend/worker-side only. The frontend receives readiness, status, and sanitized outputs only.

### AWS IAM Permissions

Approximate EC2 permissions:

- `ec2:CreateVpc`, `ec2:DeleteVpc`, `ec2:DescribeVpcs`, `ec2:ModifyVpcAttribute`
- `ec2:CreateSubnet`, `ec2:DeleteSubnet`, `ec2:DescribeSubnets`
- `ec2:CreateInternetGateway`, `ec2:AttachInternetGateway`, `ec2:DetachInternetGateway`, `ec2:DeleteInternetGateway`
- `ec2:CreateRouteTable`, `ec2:CreateRoute`, `ec2:AssociateRouteTable`, `ec2:DisassociateRouteTable`, `ec2:DeleteRouteTable`
- `ec2:AllocateAddress`, `ec2:ReleaseAddress`
- `ec2:CreateNatGateway`, `ec2:DeleteNatGateway`, `ec2:DescribeNatGateways`
- `ec2:CreateSecurityGroup`, `ec2:AuthorizeSecurityGroupIngress`, `ec2:AuthorizeSecurityGroupEgress`
- `ec2:RevokeSecurityGroupIngress`, `ec2:RevokeSecurityGroupEgress`, `ec2:DeleteSecurityGroup`, `ec2:DescribeSecurityGroups`
- `ec2:DescribeAvailabilityZones`

Approximate Cloud Map permissions:

- `servicediscovery:CreatePrivateDnsNamespace`
- `servicediscovery:GetNamespace`
- `servicediscovery:ListNamespaces`
- `servicediscovery:CreateService`
- `servicediscovery:GetService`
- `servicediscovery:ListServices`
- `servicediscovery:DeleteService`
- `servicediscovery:DeleteNamespace`

### Safety Notes

Terraform apply creates real AWS resources and may cost money. NAT Gateway has hourly cost. `TERRAFORM_APPLY_ENABLED=false` is the default. When false, full deploy can plan and pass previous gates, then stops at an intentional `disabled_by_config` apply gate without marking the run failed. Destroy/cleanup is not implemented until module 6.15, so do not leave NAT Gateway running in a real AWS account.

Terraform apply never runs before the FinOps gate has `no_approval_required` or `approved`.

### Safe Plan-Only Test

1. Set `TERRAFORM_APPLY_ENABLED=false`.
2. Start PostgreSQL and Redis.
3. Run migrations.
4. Start backend.
5. Start worker.
6. Start frontend.
7. Login.
8. Create project and link GitHub repo.
9. Run detection and pre-flight validation.
10. Generate or approve a 6.7 cost estimate.
11. Open the project pipeline page.
12. Verify readiness checklist.
13. Click Deploy and confirm.
14. Verify the job queues and reaches Terraform plan.
15. Verify apply is shown as `disabled_by_config` because `TERRAFORM_APPLY_ENABLED=false`, with later AWS stages blocked by the apply gate.

### Real Apply Test

1. Use a test AWS account.
2. Set `TERRAFORM_APPLY_ENABLED=true`.
3. Ensure Terraform CLI is installed and AWS credentials are backend/worker-side.
4. Ensure the cost estimate is approved or does not require approval.
5. Click Deploy and confirm the cost warning.
6. Verify VPC, subnets, IGW, NAT Gateway, route tables, security groups, and Cloud Map namespace in AWS console.
7. Verify sanitized outputs appear in the infrastructure panel.
8. Do not leave NAT Gateway running longer than necessary.

### Remaining For Later Modules

- 6.11: ECS service orchestration and zero-downtime rollout using these outputs.
- 6.15: destroy/cleanup workflow.

## Module 6.9 Distributed State Management

### Overview

Module 6.9 adds Terraform state safety around the 6.8 provisioning flow. Terraform workspaces now generate `backend.hcl` for an S3 backend, use a deterministic per-user/per-project state key, acquire a DeployGuard platform lock before plan/apply, run a heartbeat while Terraform is active, validate state metadata, and release the lock after completion or failure.

The implementation includes a local mock mode for state-lock testing without AWS. Set `STATE_MOCK_MODE=false` for real S3/DynamoDB-backed state operations.

### State Key Hierarchy

```text
deployguard/state/user-{userId}/project-{projectId}/{environmentName}/terraform.tfstate
```

The prefix is controlled by `DEPLOYGUARD_TF_STATE_PREFIX`.

### Environment Variables

```bash
DEPLOYGUARD_TF_STATE_BUCKET=
DEPLOYGUARD_TF_STATE_PREFIX=deployguard/state
DEPLOYGUARD_TF_LOCK_TABLE=deployguard-terraform-locks
STATE_LOCK_HEARTBEAT_INTERVAL_SECONDS=30
STATE_LOCK_STALE_AFTER_SECONDS=300
STATE_LOCK_MONITOR_INTERVAL_SECONDS=60
STATE_RESOURCE_DROP_WARNING_PERCENT=70
STATE_ENABLE_ORPHAN_AUTO_RECOVERY=true
STATE_ENABLE_FORCE_RELEASE=true
STATE_MOCK_MODE=true
```

`STATE_MOCK_MODE=true` is safe for local testing. For real AWS testing, set `STATE_MOCK_MODE=false`, configure `DEPLOYGUARD_TF_STATE_BUCKET`, `DEPLOYGUARD_TF_LOCK_TABLE`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY`.

### Platform Lock Protocol

1. Build lock ID: `project#{projectId}#environment#{environmentName}`.
2. Verify S3 state bucket, versioning, encryption, public access block, and lock table.
3. Acquire DeployGuard lock before Terraform plan/apply.
4. If lock exists, queue deployment and mark pipeline `waiting_for_state_lock`.
5. Start heartbeat every `STATE_LOCK_HEARTBEAT_INTERVAL_SECONDS`.
6. Run Terraform init with generated `backend.hcl`.
7. Run plan/apply.
8. Validate state metadata.
9. Stop heartbeat and release lock.
10. Promote the next queued deployment placeholder for the project.

### State Corruption Detection

Validation checks include:

- Terraform state JSON schema shape.
- SHA-256 checksum integrity.
- Resource count drop threshold from `STATE_RESOURCE_DROP_WARNING_PERCENT`.
- Dependency graph references and hash.

If corruption is detected, state status becomes `recovery_required`, a validation result is saved, and further apply should be blocked until recovery.

### Recovery Workflow

State management endpoints:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/:projectId/state` | State metadata, no raw state body. |
| `GET` | `/api/projects/:projectId/state/versions` | List S3 object versions. |
| `GET` | `/api/projects/:projectId/state/locks` | Current lock and project queue. |
| `GET` | `/api/projects/:projectId/state/validation` | Validation result history. |
| `POST` | `/api/projects/:projectId/state/validate` | Manual validation. |
| `POST` | `/api/projects/:projectId/state/recover` | Restore a selected S3 version. |
| `POST` | `/api/projects/:projectId/state/locks/:lockId/force-release` | Admin-only stale/orphan lock release. |

Frontend page: `/projects/:projectId/state`.

### Required AWS IAM Permissions

S3:

- `s3:CreateBucket`
- `s3:HeadBucket`
- `s3:GetBucketVersioning`
- `s3:PutBucketVersioning`
- `s3:PutBucketEncryption`
- `s3:PutPublicAccessBlock`
- `s3:GetObject`
- `s3:PutObject`
- `s3:DeleteObject`
- `s3:ListBucket`
- `s3:ListBucketVersions`
- `s3:GetObjectVersion`
- `s3:PutObjectTagging`

DynamoDB:

- `dynamodb:CreateTable`
- `dynamodb:DescribeTable`
- `dynamodb:GetItem`
- `dynamodb:PutItem`
- `dynamodb:UpdateItem`
- `dynamodb:DeleteItem`
- `dynamodb:Query`
- `dynamodb:Scan`

### Manual Mock Test

1. Set `STATE_MOCK_MODE=true`.
2. Start backend, worker, and frontend.
3. Open a project and visit `/projects/:projectId/state`.
4. Trigger a deployment or plan.
5. Verify lock metadata appears while Terraform work runs.
6. Trigger a second deployment for the same project.
7. Verify it enters `waiting_for_state_lock` queue.
8. Run manual validation from the State Management page.
9. Verify readonly users can view but cannot force-release locks.

### Real AWS Test

1. Set `STATE_MOCK_MODE=false`.
2. Set `DEPLOYGUARD_TF_STATE_BUCKET` and `DEPLOYGUARD_TF_LOCK_TABLE`.
3. Ensure AWS credentials and permissions are available only in backend/worker env.
4. Run infrastructure plan/apply.
5. Verify the S3 state object key is hierarchical.
6. Verify bucket versioning/encryption/public access block.
7. Verify DynamoDB lock record behavior while Terraform runs.
8. Verify heartbeat timestamps update and lock releases after completion.
9. Verify state versions are listed on the frontend.

### Safety Notes

- Terraform apply must not run unless a state lock is acquired and heartbeat is active.
- Force release is admin-only and only allowed for stale/orphaned locks.
- Raw Terraform state content is not returned to the frontend.
- AWS credentials and backend config files are never exposed to frontend.

## Module 6.11 Zero-Downtime ECS Orchestration

Recovery note: a partial 6.11 implementation existed before completion. It included backend orchestration files and Terraform module folders. The completed implementation reuses those files and avoids duplicate routes/entities.

### Overview

Module 6.11 deploys the ECR image produced by the pipeline to AWS ECS Fargate Spot. The worker only marks a deployment stable after AWS ECS reports service stability, ALB target health reports healthy targets, and a `ProjectStableRelease` row is saved for the full Git commit SHA.

### Deployment Flow

1. User clicks Deploy or full deploy reaches orchestration.
2. GitHub Actions, clone, Docker build, Trivy, ECR push, lifecycle policy, FinOps, Terraform state lock, infrastructure apply, and optional EFS outputs complete.
3. Terraform creates/updates ALB, target group, ECS cluster, task definition, ECS service, auto-scaling, and EventBridge ECS event rule.
4. Worker records ECS/ALB/auto-scaling/spot events.
5. Deployment is marked stable only after live ECS service stability and live ALB healthy target checks pass.
6. On failure, DeployGuard attempts rollback by updating the ECS service to the previous stable task definition and waiting for ECS/ALB health again.
7. Spot interruption recovery forces a new ECS deployment and uses a short cooldown to avoid duplicate replacement requests.
8. Scaling changes update the live Application Auto Scaling target/policy before the database record is updated.

### Environment Variables

```bash
DEPLOYGUARD_ECS_USE_FARGATE_SPOT=true
DEPLOYGUARD_ECS_ENABLE_FARGATE_FALLBACK=false
DEPLOYGUARD_ECS_MIN_TASKS=1
DEPLOYGUARD_ECS_MAX_TASKS=3
DEPLOYGUARD_ECS_CPU_TARGET_PERCENT=60
DEPLOYGUARD_ECS_DEFAULT_CPU=256
DEPLOYGUARD_ECS_DEFAULT_MEMORY=512
DEPLOYGUARD_ECS_LARGE_CPU=512
DEPLOYGUARD_ECS_LARGE_MEMORY=1024
DEPLOYGUARD_ECS_HEALTHCHECK_GRACE_SECONDS=60
DEPLOYGUARD_ECS_CONTAINER_INSIGHTS=false
DEPLOYGUARD_ALB_HEALTHCHECK_PATH=/health
DEPLOYGUARD_ALLOW_HEALTHCHECK_FALLBACK=false
DEPLOYGUARD_ROLLBACK_STABILITY_TIMEOUT_SECONDS=600
DEPLOYGUARD_SERVICE_STABILITY_TIMEOUT_SECONDS=600
DEPLOYGUARD_SERVICE_STABILITY_POLL_INTERVAL_SECONDS=15
DEPLOYGUARD_ALB_HEALTH_TIMEOUT_SECONDS=600
DEPLOYGUARD_ALB_HEALTH_POLL_INTERVAL_SECONDS=15
DEPLOYGUARD_SPOT_EVENT_WEBHOOK_SECRET=
DEPLOYGUARD_ENABLE_EVENTBRIDGE_SPOT_RULE=true
DEPLOYGUARD_ENABLE_AUTO_ROLLBACK=true
DEPLOYGUARD_SPOT_RECOVERY_COOLDOWN_SECONDS=120
```

### Backend Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/projects/:projectId/orchestration/deploy` | Queue full deploy/orchestration. |
| `GET` | `/api/projects/:projectId/orchestration/status` | Latest deployment, stable release, health, scaling, and spot status. |
| `GET` | `/api/projects/:projectId/orchestration/events` | Orchestration event timeline. |
| `GET` | `/api/projects/:projectId/orchestration/releases` | Stable release history. |
| `POST` | `/api/projects/:projectId/orchestration/rollback` | Manual rollback to previous stable release. |
| `GET` | `/api/projects/:projectId/orchestration/target-health` | ALB target health summary. |
| `GET` | `/api/projects/:projectId/orchestration/scaling` | Auto-scaling policy summary. |
| `PATCH` | `/api/projects/:projectId/orchestration/scaling` | Update min/max tasks and CPU target. |
| `POST` | `/api/projects/:projectId/orchestration/spot-event` | Protected internal spot interruption simulation/webhook endpoint. |

### Frontend Pages

| Page | Purpose |
| --- | --- |
| `/projects/:projectId/orchestration` | ECS deployment status, ALB health, scaling, Fargate Spot, rollback, and event timeline. |
| `/projects/:projectId/orchestration/releases` | Stable release history. |
| `/projects/:projectId/orchestration/rollback` | Manual rollback panel. |

### Required AWS IAM Permissions

ECS:
- `ecs:CreateCluster`
- `ecs:DescribeClusters`
- `ecs:RegisterTaskDefinition`
- `ecs:DeregisterTaskDefinition`
- `ecs:CreateService`
- `ecs:UpdateService`
- `ecs:DescribeServices`
- `ecs:DescribeTasks`
- `ecs:ListTasks`
- `ecs:RunTask`
- `ecs:StopTask`
- `ecs:TagResource`

ELBv2:
- `elasticloadbalancing:CreateLoadBalancer`
- `elasticloadbalancing:CreateTargetGroup`
- `elasticloadbalancing:CreateListener`
- `elasticloadbalancing:ModifyTargetGroup`
- `elasticloadbalancing:DescribeLoadBalancers`
- `elasticloadbalancing:DescribeTargetGroups`
- `elasticloadbalancing:DescribeTargetHealth`
- `elasticloadbalancing:DescribeListeners`

Application Auto Scaling:
- `application-autoscaling:RegisterScalableTarget`
- `application-autoscaling:PutScalingPolicy`
- `application-autoscaling:DescribeScalableTargets`
- `application-autoscaling:DescribeScalingPolicies`

EventBridge and logs:
- `events:PutRule`
- `events:PutTargets`
- `events:DescribeRule`
- `events:ListTargetsByRule`
- `events:CreateConnection`
- `events:UpdateConnection`
- `events:CreateApiDestination`
- `events:UpdateApiDestination`
- `events:InvokeApiDestination`
- `logs:CreateLogGroup`
- `logs:CreateLogStream`
- `logs:PutLogEvents`
- `logs:DescribeLogGroups`

IAM/ECR/EFS:
- `iam:CreateRole`
- `iam:AttachRolePolicy`
- `iam:PassRole`
- `iam:GetRole`
- `ecr:GetAuthorizationToken`
- `ecr:BatchGetImage`
- `ecr:GetDownloadUrlForLayer`
- `elasticfilesystem:ClientMount`
- `elasticfilesystem:ClientWrite`
- `elasticfilesystem:DescribeFileSystems`
- `elasticfilesystem:DescribeAccessPoints`

### Manual Mock Test

1. Start PostgreSQL and Redis.
2. Run migrations.
3. Start backend, worker, and frontend.
4. Open `/projects/:projectId/orchestration`.
5. Verify no stable release appears before a successful deployment.
6. Verify readonly can view but cannot deploy, rollback, or update scaling.
7. Update scaling as admin/developer and confirm the value is saved.
8. Send a sample spot event to `/api/projects/:projectId/orchestration/spot-event` with `x-deployguard-spot-secret`.
9. Confirm the spot interruption appears in the UI and event log.

### Real AWS Test

1. Use a test AWS account.
2. Configure AWS credentials only in backend/worker env.
3. Set `TERRAFORM_APPLY_ENABLED=true` only when ready.
4. Ensure ECR image exists with a full Git commit SHA tag.
5. Ensure FinOps/security gates pass.
6. Run a full deploy.
7. Verify ECS service uses Fargate Spot capacity provider strategy.
8. Verify ALB DNS responds and health check path returns success.
9. Verify deployment is marked stable and release is saved.
10. Deploy a broken image or health path and verify rollback behavior.
11. Verify EventBridge ECS event rule/log group exists.

### Safety And Limitations

- AWS credentials, ECR auth tokens, Terraform state, GitHub tokens, session secrets, and raw project secrets are not sent to the frontend.
- Secret project env vars are not injected into the Terraform task definition renderer.
- EventBridge always writes to its log target and adds a protected API Destination when `BACKEND_URL` is public HTTPS and `DEPLOYGUARD_SPOT_EVENT_WEBHOOK_SECRET` is set.
- Real ECS service/target health waiting depends on Terraform output and future deeper AWS SDK polling; do not run real production workloads until verified in a test AWS account.

## Module 6.12 Dual-Stack Monitoring & Observability

### Overview

Module 6.12 adds read-only observability for DeployGuard projects. It stores sanitized pipeline stage metrics, streams sanitized ECS task logs from CloudWatch Logs through auth-protected SSE, and exposes runtime telemetry from Prometheus with CloudWatch Metrics fallback.

### Pipeline Metrics Tracked

- GitHub Actions dispatch/run duration.
- Repository clone duration.
- Docker build duration.
- Trivy scan duration and vulnerability counts.
- ECR push duration.
- Terraform plan/apply duration.
- FinOps cost analysis duration.
- EFS provisioning duration.
- ECS deployment and service-stability duration.
- ALB health-check duration.
- Rollback and Spot recovery durations when present.

### GitHub Actions Duration Tracking

DeployGuard reads `ProjectPipelineRun.githubWorkflowRunId` when available and can query the GitHub Actions run with backend-side `GITHUB_TOKEN`. If the workflow run cannot be resolved, observability returns a fallback dispatched/unknown metric and does not fail the page.

### Trivy Scan Duration Tracking

Observability uses existing `project_security_scans` and findings. It does not rescan images. It reports scan status, start/end time, duration, severity counts, policy decision, and remediation/finding count.

### ECS Log Streaming Through SSE

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/:projectId/observability/logs` | Return recent sanitized CloudWatch log events. |
| `GET` | `/api/projects/:projectId/observability/logs/stream` | Stream sanitized log lines using Server-Sent Events. |

SSE events:
- `connected`
- `log_line`
- `heartbeat`
- `error`
- `completed`

The stream is protected by normal project access checks. Admin, developer, and readonly users can view observability data.

### Log Sanitization

Log lines and metadata are sanitized before leaving the backend. The sanitizer masks AWS keys, GitHub tokens, bearer/JWT/session-like tokens, OAuth codes, password/API-key style assignments, private keys, and database URLs with embedded passwords.

### Prometheus Setup

```bash
PROMETHEUS_ENABLED=false
PROMETHEUS_BASE_URL=http://localhost:9090
PROMETHEUS_QUERY_TIMEOUT_SECONDS=10
```

When disabled, the runtime metrics endpoint returns a clear “Prometheus is not configured” state and can fall back to CloudWatch if enabled.

### CloudWatch Fallback Setup

```bash
CLOUDWATCH_LOGS_ENABLED=true
CLOUDWATCH_METRICS_ENABLED=true
OBSERVABILITY_LOG_STREAM_POLL_INTERVAL_SECONDS=5
OBSERVABILITY_LOG_STREAM_MAX_EVENTS=100
OBSERVABILITY_LOG_STREAM_HEARTBEAT_SECONDS=15
OBSERVABILITY_MASK_SECRETS=true
OBSERVABILITY_DEFAULT_RANGE=1h
```

### Runtime Telemetry Shown

- CPU usage.
- Memory usage.
- HTTP latency.
- Request rate.
- ALB target health and request/error counts where CloudWatch dimensions are available.

### Backend Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/projects/:projectId/observability/summary` | Latest pipeline, deployment, health, Prometheus, and CloudWatch status. |
| `GET` | `/api/projects/:projectId/observability/pipeline-metrics` | Stage metrics and pipeline duration summary. |
| `GET` | `/api/projects/:projectId/observability/runtime-metrics` | Prometheus or CloudWatch CPU/memory/latency/request metrics. |
| `GET` | `/api/projects/:projectId/observability/logs` | Recent sanitized CloudWatch logs. |
| `GET` | `/api/projects/:projectId/observability/logs/stream` | Auth-protected SSE log stream. |
| `GET` | `/api/projects/:projectId/observability/health` | Observability provider and ECS/ALB health status. |

### Frontend Pages

| Page | Purpose |
| --- | --- |
| `/projects/:projectId/observability` | Overview, stage timeline, GitHub/Trivy cards, service health. |
| `/projects/:projectId/observability/logs` | Recent logs and live SSE stream. |
| `/projects/:projectId/observability/metrics` | CPU, memory, latency, and request-rate charts. |

### Required AWS IAM Permissions

CloudWatch Logs:
- `logs:DescribeLogGroups`
- `logs:DescribeLogStreams`
- `logs:GetLogEvents`
- `logs:FilterLogEvents`

CloudWatch Metrics:
- `cloudwatch:GetMetricData`
- `cloudwatch:GetMetricStatistics`
- `cloudwatch:ListMetrics`

ECS:
- `ecs:DescribeServices`
- `ecs:DescribeTasks`
- `ecs:ListTasks`

ELBv2:
- `elasticloadbalancing:DescribeTargetHealth`
- `elasticloadbalancing:DescribeTargetGroups`
- `elasticloadbalancing:DescribeLoadBalancers`

No destructive AWS permissions are required for Module 6.12.

### Manual Test Steps

Test 1: Pipeline metrics
1. Start backend, worker, and frontend.
2. Run a deployment pipeline.
3. Open `/projects/:projectId/observability`.
4. Verify stage durations appear.
5. Verify Trivy scan duration appears.
6. Verify GitHub Actions metric appears or fallback dispatch status appears.

Test 2: SSE logs
1. Ensure ECS task logs are in CloudWatch.
2. Open `/projects/:projectId/observability/logs`.
3. Start the SSE stream.
4. Verify log lines appear.
5. Verify heartbeat events keep the stream alive.
6. Verify secrets are masked.

Test 3: Prometheus disabled
1. Set `PROMETHEUS_ENABLED=false`.
2. Open `/projects/:projectId/observability/metrics`.
3. Verify the UI shows Prometheus not configured.
4. Verify CloudWatch fallback is used if enabled.

Test 4: Prometheus enabled
1. Set `PROMETHEUS_ENABLED=true`.
2. Set `PROMETHEUS_BASE_URL`.
3. Open `/projects/:projectId/observability/metrics`.
4. Verify CPU, memory, and latency charts appear.

Test 5: RBAC
1. Confirm readonly users can view observability.
2. Confirm readonly users still cannot perform deployment actions.
3. Confirm admin/developer users can view all observability data.

### Limitations

- CloudWatch log group resolution uses the ECS Terraform output stored in deployment metadata, with explicit query/default fallbacks for older deployments.
- Prometheus queries are generic defaults and may need deployment-specific labels in a real cluster.
- CloudWatch ALB metrics require ALB and target group ARN dimensions from Terraform outputs.
- Observability does not rescan Trivy or rerun pipeline work.

### Security Notes

- AWS, GitHub, ECR, Prometheus, session, Terraform state, and raw environment secrets remain backend-side.
- Frontend receives sanitized metrics, events, health summaries, and log lines only.
- Observability endpoints are read-only except for storing DeployGuard metric, event, and log-stream session records.
