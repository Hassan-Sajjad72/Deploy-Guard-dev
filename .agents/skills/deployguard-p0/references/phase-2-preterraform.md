# Phase 2 — Pre-Terraform deployability

## P0-4 — Pre-Terraform deployability validation

Validate the exact immutable Railpack-built image before AWS mutation. Stop before Terraform when reliable evidence proves it cannot deploy, including a missing runtime dependency, immediate process/container crash, invalid repository/build startup, failure to listen on `0.0.0.0:$PORT`, or missing/malformed required runtime configuration. Do not perform application business-logic QA.

## P0-5 — Supported managed-database deployability validation

For a service attached to PostgreSQL, MySQL, or MongoDB, validate the candidate against an equivalent supported database/runtime contract before Terraform wherever reliable. Use DeployGuard's generic database contract. Detectable failures include a missing required DB driver/runtime dependency, a crash during DB initialization, inability to establish a startup-required DB connection, or malformed DeployGuard DB runtime materialization. Validate behavior, never ORM implementation; do not special-case SQLAlchemy, Prisma, Sequelize, Django ORM, or similar frameworks.

## P0-6 — Deployment-readiness boundary

Readiness proves deployment correctness, not application correctness. Validate only facts such as a durable process, reachable required port/interface, required runtime bindings, a DB binding needed for startup/deployability, and whether the target can become usable. Do not fail deployment merely because login, UI, an application query, or another business feature is defective after valid startup. Application correctness belongs to the repository owner unless it prevents deployment.

## Existing verification starting points

- `backend/scripts/verify-application-runtime-validation.ts`
- `backend/scripts/verify-railpack-runtime-contract.ts`
- `backend/scripts/verify-railpack-materialization-workspace.ts`
- `.github/workflows/deployguard-reusable.yml`
