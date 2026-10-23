# DeployGuard Certification Part 2 — Positive Runtime and Framework Matrix

## Certification result

Part 2 is complete for the bounded application classes listed below. Each positive case traversed the active detection, BuildPlan, readiness, generated-Dockerfile, real-image, real-container, and reusable-workflow executable-preflight path. No Terraform command and no AWS operation was executed.

```text
VUE/VITE:
PASS

FASTAPI EXPLICIT READINESS:
PASS

FLASK EXPLICIT READINESS:
PASS

DJANGO EXPLICIT READINESS:
PASS

NODE + POSTGRES PREFLIGHT:
PASS

NODE + MONGO PREFLIGHT:
PASS

EXPLICIT /ready:
PASS

PG* EXECUTABLE ALIASES:
PASS

WRONG DB HOST MUTATION:
PASS

WRONG DB PORT MUTATION:
PASS

WRONG MONGO URI MUTATION:
PASS

MISSING PG ALIAS MUTATION:
PASS

REAL IMAGES BUILT:
8

REAL CONTAINERS EXECUTED:
8 positive executable-preflight runs, plus 7 fail-closed executable mutation runs

TERRAFORM EXECUTED:
NO

CRITICAL BLIND GUESSES:
0

NEW CRITICAL DEFECTS:
0 unresolved; 2 supported-class defects were found and corrected

FAILED EXISTING TESTS:
0

PRODUCTION FILES MODIFIED:
backend/src/projects/detection/repo-deployability-scanner.service.ts
backend/src/projects/configuration-ownership.ts

WHY EACH PRODUCTION FILE CHANGED:
repo-deployability-scanner.service.ts — explicit Django path registrations were not recognized as health evidence, while raw string occurrence was too weak to be authoritative. Health discovery now accepts bounded registered route evidence for supported JavaScript/Python routers, Nest decorators, and Django URL declarations.
configuration-ownership.ts — MONGO_URI was recognized during repository database detection but absent from the canonical MongoDB URL alias group, allowing an exact supported application alias to lose managed-database ownership. It is now a secret-backed managed MongoDB URL alias.

SAFE TO BEGIN CERTIFICATION PART 3:
YES
```

## Positive runtime matrix

| Case | Detection and BuildPlan | Real image | Non-root runtime | Executable preflight | Proven contract |
|---|---|---:|---:|---:|---|
| Vue/Vite | PASS | PASS | PASS | PASS | frontend, `vite build`, `dist`, HTTP `/`, no backend secrets |
| FastAPI | PASS | PASS | PASS | PASS | explicit `/health`; `/api/v1` remains an independent API prefix |
| Flask | PASS | PASS | PASS | PASS | explicit `/health`, proven Gunicorn command and port |
| Django | PASS | PASS | PASS | PASS | registered `/health`, build initialization, `collectstatic`, runtime secret reference |
| Node + PostgreSQL | PASS | PASS | PASS | PASS | exact `POSTGRES_*` aliases and an actual application DB query |
| Node + MongoDB | PASS | PASS | PASS | PASS | exact `MONGO_URI` and an actual application database ping |
| Express `/ready` | PASS | PASS | PASS | PASS | exact HTTP readiness path `/ready` |
| Node + PostgreSQL native aliases | PASS | PASS | PASS | PASS | `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, secret-backed `PGPASSWORD` |

The runtime matrix built the actual generated Dockerfile for every row, inspected the final image user, started the image, and executed the exact shell body of the reusable workflow step named `Execute immutable application contract before AWS mutation`.

## Fail-closed mutation matrix

| Mutation | Expected boundary | Result | Terraform touched |
|---|---|---|---:|
| FastAPI health route removed while an unrelated `/health` string remains | static readiness block | PASS | NO |
| Django required `SECRET_KEY` omitted | `INPUT_REQUIRED` | PASS | NO |
| Explicit `/ready` route removed | static readiness block | PASS | NO |
| Vue runtime health identity made invalid | executable preflight failure | PASS | NO |
| Flask component port changed | executable preflight failure | PASS | NO |
| PostgreSQL host changed | executable preflight failure | PASS | NO |
| PostgreSQL port changed | executable preflight failure | PASS | NO |
| MongoDB URI changed | executable preflight failure | PASS | NO |
| `/ready` removed from the runtime verification contract | executable preflight failure | PASS | NO |
| `PGUSER` removed from managed alias materialization | executable preflight failure | PASS | NO |

## Defects found and classification

### Explicit readiness registration

- Classification: `REAL DEPLOYGUARD DEFECT`
- First failure: a valid Django `path('health', ...)` route did not become authoritative readiness evidence.
- Risk in the old behavior: raw string matching could accept an unrelated `/health` string, while Django's normal slashless route declaration could be missed.
- Correction: accept only bounded supported route-registration forms. The negative fixture deliberately leaves an unrelated `/health` string and remains blocked.

### MongoDB exact alias ownership

- Classification: `REAL DEPLOYGUARD DEFECT`
- First failure: direct `MONGO_URI` usage proved MongoDB, but canonical ownership did not classify that exact alias as the managed secret-backed URL.
- Correction: add `MONGO_URI` to the existing MongoDB URL alias definition; no repository or framework special case was added.

Harness issues encountered while creating the matrix—missing platform-owned runtime values in the fixture runtime contract, an incomplete Django fixture database setting, and non-static alias declaration in the PG fixture—were corrected only in the certification harness/fixtures and were not treated as production defects.

## Existing regression and build results

The following passed after the production corrections:

- Certification Part 1 authority
- Topology V2
- ENV classification
- Configuration ownership and secret isolation
- Managed database engines
- Bounded full-stack topology
- Repository analysis certification
- Authoritative BuildPlan
- Static deployability preflight
- Executable deployment preflight
- Mainstream detector matrix
- Stack detection
- Reliability fixture matrix
- Docker template certification
- JavaScript generated-runtime smoke
- Generic Docker runtime smoke
- Python generated-runtime smoke
- Backend production build
- Frontend production build
- `product:verify`

The local product was restarted after the backend build because readiness correctly detected a stale compiled capability fingerprint. Verification then passed with the API, PostgreSQL, frontend, CORS, OAuth entry, authentication boundary, Prometheus target, and Grafana dashboard ready.

## AWS boundary and no-guess decision

- Terraform executed: **NO**
- AWS deployment or mutation executed: **NO**
- Critical deployment facts invented: **0**
- Supported classes broadened: **NO**
- New lifecycle states or architecture introduced: **NO**
- Worker, Redis, pure Compose-first, or pure Dockerfile-first support added: **NO**

## Final checkpoint

All mandatory Part 2 positive cases pass, all required fail-closed mutations stop before Terraform, existing tests have zero failures, and the critical blind-guess count remains zero.

**SAFE TO BEGIN CERTIFICATION PART 3: YES**
