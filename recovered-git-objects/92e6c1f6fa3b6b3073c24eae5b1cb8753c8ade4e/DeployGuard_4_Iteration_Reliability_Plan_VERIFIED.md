# DeployGuard Reliability Hardening — VERIFIED 4-Iteration Plan

## Execution Rules

- Execute **one iteration at a time only**.
- Make the **smallest reusable change** that strengthens reliability.
- Do not redesign Topology V2, the ECS/Terraform model, sibling-container deployment, candidate → verify → promote → LIVE, immutable attempts, or the complete-repository blocking contract.
- Do not add Railpack, Buildpacks, Kubernetes, a new orchestrator, or AI Dockerfile generation.
- Keep final application containers **non-root**.
- Preserve the existing project-scoped database/persistence design.
- Preserve the existing contract-wide serialization of per-component Docker payloads.
- Preserve generated Dockerfiles as the default authority; repository Dockerfiles remain only for explicit custom-Dockerfile mode.
- Do not create duplicate validators. Extend the existing BuildPlan/Preflight/template verification path where possible.
- After each iteration:
  1. run the focused regression tests,
  2. run the backend production build,
  3. report exact files changed and proof,
  4. **STOP**,
  5. ask exactly:

**`Iteration X complete. Continue to Iteration X+1? YES / NO`**

- Do not begin the next iteration until the user replies **YES**.

---

# Iteration 1 — Remove Remaining Cross-Component Build Leakage

## Goal

Make component build configuration structurally isolated so a backend cannot accidentally influence a frontend, or one sibling component another.

## Jobs

1. Inspect `DeploymentContractService.componentAsBuildPlan()` and every caller.

2. Stop creating a component BuildPlan by spreading/copying the full repository-level BuildPlan and then relying on later overrides.

3. Build each component plan from an **explicit allowlist**.

4. Component-owned fields must come only from that component or an explicitly proven relationship:
   - component id/role/root/build context;
   - detector/framework/runtime;
   - package manager;
   - install/build/start commands;
   - output/runtime files;
   - build system dependencies;
   - runtime system dependencies;
   - component ENV ownership/materialization;
   - port/bind address;
   - health path;
   - Docker strategy/template;
   - database ownership;
   - persistence requirement.

5. Repository-global fields may remain on the parent contract where genuinely global:
   - repository;
   - branch;
   - commit;
   - topology;
   - contract/detector identity;
   - repository-wide blockers/warnings/evidence used for admission/history.

   Do **not** remove global compatibility fields merely because older UI/backend consumers still read them. The requirement is that they must no longer be used as an unsafe source for sibling component build configuration.

6. Preserve intentional cross-component relationships such as:
   - frontend → backend `CALLS`;
   - backend → database `USES_DATABASE`;
   - proven monolith `BUILDS_INTO` / `SERVES`.

   Relationship-derived values must be explicit, not inherited accidentally.

7. Remove multi-component fallback behavior that selects the **first component** as runtime/configuration owner when ownership is unresolved.

   - Single-component repository: the only component may safely become the owner.
   - Multi-component repository: unresolved owner must **BLOCK readiness**.

8. Preserve full-repository admission:
   - if a required component is unsupported, the entire deployment still blocks.

## Required Regression Tests

- Django + PostgreSQL backend does not inject `libpq*`, `gcc`, migrations, DB ENV, backend port, or backend health values into Vite frontend.
- Frontend values do not overwrite backend values.
- DB credentials reach only the component that owns `USES_DATABASE`.
- Public routing ENV may cross from topology only when the relationship explicitly proves it.
- Multi-component unresolved runtime owner blocks rather than choosing the first component.
- Existing valid single-component and frontend/backend plans remain valid.

## Acceptance

- No component build configuration depends on parent-plan spreading.
- Direct system-dependency leakage between sibling components is structurally prevented.
- Intentional relationship-driven configuration still works.
- Focused tests pass.
- Backend production build passes.

**STOP.**

Ask:

**`Iteration 1 complete. Continue to Iteration 2? YES / NO`**

---

# Iteration 2 — Strengthen Existing Preflight and Docker Validation

## Goal

Reject contradictory generated deployment contracts before the real image build or AWS provisioning, without introducing a new build system.

## Jobs

1. Extend the **existing** BuildPlan/readiness/Preflight/template validation path.

2. Add or derive explicit image-family information for generated profiles/templates without unnecessary database/schema changes:
   - distro: `alpine` or `debian`;
   - package manager: `apk` or `apt`.

3. Add explicit blocking invariants where they are not already proven:

   - a component's native/system dependency must originate from that component's evidence/profile;
   - Alpine template cannot execute Debian package-manager commands;
   - Debian template cannot execute Alpine package-manager commands;
   - static frontend cannot receive database-native system packages without direct frontend evidence;
   - package installation requiring root cannot occur after the final non-root runtime `USER`;
   - final generated runtime user must be non-root;
   - required install/build/start commands must resolve;
   - required port must resolve;
   - required health contract must resolve;
   - private secret cannot enter public frontend build ENV;
   - DB credentials can only reach the component owning `USES_DATABASE`;
   - unsupported required component still blocks the complete repository.

