# Phase 4 — Release truth

## P0-10 — Per-service safe deployment and failure isolation

Judge each deployable service by its own deployment contract. A passing service may become `DEPLOYED` while an independent failing service becomes `FAILED`; do not unnecessarily fail or revert the successful service. Shared dependency failures affect only services that depend on that dependency. Preserve correct Deploy, Redeploy, Rollback, and Destroy state for every service.

## P0-11 — Terminal reconciliation before DEPLOYED

Before recording a service as `DEPLOYED`/`LIVE`, reconcile intended state with actual AWS runtime state. As applicable, verify exact release/source/image identity, expected image digest and task definition, runtime-config revision, ECS service/task and process existence, required port, ALB target registration, managed-DB and secret bindings, service identity, public endpoint, and application-entrypoint projection.

Terraform or GitHub Actions completion alone does not prove deployment success. Mark `DEPLOYED`/`LIVE` only after terminal reconciliation succeeds.

## Existing verification starting points

- `backend/scripts/verify-multi-service-release.ts`
- `backend/scripts/verify-lifecycle-properties.ts`
- `backend/scripts/verify-immutable-runtime-revisions.ts`
- `backend/scripts/verify-live-runtime-canonical-authority.ts`
- `backend/scripts/verify-application-entrypoint-authority.ts`
