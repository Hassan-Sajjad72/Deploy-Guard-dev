# DeployGuard FYP scope and certification alignment report

Date: 2026-08-24  
Mode: final read-only scope audit  
Production code changed: no  
Architecture changed: no

## 1. FYP deployment scope

The authoritative FYP deployment limitation is JavaScript- and Python-based **web applications**. The proposal describes deterministic repository inspection, framework/file-signature evidence, Docker template selection, preflight review, and AWS ECS deployment. It does not require DeployGuard to support every distributed topology that can be written in JavaScript or Python.

The correct FYP interpretation is:

> DeployGuard supports mainstream JavaScript and Python web applications that can be deterministically reduced to the platform's bounded web deployment contract. Special topologies may be rejected safely before AWS.

The proposal/scope PDF was not tracked inside the inspected repository. The available authoritative copy was inspected read-only at `/home/hassan-sajjad/Documents/FYP DOCUMENTS/DeployGuard_Scope_Document (1).pdf`. Its rule-based detection, web-deployment, and module claims were compared with the active source rather than assumed from the proposal wording.

## 2. Current actual deployment scope

The active deployment engine supports:

1. one supported frontend web application; or
2. one supported backend web application; or
3. one static frontend plus one backend with a provable relationship contract;
4. optionally, one project-scoped DeployGuard-managed PostgreSQL, MySQL, or MongoDB service;
5. bounded monorepos that reduce to the same one-frontend/one-backend contract;
6. DeployGuard-generated containers; or
7. explicit custom-Dockerfile mode for an independently detectable supported application.

The active path is GitHub Actions based. Topology, ENV ownership, BuildPlan, immutable operation identity, image construction, executable preflight, Terraform/ECS materialization, health/routing evidence, and promotion remain one authority chain.

The implementation rejects multiple frontend/backend components, an unproved SSR-plus-backend relationship, required worker processes, application Redis, ambiguous persistence, and unknown repositories that cannot provide a deterministic runtime contract.

This accurately satisfies the FYP's bounded JavaScript/Python web-application scope.

## 3. JavaScript support matrix

| Framework/profile | Detection | BuildPlan | Real image | Executable preflight | Database coverage | Routing/health coverage | Final classification |
|---|---|---|---|---|---|---|---|
| React/Vite | PASS | PASS | PASS | PASS | managed DB through bounded backend owner | generated frontend `/`; full-stack relationship fixtures | CERTIFIED_SUPPORTED |
| Vue/Vite | PASS | PASS | PASS | PASS | managed DB through bounded backend owner | generated frontend `/` | CERTIFIED_SUPPORTED |
| Next.js static/standalone/SSR | PASS for proven modes | PASS | PASS in generated-runtime smoke | PASS | runtime aliases remain component-scoped | requires its proven single-app health/runtime contract | SUPPORTED_WITH_EXPLICIT_BOUNDARY |
| Express/Node.js | PASS | PASS | PASS | PASS | PostgreSQL alias families and MongoDB URI execute in preflight | explicit `/health` or `/ready`; port/start evidence required | CERTIFIED_SUPPORTED |
| Node + PostgreSQL | PASS | PASS | PASS | PASS with exact DB aliases/query | `DATABASE_URL`, `POSTGRES_*`, `DB_*`, and `PG*` families | normal backend health contract | CERTIFIED_SUPPORTED |
| Node + MongoDB | PASS | PASS | PASS | PASS with exact URI/ping | project-managed MongoDB URI and secret binding | normal backend health contract | CERTIFIED_SUPPORTED |

Important boundary: a supported framework remains supported even though a special topology built with it may be rejected. For example, Express is supported; two independently routed Express backends are not part of the bounded contract.

## 4. Python support matrix

