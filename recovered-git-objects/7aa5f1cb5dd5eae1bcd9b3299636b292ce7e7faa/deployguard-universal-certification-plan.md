# DeployGuard Universal Deployment Reliability & Certification Plan

**Status:** Certification plan for the existing DeployGuard
architecture\
**Primary goal:** Prove that DeployGuard can safely handle a broad range
of repositories without blindly guessing critical configuration, while
stopping early when the repository is ambiguous or unsupported.\
**Architecture decision:** **No architecture replacement is proposed
here.** This document is a certification and reliability gate for the
current architecture.

------------------------------------------------------------------------

## 1. Executive Summary

DeployGuard should not be judged by whether it can deploy one or two
friendly repositories. A generic PaaS is trustworthy only when it can do
two things consistently:

1.  deploy repositories whose deployment contract is actually provable;
    and
2.  **refuse to deploy repositories whose critical contract is
    ambiguous, missing, contradictory, or unsupported.**

The repeated failures experienced so far expose a common class of
problem: DeployGuard sometimes had enough evidence to detect the
application, but then crossed an evidence boundary and **invented a
deployment fact**. The infrastructure became the first place where that
assumption was exposed.

Known examples from our deployment history include:

-   PostgreSQL applications requiring exact `POSTGRES_*` variables while
    the platform materialized generic `DB_*` aliases.
-   An `/api/v1` router prefix being treated as a callable HTTP
    relationship/health endpoint even though no `GET /api/v1` route
    existed.
-   ECS spending roughly twenty minutes trying to stabilize a service
    whose backend crashed immediately because required configuration was
    missing.
-   A security-review continuation using stale workflow identity and
    failing because continuation-specific persistence preparation was
    incomplete.
-   Security evidence being missed because artifact paths were not
    interpreted with their preserved nested paths.
-   AI troubleshooting attributing later symptoms to Trivy or candidate
    health instead of the first proven failure.

These failures are different symptoms of the same architectural
reliability principle:

> **Unknown must remain unknown. A critical unknown must stop the
> deployment before the next expensive or irreversible stage.**

The current implementation has already added important protections:
BuildPlan as a single authority, exact ENV alias enforcement,
fail-closed routing/readiness behavior, executable preflight, and an AWS
boundary after preflight. The purpose of this document is to determine
whether those protections actually generalize beyond the repositories
already tested.

This plan therefore treats certification as a **large, adversarial test
matrix**, not as a small set of happy-path deployments.

------------------------------------------------------------------------

# 2. What We Are Certifying

We are certifying the current pipeline:

``` text
GitHub repository
      |
      v
Provider / stack detection
      |
      v
BuildPlan / deployment contract
      |
      v
Critical-field validation
      |
      v
Immutable image build
      |
      v
Executable application preflight
      |
      v
AWS / Terraform provisioning
      |
      v
ECS candidate
      |
      v
Exact candidate verification
      |
      v
Promotion to LIVE
```

The critical safety property is:

``` text
                 critical fact unknown?
                         |
                         +---- YES ----> STOP
                         |
                         NO
                         |
                         v
                    next stage
```

The certification is **not** intended to prove that every arbitrary
repository in existence can be deployed. That is impossible for a
generic PaaS without imposing a contract on users.

Instead, it must prove that DeployGuard:

-   deploys supported and sufficiently evidenced applications;
-   requests input when user-controlled configuration is required;
-   blocks unsupported or ambiguous applications;
-   never silently substitutes a generic assumption for a critical
    application fact;
-   catches reproducible application-contract failures before Terraform
    whenever possible;
-   preserves immutable identity from analysis through deployment;
-   correctly identifies the first proven failure and its owner.

------------------------------------------------------------------------

# 3. The Core Reliability Contract

## 3.1 Three states for every critical fact

Every critical deployment fact must resolve to exactly one of:

### PROVEN

Evidence is strong enough to use the value.

Example:

``` text
backend.port = 8000
status = PROVEN
sources = startup command + Dockerfile + healthcheck
```

### PROVEN_ABSENT / NOT_REQUIRED

Evidence establishes that the capability is not required.

Example:

``` text
database = NOT_REQUIRED
reason = no database dependency found and application starts without one
```

### UNKNOWN / AMBIGUOUS

Evidence is insufficient or contradictory.

Example:

``` text
relationshipPrefix = /api/v1
proxyBehavior = UNKNOWN
```

The platform must never convert `UNKNOWN` into a default merely because
a default is common in other repositories.

------------------------------------------------------------------------

# 4. Absolute No-Guess Rules

The following are **critical facts**. If they are required and cannot be
proven, deployment must stop.

## 4.1 Environment variables

Do not guess:

-   required ENV names;
-   secret ENV names;
-   database aliases;
-   Redis aliases;
-   API credentials;
-   OAuth credentials;
-   storage credentials.

## 4.2 Runtime

Do not guess:

-   startup command;
-   entrypoint;
-   working directory;
-   process type;
-   worker/web role;
-   listening port.

## 4.3 HTTP

Do not guess:

-   `/health`;
-   `/ready`;
-   `/api`;
-   `/api/v1`;
-   `/status`;
-   any relationship endpoint.

## 4.4 Routing

Do not guess:

-   prefix preservation;
-   prefix stripping;
-   frontend-to-backend proxy target;
-   which backend owns a route.

## 4.5 Dependencies

Do not guess:

-   PostgreSQL when a database type is unknown;
-   Redis when a queue/cache is ambiguous;
-   MongoDB because a package happens to be installed;
-   external database ownership;
-   whether DeployGuard should provision or reuse a resource.

## 4.6 Infrastructure

Do not guess:

-   persistent storage requirements;
-   migration requirements;
-   resource ownership;
-   service relationships.

------------------------------------------------------------------------

# 5. Evidence Hierarchy

Not all evidence should have equal authority.

## Tier 1 --- Direct runtime consumption

Strongest evidence:

``` text
process.env.DATABASE_URL
process.env.POSTGRES_USER
os.environ["POSTGRES_USER"]
os.getenv("DATABASE_URL")
ENV.fetch("DATABASE_URL")
required("POSTGRES_USER")
```

