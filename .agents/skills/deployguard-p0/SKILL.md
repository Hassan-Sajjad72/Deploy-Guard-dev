---
name: deployguard-p0
description: Implement one requested DeployGuard P0 phase while preserving the canonical Railpack, configuration, AWS-runtime, observability, and release architecture. Use only for P0-1 through P0-11 work, not general DeployGuard changes.
---

# DeployGuard P0

Work on exactly one requested phase. Map an explicit P0 identifier to its phase; if the request spans phases or does not identify one clearly, obtain a single-phase scope before editing.

## Required reading

Always read [references/invariants.md](references/invariants.md), then read only the selected phase:

- P0-1–P0-3: [references/phase-1-control-plane.md](references/phase-1-control-plane.md)
- P0-4–P0-6: [references/phase-2-preterraform.md](references/phase-2-preterraform.md)
- P0-7–P0-9: [references/phase-3-aws-runtime.md](references/phase-3-aws-runtime.md)
- P0-10–P0-11: [references/phase-4-release-truth.md](references/phase-4-release-truth.md)

Do not read other phase references or begin another phase.

## Workflow

1. Inspect the current implementation, canonical contracts, and existing tests relevant to the selected phase before editing.
2. Reuse the existing architecture and make the smallest complete implementation of the requested invariant.
3. Run the narrowest affected verification first. After it passes, run broader affected verification. Prefer [scripts/verify-p0.sh](scripts/verify-p0.sh) for the selected phase when its checks match the change.
4. Keep command output bounded. Capture successful output; inspect only a bounded relevant tail after failure.
5. Report implemented changes, files changed, verification results, and any remaining blocker. Then stop.

Never treat this skill as authorization to mutate live AWS, GitHub, or production data. Preserve the user's stated mutation and release boundaries.