| Framework/profile | Detection | BuildPlan | Real image | Executable preflight | Database coverage | Routing/health coverage | Final classification |
|---|---|---|---|---|---|---|---|
| FastAPI | PASS | PASS | PASS | PASS | managed database aliases remain backend-owned | explicit registered readiness; API prefix is not health | CERTIFIED_SUPPORTED |
| Flask | PASS | PASS | PASS | PASS | managed database aliases remain backend-owned | explicit readiness and proven Gunicorn target/port | CERTIFIED_SUPPORTED |
| Django | PASS | PASS | PASS | PASS | PostgreSQL contract, build-only placeholders, runtime secrets, and release migration | registered readiness, WSGI/ASGI target, non-root runtime | CERTIFIED_SUPPORTED |
| Python + PostgreSQL | PASS | PASS | PASS through Django/runtime smoke and managed-engine suites | PASS | exact secret-backed aliases and project-managed persistence | explicit backend readiness required | CERTIFIED_SUPPORTED |

Important boundary: Django web deployment does not imply support for Django + Celery + Redis + scheduler. The web framework is supported; the required worker/Redis topology is not.

## 5. Database support matrix

| Database | Detection/binding | Runtime materialization | Persistence | Classification |
|---|---|---|---|---|
| PostgreSQL | exact semantic and repository alias evidence | exact component aliases, password secret-backed | project-scoped ECS + EFS/access point/mount targets | CERTIFIED_SUPPORTED |
| MySQL | engine-driven profile | exact component aliases, selected port/image/health/init | same project-scoped persistence architecture | CERTIFIED_SUPPORTED |
| MongoDB | URI/host aliases and backend ownership | URI and root credentials remain secret-backed | same project-scoped persistence architecture | CERTIFIED_SUPPORTED |
| Application Redis | positively detected as unsupported | not materialized | no application Redis service architecture | UNSUPPORTED_SPECIAL_TOPOLOGY |
| External/BYO database | partial explicit contract code exists | local/Compose hosts reject | not part of final managed-database product policy | OUT_OF_FINAL_SCOPE |

Redis used by DeployGuard's historical/internal orchestration experiments is not evidence that customer application Redis is supported. The active local product starts PostgreSQL, Prometheus, and Grafana; Redis/BullMQ is absent from the active `product:start` graph. GitHub Actions is the active deployment engine.

## 6. Full-stack topology support

The bounded topology implementation enforces:

- exactly one frontend at most;
- exactly one backend at most;
- a static frontend when paired with a backend;
- an evidenced frontend-to-backend relationship;
- preserve/strip routing based on repository/contract evidence;
- a backend/application as the only managed-database owner;
- frontend exclusion from backend/database secrets.

The bounded full-stack suite passes React/Vite + Express, React/Vite + Django + PostgreSQL, React/Vite + FastAPI, static-web, backend-owned MongoDB, relationship inference, and unsupported-boundary cases. A historical AWS canary also completed frontend + backend + managed MongoDB through promotion and LIVE ingestion before that project was later intentionally destroyed.

Classification: **CERTIFIED_SUPPORTED**.

## 7. ENV, runtime, health, and routing contract status

The current source and Parts 1–3 evidence still support these conclusions:

- exact repository ENV aliases remain authoritative;
- unknown critical configuration is not silently converted into a default;
- ambiguous database engines block;
- framework default ports do not become authority without supporting evidence;
- TCP readiness does not fabricate an HTTP path;
- `/api`, `/api/v1`, or another relationship prefix is not treated as a health endpoint;
- preserve/strip behavior requires evidence;
- missing/ambiguous commands, ports, health, ownership, and components block;
- executable preflight runs before Terraform;
- immutable BuildPlan identity remains authoritative downstream;
- supported custom Dockerfile paths retain command, port, user, and secret validation;
- private backend/database secrets never enter frontend components.

Current result:

- critical blind guesses: 0;
- critical late failures remaining: 0;
- existing certification test failures: 0;
- supported-scope regressions found: 0.

## 8. Special unsupported cases

