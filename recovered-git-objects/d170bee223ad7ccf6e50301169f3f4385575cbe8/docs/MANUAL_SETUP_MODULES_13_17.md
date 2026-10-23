# Manual setup for DeployGuard Modules 13–17

## 1. What is already automatic

DeployGuard persists AI sessions/results, notification preferences/deliveries, destroy challenges/operations, short-lived exports, billing subscriptions, usage and webhook idempotency. Evidence is sanitized/bounded; missing providers are labeled `demo`, `fallback`, `unavailable`, or `skipped_unconfigured`. Destroy is queued and demo-only by default. ZIP export excludes state, plans, credentials, caches and symlinks.

## 2. Prerequisites and install commands

Use Node.js 20+, npm, PostgreSQL and Redis. Git/Docker are needed for the existing pipeline. Terraform/AWS credentials are only needed for live infrastructure behavior.

```bash
cd backend && npm install
cd ../frontend && npm install
```

## 3. Database migration commands

Back up PostgreSQL, disable synchronization for migration testing, and run:

```bash
cd backend
TYPEORM_SYNCHRONIZE=false npm run migration:run
```

`1760000012000-CreatePlatformExtensionTables.ts` creates Modules 13–17 tables, and `1760000013000-HardenPlatformExtensionEvents.ts` adds provider-event ordering timestamps. `1760000014000-Version14LifecycleTimestampsAndFingerprints.ts` adds analysis fingerprints, the `apply_disabled` pipeline status, and converts real instant columns to `timestamptz` using the documented legacy-time interpretation. The preceding GitHub-token migration is idempotent for local databases previously initialized with synchronization.

## 4. All new backend environment variables

| Variable | Module | Required/optional | Safe example | Secret | Demo/live behavior |
|---|---|---|---|---|---|
| `AI_ASSISTANT_ENABLED` | 13 | Optional | `true` | No | Enables backend AI actions when the key exists |
| `AI_PROVIDER` | 13 | Required when enabled | `google` | No | Selects Google Gemini |
| `GOOGLE_AI_API_KEY` | 13 | Live required | backend environment only | Yes | Missing key disables AI actions gracefully |
| `GEMINI_MODEL` | 13 | Optional | `gemini-1.5-flash` | No | Server-selected Gemini model |
| `AI_PROVIDER_TEMPERATURE` | 13 | Optional | `0.3` | No | Low-temperature diagnosis |
| `AI_PROVIDER_TIMEOUT_MS` | 13 | Optional | `30000` | No | Bounded request |
| `AI_PROVIDER_MAX_OUTPUT_TOKENS` | 13 | Optional | `1200` | No | Bounded response |
| `SNS_TOPIC_ARN` | 14 | Live required | empty | No | Empty persists `skipped_unconfigured` |
| `SNS_REGION` | 14 | Optional | `us-east-1` | No | AWS SDK region |
| `DESTROY_ENABLED` | 15 | Live required | `false` | No | Enables real targeted destroy |
| `DESTROY_DEMO_MODE` | 15 | Optional | `true` | No | No Terraform/AWS mutation |
| `DESTROY_RECENT_AUTH_MINUTES` | 15 | Optional | `15` | No | Recent-login window |
| `TERRAFORM_EXPORT_MAX_BYTES` | 16 | Optional | `10485760` | No | Source/archive ceiling |
| `BILLING_DEMO_MODE` | 17 | Optional | `true` | No | No payment processed |
| `STRIPE_SECRET_KEY` | 17 | Live required | empty | Yes | Official SDK when configured |
| `STRIPE_PRO_PRICE_ID` | 17 | Live required | empty | No | Hosted recurring Pro price |
| `STRIPE_WEBHOOK_SECRET` | 17 | Live required | empty | Yes | Verifies raw webhook body |

Existing database, Redis, AWS, Terraform workspace/state and observability variables still apply. Never expose these through `VITE_` variables.

## 5. Frontend environment variables

Only `VITE_API_BASE_URL=http://localhost:5000` is needed. It is not secret. AI, AWS, SNS and Stripe secrets must never appear in frontend configuration.

## 6. AI provider setup

Create a Google AI Studio key and set it only as `GOOGLE_AI_API_KEY` in the backend/worker environment. No callback is needed; backend outbound HTTPS to the Gemini API is required. Missing configuration returns `AI assistant is enabled but GOOGLE_AI_API_KEY is not configured.` without affecting pipelines. Run `npm run test:ai-troubleshooting`, fail a pipeline and choose **Troubleshooting → Analyze latest run**. Only a real successful provider response is labeled live.