4. Do **not** add a live Debian/Alpine package-repository resolver.

5. Keep package existence as an executable-build concern; do not pretend static validation can prove every external package exists forever.

6. In the active reusable GitHub Actions path, after generated Dockerfiles are materialized and before each real image build, run Docker BuildKit/Buildx checks **only if supported by the existing runner/toolchain**.

   Preferred check:

   `docker buildx build --check ...`

   If the installed runner version cannot support this safely, do not perform a risky toolchain migration just for this feature. Keep the existing validator plus real Docker build as the authoritative executable gate and report the limitation.

7. Preserve the current deployment ordering:

   `materialize → validate/check → build/push every required image → Terraform`

8. A failed contract validation, Docker check, or real image build must stop **before Terraform**.

## Required Regression Tests

- Alpine + `apt` mismatch blocks.
- Debian + `apk` mismatch blocks.
- final runtime `USER root` blocks.
- privileged package installation after the final non-root `USER` blocks.
- backend DB-native package leakage into static frontend blocks.
- private frontend secret exposure blocks.
- valid Vite, Next.js, Express, Django, Flask, and FastAPI generated contracts still pass.
- workflow/static test proves all required images finish before Terraform can begin.

## Acceptance

- The generated contract has an explicit pre-build safety boundary.
- No duplicate validation subsystem was introduced.
- Existing Docker build behavior remains authoritative.
- Focused tests pass.
- Backend production build passes.

**STOP.**

Ask:

**`Iteration 2 complete. Continue to Iteration 3? YES / NO`**

---

# Iteration 3 — Restore Trivy as a User-Controlled Security Review

## Goal

Restore Trivy in the active deployment path without making vulnerability findings an unconditional deployment failure.

A vulnerability finding should become a **user decision**.

A scanner execution failure remains a real technical failure.

## Policy

Reuse the project's existing/previous Trivy severity policy if one exists.

Do not invent a stricter vulnerability threshold.

Findings below the configured review threshold may be reported and deployment may continue automatically.

Findings at or above the configured review threshold trigger user review.

## Required Flow

### 1. Build and Push

Build and push all required component images first so each scan is tied to an exact immutable ECR digest.

### 2. Scan

Run Trivy against every exact component image digest.

Generate structured JSON evidence plus a compact summary.

A vulnerability result must not make the GitHub step fail merely because vulnerabilities exist.

A genuine Trivy execution error must still fail/report as a scanner error.

### 3A. No Review-Threshold Findings

If the scan completes successfully and no configured review-threshold findings exist:

- persist `SECURITY_SCAN_PASSED`;
- expose the scan summary;
- show **no YES/NO buttons**;
- continue automatically to Terraform.

Flow:

`images → Trivy PASS → Terraform`

### 3B. Review-Threshold Findings Exist

If Trivy successfully finds vulnerabilities at/above the configured review threshold:

- do **not** mark the deployment failed;
- do **not** start Terraform;
- persist a waiting state such as:

`SECURITY_REVIEW_REQUIRED`

- preserve:
  - project;
  - deployment attempt/generation;
  - commit;
  - exact image digests;
  - per-component finding counts;
  - sanitized Trivy evidence;
  - evidence/result hash.

- show the user:
  - affected component/image;
  - CRITICAL/HIGH/etc. counts according to the configured policy;
  - concise warning;
  - exactly two actions:

**YES — Continue deployment anyway**  
**NO — Stop deployment**

## Important Implementation Constraint

Do **not** keep a GitHub Actions job open waiting for a human response.

That is unnecessary and unreliable.

Use the existing immutable-operation style:

- build/scan phase ends cleanly in `SECURITY_REVIEW_REQUIRED`;
- backend persists the exact scanned image digests and evidence;
- the user decides later.

### YES

When the authenticated user chooses YES:

1. persist an auditable security acknowledgement containing:
   - user;
   - timestamp;
   - original deployment/scan identity;
   - exact image digests;
   - Trivy evidence/result hash;
   - explicit override decision.

2. dispatch a small **continuation phase** linked to the same deployment generation/attempt lineage.

3. continuation must:
   - reuse the exact already-built/scanned image digests;
   - skip repository rebuild;
   - skip Dockerfile regeneration;
   - skip image rebuild;
   - verify the stored digest/evidence identity;
   - continue from Terraform/provisioning.

4. display the security state as:

`CONTINUED_WITH_SECURITY_OVERRIDE`

Never relabel the vulnerable scan as PASSED.

### NO

When the authenticated user chooses NO:

- persist `SECURITY_REJECTED_BY_USER` or equivalent;
- do not run Terraform;
- do not create candidate application infrastructure;
- preserve scan evidence and decision history;
- leave any existing verified LIVE release authoritative.

Do not add complex immediate ECR cleanup merely for this decision; existing image lifecycle/cleanup rules may handle unused candidate images.

### Scanner Execution Error

If Trivy itself cannot execute or cannot produce trustworthy output:

