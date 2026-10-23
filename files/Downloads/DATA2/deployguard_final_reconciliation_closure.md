# DeployGuard Final Architecture-Contract Reconciliation & Closure Task

## Role

Act as a Principal Distributed Systems Engineer and Cloud Platform Architect working directly on the DeployGuard repository.

## Objective

**YOUR OBJECTIVE IS IMPLEMENTATION AND CERTIFICATION, NOT ADVICE.**

Inspect the actual DeployGuard codebase, reconcile every current-code handoff so the platform has one coherent execution model, implement every confirmed defect fix, remove equivalent stale assumptions globally, add cross-layer regression coverage, run the relevant local certifications, and only return when the current product path is internally consistent.

Do **not** redesign working framework detection.
Do **not** invent replacement schemas if the existing current BuildPlan v2 schema can be made authoritative.
Do **not** treat historical failures as proof they still exist; trace/reproduce them against the current code first.
Do **not** patch only the single failing framework/file when the defect represents a reusable contract-drift class.

The starting/reference baseline is:

`1cd0dd22b4e94e554ebe309e2c3e6bba45a822ff`

This is **not** the final certified SHA after modifications. Any code change creates a new release SHA. At the end, the new release identity must be aligned everywhere.

---

# 1. System Context

DeployGuard is a containerized PaaS using:

- GitHub repositories + developer ENV
- service discovery / repository analysis
- BuildPlan v2
- generated or custom Docker builds
- executable preflight
- GitHub Actions reusable workflow
- Terraform
- AWS ECS Fargate
- ALB
- ECR
- managed PostgreSQL / MySQL / MongoDB
- Secrets Manager
- candidate verification
- promotion
- rollback
- destroy
- generation ownership

The current problem is **not primarily framework detection** and **not deleted legacy architecture**.

The recurring problem is:

> **CURRENT-CODE CONTRACT DRIFT AND SPLIT SOURCES OF TRUTH ACROSS HANDOFFS.**

One layer establishes the correct fact, but a downstream layer may:
- drop it,
- re-infer it,
- filter it based on role/framework,
- use another config source,
- use stale release identity,
- parse repository source again,
- apply a development default over a platform binding,
- or run under a different harness/runtime context.

The goal is to eliminate that entire defect class.

---

# 2. Core Architectural Invariants

## 2.1 Law of Monotonic Authority

Once an upstream authoritative stage establishes a deployment fact, downstream stages may validate or execute it but must not reinterpret its application semantics.

Downstream layers must not independently decide facts already represented by the canonical current contract.

Examples include:

- runtime ownership
- database ownership
- required runtime ENV
- build-time ENV
- service role
- runtime type
- build/start command
- port
- bind host
- readiness mode
- binding target
- resource provider
- release identity

---

## 2.2 BuildPlan v2 as Sole Semantic Authority

BuildPlan v2 is the single current deployment-semantic authority.

No downstream layer may independently re-detect or reconstruct application semantics from:

- framework identity
- repository files
- package manifests
- raw `.env` files
- service labels such as `frontend`, `backend`, or `application`
- component count
- old relationship fields
- stale persisted analysis

If downstream execution requires a fact, that fact must come from the canonical current BuildPlan/deployment contract or from an explicitly infrastructure-owned input.

---

## 2.3 Preserve Current Schema

Do **not** replace the working domain model with a new `web | worker | resource` schema merely for architectural purity.

Preserve the existing current BuildPlan v2 types and service/resource representation unless actual repository evidence proves a schema change is unavoidable.

Remove stale **role-based restrictions**, not the working schema.

---

## 2.4 Runtime/Resource Ownership Must Be Service/Component-ID Based

A valid service may own runtime ENV and managed resources regardless of labels such as:

- frontend
- backend
- application

Do not use role whitelists to decide runtime capability.

Do not use a heuristic like:

```text
backend OR application
```

Do not replace it with another heuristic like:

```text
frontend OR backend OR application
```

Do not use:

```text
if component count == 1, choose component[0]
```

unless that exact ownership was already established canonically upstream.

**Correct rule:**

> Runtime/resource ownership comes from the canonical current BuildPlan/resource binding/service identity, not from component role or component count.

---