| Special topology | Current behavior | Classification |
|---|---|---|
| Required application worker | detected and blocked before AWS | UNSUPPORTED_BY_DESIGN |
| Application Redis / Redis worker | detected and blocked before AWS | UNSUPPORTED_BY_DESIGN |
| Pure Compose-first deployment | Compose is evidence, not the deployment engine | UNSUPPORTED_BY_DESIGN |
| Unknown Dockerfile-only repository | blocked when no independent runtime contract exists | UNSUPPORTED_BY_DESIGN |
| Multiple backends/frontends | deterministic topology blocker | UNSUPPORTED_BY_DESIGN |
| Ambiguous microservices | unresolved/blocked | UNSUPPORTED_BY_DESIGN |
| SSR frontend plus separate backend | blocked unless the bounded relationship is supportable | UNSUPPORTED_BY_DESIGN |
| External/BYO database | not part of the managed-only final product policy | UNSUPPORTED_BY_DESIGN |
| Public TCP-only service | no fabricated HTTP readiness; not advertised as supported public web deployment | UNSUPPORTED_BY_DESIGN |

These are not current defects because they are outside the FYP web topology and fail closed before AWS.

## 9. Universal-plan overreach analysis

**Did the universal certification plan accidentally expand the FYP scope? YES.**

The plan correctly supplied valuable adversarial tests, but its “minimum positive corpus” promoted these broader capabilities into mandatory successful deployment classes:

- application workers;
- application Redis and Redis-backed workers;
- pure Compose-first deployment;
- arbitrary Dockerfile-first deployment without an independently proven web contract;
- public TCP-only services;
- external/BYO databases.

Classification of universal-plan entries:

- actual FYP requirements: mainstream JavaScript/Python web applications, deterministic detection, generated deployment profiles, supported custom containers, bounded frontend/backend, managed database, preflight, GitHub Actions, Terraform, ECS, and health/routing evidence;
- useful adversarial tests: ambiguous ENV/DB/ports/commands/health/routing, multiple components, secret leakage, stale identity, and unsupported dependencies;
- optional future product scope: workers, application Redis, Compose-first execution, broader microservices, external databases, and public TCP services;
- incorrectly mandatory positive support: the same optional classes when listed as required PASS cases rather than safe unsupported boundaries.

Consequently, the earlier “four implementation gaps” language was a scope-classification error. Those were unsupported future capabilities, not defects in the certified FYP scope.

## 10. Proposal versus final implementation

| Proposal module/claim | Current source status | Final interpretation |
|---|---|---|
| GitHub repository connection and deterministic stack detection | IMPLEMENTED | active GitHub App + topology/detector/BuildPlan path |
| GitHub OAuth plus normal email/password | IMPLEMENTED_DIFFERENTLY | developers use GitHub; admin uses separate database email/password; normal developer password login is not active |
| RBAC and audit logging | IMPLEMENTED | authenticated developer/admin boundaries and PostgreSQL audit evidence |
| Generated Docker templates and preflight | IMPLEMENTED | supported JS/Python templates, custom mode, executable pre-AWS gate |
| Redis/BullMQ deployment queue | REMOVED_DURING_IMPLEMENTATION | legacy/inactive code remains, but active product uses GitHub Actions and does not start Redis/BullMQ |
| Aqua Trivy mandatory vulnerability gate | REMOVED_DURING_IMPLEMENTATION | Trivy is absent from the active reusable workflow; do not claim container vulnerability scanning |
| Infracost pre-deployment approval gate | IMPLEMENTED_DIFFERENTLY | candidate Terraform cost artifacts are ingested for release-specific estimates when configured; deployment does not pause for a cost approval gate |
| S3 + DynamoDB Terraform locking | IMPLEMENTED_DIFFERENTLY | S3 state with versioning/native `use_lockfile=true`; DynamoDB locking is not active |
| ECS Fargate Spot | IMPLEMENTED_DIFFERENTLY | active generated Terraform uses ECS Fargate `launch_type = "FARGATE"`, not Spot |
| EFS persistent storage | IMPLEMENTED_DIFFERENTLY | active project-scoped EFS is for DeployGuard-managed databases, not arbitrary application filesystem persistence |
| EventBridge Spot interruption response | REMOVED_DURING_IMPLEMENTATION | not part of the active GitHub Actions deployment graph |
| automatic rollback from EventBridge/health | IMPLEMENTED_DIFFERENTLY | immutable application rollback exists as a controlled release operation; no active EventBridge-driven automatic rollback is claimed |
| Prometheus/CloudWatch/SSE monitoring | IMPLEMENTED | active module, authenticated SSE logs, CloudWatch telemetry, Prometheus export, Grafana UI |
| AI troubleshooting | IMPLEMENTED | Gemini when configured plus deterministic sanitized evidence-only fallback |
| SNS notifications | IMPLEMENTED | project-scoped subscription/preferences and authoritative lifecycle dispatch |
| Destroy retaining EFS by default | IMPLEMENTED_DIFFERENTLY | final product policy is verified complete project extinction, including project persistence |
| Terraform export | IMPLEMENTED | authenticated, sanitized, bounded ZIP without state/plans/secrets |
| Billing/subscriptions/payment | NOT_COMPLETED | source artifacts exist but BillingModule and billing routes are not active in the final product graph; do not present as completed |