- report `SECURITY_SCAN_ERROR`;
- do not call it PASS;
- do not offer the vulnerability YES/NO override as though a scan succeeded;
- do not start Terraform.

## Jobs

1. Re-enable Trivy in the **active reusable GitHub Actions deployment path**.
2. Scan every required component image by exact digest.
3. Persist scan summary/evidence and review state.
4. Add backend YES/NO actions.
5. Add only the minimal frontend review UI needed.
6. Add a small continuation workflow/mode that starts from the already-scanned image digests instead of trying to pause/resume the original GitHub job.
7. Update reconciliation/current-state/pipeline presentation for:
   - scan passed;
   - review required;
   - continued with override;
   - rejected by user;
   - scanner execution failure.
8. Existing stable LIVE release must stay LIVE while a newer generation waits for security review.

## Required Regression Tests

- clean scan → automatic continuation; no buttons.
- below-threshold findings → report but automatic continuation according to configured policy.
- threshold findings → `SECURITY_REVIEW_REQUIRED`; Terraform cannot begin.
- YES → exact scanned digests are reused; no rebuild occurs.
- YES → acknowledgement is persisted and auditable.
- NO → Terraform never starts.
- scanner execution error → no PASS and no vulnerability override.
- existing LIVE release remains authoritative while review is pending.
- stale/tampered digest or evidence hash prevents continuation.

## Acceptance

Trivy is active again, but vulnerabilities are **reviewable by the user rather than automatically fatal**.

The solution does not depend on holding a GitHub runner open.

Focused tests pass.
Backend production build passes.
Frontend build/tests for the minimal review UI pass.

**STOP.**

Ask:

**`Iteration 3 complete. Continue to Iteration 4? YES / NO`**

---

# Iteration 4 — Executable Reliability Certification

## Goal

Convert the major supported paths and discovered defect classes into repeatable executable tests so the same failures do not return.

Do not build a huge AWS test platform.

## Jobs

1. Create/standardize the smallest representative fixture matrix that covers the declared framework scope:

   - React/Vite;
   - Next.js;
   - Express;
   - Django + PostgreSQL;
   - Flask;
   - FastAPI;
   - React/Vite + Django + PostgreSQL;
   - React/Vite + FastAPI.

2. Add focused negative fixtures:

   - required React Native sibling → complete-repository block;
   - two viable backends → ambiguity block;
   - Django/PostgreSQL native dependency must not leak into Vite;
   - public/private ENV ownership violation;
   - invalid distro/package-manager contract;
   - unresolved multi-component runtime owner.

3. For positive fixtures:

   - run real detection;
   - create the real BuildPlan;
   - generate the real Dockerfile(s);
   - run existing/pre-build validation;
   - run Docker build check where available;
   - actually build the generated image(s);
   - inspect final image configuration;
   - verify the final runtime user is non-root.

4. Keep AWS testing small and manual/explicit.

   Do **not** automatically create AWS resources during this iteration unless the user separately authorizes it.

5. Produce a final AWS certification checklist using only a few representative cases:

   - one single-component JavaScript app;
   - one single-component Python app;
   - one multi-component frontend/backend app;
   - one managed-database app;
   - one unsupported repo that must block correctly.

6. Run the complete focused backend verification/build suite and relevant frontend tests.

7. Do not add generator-version schema changes unless an existing field/mechanism can record the generator identity without migration risk. This is not required for Iteration 4 acceptance.

## Final Acceptance

Prove with executable evidence:

- Django/PostgreSQL → Vite dependency leakage cannot recur through the corrected component-plan path;
- multi-component unresolved ownership blocks instead of guessing;
- generated contracts are validated before infrastructure;
- positive generated images actually build;
- final application runtime users are non-root;
- every required image must build before Terraform;
- Trivy is active;
- Trivy PASS continues automatically;
- review-threshold findings pause before Terraform;
- YES reuses exact scanned digests and is auditable;
- NO prevents Terraform;
- scanner failure is distinct from vulnerability findings;
- candidate verification/promotion/LIVE authority remains unchanged;
- Retry still preserves immutable historical attempts;
- New Deploy still regenerates using current platform logic;
- unsupported/ambiguous fixtures intentionally block.

## Final Report

Return only:

### IMPLEMENTED
- concise list grouped by iteration

### FILES CHANGED
- grouped by iteration

### REGRESSION TESTS
- pass/fail

### EXECUTABLE FIXTURE BUILDS
- pass/fail by fixture

### COMPONENT ISOLATION
- PASS / FAIL
- evidence

### PRE-BUILD VALIDATION
- PASS / FAIL
- evidence

### TRIVY USER-DECISION FLOW
- PASS behavior
- review-required behavior
- YES behavior
- NO behavior
- scanner-error behavior

### NON-ROOT VERIFICATION
- PASS / FAIL
- evidence

### AWS CERTIFICATION CHECKLIST
- exact 5 cases to run manually

### REMAINING KNOWN RELIABILITY GAPS
- genuine unresolved gaps only

### READY FOR FINAL AWS CERTIFICATION
- YES / NO
- if NO, exact blockers only

**STOP. Do not begin unrelated architecture work.**