## 2.5 Orthogonal Readiness State

Preserve the current state semantics:

- `READY`
- `READY_WITH_WARNINGS`
- `INPUT_REQUIRED`
- `BLOCKED`

Missing developer-provided secrets/configuration such as `JWT_SECRET` must produce `INPUT_REQUIRED`, not `BLOCKED`.

`BLOCKED` is reserved for a genuinely invalid/unsupported/unexecutable deployment contract.

---

## 2.6 Deterministic Routing

Platform-owned frontend-to-backend mount:

`/__deployguard/backend`

Rules:

- strip only `/__deployguard/backend`
- preserve the application pathname exactly
- never infer whether `/api`, `/v1`, `/graphql`, etc. should be stripped
- external URLs must never be rebound
- ambiguous internal target should become actionable `INPUT_REQUIRED` where appropriate

---

## 2.7 ENV / Value Precedence

Enforce one deterministic precedence model:

1. **Platform-managed bindings** — highest precedence
2. **User-provided secrets / explicit overrides**
3. **Committed production ENV**
4. **Repository development/local defaults** — lowest precedence

If DeployGuard deterministically owns and supplies a managed binding, a repository development default such as:

- `localhost`
- `127.0.0.1`
- `0.0.0.0`
- local DB port
- `.env.example` dev URL

must not override or block the managed runtime value.

Unmanaged local/private endpoints should still fail safely when no platform binding replaces them.

---

## 2.8 Health / Readiness

Preserve:

- explicit proven HTTP health endpoint → HTTP readiness
- otherwise → TCP readiness
- platform ALB liveness may use `/` with an appropriate matcher when required
- do not fabricate application `/health`

Do not let UI or workflow presentation convert platform liveness into a fake application health endpoint.

---

## 2.9 Atomic Release Identity

Final release identity must satisfy:

```text
NEW CERTIFIED COMMIT SHA
=
REUSABLE WORKFLOW REF SHA
=
GENERATED DISPATCH SHA
=
CONTROL-PLANE RELEASE IDENTITY
```

Do not rely on a stale hardcoded workflow SHA.

Do not create a self-referential committed manifest containing the SHA of the commit that contains the manifest.

If a release manifest is useful, generate it as an immutable **post-commit / CI artifact** or inject the immutable release SHA at runtime.

Production behavior should fail closed when release identity cannot be proven.

---

# 3. Real Failure Classes Already Observed

Treat these as **regression archetypes**, not assumptions that the exact bug still exists.

For each:
1. reproduce/trace against current code,
2. classify `ALREADY CORRECT` if fixed,
3. otherwise implement the global root-cause fix,
4. inspect all equivalent consumers,
5. add cross-layer regression coverage.

---

## 3.1 Release Identity Drift

Observed:

- a certified release commit had been pushed,
- but the running control plane still referenced an older reusable-workflow SHA.

This proved source SHA and executed workflow SHA were separate configuration truths.

### Required resolution

There must be one authoritative release identity path.

Audit:

- source/config constants
- environment variables
- control-plane configuration
- workflow generation
- generated caller workflow
- dispatch payload
- persisted release data
- reusable workflow ref

No hidden fallback may silently execute an older release.

---

## 3.2 Harness / TSConfig Context Drift

Observed:

- inline TypeScript lifecycle harness selected the wrong project configuration,
- product services were never reached.

### Required resolution

Certification tooling must be hermetic:

- explicit working directory
- explicit tsconfig/project file
- explicit ENV source
- explicit command
- explicit timeout
- explicit process cleanup
- explicit exit status
- no dependence on ambient shell/CWD configuration

Prefer committed scripts or precompiled JS for final certification rather than ad-hoc inline TypeScript.

---

## 3.3 Configuration-Authority Drift

Observed:

- a DB inspection path inferred the wrong database identity/configuration rather than reading the canonical product state.

### Required resolution

Operational/certification tooling must read authoritative current configuration from:

- current product API,
- canonical persisted contract,
- or generated deployment contract

instead of independently scanning/re-inferring repository semantics.

---

## 3.4 Database Ownership Dropped After Correct Detection

Observed:

