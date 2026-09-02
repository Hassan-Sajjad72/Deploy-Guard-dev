# DeployGuard repository instructions

- Make the smallest complete change that satisfies the requested invariant.
- Preserve the existing DeployGuard architecture unless a listed P0 requirement explicitly requires a change.
- Do not redesign, replace, or create a parallel implementation of the existing Railpack architecture. Railpack remains the application build/start authority.
- DeployGuard guarantees deployment correctness, not application business correctness. An application bug that does not prevent valid deployment is not a DeployGuard deployment failure.
- Supported managed databases are PostgreSQL, MySQL, and MongoDB only.
- Do not add ORM- or framework-specific compatibility logic, including SQLAlchemy, Prisma, Sequelize, or Django ORM handling.
- Base failure ownership on evidence, never merely on the failed stage or symptom.
- Reuse canonical services, entities, contracts, and tests instead of creating parallel systems.
- Do not perform unrelated cleanup, refactors, renames, or architecture modernization.
- Preserve Deploy → Redeploy → Rollback → Destroy lifecycle semantics.
