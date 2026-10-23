# DeployGuard Certification Part 1

## Decision

Part 1 is certified. The four source-proven blind guesses have been removed from the existing repository-analysis, topology, BuildPlan, readiness, dispatch-contract, and executable-preflight path. No AWS deployment, Terraform apply, or AWS mutation was run during this certification.

The active detector remains `topology-detection-v3`. The existing architecture and intentionally unsupported topology boundaries were preserved.

## Authority corrections

### Database engine identity

Database evidence is collected into a set before selection. Exactly one supported engine is accepted. Multiple positively evidenced engines fail closed with `DATABASE_ENGINE_AMBIGUOUS`; fixed-order PostgreSQL/MySQL/MongoDB precedence is no longer used as authority.

### Runtime port identity

Server ports are authoritative only when supported by a startup command, application configuration, runtime ENV contract, applicable Docker/Compose evidence, explicit configuration, or a generated runtime contract that guarantees binding. Framework defaults remain hints and cannot make a server deployable. Conflicting strong values fail closed with `PORT_IDENTITY_AMBIGUOUS`.

### Health identity

TCP startup evidence is represented as `healthCheckMode=TCP` and `healthPath=null`. HTTP paths are retained only from direct/config evidence. DeployGuard-generated static frontends may use `/` because the platform owns that HTTP contract. An API/router prefix alone is not treated as a health endpoint.

### ENV requiredness

`UNKNOWN` remains distinct from `OPTIONAL`. An absent unknown application runtime value becomes an actionable required input; a safely supplied value resolves the input without changing its provenance. Proven defaults remain optional, and exact managed-database aliases remain platform-bound.

## ENV source evidence

| Source | Certified behavior |
| --- | --- |
| `.env` | Configuration evidence is recognized; committed values do not override explicit user configuration and secret values are not copied into deployment defaults. |
| `.env.local` | Classified as local/development evidence by default and not promoted to production authority merely by existing. |
| `.env.production` | Recognized as production evidence while preserving explicit-user precedence and secret policy. |
| Compose `env_file` | Resolved per component/service with deterministic relative paths, ordered-file precedence, inline `environment` override, missing-file blocking, and frontend/backend isolation. |
| README | Bounded explicit ENV sections are supporting evidence only and cannot override direct runtime/code evidence. |
| Pydantic settings | Bounded `BaseSettings` declarations classify fields without defaults as required and fields with defaults or optional typing as optional. No repository code is executed. |

## Safe unsupported boundaries

The following remain `UNSUPPORTED_BY_DESIGN` and continue to block before AWS when required by a repository:

- worker application topology;
- Redis application topology;
- pure Compose-first deployment;
- pure Dockerfile-first deployment;
- multiple backend deployment;
- external/BYO database.

## Verification evidence

All required suites completed with exit code 0 in a clean run after the final correction:

- `test:certification-part1-authority`
- `test:topology-v2`
- `test:environment-classification`
- `test:configuration-ownership`
- `test:managed-database-engines`
- `test:bounded-fullstack-topology`
- `test:repository-analysis-certification`
- `test:authoritative-build-plan`
- `test:deployability-preflight`
- `test:executable-deployment-preflight`
- `test:mainstream-detectors`
- `test:detection`
- `test:reliability-fixture-matrix`
- `test:github-actions-runtime-configuration`
- `test:github-actions-safety`
- backend production build
- frontend production build
- migration status/run (`No migrations are pending`)
- `product:verify`

The reliability matrix includes deployable React/Vite, Express, React/Vite + Django + PostgreSQL, and React/Vite + FastAPI paths, plus fail-closed unknown-readiness and unsupported-repository cases. The executable preflight exercised the real workflow shell and verified success, exact-alias failure, crash, wrong-port, non-root, cleanup, and ordering cases.

## Required result matrix

```text
DATABASE ENGINE BLIND GUESS:
PASS

FRAMEWORK PORT BLIND GUESS:
PASS

FABRICATED HEALTH PATH:
PASS

UNKNOWN ENV TREATED OPTIONAL:
NO

.env SUPPORT:
PASS

.env.local CLASSIFICATION:
PASS

.env.production SUPPORT:
PASS

COMPOSE env_file:
PASS

PYDANTIC SETTINGS:
PASS

README EVIDENCE:
SAFE

CONFLICTING DATABASE TEST:
PASS

CONFLICTING PORT TEST:
PASS

MAINSTREAM DETECTOR SUITE:
PASS

CRITICAL BLIND GUESSES:
0

FAILED EXISTING TESTS:
0

ARCHITECTURE CHANGED:
NO

SAFE TO BEGIN CERTIFICATION PART 2:
YES
```

## Operational boundary

The reusable workflow was changed locally only to enforce the same nullable TCP-health contract at workflow validation. It was not published or repinned in this task, and no deployment should consume that local workflow correction until the repository's normal immutable publication and pinning process is performed in a separately authorized task.