- Next.js SSR detection correctly proved PostgreSQL usage,
- topology later dropped ownership and produced:
  - `DATABASE_RUNTIME_OWNER_MISSING`
  - `DATABASE_ENGINE_AMBIGUOUS`
- deployment-contract compilation later repeated the same stale role assumption.

### Required resolution

Database/resource ownership must be bound to canonical service/component identity.

Downstream layers must not reject ownership because the service label is `frontend`.

Audit **all** equivalent runtime/resource-owner conditions globally.

---

## 3.5 Managed Binding vs Localhost Default Drift

Observed:

- repository development DB default referenced `localhost`,
- DeployGuard generated a managed PostgreSQL binding,
- preflight still treated the local default as an ECS blocker.

### Required resolution

Platform-managed resolved values must take deterministic precedence.

Preflight must validate the **resolved deployment environment**, not independently reinterpret lower-precedence raw repository defaults.

---

## 3.6 Process Supervisor Fragility

Observed:

- shell/process restart logic matched its own shell or failed when detached processes were torn down.

### Required resolution

Use deterministic child-process/process-group supervision:

- child process ownership
- captured stdout/stderr
- persistent stage result
- timeout
- entire process-tree termination
- deterministic cleanup
- no process-name grep/kill heuristics
- no orphan processes

---

## 3.7 SSR Runtime ENV/Secret Delivery Drift

Observed during real executable preflight:

- Next.js SSR was correctly represented as:
  - role: `frontend`
  - runtimeType: server
- required `JWT_SECRET` existed upstream
- reusable workflow only treated `backend`/`application` as runtime owners
- SSR container was launched without the required runtime ENV
- executable preflight correctly failed:
  - `EXECUTABLE_PREFLIGHT_FAILED: missing required runtime configuration: JWT_SECRET`

### Required global resolution

Do **not** patch this as a Next.js-only special case.

Do **not** decide runtime ENV ownership from role.

The reusable workflow, task definition generation, preflight, and every other consumer must inject runtime ENV/secrets based on the canonical current runtime owner/service contract.

---

# 4. Confirmed/High-Risk Hotspots Found in Supplied Source Archives

Inspect these first, but do not limit the audit to these files.

---

## 4.1 `backend/src/projects/github-app.service.ts`

Previously observed in supplied source:

- hardcoded stale reusable workflow SHA:
  `0def2608f708a2cfcbc93c4b816694b39b44bafa`
- runtime config could fall back to that old SHA
- another part of the control plane could consider GitHub Actions unconfigured while workflow generation still had a fallback

### Required reconciliation

Create **one release-identity authority**.

Do not merely update one hardcoded SHA to another permanent stale SHA.

Production path should derive/validate the active immutable release identity and fail closed if it cannot establish the correct workflow ref.

The starting baseline `1cd0dd22...` is reference evidence only.

After changes, use the **new** commit SHA everywhere.

---

## 4.2 `backend/src/projects/build-plan.ts`

Previously observed:

`buildPlanRuntimeOwner()` contained ownership logic equivalent to:

```text
role == backend OR role == application
```

with a single-component fallback.

This is the same defect family as the real SSR workflow failure.

### Required reconciliation

Remove role/count-based ownership reconstruction.

Use canonical current owner/resource/service identity.

Audit all callers, including database binding logic.

---

## 4.3 `backend/src/infrastructure/database-service-binding.service.ts`

Previously observed to consume runtime-owner logic from BuildPlan helpers.

### Required reconciliation

Ensure database binding consumes the canonical already-established owner.

Do not independently decide owner by role/framework.

---

## 4.4 `backend/src/projects/detection/stack-detection.service.ts`

Previously observed to contain runtime-owner/database-owner conditions.

### Required reconciliation

Detection may establish authoritative evidence/ownership.

But ensure its output is represented once in the canonical current contract.

Do not force downstream consumers to reconstruct the same condition.

---

## 4.5 `backend/src/projects/deployment-contract.service.ts`

Previously observed to contain its own ownership conditions and localhost/database handling.

### Required reconciliation

- consume canonical ownership
- do not re-decide ownership from service role
- enforce resolved ENV precedence
- allow managed DB binding to mask dev localhost defaults
- do not fabricate routing/health semantics

---

## 4.6 `.github/workflows/deployguard-reusable.yml`