Also include typed/validated configuration systems where the variable
name is explicit.

## Tier 2 --- Explicit deployment configuration

Examples:

-   Docker Compose `environment`;
-   Docker Compose `env_file`;
-   Dockerfile `ENV`;
-   application deployment manifests;
-   explicit health checks;
-   explicit startup commands;
-   framework configuration;
-   platform configuration files.

## Tier 3 --- Example/configuration documentation

Examples:

-   `.env.example`;
-   README configuration sections;
-   setup scripts;
-   sample deployment files.

## Tier 4 --- Convention-only inference

Examples:

``` text
Most PostgreSQL apps use POSTGRES_USER.
Most APIs use /health.
Most React apps use /api.
```

**Tier 4 is not sufficient evidence for a critical deployment fact.**

------------------------------------------------------------------------

# 6. Environment Variable Certification

Environment configuration is one of the highest-risk generic-PaaS areas
because equivalent semantics are represented by many names.

A PostgreSQL application may use:

``` text
POSTGRES_HOST
POSTGRES_PORT
POSTGRES_DB
POSTGRES_USER
POSTGRES_PASSWORD
```

Another may use:

``` text
DB_HOST
DB_PORT
DB_NAME
DB_USER
DB_PASSWORD
```

Another may use:

``` text
DATABASE_URL
```

Another may use:

``` text
PGHOST
PGPORT
PGDATABASE
PGUSER
PGPASSWORD
```

These are semantically related but **not interchangeable application
contracts**.

## 6.1 Correct internal model

DeployGuard may normalize internally:

``` text
managedDatabase.host
managedDatabase.port
managedDatabase.database
managedDatabase.username
managedDatabase.password
```

But the application-facing contract must preserve the exact proven
names.

Example:

``` text
Application requires: POSTGRES_USER
Internal property:    database.username
Runtime injection:    POSTGRES_USER
```

Not:

``` text
Application requires: POSTGRES_USER
Runtime injection:    DB_USER
```

unless the repository separately proves `DB_USER`.

## 6.2 Legacy compatibility

Existing applications using `DB_*` must remain supported.

Applications using both families may receive identical semantic values
only when both families are independently evidenced.

## 6.3 Unknown aliases

If the application clearly requires a database but the exact application
contract is not provable:

``` text
INPUT_REQUIRED
```

Example:

``` text
Deployment blocked before AWS provisioning.

Database dependency detected, but the application's required
connection variables could not be proven.

Unresolved:
- database host contract
- database authentication contract
- database secret variable
```

No Terraform.

No ECS.

No twenty-minute AWS timeout.

------------------------------------------------------------------------

# 7. Environment Variable Classes

Every discovered variable should be classified as one of these classes.

## 7.1 Runtime required

Examples:

``` text
DATABASE_URL
POSTGRES_USER
JWT_SECRET
STRIPE_SECRET_KEY
```

If proven required and no safe source exists:

``` text
INPUT_REQUIRED
```

## 7.2 Runtime optional

Examples:

``` text
LOG_LEVEL
SENTRY_DSN
ENABLE_METRICS
```

Absence is acceptable only if repository evidence establishes that the
application treats it as optional.

## 7.3 Build-time public configuration

Examples:

``` text
VITE_API_URL
NEXT_PUBLIC_API_URL
PUBLIC_API_URL
```

These may be embedded into frontend assets depending on framework
semantics.

## 7.4 Runtime secret

Examples:

``` text
DATABASE_PASSWORD
JWT_SECRET
STRIPE_SECRET_KEY
```

These must be secret-backed at runtime.

AWS ECS explicitly models normal environment variables separately from
secret references, and AWS warns against plaintext sensitive environment
variables. citeturn1search5turn1search9turn1search10

## 7.5 Platform-generated values

Examples:

``` text
PORT
service hostname
deployment ID
deployment URL
```

A value is not a blind guess when it is explicitly owned by the
DeployGuard platform contract.

------------------------------------------------------------------------

# 8. Environment Source Matrix

Certification must cover all of these structures.

  -------------------------------------------------------------------------
  Case                    Repository structure      Expected behavior
  ----------------------- ------------------------- -----------------------
  ENV-01                  root `.env.example`       parse as supporting
                                                    evidence

  ENV-02                  `backend/.env.example`    scope to backend

  ENV-03                  `frontend/.env.example`   scope to frontend

  ENV-04                  `.env`                    inspect, but never
                                                    expose secrets

  ENV-05                  `.env.local`              do not automatically
                                                    treat as production

  ENV-06                  `.env.production`         production-specific
                                                    evidence

  ENV-07                  Compose `environment`     service-scoped runtime
                                                    evidence

  ENV-08                  Compose `env_file`        service-scoped runtime
                                                    evidence

  ENV-09                  Dockerfile `ENV`          image/runtime evidence

  ENV-10                  code-only `process.env.X` strong runtime evidence

  ENV-11                  code-only                 strong runtime evidence
                          `os.environ["X"]`         

  ENV-12                  `required("X")` helper    strong runtime evidence

  ENV-13                  typed settings schema     strong runtime evidence

  ENV-14                  README only               supporting evidence,
                                                    not always sufficient

  ENV-15                  conflicting sources       resolve only with
                                                    deterministic
                                                    precedence

  ENV-16                  unresolved critical       BLOCK
                          conflict                  
  -------------------------------------------------------------------------

Docker Compose itself has explicit variable interpolation and precedence
rules. DeployGuard must reason about the resolved service environment
rather than assuming that a raw `.env` file is the final container
environment. citeturn1search1turn1search6turn1search7

------------------------------------------------------------------------

# 9. Framework Environment Matrix

## 9.1 React / Vite

Test:

``` text
VITE_API_URL
```

Requirements:

-   identify build-time public configuration;
-   do not send database secrets to frontend;
-   preserve exact public variable names;
-   do not assume runtime server-side access for a browser variable.

Vite-style public variables and framework-prefixed browser variables are
a documented PaaS pattern. citeturn1search0turn1search4

