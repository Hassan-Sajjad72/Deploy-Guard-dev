# AGENTS.md — DeployGuard Cloud Simplification & Defect Closure

## Repository
- Repo: `Hassan-Sajjad72/Deploy-Guard-dev`
- Branch: `test1`
- Baseline when written: `e9ce648f227cea12d56a8207d50e8de71ce96613`
- Before editing, verify current `test1` HEAD. If it changed, re-check all findings against the new SHA.

## Mission
Reduce AWS deployment uncertainty without rewriting DeployGuard.

Target:

`Railpack/build -> Terraform ensures infrastructure -> DeployGuard/ECS controls runtime success -> verify -> stable release`

Terraform remains the infrastructure/state/destroy engine.
DeployGuard owns runtime-success decisions, failure classification, release promotion, and manual rollback policy.
ECS is the low-level service deployment mechanism.

## Non-goals
Do not redesign:
- repository/root or multi-service detection
- Railpack/build intelligence
- canonical service ownership
- runtime ENV/secrets
- public-entrypoint ownership
- managed-DB product semantics
- destroy architecture
- unrelated UI/backend
- port detection unless explicitly requested separately

No unrelated cleanup.

---

# Confirmed defects / blockers

## D1 — Global DB readiness barrier
Current app ECS services globally depend on `terraform_data.database_readiness`.

**Fix:** only the DB-attached service may wait for that DB prerequisite. Unrelated services must remain independent.

## D2 — Reset & Deploy Fresh is ordinary deploy
Current `resetAndDeployFresh(...)` dispatches `"deploy"`.

**Fix:** perform real reset/reconciliation first, then create a fresh deployment identity, deploy current canonical source, verify, and persist terminal state.

Data rules:
- never delete healthy persistent DB data merely to make a deployment “fresh”;
- reuse existing recovery/reset/reconciliation semantics;
- if recovery is required, do not silently reset;
- do not invent new destructive DB semantics.

## D3 — Managed-DB admission gap
Deploy admission loads a managed tier without clearly enforcing the existing reconciliation classifier.

**Fix:** evaluate authoritative managed-DB reconciliation before deploy and proceed only when `deploymentAllowed === true`.

Respect existing states:
`HEALTHY`, `RECOVERABLE`, `DATA_LOST_RESET_REQUIRED`, `STALE_METADATA`, `IDENTITY_MIGRATION_REQUIRED`.

## D4 — Terraform plan mislabeled as apply failure
**Fix:**
- plan -> `DG_TERRAFORM_PLAN_FAILED`, stage `terraform_plan`
- apply -> separate existing/apply failure semantics

Update classification/tests accordingly.

## B1 — External fixture caller pin stale
The 20-app fixture was pinned to `05afec5...` while the baseline DeployGuard release was `e9ce648...`.

Before AWS certification, pin the fixture caller to the exact **40-character Git SHA** under test.

This is a release blocker, not an architecture defect.

## B2 — Git SHA and executable fingerprints are different
- caller workflow pin = **40-character Git SHA**
- certified workflow/script/Terraform fingerprints = **64-character SHA-256**

When control-plane executable files change, update the 64-character certified fingerprints only after contract tests pass. Do not confuse this with the caller pin.

## V1 — MySQL grant repair needs current-SHA AWS proof
Preserve the existing MySQL `deployguard@'%'` reconciliation and:
`DG_MANAGED_MYSQL_GRANT_RECONCILIATION_FAILED`

Do not remove it until equivalent replacement behavior has AWS proof.

---

# Ownership after simplification

## Terraform owns
- ECS cluster and ECS service resource existence
- ALB/listeners/target groups
- SG/IAM/networking
- EFS
- Cloud Map
- managed DB infrastructure
- Secrets Manager infrastructure
- Terraform state
- final destroy

Terraform is **not** the final authority for runtime health.

## DeployGuard owns
- managed-DB runtime readiness decision
- platform-owned DB credential/grant readiness decision
- ECS deployment success/failure
- task/container/target-health diagnosis
- runtime/public verification
- stable-release promotion
- deterministic code/stage/owner/evidence
- manual rollback target selection

## ECS owns
- starting/scaling an existing app service after prerequisites
- later release-only task-definition updates
- rolling deployment/stability primitives

---

# Exact first-deploy sequence

This sequence is authoritative:

1. Resolve exact source SHA.
2. Railpack build + local validation.
3. Push immutable images to ECR.
4. Terraform `init/validate/plan/apply` ensures infrastructure.
5. Terraform starts the managed DB ECS service when configured.
6. Terraform creates application ECS service resources:
   - no managed DB: normal desired count;
   - DB-attached: initial `desired_count = 0`.
7. Terraform apply completes without a global procedural DB-readiness barrier.
8. DeployGuard observes the managed DB ECS task:
   - PostgreSQL/MongoDB: require authoritative DB container readiness;
   - MySQL: require DB health **and** existing grant reconciler success (`exitCode == 0`).
9. DB prerequisite failure:
   - fail only the attached service/deployment with deterministic evidence;
   - do not start/promote the attached app;
   - do not block/destroy unrelated services solely because that DB failed.
10. DB prerequisite success:
   - DeployGuard calls ECS `UpdateService` to raise the attached app to intended desired count.
11. DeployGuard waits for ECS deployment/runtime stability.
12. On failure, inspect service events, stopped tasks, container exits and target health.
13. Run existing runtime/public verification.
14. Promote stable release only after verification succeeds.

### Required ownership rule for desired count
Once DeployGuard performs post-create scaling:
- Terraform must ignore externally managed `desired_count` updates on application ECS services;
- a later Terraform apply must not scale the service back unintentionally;
- Terraform destroy must still delete the service.