This file was missing from the previously supplied ZIPs, yet recent real defects occurred inside it.

### Required audit

Inspect the complete workflow for all logic that independently decides:

- runtime owner
- ENV owner
- secrets owner
- DB owner
- service role
- framework behavior
- health behavior
- image/start behavior
- binding behavior
- component count semantics

Any semantic fact already established upstream must be consumed, not re-derived.

Specifically ensure runtime ENV/secrets are delivered to valid server-runtime owners independent of labels such as `frontend/backend/application`.

---

## 4.7 Terraform ECS Task Definition Generation

Also missing from the earlier ZIPs.

### Required audit

Inspect Terraform/local task-definition generation for duplicate owner heuristics.

Environment and secrets must attach to the canonical runtime owner/service identity.

Do not introduce:

```text
if backend
if application
if one component
```

as substitute semantic authorities.

---

# 5. Relationship / Routing Surface Audit

Previously observed current types/code still contained concepts such as:

- `CALLS`
- `pathPrefix`
- `stripPathPrefix`
- `verificationPath`

These may now be optional evidence, but they are a potential second semantic surface.

### Required action

For each field/consumer:

- prove it is still required by the current architecture,
- prove it cannot become a readiness blocker or route-rewrite authority,
- remove stale uses,
- ensure `/__deployguard/backend` remains the only platform-owned binding semantic.

Delete/update stale certification scripts that still construct old `/api` relationship assumptions if they no longer represent current behavior.

---

# 6. Current-Code Handoff Consistency Audit

Trace the real production path:

```text
Repository Input
→ Repository Analysis
→ Service Discovery
→ BuildPlan v2
→ Topology/Readiness
→ Persistence
→ Reload/Deserialization
→ Deployment Contract
→ Workflow Generation
→ Workflow SHA Resolution
→ Dispatch Payload
→ Image Build
→ Executable Preflight
→ Terraform Materialization
→ ECS Task Definition
→ ALB / Managed DB / Secrets
→ Candidate Verification
→ Promotion
→ Rollback
→ Destroy / Cleanup
```

At **every boundary**, record:

1. authoritative producer
2. canonical field/value
3. consumer
4. whether persisted
5. whether transformed
6. whether downstream re-inference exists
7. whether local/raw repo state can override it
8. whether stale configuration can override it
9. whether another implementation can execute
10. executable regression proving preservation

Target:

**ONE AUTHORITATIVE PRODUCER PER SEMANTIC FACT.**

---

# 7. Global Semantic-Authority Search

Search the full repository for duplicate decisions involving:

- role
- runtimeType
- frontend
- backend
- application
- service count
- runtime owner
- database owner
- environment owner
- secrets owner
- framework
- Next
- Express
- Fastify
- Nest
- FastAPI
- Flask
- Django
- health
- pathPrefix
- stripPathPrefix
- relationship
- DATABASE_URL
- DB_HOST
- localhost
- workflow SHA
- reusable workflow
- release SHA
- commit SHA

For each active semantic condition, classify:

- AUTHORITATIVE PRODUCER
- VALIDATION ONLY
- INFRASTRUCTURE EXECUTION ONLY
- DUPLICATE SEMANTIC AUTHORITY
- STALE

Remove/reconcile every duplicate semantic authority.

---

# 8. Blocker Inventory

Find every active path capable of producing:

- `BLOCKED`
- `INPUT_REQUIRED`
- unsupported
- unresolved
- cannot deploy
- missing runtime owner
- ambiguous engine
- executable preflight failure

For every current blocker record:

- file
- condition
- authoritative input used
- why the current architecture requires it
- regression test proving the behavior

A blocker must not be produced because a downstream stage re-inferred semantics differently from BuildPlan/current contract.

---

# 9. Persistence / Reload Consistency

Verify canonical facts survive:

```text
produce
→ serialize
→ persist
→ reload
→ validate
→ deployment contract
→ workflow
```

Ensure no stale or incomplete persisted representation causes:

- owner loss
- DB engine loss
- runtime ENV loss
- readiness change
- role reinterpretation
- workflow SHA drift

Stale historical analysis should be rejected/reanalysed where required, not silently executed.

---

# 10. ENV Resolution Contract