## 9.2 Next.js

Test:

``` text
NEXT_PUBLIC_API_URL
DATABASE_URL
NEXTAUTH_SECRET
```

Requirements:

-   distinguish browser-exposed and server-only variables;
-   do not expose secrets through public prefixes;
-   understand build-time embedding of public values.

## 9.3 Express / Node

Test:

``` javascript
process.env.PORT
process.env.DATABASE_URL
```

and helper-based configuration:

``` javascript
required("POSTGRES_USER")
```

## 9.4 FastAPI

Test:

``` python
os.environ["POSTGRES_USER"]
os.getenv("DATABASE_URL")
```

and settings libraries such as Pydantic settings.

## 9.5 Flask

Test direct environment access and application-factory configuration.

## 9.6 Django

Test:

``` python
os.environ["POSTGRES_USER"]
os.getenv("DATABASE_URL")
```

plus configuration helper libraries.

------------------------------------------------------------------------

# 10. Database Matrix

Minimum database corpus:

  DB case   Expected
  --------- ---------------------------------------------
  DB-01     PostgreSQL individual variables
  DB-02     PostgreSQL `DATABASE_URL`
  DB-03     PostgreSQL `PG*` variables
  DB-04     MySQL individual variables
  DB-05     MySQL `MYSQL_*` variables
  DB-06     MongoDB URI
  DB-07     MongoDB host/port/user/password
  DB-08     Redis URL
  DB-09     Redis host/port/password
  DB-10     No database dependency
  DB-11     Database clearly required but alias unknown
  DB-12     Multiple database candidates
  DB-13     Existing external database
  DB-14     Managed database ownership proven
  DB-15     Conflicting database evidence

For DB-11, DB-12, DB-13, and DB-15, the expected result is **not a
generic deployment attempt**. It is either `INPUT_REQUIRED` or
`BLOCKED`, depending on whether the user can resolve the ambiguity.

------------------------------------------------------------------------

# 11. Multi-Component Repository Matrix

## APP-01 --- Single frontend

``` text
frontend
```

Expected:

-   one web component;
-   public HTTP root if proven;
-   no backend secret injection;
-   no database infrastructure unless explicitly required.

## APP-02 --- Single backend

``` text
backend
```

Expected:

-   one backend component;
-   exact application port;
-   exact startup command;
-   exact health/readiness contract.

## APP-03 --- Frontend + backend

``` text
frontend/
backend/
```

Expected:

``` text
frontend -> backend
```

Backend owns private dependencies.

## APP-04 --- Frontend + backend + PostgreSQL

``` text
frontend/
backend/
postgres
```

Expected:

``` text
frontend -> backend -> postgres
```

Database credentials belong to backend only.

## APP-05 --- Backend + worker + PostgreSQL

``` text
backend/
worker/
```

Expected:

``` text
backend -> postgres
worker  -> postgres
```

only if repository evidence proves both consumers.

## APP-06 --- Backend + worker + Redis + PostgreSQL

Each component receives only its proven dependencies.

## APP-07 --- Multiple backends

``` text
frontend/
auth/
api/
```

If routing ownership cannot be proven:

``` text
BLOCKED
```

Do not select one arbitrarily.

------------------------------------------------------------------------

# 12. Monorepo Matrix

Test:

``` text
/apps/frontend
/apps/backend
/packages/shared
```

and:

``` text
client/
server/
```

and:

``` text
frontend/
backend/
worker/
```

and nested infrastructure:

``` text
infra/compose.yaml
deployment/docker-compose.yml
```

The platform must locate actual component roots and must not assume the
repository root is the runtime root.

------------------------------------------------------------------------

# 13. Dockerfile Matrix

Test all of the following:

``` text
Dockerfile
frontend/Dockerfile
backend/Dockerfile
Dockerfile.prod
docker/Dockerfile
docker/backend.Dockerfile
```

Also test:

-   single-stage builds;
-   multi-stage builds;
-   Dockerfile `CMD`;
-   Dockerfile `ENTRYPOINT`;
-   externally supplied command;
-   missing command;
-   build-only stages;
-   non-root user.

If no deterministic runtime command exists, DeployGuard must stop before
ECS rather than inventing one.

Render's Docker deployment model similarly treats the Dockerfile/runtime
command as part of the deployable service contract and warns that
missing `CMD`/`ENTRYPOINT` can make a deployment appear to hang.
citeturn0search0turn0search6

------------------------------------------------------------------------

# 14. Port Matrix

Test:

### PORT-01

``` text
EXPOSE 8000
```

### PORT-02

``` text
app.run(port=5000)
```

### PORT-03

``` text
PORT=8080
```

### PORT-04

Compose:

``` yaml
ports:
  - "8080:8000"
```

The platform must distinguish:

``` text
public/host port
container port
application listening port
target port
```

`8080:8000` does not prove that the application itself listens on 8080.

If two strong sources disagree and precedence is not deterministic:

``` text
BLOCKED
```

------------------------------------------------------------------------

# 15. Health and Readiness Matrix

This is a critical certification area because a false health assumption
can turn a valid deployment into a false failure.

## HEALTH-01 --- Explicit `/health`

Use it when proven.

## HEALTH-02 --- Explicit `/ready`

Prefer readiness when repository evidence establishes that it represents
readiness.

Railway explicitly recommends a readiness endpoint when available and
uses health checks to ensure a new deployment is live before activation.
citeturn2search0turn2search5

## HEALTH-03 --- TCP-only service

If no HTTP endpoint can be proven but a TCP listener can be proven, TCP
startup verification may be valid.

Cloud Run documents TCP startup probes as a valid startup mechanism when
HTTP is not appropriate. citeturn2search6

## HEALTH-04 --- Root `/`

For a frontend, a proven `GET / -> 200` may be used for HTTP
verification.

## HEALTH-05 --- `/api/v1` prefix only

If the repository proves:

``` text
/api/v1
```

as a router prefix but not as a GET handler:

``` text
DO NOT PROBE GET /api/v1 AS HEALTH
```

This directly covers the previously observed 404 defect.

