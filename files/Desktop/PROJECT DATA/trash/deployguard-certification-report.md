# DeployGuard universal certification report

Date: 2026-08-24  
Certification authority: `deployguard-universal-certification-plan.md`  
Scope: the current, tracked DeployGuard implementation and its explicitly bounded application corpus  
Decision: **CONDITIONALLY CERTIFIED**

## 1. Executive summary

DeployGuard is reliable for its currently implemented bounded topology: one supported application component, or one frontend plus one backend, with an optional DeployGuard-managed PostgreSQL, MySQL, or MongoDB service. Within that boundary, repository evidence remains authoritative through Topology V2, ENV ownership, immutable BuildPlan generation, generated/custom containerization, executable preflight, the pinned reusable workflow, Terraform/ECS materialization, candidate verification, promotion, current-state projection, and evidence-bounded troubleshooting.

The inspected implementation fails closed for ambiguous database engines, ports, health paths, routing behavior, component ownership, secrets, and unsupported required components. The executed local suites found no remaining critical blind guess and no failing supported-path regression.

DeployGuard is **not universally certified** against every positive class named in the plan. Application workers, Redis-backed application topology, pure Compose-first deployment, and Dockerfile-only repositories with no supported detectable component remain outside the implemented deployment topology. Several partially represented paths also lack a full executable or AWS proof. Those limitations require a conditional verdict even though they are rejected safely before AWS.

One historical AWS canary proves the bounded frontend + backend + managed MongoDB path reached LIVE using the exact immutable BuildPlan. That project was subsequently fully destroyed: its ECS services are now INACTIVE, its endpoints return 404, and its local project row is absent. The historical successful run remains evidence of the deployment path; it is not evidence that an application is currently LIVE.

No production source file was changed during this inspection. This report is the only file updated.

## 2. Inspected architecture

The real execution path inspected was:

`ProjectsController` / repository analysis  
→ `StackDetectionService` and `RepoDeployabilityScannerService`  
→ canonical application topology and relationship evidence  
→ configuration ownership and exact database aliases  
→ `DeploymentContractService`  
→ authoritative immutable BuildPlan  
→ `GithubActionsDeploymentService` admission and dispatch  
→ immutable caller pinned to the reusable workflow  
→ actual workflow shell/JQ validation  
→ generated or explicit custom Docker build  
→ executable preflight before Terraform  
→ Terraform generation/validation and ECS/ALB contract  
→ candidate health and relationship evidence  
→ promotion/result ingestion  
→ current-state, pipeline presentation, and AI troubleshooting.

## 3. Primary inspected files

- `backend/src/projects/detection/stack-detection.service.ts`
- `backend/src/projects/detection/repo-deployability-scanner.service.ts`
- `backend/src/projects/detection/application-unit-discovery.service.ts`
- `backend/src/projects/detection/relationship-inference.service.ts`
- `backend/src/projects/configuration-ownership.ts`
- `backend/src/projects/deployment-contract.service.ts`
- `backend/src/projects/build-plan.ts`
- `backend/src/projects/build-plan-readiness.ts`
- `backend/src/projects/github-actions-operation-contract.ts`
- `backend/src/projects/github-actions-deployment.service.ts`
- `backend/src/projects/current-state/project-current-state.service.ts`
- `backend/src/projects/pipeline/github-actions-stage-presentation.ts`
- `backend/src/projects/templates/docker-template-engine.service.ts`
- `backend/templates/docker/**`
- `.github/workflows/deployguard-reusable.yml`
- `backend/scripts/verify-certification-part1-authority.ts`
- `backend/scripts/verify-certification-part2-runtime.ts`
- `backend/scripts/verify-certification-part3-adversarial.ts`
- the repository-analysis, topology, ENV, BuildPlan, workflow, Terraform, current-state, and troubleshooting verification scripts invoked below.

## 4. Requirement matrix

