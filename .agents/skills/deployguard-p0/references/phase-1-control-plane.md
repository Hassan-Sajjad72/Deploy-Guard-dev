# Phase 1 — Control plane

## P0-1 — GitHub branch/workflow correctness

Any selected repository source branch/SHA must deploy correctly. Treat the selected application source branch and GitHub workflow-registration branch as separate concerns. Satisfy GitHub default-branch workflow requirements without forcing application source to the default branch or changing the selected source branch/SHA merely to make dispatch work.

## P0-2 — Supported-capability admission before Terraform

Validate DeployGuard-supported capabilities before infrastructure mutation. Supported managed databases are PostgreSQL, MySQL, and MongoDB. Fail unsupported managed databases or capabilities explicitly before Terraform; never guess, substitute, or silently fall back.

## P0-3 — Complete build/runtime ENV and secret semantics

Execute the existing `build`, `runtime`, and `both` ENV scopes correctly. Deliver build-time values to the build when required and runtime values only to the correct service/runtime. Preserve exact per-service ENV and secret ownership and protect DeployGuard-owned values such as `PORT`. Extend the canonical ENV model; do not create another one.

## Existing verification starting points

- `backend/scripts/verify-dispatch-state-projection.ts`
- `backend/scripts/verify-configuration-admission.ts`
- `backend/scripts/verify-reserved-environment-boundary.ts`
- `backend/scripts/verify-service-env-isolation.ts`