## HEALTH-06 --- Missing readiness

If a service type requires application-level readiness and DeployGuard
cannot prove a suitable readiness method:

``` text
BLOCKED
```

unless the deployment contract explicitly supports a safe lower-level
probe.

## HEALTH-07 --- Wrong inferred path

If DeployGuard invents `/health` or `/api/v1` without evidence:

``` text
CERTIFICATION FAILURE
```

This is a platform defect, not a repository defect.

------------------------------------------------------------------------

# 16. Routing / Reverse Proxy Matrix

Test:

### ROUTE-01 --- Direct backend

``` text
ALB -> backend
```

### ROUTE-02 --- Frontend reverse proxy

``` text
ALB -> nginx -> frontend -> backend
```

### ROUTE-03 --- Prefix preserved

``` text
/api/v1/users
      |
      v
backend receives /api/v1/users
```

### ROUTE-04 --- Prefix stripped

``` text
/api/v1/users
      |
      v
backend receives /users
```

### ROUTE-05 --- Prefix ambiguous

Expected:

``` text
BLOCKED
```

The platform must not infer preserve/strip behavior merely from
framework convention.

------------------------------------------------------------------------

# 17. Relationship Verification vs Health Verification

These must be different concepts.

## Health verification

Question:

> Is this component ready to receive traffic?

## Relationship verification

Question:

> Can component A reach component B through the proven topology?

Example:

``` text
/api/v1
```

may be useful evidence for a frontend/backend relationship but does not
prove:

``` text
GET /api/v1 -> 200
```

A router prefix is topology evidence, not a health endpoint.

------------------------------------------------------------------------

# 18. Secret Handling Matrix

Test:

-   database password;
-   JWT secret;
-   Stripe secret;
-   OAuth client secret;
-   SMTP password;
-   cloud credentials;
-   private package token.

Expected:

``` text
secret source
   |
   v
secret reference
   |
   v
runtime injection
```

Never:

``` text
secret -> Dockerfile ARG
secret -> image layer
secret -> log
secret -> artifact
secret -> public frontend
```

Render's Docker guidance likewise warns against putting sensitive values
into image build layers, and ECS provides a dedicated secret reference
mechanism. citeturn0search5turn1search5

------------------------------------------------------------------------

# 19. Frontend Secret Isolation Matrix

Example:

``` text
frontend:
  VITE_API_URL
  NEXT_PUBLIC_API_URL

backend:
  DATABASE_URL
  JWT_SECRET
  STRIPE_SECRET_KEY
```

Expected:

``` text
frontend -> public configuration only
backend  -> private configuration + secrets
```

The frontend must not receive backend secrets simply because both
components exist in one repository.

------------------------------------------------------------------------

# 20. Build-Time vs Runtime Configuration

This distinction must be explicit.

## Build-time public configuration

Examples:

``` text
VITE_API_URL
NEXT_PUBLIC_API_URL
```

These can become part of built frontend assets.

## Runtime private configuration

Examples:

``` text
DATABASE_URL
JWT_SECRET
REDIS_URL
```

These must remain runtime configuration.

Render, Heroku, and Railway all treat deployment configuration as
external service configuration rather than hard-coded application
source, while their documentation also distinguishes deployment/build
behavior from runtime service behavior.
citeturn0search9turn0search3turn2search1

The Twelve-Factor App similarly defines deploy-varying configuration as
environment-level configuration separate from code. citeturn0search4

------------------------------------------------------------------------

# 21. Persistence / Database Lifecycle Matrix

Test:

### PERSIST-01 --- No database

No database infrastructure.

### PERSIST-02 --- Managed PostgreSQL

Expected:

``` text
provision database
materialize exact application contract
start application
verify application
```

### PERSIST-03 --- External database

If the repository requires an external database but DeployGuard cannot
prove ownership/configuration:

``` text
INPUT_REQUIRED
```

Do not silently provision a second database.

### PERSIST-04 --- Migration required

If a migration command is explicitly proven, it must run at the correct
lifecycle stage.

If migration requirements are ambiguous:

``` text
BLOCKED
```

------------------------------------------------------------------------

# 22. Supported Application Corpus

Minimum positive corpus:

1.  React/Vite frontend
2.  Vue/Vite frontend
3.  Next.js
4.  Express API
5.  FastAPI
6.  Flask
7.  Django
8.  Node + PostgreSQL
9.  Python + PostgreSQL
10. Node + MongoDB
11. Python + PostgreSQL + Redis
12. frontend + backend
13. frontend + backend + PostgreSQL
14. backend + worker + database
15. backend + worker + Redis + database
16. monorepo
17. Dockerfile-first repository
18. Compose-first repository
19. explicit `/health`
20. explicit `/ready`
21. TCP-only service
22. API prefix without health handler
23. reverse proxy preserve
24. reverse proxy strip
25. external database dependency

This is a **minimum** corpus, not the maximum.

------------------------------------------------------------------------

# 23. Negative / Adversarial Corpus

Negative tests are mandatory because safe refusal is part of PaaS
correctness.

  ID       Broken/ambiguous condition               Expected result
  -------- ---------------------------------------- -----------------------
  NEG-01   required ENV absent                      INPUT_REQUIRED/BLOCK
  NEG-02   required ENV alias ambiguous             INPUT_REQUIRED/BLOCK
  NEG-03   conflicting ENV evidence                 BLOCK
  NEG-04   required secret unavailable              INPUT_REQUIRED/BLOCK
  NEG-05   missing port                             BLOCK
  NEG-06   conflicting ports                        BLOCK
  NEG-07   missing runtime command                  BLOCK
  NEG-08   multiple backend candidates              BLOCK
  NEG-09   unsupported required runtime             BLOCK
  NEG-10   ambiguous database ownership             INPUT_REQUIRED
  NEG-11   ambiguous proxy behavior                 BLOCK
  NEG-12   API prefix without GET route             MUST NOT HEALTH-PROBE
  NEG-13   inferred `/health` with no evidence      CERTIFICATION FAILURE
  NEG-14   backend secret assigned to frontend      SECURITY FAILURE
  NEG-15   runtime secret embedded in image         SECURITY FAILURE
  NEG-16   broken startup                           PREFLIGHT FAIL
  NEG-17   broken health endpoint                   PREFLIGHT/VERIFY FAIL
  NEG-18   missing database connectivity contract   BLOCK
  NEG-19   conflicting database types               BLOCK
  NEG-20   unsupported worker dependency            BLOCK