| Requirement | Classification | Evidence / boundary |
|---|---|---|
| Canonical Topology authority | IMPLEMENTED | Topology V2 certification and bounded full-stack suites pass; unsupported multiplicity blocks. |
| ENV discovery and component scoping | IMPLEMENTED | `.env*`, Compose `environment`/`env_file`, code, typed settings, bounded README evidence, and component isolation are tested. |
| Unknown/ambiguous critical facts | IMPLEMENTED | Unknown required deployment facts become input/blocking evidence; they are not silently defaulted. |
| Exact ENV alias preservation | IMPLEMENTED | `DATABASE_URL`, `POSTGRES_*`, `DB_*`, `PG*`, MongoDB aliases, and secret-backed mappings pass. |
| Frontend secret isolation | IMPLEMENTED | Private backend/database secrets are rejected from browser builds. |
| Managed PostgreSQL/MySQL/MongoDB | IMPLEMENTED | Engine contract, alias, secret, ownership, and persistence tests pass. |
| Conflicting database engines | IMPLEMENTED | Multiple proven engines reject with deterministic ambiguity rather than precedence. |
| Runtime command and port authority | IMPLEMENTED | Missing/conflicting command or port evidence blocks; framework defaults alone are not authority. |
| Health identity | IMPLEMENTED | Explicit `/health` and `/ready` are retained; API prefixes are not fabricated as health paths; TCP has no invented HTTP path. |
| Preserve/strip relationship routing | IMPLEMENTED | Proven behavior is retained; unresolved behavior blocks. |
| Generated Node/Python containers | IMPLEMENTED | Real images build, final users are non-root, commands/ports are preserved, and executable preflight passes. |
| Supported-component custom Dockerfile mode | IMPLEMENTED | Six path/stage/CMD/ENTRYPOINT variants pass real build and preflight checks. |
| Dockerfile-only unknown application | UNSUPPORTED_BY_DESIGN | A Dockerfile cannot substitute for missing component/runtime authority. |
| Pure Compose-first deployment | UNSUPPORTED_BY_DESIGN | Compose contributes evidence, but Compose is not the deployment engine. |
| Application worker topology | MISSING | Required worker evidence is deliberately rejected; no worker ECS execution path exists. |
| Application Redis topology | MISSING | Redis/ioredis evidence resolves to unsupported; no managed Redis binding/runtime exists. |
| External database contract | PARTIALLY_IMPLEMENTED | Explicit host/port/secret mappings exist, including unsafe-local-host rejection; no full executable/AWS certification was found. |
| TCP-only public service | PARTIALLY_IMPLEMENTED | TCP authority is represented without an invented path; no full public deployment certification was found. |
| Immutable BuildPlan dispatch | IMPLEMENTED | Runtime-contract and caller tests pass; stale identity reanalysis and exact contract checks precede operation dispatch. |
| Executable pre-Terraform gate | IMPLEMENTED | The actual extracted workflow shell rejects runtime, ENV, DB, port, command, and health mutations before Terraform. |
| Terraform generation/local validation | IMPLEMENTED | Format, backend-free initialization/validation, ownership and pre-plan reconciliation tests pass. |
| ECS/ALB candidate evidence and promotion | IMPLEMENTED | Current-state tests and one historical successful AWS canary prove the bounded path. |
| Current-state/failure ownership | IMPLEMENTED | Current-state and pipeline tests keep LIVE authority separate and preserve the authoritative failed stage. |
| AI evidence boundaries | IMPLEMENTED | Troubleshooting tests bind evidence to the selected project/operation and preserve deterministic fallback ownership. |
| Immutable reusable workflow | IMPLEMENTED | Active SHA is immutable; local and remote bytes match; 28/28 inputs include `build_plan_base64`. |

## 5. Positive cases