Centralize or prove a single canonical environment resolution result.

The final resolved environment consumed by:

- executable preflight
- workflow
- ECS task definition
- Terraform
- runtime

must be semantically identical.

No later stage may parse raw `.env.example` or local defaults and re-block a value already replaced by a higher-precedence managed binding.

Add explicit tests for:

- managed PostgreSQL overrides `DB_HOST=localhost`
- managed `DATABASE_URL` overrides localhost dev URL
- user `JWT_SECRET` preserved
- missing required user secret → `INPUT_REQUIRED`
- external service URLs not rebound
- platform binding only affects owned aliases

---

# 11. Required Regression Coverage

Treat each failure as a reusable defect class.

At minimum add/retain executable or cross-layer tests for:

### SSR runtime ENV

```text
Next.js SSR
→ canonical runtime owner established
→ JWT_SECRET required
→ workflow receives it
→ preflight container receives it
→ ECS task definition receives it
```

### SSR + PostgreSQL

```text
Next.js SSR
→ PostgreSQL ownership established
→ BuildPlan preserves owner
→ topology preserves owner
→ contract preserves owner
→ managed binding produced
→ preflight receives managed DB ENV
```

### Multi-component ownership

Use representative service combinations to prove ownership is not selected by role or arbitrary component count.

### Managed localhost suppression

```text
repo default localhost
+ managed binding exists
→ managed value wins
→ no false ECS blocker
```

### Missing secret

```text
JWT_SECRET required but absent
→ INPUT_REQUIRED
→ no workflow/AWS mutation
```

### Release identity

```text
new release SHA
→ generated caller workflow ref
→ dispatch SHA
→ control-plane release identity
all identical
```

### Harness determinism

Run certification from explicit committed scripts/configuration with no implicit tsconfig/CWD behavior.

---

# 12. Certification Process Requirements

Do not use ad-hoc PASS claims.

Every critical stage must produce terminal:

- PASS
- CONFIRMED PRODUCT DEFECT
- TEST/HARNESS DEFECT
- EXPECTED INPUT_REQUIRED/BLOCKED
- UNVERIFIED

An unexecuted stage is `UNVERIFIED`, not `FAIL`.

Do not modify product code because of a harness/configuration failure unless the same failure is reproduced through the real product path.

---

# 13. Local Certification Matrix

Run the current relevant local suites, including where present:

- backend production build
- frontend production build
- typecheck/lint
- repository analysis
- BuildPlan v2 authority
- topology
- readiness
- deployment contract
- service binding
- exact ENV ownership
- canonical ENV resolution
- static frontend
- SSR/web frontend
- React/Vite
- Vue/Vite
- Svelte/SvelteKit
- Next.js static
- Next.js SSR
- Express
- Fastify
- NestJS
- FastAPI
- Flask
- Django
- generated Docker
- custom Dockerfile
- non-root
- executable preflight
- generated runtime matrix
- PostgreSQL
- MySQL
- MongoDB
- Django migrations/connectivity
- workflow contract
- workflow/runtime configuration
- immutable release identity
- candidate promotion
- rollback
- destroy
- generation ownership
- Terraform fmt/validate where available

Do not run AWS until local current-code reconciliation is complete unless specifically instructed to continue controlled AWS certification.

---

# 14. Dead / Retired Code Classification

A previous source audit identified many files not reachable from the primary backend import graph, including:

- historical migrations
- old lifecycle/service areas
- verification-only code
- potentially retired modules

Do not blindly delete by filename.

Classify non-active files:

- ACTIVE
- ACTIVE_SHARED
- TEST_ONLY
- HISTORICAL_MIGRATION
- HISTORICAL_REJECTION
- DEAD_RETIRED

Delete only `DEAD_RETIRED`.

Historical migrations normally remain.

Remove stale certification scripts that can produce misleading results against old semantics.

---

# 15. UI / Presentation Consistency

Inspect frontend presentation for stale current-code inconsistencies such as:

- legacy labels
- health path fallback shown as application health when actual strategy is TCP
- stale blocker wording
- frontend-side reinterpretation of backend readiness
- old topology/routing terminology

Frontend must present current backend truth, not create a second semantic authority.

---