------------------------------------------------------------------------

# 24. Mutation Testing

Every important positive fixture must have controlled mutations.

## ENV mutations

-   delete required variable;
-   rename required variable;
-   change alias;
-   provide wrong alias;
-   remove secret;
-   move backend variable to frontend;
-   add conflicting alias family.

## Runtime mutations

-   wrong port;
-   wrong startup command;
-   invalid entrypoint;
-   missing executable.

## Health mutations

-   remove `/health`;
-   change `/health` to `/ready`;
-   make `/health` return 404;
-   leave only `/api/v1` prefix;
-   remove readiness evidence.

## Routing mutations

-   change preserve to strip;
-   change strip to preserve;
-   remove proxy rule;
-   create conflicting proxy rules.

## Dependency mutations

-   wrong DB hostname;
-   wrong DB port;
-   missing Redis;
-   invalid secret;
-   dependency unavailable.

Expected behavior:

> DeployGuard must stop at the earliest stage where the mutated contract
> becomes provably invalid.

------------------------------------------------------------------------

# 25. Executable Preflight Certification

The purpose of preflight is **not** to recreate all of AWS locally.

The purpose is to catch failures that DeployGuard itself can reproduce
from the application contract.

Minimum preflight:

1.  build immutable image;
2.  start the image;
3.  inject the exact application ENV contract;
4.  start all required components;
5.  verify TCP listening;
6.  verify explicit HTTP readiness where proven;
7.  verify frontend/backend relationship where proven;
8.  verify proxy behavior where reproducible;
9.  verify non-root execution;
10. verify required dependency connectivity where locally reproducible;
11. stop before Terraform if a critical contract fails.

The important boundary is:

``` text
Build immutable image
        |
        v
Executable preflight
        |
        +---- FAIL ----> STOP
        |
       PASS
        |
        v
Terraform
```

This is the mechanism that should prevent an ENV/configuration defect
from becoming a 20-minute ECS stabilization failure.

------------------------------------------------------------------------

# 26. AWS Boundary Certification

For every case expected to be blocked before AWS, verify:

``` text
Terraform executed? NO
ECS service created? NO
ALB target created? NO
AWS infrastructure modified? NO
```

For cases expected to deploy:

``` text
BuildPlan frozen
        |
        v
exact immutable images
        |
        v
Terraform
        |
        v
ECS
        |
        v
candidate verification
        |
        v
promotion
```

No later stage may reinterpret the BuildPlan.

------------------------------------------------------------------------

# 27. Immutable Contract Requirement

Once preflight succeeds, the same deployment contract must reach AWS.

Required invariant:

``` text
validated BuildPlan
      ==
deployed BuildPlan
```

The following must not change between stages without a new analysis
generation:

-   image identity;
-   component identity;
-   ENV names;
-   secret bindings;
-   ports;
-   startup command;
-   health path;
-   routing semantics;
-   dependency ownership.

If the plan changes, the operation must be invalidated and reanalyzed.

------------------------------------------------------------------------

# 28. Deployment State Semantics

The system must distinguish:

``` text
ANALYZING
INPUT_REQUIRED
BLOCKED
BUILDING
PREFLIGHTING
PROVISIONING
VERIFYING
PROMOTING
LIVE
FAILED
DESTROYING
```

Do not convert:

``` text
UNKNOWN -> FAILED AWS
WAITING_FOR_INPUT -> APPLICATION FAILURE
PLATFORM CONTRACT FAILURE -> REPOSITORY FAILURE
```

Correct state semantics are necessary for reliable user-facing
diagnosis.

------------------------------------------------------------------------

# 29. Failure Ownership Model

Every failure must have an owner.

## REPOSITORY

Example:

``` text
application itself requires a missing package
```

## USER INPUT

Example:

``` text
required external API secret has no configured source
```

## DEPLOYGUARD

Example:

``` text
repository proves POSTGRES_USER
but platform materializes only DB_USER
```

## AWS

Example:

``` text
proven deployment contract reaches AWS
but AWS returns a genuine infrastructure error
```

## TRANSIENT INFRASTRUCTURE

Example:

``` text
temporary registry/network service failure
```

## UNKNOWN

Only when the evidence genuinely cannot establish ownership.

AI must not turn UNKNOWN into a confident diagnosis.

------------------------------------------------------------------------

# 30. AI Troubleshooting Certification

AI input must include:

-   exact operation;
-   exact stage;
-   first proven failure;
-   sanitized evidence;
-   evidence provenance;
-   owner classification;
-   successful preceding stages;
-   skipped subsequent stages.

AI must not say:

``` text
Trivy failed
```

just because security evidence is missing.

AI must not say:

``` text
network failed
```

just because HTTP returned 404.

AI must not say:

``` text
database failed
```

just because application initialization failed.

The diagnosis must be bounded by evidence.

------------------------------------------------------------------------

# 31. Evidence Chain Requirement

For every critical BuildPlan field:

``` text
FIELD
  |
  +-- VALUE
  |
  +-- PROVENANCE
  |
  +-- CONFIDENCE
  |
  +-- VALIDATION
  |
  +-- PREFLIGHT RESULT
```

Example:

``` text
backend.port
value: 8000
source: Dockerfile + startup command
status: PROVEN
preflight: TCP 8000 PASS
```

This makes debugging deterministic and auditable.

------------------------------------------------------------------------

# 32. Certification Scoring

Do not use one aggregate "tests passed" number.

Use independent gates.

## Gate A --- Detection

Target:

``` text
100% deterministic detection fixtures
```

No critical false-positive deployment.

## Gate B --- Contract validation

Target:

``` text
100% critical ambiguity cases block
```

## Gate C --- Preflight

Target:

