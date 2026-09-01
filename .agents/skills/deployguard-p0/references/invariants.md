# Permanent invariants

- **Smallest complete change:** Change every canonical layer needed for the requested invariant, but nothing unrelated.
- **Architecture preservation:** Extend current services, entities, contracts, workflows, Terraform, and tests. Do not introduce competing authorities or modernize adjacent code.
- **Railpack authority:** Railpack continues to determine how repository application code is built and started. P0 work may validate or carry its result, but must not replace it.
- **Correctness boundary:** DeployGuard proves deployability and runtime identity. Business endpoints, UI behavior, and application features remain repository concerns unless they prevent a valid deployment.
- **Managed databases:** Admit only PostgreSQL, MySQL, and MongoDB. Reject unsupported capabilities explicitly before infrastructure mutation; never substitute an engine.
- **Generic behavior:** Validate observable build, process, port, binding, and connection behavior. Do not encode ORM- or framework-specific fixes.
- **Evidence ownership:** Classify `REPOSITORY_APPLICATION`, `DEPLOYGUARD_PLATFORM`, `EXTERNAL_PROVIDER`, or `UNVERIFIED` from collected evidence. A stage name is context, not proof.
- **Canonical authority:** Find and reuse the existing source of truth and its tests before adding a field, state transition, classifier, or projection.
- **Focused scope:** Avoid cleanup, refactors, renames, speculative compatibility, and documentation churn unrelated to the selected P0.
- **Lifecycle integrity:** Preserve Deploy → Redeploy → Rollback → Destroy state, immutable identity, and cleanup semantics across all affected services.