# 16. Release Identity Implementation Rule

Do **not** merely update a hardcoded old SHA to `1cd0dd...` and declare the issue solved.

`1cd0dd...` is the starting/reference release.

After implementation:

1. run local certification,
2. create a new coherent commit,
3. obtain its new immutable SHA,
4. ensure the active control-plane release identity uses that SHA,
5. generate/verify caller workflow pinned to that SHA,
6. verify dispatch payload uses that SHA,
7. ensure no stale fallback can select an older workflow.

Required invariant:

```text
FINAL_NEW_SHA
=
WORKFLOW_REF_SHA
=
DISPATCH_SHA
=
CONTROL_PLANE_RELEASE_SHA
```

---

# 17. Final Acceptance Gate

Do **not** return `COMPLETE` until all current-code handoffs relevant to the supported product path are verified.

Required conditions:

- BuildPlan v2 single semantic authority: PASS
- duplicate runtime-owner heuristics: NONE
- duplicate database-owner heuristics: NONE
- role-based ENV/secrets ownership: NONE
- component-count ownership fallback: NONE unless canonical and justified
- workflow stale SHA fallback: NONE in production path
- release identity parity: PASS
- managed ENV precedence: PASS
- detector → topology fact preservation: PASS
- topology → deployment-contract preservation: PASS
- deployment-contract → workflow preservation: PASS
- workflow → preflight ENV preservation: PASS
- workflow → ECS task-definition ENV preservation: PASS
- persisted/reloaded contract preservation: PASS
- harness determinism: PASS
- active unexplained blockers: NONE
- critical local certification: PASS
- current-code handoffs unverified: NONE

---

# 18. Required Final Report

Return:

```text
ARCHITECTURAL RECONCILIATION:
PASS / FAIL

STARTING BASELINE:
1cd0dd22b4e94e554ebe309e2c3e6bba45a822ff

FINAL IMPLEMENTED SHA:
<new SHA or NOT CREATED>

BUILDPLAN V2 SINGLE AUTHORITY:
PASS / FAIL

DUPLICATE SEMANTIC AUTHORITIES:
NONE / list

RUNTIME OWNER AUTHORITY:
PASS / FAIL

DATABASE OWNER AUTHORITY:
PASS / FAIL

ENV/SECRETS OWNER AUTHORITY:
PASS / FAIL

MANAGED VALUE PRECEDENCE:
PASS / FAIL

RELEASE IDENTITY PARITY:
PASS / FAIL

WORKFLOW SHA AUTHORITY:
<exact source>

STALE WORKFLOW FALLBACK:
NONE / exact remaining path

DETECTOR → TOPOLOGY:
PASS / FAIL

TOPOLOGY → DEPLOYMENT CONTRACT:
PASS / FAIL

DEPLOYMENT CONTRACT → WORKFLOW:
PASS / FAIL

WORKFLOW → PREFLIGHT:
PASS / FAIL

WORKFLOW → ECS TASK DEFINITION:
PASS / FAIL

PERSIST/RELOAD CONTRACT:
PASS / FAIL

HERMETIC CERTIFICATION:
PASS / FAIL

BLOCKER INVENTORY:
<count + every current blocker>

CONFIRMED PRODUCT DEFECTS FIXED:
<list>

ALREADY CORRECT:
<list>

TEST/HARNESS DEFECTS FIXED:
<list>

UNVERIFIED:
NONE / list

BACKEND BUILD:
PASS / FAIL

FRONTEND BUILD:
PASS / FAIL

CRITICAL LOCAL CERTIFICATION:
PASS / FAIL

AWS EXECUTED:
YES / NO

FINAL VERDICT:
CURRENT DEPLOYGUARD CODEBASE IS INTERNALLY COHERENT END TO END
or
NOT CLOSED — <exact remaining contradictions>
```

---

# Final Instruction

Do not solve failures as isolated framework patches.

For every defect:

```text
trace canonical upstream fact
→ enumerate every downstream consumer
→ remove all equivalent stale assumptions
→ add cross-layer preservation tests
→ execute the real path
→ continue until terminal PASS
```

The product is closed only when the same deployment facts remain coherent from repository analysis through final infrastructure materialization without being independently reinterpreted at later layers.