``` text
100% known reproducible application-contract failures
are caught before Terraform
```

## Gate D --- AWS deployment

For the supported positive corpus:

``` text
100% compatible cases reach successful candidate verification
```

## Gate E --- Failure attribution

Target:

``` text
100% intentionally injected failures identify
first proven failure and correct owner
```

One critical false-positive deployment is enough to fail certification
even if the aggregate percentage looks high.

------------------------------------------------------------------------

# 33. Certification Matrix --- 60+ Required Cases

## Positive application cases

  -----------------------------------------------------------------------
  ID                      Profile                 Expected
  ----------------------- ----------------------- -----------------------
  P01                     React/Vite              PASS

  P02                     Vue/Vite                PASS

  P03                     Next.js                 PASS or safe BLOCK if
                                                  required contract
                                                  unsupported

  P04                     Express                 PASS

  P05                     FastAPI                 PASS

  P06                     Flask                   PASS

  P07                     Django                  PASS

  P08                     Node + PostgreSQL       PASS

  P09                     Python + PostgreSQL     PASS

  P10                     Node + MongoDB          PASS

  P11                     Python + PostgreSQL +   PASS
                          Redis                   

  P12                     frontend + backend      PASS

  P13                     frontend + backend +    PASS
                          PostgreSQL              

  P14                     backend + worker +      PASS
                          PostgreSQL              

  P15                     backend + worker +      PASS
                          Redis + PostgreSQL      

  P16                     monorepo                PASS

  P17                     Dockerfile-first        PASS

  P18                     Compose-first           PASS

  P19                     explicit `/health`      PASS

  P20                     explicit `/ready`       PASS

  P21                     TCP-only service        PASS if supported

  P22                     external DB with        PASS or INPUT_REQUIRED
                          explicit contract       depending ownership

  P23                     reverse proxy preserve  PASS

  P24                     reverse proxy strip     PASS
  -----------------------------------------------------------------------

## Environment cases

  ID    Profile                    Expected
  ----- -------------------------- -----------------------------
  E01   `DATABASE_URL`             exact preservation
  E02   `POSTGRES_*`               exact preservation
  E03   `DB_*`                     exact preservation
  E04   `PG*`                      exact preservation
  E05   mixed aliases              evidence-based only
  E06   `.env.example`             supporting evidence
  E07   component `.env.example`   component scope
  E08   Compose `environment`      exact service scope
  E09   Compose `env_file`         exact service scope
  E10   Dockerfile `ENV`           supporting/runtime evidence
  E11   direct code access         strong evidence
  E12   fail-fast helper           strong evidence
  E13   typed settings             strong evidence
  E14   public frontend variable   build/public classification
  E15   runtime secret             secret classification
  E16   conflicting values         BLOCK unless deterministic

## Routing/health cases

  ID    Profile                          Expected
  ----- -------------------------------- ------------------------
  R01   explicit `/health`               probe it
  R02   explicit `/ready`                probe it
  R03   root `/` frontend                probe it if proven
  R04   `/api/v1` prefix only            do not probe as health
  R05   `/api/v1` + explicit `/health`   use `/health`
  R06   preserve routing                 honor evidence
  R07   strip routing                    honor evidence
  R08   ambiguous routing                BLOCK
  R09   missing readiness                BLOCK when required
  R10   wrong inferred health            certification failure

## Negative cases

  ID    Profile                            Expected
  ----- ---------------------------------- -----------------------
  N01   missing required ENV               BLOCK
  N02   missing secret                     INPUT_REQUIRED/BLOCK
  N03   ambiguous alias                    BLOCK
  N04   conflicting DB types               BLOCK
  N05   missing port                       BLOCK
  N06   conflicting ports                  BLOCK
  N07   missing command                    BLOCK
  N08   multiple backend candidates        BLOCK
  N09   unsupported required component     BLOCK
  N10   ambiguous DB ownership             INPUT_REQUIRED
  N11   ambiguous proxy semantics          BLOCK
  N12   broken startup                     PREFLIGHT FAIL
  N13   broken health endpoint             PREFLIGHT/VERIFY FAIL
  N14   frontend gets secret               SECURITY FAIL
  N15   secret in image                    SECURITY FAIL
  N16   unknown relationship path          BLOCK
  N17   stale BuildPlan                    REANALYZE
  N18   changed image after validation     REJECT
  N19   changed ENV after preflight        REJECT
  N20   changed routing after validation   REJECT

This matrix is the minimum baseline. Codex must expand it when
repository inspection discovers additional supported primitives.

------------------------------------------------------------------------

# 34. Mutation Certification

For every positive case, Codex must attempt at least one controlled
mutation in each relevant category:

``` text
ENV
PORT
COMMAND
HEALTH
ROUTING
DEPENDENCY
SECRET
COMPONENT OWNERSHIP
```

The expected result is not always `FAIL`.

It is:

> **fail at the earliest correct boundary with the correct owner and no
> unnecessary AWS mutation.**

------------------------------------------------------------------------

# 35. No-Guess Acceptance Tests

The following are hard acceptance tests.

## NG-01

Repository requires:

``` text
POSTGRES_USER
```

DeployGuard must not deploy with only:

``` text
DB_USER
```

## NG-02

Repository contains:

``` text
/api/v1
```

but no GET handler.

DeployGuard must not call:

``` text
GET /api/v1
```

as health.

## NG-03

Repository has two possible backend roots.

DeployGuard must not select one silently.

## NG-04

Repository proves database dependency but not connection contract.

DeployGuard must not invent a database ENV family.

## NG-05

Repository has no proven HTTP readiness path.

DeployGuard must not invent `/health`.

## NG-06

Repository has conflicting proxy semantics.

DeployGuard must not choose preserve/strip arbitrarily.

## NG-07

Repository has an unsupported required component.

DeployGuard must stop before infrastructure provisioning.

------------------------------------------------------------------------

# 36. Early-Stop Acceptance Tests

For every intentionally invalid case, record:

``` text
analysis completed? YES/NO
BuildPlan generated? YES/NO
preflight executed? YES/NO
Terraform executed? YES/NO
ECS created? YES/NO
ALB changed? YES/NO
AWS resources modified? YES/NO
```