Do **not** use a second full Terraform apply just to start the DB-attached app.

The current global `terraform_data.database_readiness` dependency must be removed from application-service gating when this boundary is implemented.

The existing MySQL reconciler may remain defined inside the DB task during this migration; DeployGuard becomes the authority that observes and accepts/rejects its result.

---

# Redeploy — only after first deploy is certified

For release-only change:

`build -> ECR -> register immutable task definition -> ECS UpdateService -> wait -> verify -> promote`

Do not run full Terraform for release-only redeploy.

DeployGuard retains immutable source/image/runtime identity, evidence, retry semantics, and release history.

### Active task-definition ownership
Once direct ECS release updates are enabled:
- Terraform owns the ECS service resource;
- DeployGuard/ECS owns the active `task_definition` revision;
- Terraform must ignore externally managed `task_definition` changes (or use an explicitly equivalent proven mechanism);
- later topology applies must not revert the running release;
- Terraform destroy must still destroy the service.

Do not remove the current Terraform task-definition/bootstrap path until the direct ECS release path is certified.

---

# Manual rollback — only after redeploy is certified

`select exact immutable previous release -> validate -> ECS UpdateService(previous revision) -> wait -> verify -> promote`

Rules:
- no source rebuild;
- no guessing historical runtime configuration;
- validate managed-DB secret/version compatibility;
- stable pointer moves only after verification;
- ECS automatic circuit-breaker rollback does not replace DeployGuard manual rollback semantics.

---

# Destroy
Do not redesign.

Keep:

`confirmation/admission -> Terraform destroy -> verify AWS deletion -> non-Terraform cleanup -> control-plane finalization`

Shared-ownership `ignore_changes` rules must not interfere with destroy.

---

# Execution order

## Phase 0 — Inspect
Verify HEAD and trace:
- deploy/redeploy/rollback/retry/reset/destroy
- DB reconciliation/admission
- `terraform_data.database_readiness`
- ECS service/task-definition ownership
- failure classification
- caller pin and executable SHA-256 contract

Identify the smallest safe change surface.

## Phase 1 — Low-risk defect closure
Implement:
- D3 managed-DB admission gate
- D4 plan/apply failure separation
- D2 real Reset & Deploy Fresh using existing data/recovery contracts

No cloud-boundary redesign yet.

## Phase 2 — First-deploy runtime boundary
Implement the exact first-deploy sequence above.

This phase is the final fix for D1.
Do not build a temporary Terraform-only isolation solution first.

## Phase 3 — AWS deploy certification
Before testing:
1. commit/push the control-plane changes;
2. update certified 64-char executable fingerprints if required and verified;
3. pin fixture caller to that exact new 40-char Git SHA.

Required proof:
- build/local validation
- immutable ECR image
- Terraform infra success
- managed DB readiness
- MySQL dynamic task-IP grant case
- DB-attached start gate
- unrelated-service isolation
- ECS stability/diagnostics
- public endpoint
- DB write/read where fixture supports it
- persisted deterministic evidence

## Phase 4 — Redeploy
Implement direct ECS release-only path and `task_definition` ownership protection. Certify before removing old behavior.

## Phase 5 — Manual rollback
Implement exact immutable ECS rollback path. Certify before removing old behavior.

## Phase 6 — Destroy certification
No redesign. Prove idempotent destroy and correct persistence/control-plane cleanup.

---

# Failure ownership
Never guess.

- Terraform planning failure -> `DG_TERRAFORM_PLAN_FAILED`
- Terraform apply infrastructure failure -> Terraform/AWS boundary
- platform-owned DB readiness/grant contract failure -> `DEPLOYGUARD_PLATFORM`
- AWS API/observation failure -> `EXTERNAL_PROVIDER/aws`
- proven repository application runtime failure -> `REPOSITORY_APPLICATION`
- ambiguous evidence -> `UNVERIFIED`

Preserve service-specific evidence.

# Certification statuses
Use only:
- `CONFIRMED DEFECT`
- `PASS`
- `EXPECTED BLOCKER`
- `UNVERIFIED`

Source inspection can prove structural defects.
`PASS E2E` requires executable proof on the exact SHA.

# Safety invariants
- GitHub baseline remains fallback while local/work branch changes.
- One bounded responsibility change at a time.
- Preserve immutable source/image/runtime identity.
- Preserve DB persistence/backup semantics.
- Preserve MySQL grant protection until replacement is proven.
- Preserve structured failure evidence.
- Never allow Terraform and ECS release control to fight over `desired_count` or active `task_definition`.
- Do not delete old behavior before equivalent replacement passes tests.

# Completion criteria
Complete only when:
1. D2/D3/D4 fixed;
2. no global DB gate blocks unrelated services;
3. attached service waits for DB prerequisite;
4. MySQL dynamic task-IP case passes;
5. PostgreSQL/DB-container/ECS stability failures produce direct deterministic evidence;
6. first deploy passes exact-SHA AWS certification;
7. release-only redeploy passes without full Terraform;
8. manual rollback passes using exact immutable prior release;
9. topology Terraform apply cannot revert active release revision;
10. destroy passes unchanged;
11. fixture caller uses exact tested 40-char SHA;
12. 64-char executable fingerprints match the certified executable set.

# Required report after each phase
Return only:
- `CURRENT_HEAD`
- `PHASE`
- `SCOPE`
- `FILES_CHANGED`
- `CONTRACT_BEFORE`
- `CONTRACT_AFTER`
- `TEST_RESULTS`
- `AWS_E2E_STATUS`
- `UNVERIFIED`
- `NEXT_BOUNDED_STEP`

Do not claim work that was not executed.