## 7. AWS SNS setup

Create one Standard SNS topic in `SNS_REGION`, set its ARN, and allow users to confirm the AWS email. Minimum IAM actions are `sns:Subscribe`, `sns:Unsubscribe`, and `sns:Publish` on that exact topic. Verify confirmation and test delivery in Project Settings, then inspect `notification_deliveries`. Empty configuration must show `skipped_unconfigured`, never sent.

## 8. Destroy workflow setup

Start with `DESTROY_ENABLED=false` and `DESTROY_DEMO_MODE=true`. Live mode also needs Terraform, disposable AWS credentials, Redis, state metadata and a generated workspace below `TERRAFORM_WORKING_BASE_DIR`. The central S3 state bucket must have versioning, encryption, and public-access blocking enabled. After the one-use `DESTROY` challenge is confirmed, the backend records the current project state object's S3 `VersionId` before it queues destroy; missing state, missing versioning, or an unreadable object stops the request before Terraform runs. The API checks owner/Admin, recent login, active operations/locks and a five-minute one-use typed challenge. The worker acquires/heartbeats its PostgreSQL coordination lock and excludes EFS, access/data, KMS, backup, S3 buckets, shared and global addresses. Never give it deletion access to the shared state bucket, native lockfiles, platform network or unrelated projects.

## 9. Terraform export setup

Generate a plan so the environment records a workspace below `TERRAFORM_WORKING_BASE_DIR`. Artifacts expire after 15 minutes in PostgreSQL. Included: allowlisted `.tf`, referenced local modules and safe examples/docs. Excluded: `.terraform`, state, plans, real tfvars, backend config, lock/cache, credentials/tokens/secrets/private keys and symlinks. Run `npm run test:terraform-export`, unzip in `/tmp`, then secret-scan with `rg -n '(AKIA|SECRET|TOKEN|PASSWORD|PRIVATE KEY|tfstate)'`.

## 10. Payment provider setup

Demo: keep Stripe variables empty and `BILLING_DEMO_MODE=true`; Plan & Usage explicitly says no payment is processed. Live test mode: create a Stripe recurring Pro product/price, configure the secret key/price ID, customer portal and `FRONTEND_URL`. Webhook: `POST /api/billing/webhook/stripe`; subscribe to checkout, customer subscription and invoice events. Set the signing secret. Local forwarding: `stripe listen --forward-to localhost:5000/api/billing/webhook/stripe`. Webhooks verify raw-body signatures and unique event IDs; frontend query flags never grant Pro.

## 11. Plan limits and how to change them safely

Edit `backend/src/billing/billing-plan.ts`, update tests/product copy, and deploy backend before frontend. Free: 3 active projects, 5 analyses, 10 follow-ups, 25 notifications, 1 export/month. Pro: 50, 200, 500, 5000, 100 plus stage notifications. Downgrades preserve existing data while blocking new over-limit work.

## 12. Commands to start PostgreSQL, Redis, backend, worker, and frontend

```bash
docker compose up -d postgres redis
cd backend && npm run migration:run
cd backend && npm run start:dev
cd backend && npm run dev:worker
cd frontend && npm run dev
```

Use actual compose service names if different. Defaults are backend 5000 and Vite 5173.

## 13. End-to-end test checklist for each Module 13–17

- 13: fail run; analyze; check persisted session/result/messages, provider mode, evidence and safe audit; follow up and verify five-pair context pruning.
- 14: toggle/subscribe/confirm; trigger failure/success; check one deduplicated delivery, retries/final state and audit. Unconfigured mode must persist skipped status.
- 15: review resources/preservation; test wrong/expired/reused challenge; queue demo destroy; run worker; check lock, backup reference, audit and notification.
- 16: create/download; inspect config/modules/examples/manifest; verify exclusions, checksum, expiry, quota and audit.
- 17: view Free usage; test demo upgrade/downgrade and idempotent usage; in Stripe test mode check signed/duplicate events, subscription/invoice and payment-failure notification.

## 14. Modules 1–12 regression checklist

Verify email signup/login/logout, GitHub OAuth/private token, repo/branch/app-directory, detection/templates/pre-flight, BullMQ run/cancel/retry, Dockerfile security gate and advisory Trivy results, FinOps, protected apply gate, state/recovery, EFS, ECS/ALB/rollback concepts, observability, Pipeline vs Pipeline Events ownership, RBAC and audits. Do not run apply/destroy for routine regression.

## 15. AWS IAM policy actions required

