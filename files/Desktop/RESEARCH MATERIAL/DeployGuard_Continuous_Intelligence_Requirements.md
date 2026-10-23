# DeployGuard — Continuous Intelligence & Assisted Operations
**Status:** Proposed extension to the existing Intelligence Harness (not yet implemented end-to-end)

## Goal
Extend DeployGuard from **intelligent deployment planning** to **continuous post-deployment assessment and approved remediation**, without building a separate Copilot or replacing existing deployment workflows.

## Functional Requirements
- **CI-01 — Observe:** Reuse existing monitoring, deployment history, CloudWatch metrics/logs, and cost evidence to detect unhealthy applications, repeated errors, deployment regressions, and material cost changes. Clearly distinguish measured data from estimates.
- **CI-02 — Investigate:** Correlate symptoms with recent deployments and configuration changes; use existing AI troubleshooting only to explain evidence and suggest hypotheses. Return **unknown** when evidence is insufficient.
- **CI-03 — Recommend:** Produce ranked, actionable recommendations with the problem, supporting evidence, expected impact, cost/risk trade-offs, and confidence. Offer **no action** if no safe recommendation can be justified.
- **CI-04 — Govern:** Convert any proposed infrastructure change into a versioned, immutable Deployment Plan. Validate compatibility, permissions, security policy, budget, and resource ownership. Require explicit, RBAC-authorized human approval tied to the exact plan fingerprint.
- **CI-05 — Execute and verify:** After approval, reuse current AWS deployment, rollback, and cleanup services. Check application-level health and cost/operational outcomes; stop and report failures, and offer controlled rollback rather than silently continuing.
- **CI-06 — Learn:** Record incident, evidence, recommendation, approval, operation, and observed outcome to improve future recommendations. Never let AI independently authorize or execute destructive operations.

## Guardrails
- Preserve the current NestJS control plane, Intelligence Harness, Gemini integration, Terraform/GitHub Actions workflows, tenant isolation, and audit system. **No separate microservice or autonomous multi-agent system required.**
- Use least-privilege temporary AWS credentials; sanitize logs/prompts; enforce per-tenant access and bounded polling/costs.
- Start with **recommendation-only mode**; enable approved actions only after production safety tests pass.

## Acceptance Criteria
1. A simulated health failure produces an evidence-backed alert and a reviewable recommendation.
2. An insufficient-evidence scenario produces no invented root cause or automatic fix.
3. An unapproved, stale, unauthorized, or out-of-budget plan cannot change AWS resources.
4. An approved change uses the existing deployment pipeline and produces health, outcome, and audit evidence; failure supports a safe rollback path.
5. Existing deployments, monitoring, billing, and customer isolation remain unaffected.

## Delivery Sequence
**Stage 1:** Read-only monitoring → evidence correlation → recommendation UI.  
**Stage 2:** Approval-bound plan generation → controlled execution → verification and rollback.  
**Stage 3:** Cost/reliability optimization with measured outcomes, after customer validation.

**Prerequisite:** Complete the current release, signed hosting proofs, and real cross-account customer certification before enabling automated production modifications.