| Plan case | Result | Certification level |
|---|---|---|
| React/Vite | PASS | detector, BuildPlan, generated template/runtime suites |
| Vue/Vite | PASS | real image and container |
| Next.js | SAFE BLOCK where required readiness is unproven | allowed by P03 |
| Express | PASS | real image/container and readiness fixtures |
| FastAPI | PASS | real image/container with explicit health |
| Flask | PASS | real image/container with explicit health |
| Django | PASS | real image/container, collectstatic, non-root runtime |
| Node + PostgreSQL | PASS | exact aliases and executable DB query |
| Python + PostgreSQL | PARTIAL | contract/engine coverage; no isolated real managed-PostgreSQL positive runtime in this pass |
| Node + MongoDB | PASS | exact URI and executable database ping |
| Python + PostgreSQL + Redis | UNSUPPORTED | Redis is rejected before AWS |
| frontend + backend | PASS | bounded topology and historical AWS canary |
| frontend + backend + PostgreSQL | PASS locally | reliability fixture and contract/preflight coverage |
| backend + worker + PostgreSQL | UNSUPPORTED | worker evidence blocks before AWS |
| backend + worker + Redis + PostgreSQL | UNSUPPORTED | worker/Redis evidence blocks before AWS |
| monorepo | PASS within one-frontend/one-backend bound | topology/component scoping tests |
| supported-app custom Dockerfile | PASS | six real builds and executable preflight runs |
| Dockerfile-only unknown app | UNSUPPORTED | fail-closed |
| Compose-first | UNSUPPORTED | Compose evidence is parsed; Compose deployment is not implemented |
| explicit `/health` | PASS | real FastAPI/Flask/Django cases |
| explicit `/ready` | PASS | real Express case |
| TCP-only | PARTIAL | no fabricated HTTP path; full runtime/AWS proof missing |
| `/api/v1` prefix without GET route | PASS | prefix is not health-probed |
| reverse proxy preserve | PASS | relationship suite and historical canary |
| reverse proxy strip | PASS locally | relationship suite; no dedicated AWS canary |
| external database | PARTIAL | explicit contract exists; end-to-end certification missing |

## 6. Negative cases

All mandatory negative families exercised by the current suites stopped at analysis, readiness, build validation, or executable preflight. None ran Terraform or mutated AWS.

| Case family | Expected | Actual | First boundary | Owner |
|---|---|---|---|---|
| Missing/ambiguous ENV or secret | INPUT_REQUIRED/BLOCK | PASS | readiness/contract | USER_INPUT or REPOSITORY |
| Conflicting database types | BLOCK | PASS | repository analysis | REPOSITORY |
| Missing/conflicting port | BLOCK | PASS | analysis/preflight | REPOSITORY |
| Missing/invalid runtime command | BLOCK/PREFLIGHT FAIL | PASS | analysis/preflight | REPOSITORY |
| Multiple backend candidates | BLOCK | PASS | topology | REPOSITORY |
| Unsupported worker/Redis component | BLOCK | PASS | topology | REPOSITORY |
| Ambiguous database ownership | INPUT_REQUIRED/BLOCK | PASS | contract/readiness | REPOSITORY |
| Ambiguous routing or relationship path | BLOCK | PASS | topology/readiness | REPOSITORY |
| API prefix without health handler | MUST NOT HEALTH-PROBE | PASS | health contract | DEPLOYGUARD policy |
| Backend secret assigned to frontend | SECURITY FAIL | PASS | ownership/security gate | DEPLOYGUARD policy |
| Runtime secret embedded in image | SECURITY FAIL | PASS | Docker validation/image inspection | REPOSITORY |
| Broken startup/health | PREFLIGHT FAIL | PASS | executable preflight | REPOSITORY |
| Stale contract/image/ENV/routing identity | REANALYZE/REJECT | PASS | immutable contract | DEPLOYGUARD policy |

## 7. Mutation cases

Executed mutations covered required ENV removal, alias removal, secret isolation, port changes, command changes, removed or failing readiness paths, database host/port/URI changes, component ownership, root runtime users, secret-like Docker ARG/ENV, and ambiguous Dockerfile paths.

The expected result was achieved: the first proven failure was owned correctly and stopped before Terraform. No mutation produced a false-positive deployment.

## 8. ENV cases

- Exact repository aliases are preserved through BuildPlan and runtime materialization.
- Managed database semantics remain internal while the application receives its evidenced aliases.
- Unknown critical values remain unknown and become explicit input/blocking evidence instead of defaults.
- Public frontend build variables are isolated from private runtime secrets.
- Missing required values stop before dispatch; absent proven-optional values are omitted.
- Compose service scope and `env_file` precedence are deterministic.