The platform should stop as early as the evidence permits.

A failure after Terraform is not equivalent to a failure before
Terraform.

------------------------------------------------------------------------

# 37. Presentation-Ready Reliability Standard

DeployGuard should be considered presentation-ready only when all of the
following are true:

``` text
Detection correctness             PASS
BuildPlan correctness             PASS
Critical ambiguity blocking       PASS
Exact ENV preservation            PASS
Secret isolation                  PASS
Routing evidence                  PASS
Health evidence                   PASS
Executable preflight              PASS
AWS boundary                      PASS
Immutable contract                PASS
Candidate verification            PASS
Promotion safety                  PASS
Failure ownership                 PASS
AI evidence bounds                PASS
Mutation suite                    PASS
Negative corpus                   PASS
```

The platform does **not** need to deploy every arbitrary repository.

It does need to behave predictably for every repository class it claims
to support.

------------------------------------------------------------------------

# 38. Research Basis

This plan is grounded in established PaaS and deployment-system
practices and research.

## Twelve-Factor App --- Config

Configuration that varies between deploys should be separated from
application code and managed as deployment configuration.

Source: `12factor.net/config`

## Heroku --- Config Vars

Heroku models deploy-varying configuration as external config vars
exposed to the running application.

Source: `devcenter.heroku.com/articles/how-heroku-works`

## Render --- Environment Variables and Docker

Render separates service environment configuration from source, supports
Docker deployments, and documents the distinction between build-time and
runtime handling of sensitive configuration.

Sources:

-   `render.com/docs/environment-variables`
-   `render.com/docs/configure-environment-variables`
-   `render.com/docs/docker`
-   `render.com/docs/docker-secrets`
-   `render.com/docs/health-checks`

## Railway --- Variables and Health Checks

Railway supports service/shared/reference variables and deployment
health checks that gate activation of a new deployment.

Sources:

-   `docs.railway.com/variables`
-   `docs.railway.com/deployments/healthchecks`
-   `docs.railway.com/deployments/reference`
-   `docs.railway.com/templates/best-practices`

## AWS ECS

ECS task definitions explicitly model container environment, secret
references, commands, networking, and health checks.

Sources:

-   `docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definitions.html`
-   `docs.aws.amazon.com/AmazonECS/latest/developerguide/create-task-definition.html`

## Google Cloud Run

Cloud Run distinguishes startup, liveness, and readiness behavior and
supports TCP startup probes where appropriate.

Source: `cloud.google.com/run/docs/configuring/healthchecks`

## Configuration-error research

Empirical research has repeatedly identified configuration errors as a
major class of system failures. This is directly relevant to DeployGuard
because DeployGuard acts as a configuration compiler between arbitrary
repositories and standardized infrastructure.

Sources:

-   Yin et al., *An Empirical Study on Configuration Errors in
    Commercial and Open Source Systems* (SOSP 2011)
-   Xu et al., *70 Systems Approaches to Tackling Configuration Errors*
-   Chen et al., *Understanding and Discovering Software Configuration*
    literature

## Automated cloud deployment research

Research on cloud deployment and automated deployment emphasizes
explicit configuration/deployment models, controlled execution, and
structured deployment workflows rather than arbitrary interpretation of
incomplete information.

Sources:

-   *Cloud application deployment with transient failure recovery
    capabilities*
-   *Optimal and Automated Deployment for Microservices*
-   *Toward governance of cross-Cloud application deployment*

------------------------------------------------------------------------

# 39. Codex Certification Rules

Codex must **not** redesign DeployGuard merely to make this
certification pass.

Codex must first inspect the existing implementation and classify each
requirement as:

``` text
IMPLEMENTED
PARTIALLY_IMPLEMENTED
MISSING
BROKEN
UNSUPPORTED_BY_DESIGN
TEST_ONLY_MISSING
```

Codex must trace the real execution path rather than checking whether a
similarly named function exists.

If a requirement cannot be satisfied without changing the architecture,
Codex must report an `ARCHITECTURE GAP` instead of inventing another
architecture.

------------------------------------------------------------------------

# 40. Required Certification Report

Codex must create:

``` text
docs/deployguard-certification-report.md
```

For every certification case, report:

``` text
CASE ID
REPOSITORY/FIXTURE
INPUT STRUCTURE
DETECTED COMPONENTS
DETECTED ENV
DETECTED SECRETS
DATABASE CONTRACT
PORT CONTRACT
START COMMAND
HEALTH CONTRACT
ROUTING CONTRACT
BUILDPLAN STATUS
PREFLIGHT STATUS
AWS STATUS
EXPECTED RESULT
ACTUAL RESULT
FIRST PROVEN FAILURE
FAILURE OWNER
PROVENANCE
AWS TOUCHED? YES/NO
GUESS MADE? YES/NO
DETECTED BEFORE AWS? YES/NO
PASS/FAIL
```

For every failure, explain:

``` text
WHY IT FAILED
WHETHER DEPLOYMENT WAS CORRECTLY BLOCKED
WHETHER AWS WAS TOUCHED
WHETHER THE FAILURE WAS DETECTED TOO LATE
WHETHER THE PLATFORM GUESSED
WHETHER THE ERROR WAS CORRECTLY ATTRIBUTED
```

------------------------------------------------------------------------

# 41. Codex Must Not Give False Certification

Do not report `PASS` merely because:

-   the repository builds;
-   unit tests pass;
-   a detector function returns a value;
-   a fixture parses successfully;
-   a mock returns expected data;
-   Product Verify passes.

A certification case passes only when the actual end-to-end behavior
satisfies its expected contract.

For a blocked case, the platform must actually demonstrate that it stops
at the correct boundary.

For a positive case, the platform must demonstrate that the immutable
contract reaches the runtime unchanged.

------------------------------------------------------------------------

# 42. Final Certification Decision

Codex must produce exactly one final status.

## CERTIFIED

All mandatory positive and negative cases pass, critical blind guesses
are zero, and no critical AWS-side failure remains that should have been
caught earlier.