## 11. Actual regressions found

None.

The current source still satisfies the Parts 1–3 bounded contract. No previously certified supported path was found broken during this inspection.

## 12. Actual supported-scope defects found

None.

No current behavior was found that violates the intended one-frontend/one-backend JavaScript/Python web-application contract.

## 13. Additional evidence gaps

These are evidence/documentation gaps, not implementation defects:

1. `docs/deployguard-certification-report-part3.md` is not present as a standalone document. Part 3 executable evidence exists in `verify-certification-part3-adversarial.ts` and the consolidated report.
2. One bounded full-stack managed-MongoDB AWS canary proves the complete path, but not every supported framework/database combination has a separate AWS canary.
3. The proposal PDF is not tracked in the inspected repository, so the available external project-document copy had to be used read-only.

These do not invalidate FYP-scope certification because the active architecture, local executable corpus, negative boundaries, and one full AWS path are proven.

## 14. Future scope only

Future expansion may include customer application workers, managed Redis, Compose execution, broader microservices, unknown Dockerfile-only applications, external databases, public TCP services, Spot/EventBridge recovery, restored security scanning, and active billing/payment.

None is required to freeze or present the current FYP deployment engine. Adding any of them would be a feature/architecture task and must not be disguised as certification repair.

## 15. Final FYP certification conclusion

Parts 1–3 removed the proven reliability defects and certified the actual bounded JavaScript/Python web-application deployment contract. The universal plan's broader positive corpus exceeded the FYP limitation by treating optional special topologies as mandatory supported deployments.

The correct conclusion is **CERTIFIED for the FYP scope**. Unsupported special topologies are safely rejected. There are no new regressions, no supported-scope defects, and no reason to modify or expand the deployment engine before presentation.

Recommendation: freeze the deployment engine. Update presentation/report claims to match the implemented-differently/removed proposal modules above, especially Trivy, BullMQ, Fargate Spot, DynamoDB locking, pre-deployment cost approval, and billing.

FYP DEPLOYMENT SCOPE:
Deterministically supported JavaScript and Python web applications within one frontend, one backend, or one frontend-plus-one-backend topology, optionally using a DeployGuard-managed PostgreSQL, MySQL, or MongoDB service.

JAVASCRIPT WEB APPLICATION SCOPE:
CERTIFIED

PYTHON WEB APPLICATION SCOPE:
CERTIFIED

BOUNDED FRONTEND + BACKEND SCOPE:
CERTIFIED

MANAGED DATABASE SCOPE:
CERTIFIED

CRITICAL BLIND GUESSES:
0

CRITICAL LATE FAILURES:
0

FAILED EXISTING TESTS:
0

NEW REGRESSIONS FOUND:
0

SUPPORTED-SCOPE DEFECTS FOUND:
0

UNSUPPORTED SPECIAL TOPOLOGIES SAFELY BLOCK:
YES

UNIVERSAL PLAN EXPANDED FYP SCOPE:
YES

PRODUCTION CODE CHANGED:
NO

ARCHITECTURE CHANGED:
NO

FYP-SCOPE CERTIFICATION:
CERTIFIED

SAFE TO FREEZE DEPLOYMENT ENGINE:
YES

SAFE TO PRESENT:
YES