Result: **PASS for the tested corpus.**

## 9. Database cases

- PostgreSQL, MySQL, and MongoDB engine profiles pass focused contract tests.
- PostgreSQL alias families and MongoDB URI aliases pass executable tests.
- Passwords remain secret-backed and excluded from frontend components.
- Conflicting engines and ambiguous ownership block.
- Project-managed persistence remains separate from generation-owned application resources in the tested contracts.

Result: **PASS for managed database contracts; PARTIAL for external DB and unimplemented Redis.**

## 10. Routing cases

Preserve and strip semantics are evidence-driven. An API prefix is never silently reused as a health path. Ambiguous routing blocks. Frontend, backend, and relationship verification remain separate facts.

Result: **PASS locally; dedicated AWS proof exists for preserve, not strip.**

## 11. Health cases

Explicit HTTP routes are authoritative. Generated static frontends may use `/` because DeployGuard owns that surface. TCP evidence remains TCP and does not fabricate `/health` or `/`.

Result: **PASS locally; TCP-only full deployment proof is missing.**

## 12. Secret cases

Runtime secrets stay secret-backed; private backend/database values are not exposed to frontend builds; generated-image inspection found no sentinel secret in config or history. Public generated build configuration uses a bounded build-only file/stream contract rather than persistent Docker ARG/ENV declarations.

Result: **PASS.**

## 13. Preflight cases

The certification executed the real shell body used by the reusable workflow. Real generated images and custom images were inspected and run. Invalid port, command, health, ENV, database dependency, user, or ordering failed before Terraform.

Result: **PASS.**

## 14. AWS boundary

This inspection itself performed no AWS mutation. Local negative/mutation cases did not run Terraform apply, create ECS services, or change ALB resources.

Historical positive evidence:

- repository: `Hassan-Sajjad72/Fullstack-Web-Application`
- successful workflow run: `32669690418`
- operation: `7f56c1df-fd6e-4592-8dc3-08958c9535e3`
- generation: `501f5262-0144-4bb3-a5c9-7cc536e26360`
- workflow SHA: `0def2608f708a2cfcbc93c4b816694b39b44bafa`
- build, executable preflight, managed MongoDB, Terraform, ECS/ALB health, relationship verification, promotion, and ingestion: PASS at deployment time.

Current read-only state on 2026-08-24:

- application service `dg-e106de9d-501f5262`: INACTIVE, `0/0/0`;
- database service `dg-e106de9d-database`: INACTIVE, `0/0/0`;
- former endpoints: HTTP 404;
- local project row: absent.

This is consistent with later project extinction. It does not invalidate the historical deployment evidence and must not be represented as a currently LIVE canary.

## 15. First-failure analysis

The historical first canary exposed one DeployGuard-generated Docker build-check failure. It was corrected globally and the entire local certification was rerun before the successful fresh canary.

CASE: generated Vite image with optional public build configuration  
EXPECTED: build the immutable image without persisting build-only values  
ACTUAL: hosted `docker buildx build --check` rejected secret-shaped Dockerfile `ARG`/`ENV` declarations  
FIRST PROVEN FAILURE: generated Dockerfile static validation  
OWNER: DEPLOYGUARD  
EVIDENCE: `SecretsUsedInArgOrEnv` before image construction  
AWS TOUCHED? YES — ECR setup had completed; Terraform/ECS/ALB did not run  
GUESS MADE? NO  
DETECTED BEFORE AWS? NO — this was the late failure corrected by the final regression  

Global correction: generated public build configuration is supplied through an optional bounded BuildKit secret file, permitted keys are canonical, absent optional values remain omitted, and values do not persist in image history/configuration. The corrected real Buildx regression passes.

## 16. Failure ownership

Deterministic failures are assigned one primary owner: REPOSITORY, USER_INPUT, DEPLOYGUARD, AWS, TRANSIENT_INFRASTRUCTURE, or UNKNOWN. Current-state and AI tests show that a missing later-stage artifact does not overwrite an earlier authoritative stage failure, and Gemini cannot upgrade UNKNOWN into a factual diagnosis.