## CONDITIONALLY CERTIFIED

The platform is reliable for a clearly defined supported corpus, while
unsupported classes are consistently blocked and documented.

## NOT CERTIFIED

Any of the following is sufficient:

-   critical blind guess;
-   critical ambiguity allowed into Terraform;
-   critical application-contract failure discovered only after AWS;
-   incorrect failure ownership;
-   fabricated health path;
-   fabricated routing semantics;
-   secret isolation failure;
-   immutable-contract violation;
-   unsafe unsupported-repository behavior.

------------------------------------------------------------------------

# 43. Codex Certification Prompt

Copy this section directly to Codex after saving this document in the
repository.

``` text
TASK: Certify DeployGuard against docs/deployguard-universal-certification-plan.md.

ROLE: Senior platform/reliability engineer. Treat this as a production-readiness certification, not a feature request.

DO NOT redesign DeployGuard.
DO NOT replace the current architecture.
DO NOT introduce another deployment architecture.
DO NOT weaken a requirement to make a test pass.

PHASE 1 — INSPECT

Inspect the complete current execution path:
- repository/stack detection
- ENV classification
- database binding
- BuildPlan generation
- deployment contract validation
- executable preflight
- image build
- GitHub Actions workflow
- Terraform generation
- ECS task definition generation
- health verification
- routing/relationship verification
- current-state/reconciliation
- failure classification
- AI troubleshooting evidence
- all existing regression scripts/tests

PHASE 2 — REQUIREMENT MATRIX

For every requirement in the certification plan, classify it as:
IMPLEMENTED
PARTIALLY_IMPLEMENTED
MISSING
BROKEN
UNSUPPORTED_BY_DESIGN
TEST_ONLY_MISSING

Trace the actual execution path. Do not call something implemented because a nearby function exists.

PHASE 3 — BUILD CERTIFICATION FIXTURES

Create or reuse deterministic fixtures covering:
- React/Vite
- Vue/Vite
- Next.js
- Express
- FastAPI
- Flask
- Django
- frontend + backend
- frontend + backend + PostgreSQL
- backend + PostgreSQL
- backend + Redis
- backend + worker + PostgreSQL
- backend + worker + Redis + PostgreSQL
- monorepo
- Dockerfile-first
- Compose-first
- explicit /health
- explicit /ready
- TCP-only
- /api/v1 prefix without GET handler
- preserve routing
- strip routing
- ambiguous routing
- missing ENV
- ambiguous ENV
- conflicting ENV
- missing port
- missing command
- multiple backend candidates
- unsupported component
- external database
- public frontend ENV
- runtime secret
- frontend/backend secret isolation

Use synthetic fixtures where a real repository is unavailable.

PHASE 4 — MUTATION TESTING

For every relevant positive fixture, mutate:
- required ENV
- ENV alias
- secret
- port
- command
- health endpoint
- routing prefix
- proxy behavior
- database dependency
- Redis dependency
- component ownership

Verify that DeployGuard stops at the earliest correct boundary.

PHASE 5 — ABSOLUTE NO-GUESS TEST

For every case ask:
"Did DeployGuard invent any critical deployment fact?"

Critical facts include:
- ENV names
- secrets
- ports
- commands
- health paths
- relationship paths
- routing preserve/strip behavior
- database ownership/type
- component ownership
- persistence requirements

If YES: FAIL.
Do not rationalize the guess.

PHASE 6 — AWS BOUNDARY

For every blocked case verify:
- Terraform did not run
- ECS was not created/modified
- ALB was not unnecessarily changed
- no unnecessary AWS infrastructure was created

For positive cases verify the exact immutable BuildPlan reaches AWS unchanged.

PHASE 7 — FAILURE OWNERSHIP

For every failure identify exactly one primary owner:
REPOSITORY
USER_INPUT
DEPLOYGUARD
AWS
TRANSIENT_INFRASTRUCTURE
UNKNOWN

Do not blame AWS for a DeployGuard-generated contract error.
Do not blame the repository for a DeployGuard-generated guess.
Do not let Gemini infer a cause that is not proven by evidence.

PHASE 8 — REPORT

Create:
docs/deployguard-certification-report.md

Include:
1. executive summary
2. inspected architecture
3. inspected files
4. requirement matrix
5. positive cases
6. negative cases
7. mutation cases
8. ENV cases
9. database cases
10. routing cases
11. health cases
12. secret cases
13. preflight cases
14. AWS-boundary cases
15. first-failure analysis
16. ownership classification
17. blind-guess audit
18. unsupported classes
19. exact missing implementation
20. exact missing tests
21. final certification decision

Every failed case must contain:
CASE
EXPECTED
ACTUAL
FIRST PROVEN FAILURE
OWNER
EVIDENCE
AWS TOUCHED? YES/NO
GUESS MADE? YES/NO
DETECTED BEFORE AWS? YES/NO

PHASE 9 — NO ARCHITECTURE DRIFT

If a requirement cannot be met without architectural change, stop and report:
ARCHITECTURE GAP

Do not invent another architecture.

PHASE 10 — FINAL OUTPUT

At the end print exactly:

CERTIFICATION STATUS:
CERTIFIED / CONDITIONALLY CERTIFIED / NOT CERTIFIED

CRITICAL BLIND GUESSES:
<number>

CRITICAL LATE FAILURES:
<number>

CRITICAL UNRESOLVED IMPLEMENTATION GAPS:
<number>

MANDATORY TEST GAPS:
<number>

AWS-SIDE FAILURES THAT SHOULD HAVE BEEN CAUGHT BEFORE AWS:
<number>

SAFE TO PRESENT:
YES / NO

Do not claim universal deployment capability. Certify only what the evidence proves.
```

------------------------------------------------------------------------

# 44. Final Engineering Principle

The objective is not:

> "Make DeployGuard try harder to deploy every repository."

The objective is:

> **Make DeployGuard impossible to fool by its own assumptions.**

A successful PaaS deployment is valuable.

A safe refusal is also a successful platform behavior.

The final certification must prove both.