- SNS: `sns:Subscribe`, `sns:Unsubscribe`, `sns:Publish` on one topic only.
- Logs: existing `logs:DescribeLogStreams`, `logs:GetLogEvents`, `logs:FilterLogEvents` on DeployGuard log groups.
- Runtime/state: retain existing least-privilege ECR/ECS/ELB/CloudWatch/S3 policies scoped by project/environment tags and ARNs. New Terraform state locking needs no DynamoDB permissions.
- Live destroy: only actions required by disposable project resources. Explicitly exclude shared state bucket/table deletion, shared ECR/network and unrelated ARNs. Do not use broad `Resource: "*"` merely for a demo.

## 16. Security checklist

- Keep all provider/AWS/Stripe/session secrets server-side and out of audits.
- Verify Stripe signatures over raw body and keep webhook event IDs unique.
- Confirm AI sanitization masks environment values, credentials, connection strings and private keys.
- Secret-scan ZIPs and retain allowlist/root/symlink/size controls.
- Require RBAC/ownership, recent login, active-operation check, server challenge, lock and worker for destroy.
- Keep AI rate/monthly limits, pagination and five-pair pruning.
- Mask notification destinations and provider errors.

## 17. Troubleshooting table

| Symptom | Likely cause | Exact check | Fix |
|---|---|---|---|
| AI fallback | no key/timeout/invalid JSON | provider status and audit | configure network/model or use labeled demo |
| SNS pending | email unconfirmed | Project Settings status/email | confirm AWS email or resubscribe |
| Notification skipped | no topic | `SNS_TOPIC_ARN` | configure topic/IAM or accept local mode |
| Destroy disabled | run/lock/feature | destroy review `blockers`/`mode` | finish operation, validly release stale lock, or demo flag |
| Challenge rejected | expired/reused/wrong/recent auth | issue after login | sign in and repeat both steps |
| Export unavailable | no workspace | infrastructure environment | generate a safe plan |
| Export rejected | root/symlink/size | backend error/root/max | regenerate safely/remove unsafe files |
| Checkout URL absent | demo billing | billing provider mode | expected; configure Stripe test mode |
| Webhook rejected | signature/raw-body mismatch | Stripe CLI logs/secret | correct secret; retain Nest raw body |
| Usage denied | plan limit | Plan & Usage | wait/reset, archive, or upgrade |

## 18. Cloud resources that can incur cost and cleanup procedure

SNS, CloudWatch, ECS/Fargate, ALB/NAT, ECR, S3, EFS/backup/KMS and external AI/Stripe services may cost money. Stop demo workers, revoke provider keys, archive projects, and use guarded destroy only for disposable application infrastructure. Verify state/AWS inventory manually. EFS data/access, backup/KMS and shared platform resources are intentionally preserved and require a separate, explicitly authorized future deletion flow.

## 19. Verified status matrix (VERSION-14 audit, 2026-07-15)

| Module | Local | Demo/mock | Real external | Manual remaining |
|---|---|---|---|---|
| 13 AI | build + evidence/validation script | deterministic fallback, persisted sessions | not tested | provider network/model, live response |
| 14 SNS | canonical mapping + delivery rules script | unconfigured delivery is skipped, not sent | not tested | topic/IAM/email confirmation/provider delivery |
| 15 Destroy | challenge/target/backend safety script | no-AWS mutation and honest demo backup marker | not tested | disposable AWS, versioned state, guarded cleanup |
| 16 Export | allowlist/checksum/secret ZIP script | local representative archive | n/a | expiry cleanup under a long-running worker |
| 17 Billing | entitlement/idempotency script | server-authoritative Free/Pro demo | not tested | Stripe test checkout/portal/signed webhooks |

The detailed evidence, limitations, and safe pipeline run are recorded in [VERSION_14_AUDIT_REMEDIATION_AND_E2E_RESULTS.md](./VERSION_14_AUDIT_REMEDIATION_AND_E2E_RESULTS.md). No live AI, SNS, destroy, or Stripe provider operation was claimed by this audit.

## 20. FYP demonstration sequence

Start PostgreSQL, Redis, backend, worker and frontend with AI/destroy/billing demo and empty SNS. Create a project and fail a run; show evidence-bound diagnosis/follow-up. Save notifications and show honest skipped delivery. Review preservation, type the server phrase and queue demo destroy; show lock/audit completion without AWS. Inspect a sanitized ZIP. Show Free counters/limit and labeled demo Pro. Optionally repeat with AI/SNS/Stripe test credentials, and use disposable AWS for live destroy only after IAM/state review.