Result: **PASS for the exercised corpus.**

## 17. Blind-guess audit

Critical facts audited: ENV names, secret ownership, database aliases/engine, component ownership, commands, ports, health paths, relationship paths, preserve/strip behavior, and persistence requirements.

Critical blind guesses found in the current tested path: **0**.

## 18. Unsupported classes

The following are safe refusals, not deployment successes:

- required application workers;
- Redis or Redis-backed application topology;
- pure Compose-first deployment;
- Dockerfile-only repositories without enough supported application evidence;
- multiple frontends or multiple backends;
- SSR frontend plus a separate backend where the bounded proxy contract is not proven;
- ambiguous external database ownership;
- unproved public TCP-only runtime behavior.

These classes must remain visibly blocked before AWS.

## 19. Exact missing implementation

Four architecture gaps prevent universal certification:

1. no application-worker execution topology;
2. no Redis service/binding/runtime topology;
3. no pure Compose-first deployment path;
4. no safe Dockerfile-only path when the repository supplies no independently provable supported application contract.

Satisfying these would expand architecture and was therefore not attempted during certification.

## 20. Exact missing tests

Five mandatory evidence gaps remain:

1. an isolated Python + managed PostgreSQL real positive runtime;
2. a full TCP-only deployment proof if that class is to be advertised as supported;
3. an end-to-end explicit external-database positive contract;
4. a dedicated real runtime/AWS reverse-proxy strip case;
5. AWS immutable BuildPlan parity across the supported corpus beyond the single historical preserve-routing canary.

Worker, Redis, pure Compose-first, and unknown Dockerfile-only positive tests cannot be added honestly until their architecture gaps are resolved.

## 21. Verification executed on 2026-08-24

Passed:

- `test:certification-part1-authority`
- `test:certification-part2-runtime`
- `test:certification-part3-adversarial`
- `test:topology-v2`
- `test:environment-classification`
- `test:configuration-ownership`
- `test:manifest-secret-safety`
- `test:managed-database-engines`
- `test:bounded-fullstack-topology`
- `test:repository-analysis-certification`
- `test:reliability-fixture-matrix`
- `test:deployability-preflight`
- `test:authoritative-build-plan`
- `test:docker-templates`
- `test:executable-deployment-preflight`
- `test:github-actions-runtime-configuration`
- `test:github-actions-current-state`
- `test:external-action-pins` (4/4 official refs resolve)
- `test:terraform-preplan-reconciliation`
- `test:ai-troubleshooting`
- backend production build
- frontend production build
- migrations: no pending migrations
- `product:verify` under Node `22.23.2`

Published workflow evidence:

- active immutable SHA: `0def2608f708a2cfcbc93c4b816694b39b44bafa`
- local SHA-256: `f4f1c8024b4e16475597d5293e39e643289259d05b718c12e27a86434eacf093`
- remote SHA-256: `f4f1c8024b4e16475597d5293e39e643289259d05b718c12e27a86434eacf093`
- contract: `deployguard.workflow-call/v2`, 28/28 inputs, including `build_plan_base64`

## 22. Final certification decision

DeployGuard is **CONDITIONALLY CERTIFIED** for the explicitly bounded corpus proven above. Unsupported classes are rejected safely and documented. It is not universally certified for arbitrary repositories or for every positive class listed in the universal plan.

The platform is safe to present only with this scope stated accurately. A demonstration should use a certified supported fixture or clearly label a blocked unsupported repository as expected fail-closed behavior.

CERTIFICATION STATUS: CONDITIONALLY CERTIFIED

CRITICAL BLIND GUESSES: 0

CRITICAL LATE FAILURES: 0

CRITICAL UNRESOLVED IMPLEMENTATION GAPS: 4

MANDATORY TEST GAPS: 5

AWS-SIDE FAILURES THAT SHOULD HAVE BEEN CAUGHT BEFORE AWS: 0

SAFE TO PRESENT: YES
