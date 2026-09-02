# Phase 3 — AWS runtime and diagnostics

## P0-7 — Real AWS runtime verification

After pre-Terraform validation passes, verify facts that require AWS: ECS task startup, IAM/authorization, Secrets Manager injection, VPC/security-group connectivity, DNS/Cloud Map, ALB target registration, managed-database networking, and expected AWS runtime configuration. Never present local validation as proof of AWS-only behavior.

## P0-8 — Structured diagnostics and evidence-based ownership

For every failed deployment stage, collect bounded, sanitized evidence where available: failed stage, structured failure code, ECS `stopCode`/`stoppedReason`, container exit code/reason, bounded CloudWatch tail, ECS service events, ALB target-health reason, relevant database state, and Terraform/provider error.

Classify ownership as exactly `REPOSITORY_APPLICATION`, `DEPLOYGUARD_PLATFORM`, `EXTERNAL_PROVIDER`, or `UNVERIFIED`. Never infer provider ownership from a symptom or stage such as `DG_ECS_STABILITY_FAILED`. For ECS instability, extend the canonical ECS diagnostics classifier instead of creating another classifier.

## P0-9 — Diagnostics and Monitoring inside DeployGuard

Persist and surface enough actionable, sanitized evidence that normal users do not need GitHub Actions, ECS, or CloudWatch for ordinary diagnosis. Do not mirror unlimited raw logs; redact secrets and credentials before persistence and display. Default Monitoring/observability must resolve the canonical `applicationEntryPointServiceId`, not UUID, name, or ordering heuristics. Explicit per-service monitoring may remain supported.

## Existing verification starting points

- `backend/scripts/verify-multi-service-runtime.ts`
- `backend/scripts/verify-failure-ownership.ts`
- `backend/scripts/verify-developer-observability-projection.ts`
- `backend/scripts/verify-live-runtime-canonical-authority.ts`
- `frontend/scripts/verify-monitoring-presentation.mjs`
