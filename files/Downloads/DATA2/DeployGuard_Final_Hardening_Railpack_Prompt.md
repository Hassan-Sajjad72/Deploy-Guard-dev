You are working on the **DeployGuard backend**.

This is a **FINAL RELIABILITY/HARDENING PASS**, not an architecture brainstorming session.

Your job is to make the existing DeployGuard repository-analysis and deployment pipeline **provably reliable for the fixed Tier-1 JavaScript/TypeScript and Python web-framework targets defined below**.

Do not give ratings such as 7/10, 8/10, etc.

Do not merely review code.

Do not stop after finding defects.

**Find → reproduce → fix → test → re-test until the supported matrix is 100% green.**

---

# PRIMARY OBJECTIVE

Given a real Git repository, DeployGuard must correctly determine everything required to build and deploy it:

```text
Repository
    ↓
Repository evidence
    ↓
Application/component discovery
    ↓
Framework/runtime detection
    ↓
Repository topology
    ↓
Package/dependency/install strategy
    ↓
Build/start/release commands
    ↓
Environment-variable requirements
    ↓
Database requirements
    ↓
Deployment contract / build plan
    ↓
Docker build configuration
    ↓
Actual Docker image build
    ↓
RuntimeSpec
    ↓
VPS runtime deployment
    ↓
Container starts and becomes reachable

```

Correct stack detection alone is NOT sufficient.

A repository is considered supported only when the information remains correct through **every stage** and the generated image can actually build and start.

---

# NON-NEGOTIABLE RULE

Every important repository fact must have **one canonical meaning** across the pipeline.

Examples:

```text
framework
framework variant
component root
repository root
build context
install root
package manager
build command
run command
release command
runtime port
health endpoint
database engine
database service hostname
database name
database username
environment-variable name
environment-variable owner
environment-variable phase
environment-variable component
environment-variable exposure
Docker image identity

```

Do not allow stage N and stage N+1 to independently recreate the same information using different naming or assumptions.

The rule is:

> DETECT ONCE → NORMALIZE ONCE → CONSUME DOWNSTREAM.

---


# FIXED TIER-1 FRAMEWORK TARGET — DO NOT SHRINK OR SUBSTITUTE

The following framework families are **mandatory Tier-1 DeployGuard targets** for this hardening pass.

Do not remove a framework from this target merely because a test fails.
Do not redefine a failing supported case as unsupported simply to obtain green tests.
Framework-specific unsupported modes may be blocked only when there is a concrete technical reason and the blocker is explicit and tested.

## JavaScript / TypeScript Frontend + Full-stack

```text
React + Vite
Next.js
Vue + Vite
Nuxt
Angular
SvelteKit
Astro
Remix
Create React App — legacy compatibility
```

## Node.js Backends

```text
Express
Fastify
NestJS
```

## Python Web Frameworks

```text
Django
Flask — including application factories
FastAPI
Streamlit
```

These are the core product targets.

For them, "supported" does NOT mean merely recognizing a dependency or framework name.

For supported repository shapes, DeployGuard must correctly carry the complete deployment meaning through:

```text
repository
→ evidence
→ component discovery
→ framework + variant
→ topology
→ app/workspace/build/install roots
→ package/dependency strategy
→ ENV analysis
→ DB/ORM analysis
→ frontend/backend relationships
→ build/start/release commands
→ port/health behavior
→ canonical contract
→ Railpack plan correlation
→ image build
→ container startup
→ RuntimeSpec
→ VPS deployment
```

The target is:

```text
known supported regression cases          100% green
cross-stage invariants                    100% green
Railpack correlation tests                100% green
actual image builds                       100% green
actual runtime smoke tests                100% green
deterministic expected blockers           100% green
confidently wrong deployments             0
```

---

# RAILPACK INTEGRATION — REQUIRED OPERATING MODEL

Railpack is being added to **increase build reliability**, not to replace DeployGuard's repository intelligence.

The responsibility boundary is mandatory:

```text
DeployGuard = repository intelligence + canonical facts + policy + correlation + runtime orchestration
Railpack    = per-component build-plan assistance + build execution
```

## DeployGuard remains the source of truth for repository-level intelligence

DeployGuard must continue to determine and own:

```text
repository type/topology
component boundaries
framework + framework variant
application roots
workspace/monorepo structure
repositoryRoot
workspaceRoot
appRoot
installRoot
buildContext
package-manager evidence
ENV requirements
ENV ownership
ENV phase
ENV exposure
component-scoped ENV identity
database requirements
ORM/database evidence
database provisioning intent
frontend ↔ backend relationships
ports
health/readiness evidence
migration/release requirements
routing metadata
DeployGuard runtime policy
VPS deployment orchestration
```

Railpack must NOT become the sole source of truth for those facts.

## Railpack responsibility

For each DeployGuard-detected deployable component, use Railpack to produce and inspect its build information/plan and, where appropriate, build the OCI image.

Railpack may own or assist with:

```text
language/provider verification
runtime version selection
dependency installation strategy
install command
build command
start command
system-package requirements
framework-specific build mechanics
build-plan generation
OCI image construction through BuildKit
```

Do not treat Railpack as an opaque black box.

Persist or expose enough Railpack plan/provenance information to explain what was built, including the Railpack version used.

Pin the Railpack version used by DeployGuard so an upstream Railpack release cannot silently change production behavior without tests.

## Required pipeline with Railpack

```text
Repository
↓
DeployGuard repository evidence
↓
DeployGuard component/topology detection
↓
DeployGuard canonical facts
↓
Railpack analysis/plan PER COMPONENT
↓
DeployGuard pre-flight correlation
↓
critical agreement or evidence-based resolution
↓
Railpack/BuildKit image build
↓
actual container startup verification
↓
DeployGuard RuntimeSpec
↓
VPS runtime
```

Railpack must run **after component boundaries are known**.
Do not pass an ambiguous whole multi-app repository to Railpack and allow it to decide DeployGuard's topology.

---

# DEPLOYGUARD ↔ RAILPACK PRE-FLIGHT CORRELATION

The existing DeployGuard pre-flight validator remains mandatory and becomes stronger.

For every component, compare DeployGuard canonical facts with the Railpack plan where the same semantic fact exists.

At minimum correlate:

```text
DeployGuard framework/runtime
↔ Railpack provider/runtime

DeployGuard appRoot/buildContext
↔ Railpack analysis/build context

DeployGuard package manager
↔ Railpack dependency/install strategy

DeployGuard build command
↔ Railpack build command

DeployGuard start command
↔ Railpack start command

DeployGuard runtime port expectation
↔ Railpack/runtime plan where available

DeployGuard required build-time ENV
↔ Railpack build inputs

DeployGuard required runtime ENV
↔ final runtime configuration
```

Agreement is evidence that the build can proceed.

A disagreement is NOT automatically proof that DeployGuard is wrong or that Railpack is wrong.

For a critical disagreement:

```text
1. inspect repository evidence,
2. determine which result is actually supported by that evidence,
3. fix the incorrect stage if the cause is a DeployGuard defect,
4. add a regression test,
5. if the repository remains genuinely ambiguous, block safely.
```

Never silently accept a critical disagreement.

Never overwrite a canonical DeployGuard fact merely because Railpack produced a different guess.

---

# EXISTING DOCKER TEMPLATE / DOCKERFILE MODULES — NEW ROLE

Do NOT delete the existing DeployGuard Docker/template work merely because Railpack is introduced.

Change the responsibility hierarchy.

## Old default path

```text
DeployGuard detection
→ Docker template matching
→ pre-flight
→ DeployGuard Dockerfile generation
→ docker build
```

## New preferred path

```text
DeployGuard detection
→ canonical component facts
→ Railpack plan
→ DeployGuard pre-flight correlation
→ Railpack/BuildKit image build
```

Existing DeployGuard Docker template matching and Dockerfile generation become a **tested fallback/compatibility path**, not the default path for a repository Railpack can safely build.

## Required build hierarchy

```text
1. Valid user-provided Dockerfile
   → respect the explicit repository build contract after safety/pre-flight validation

2. No user Dockerfile
   → DeployGuard detection
   → Railpack plan
   → DeployGuard ↔ Railpack validation
   → Railpack/BuildKit build

3. Railpack cannot safely build a Tier-1 case that DeployGuard can prove
   → use a PROVEN DeployGuard fallback template only if a regression fixture covers it

4. Neither path can prove a safe deployment
   → deterministic BLOCK with an exact reason
```

Never generate a guessed fallback Dockerfile.

Do not allow a generic template to hide a Railpack/DeployGuard disagreement.

---

# STACK-DETECTION CONFIGURATION / LEGACY OFF SWITCH

Search for environment/configuration flags that globally disable stack or repository detection, including concepts such as:

```text
STACK_DETECTION=false
STACK_DETECTION_ENABLED=false
DISABLE_STACK_DETECTION=true
```

or equivalent project-specific flags.

For the normal automatic deployment path, DeployGuard repository intelligence must NOT be silently disabled.

If a legacy kill switch exists:

1. determine why it exists,
2. remove it from the normal/default automatic deployment path or make the safe default detection-enabled,
3. preserve an explicit bypass only when there is a legitimate explicit build contract such as a user-provided Dockerfile, if the product design requires that bypass,
4. add regression tests proving the normal automatic path cannot accidentally run with repository detection disabled,
5. log/record when an explicit bypass is used.

Railpack presence is NOT a reason to turn DeployGuard detection off.

Correct model:

```text
DEPLOYGUARD_DETECTION = ON
BUILD_ENGINE           = RAILPACK
CUSTOM_TEMPLATE        = FALLBACK ONLY
```

Do not merely rename flags; fix the actual behavior and tests.

---

# RAILPACK FAILURE / FALLBACK POLICY

Railpack failure must be classified.

Examples:

```text
Railpack cannot detect provider
Railpack produces no valid start command
Railpack plan contradicts proven repository evidence
Railpack build fails
Railpack version/runtime is unsupported by the repository
```

For a Tier-1 case:

```text
Railpack failure
↓
inspect evidence
↓
if DeployGuard has a proven tested fallback template → use fallback
otherwise → BLOCK
```

Do not silently downgrade to an untested Dockerfile.

Every fallback that is allowed in production must have an executable regression fixture proving:

```text
detection
→ fallback selection
→ Docker build
→ container start
→ health/readiness
```

---

# RAILPACK MUST NOT HIDE EXISTING DEPLOYGUARD DEFECTS

Before declaring Railpack integration successful, verify that DeployGuard still independently produces correct repository-level facts.

A Railpack-built image succeeding does NOT excuse incorrect DeployGuard data.

The following must still be correct in DeployGuard:

```text
topology
component roots
workspace/build/install roots
ENV ownership
ENV component identity
DB engine
DB identity
frontend/backend relation
release/migration intent
port
health metadata
RuntimeSpec
```

If Railpack happens to compensate for a wrong DeployGuard inference, the test must still fail.

---

# REAL-WORLD / HELD-OUT VALIDATION

Do not rely only on hand-authored happy-path fixtures.

In addition to regression fixtures, maintain a held-out validation corpus containing realistic repository layouts for the Tier-1 frameworks.

The implementation must not contain:

```text
fixture-name checks
repository-name checks
hardcoded paths that exist only in test fixtures
special branches written solely for held-out repositories
```

Use the held-out corpus after normal regression fixes to evaluate generalization.

Track separately:

```text
correct automatic deployment
correct deterministic blocker
wrong automatic deployment
wrong blocker
```

The worst category is:

```text
WRONG AUTOMATIC DEPLOYMENT
```

The target for confidently wrong deployments is zero.

---

# MUTATION / ADVERSARIAL TESTING

For the Tier-1 frameworks, mutate otherwise valid fixtures to ensure the detector is evidence-driven rather than filename-driven.

Examples include:

```text
move app.py into a nested package
move server.ts under src/http/
change npm ↔ pnpm/yarn where valid
move app into apps/web
introduce a root workspace lockfile
add a second package.json
add a misleading but unused dependency
remove direct pg dependency while Prisma still declares PostgreSQL
rename DB_USER ↔ DATABASE_USER
use the same ENV key in two different components
change public frontend ENV names such as VITE_* / NEXT_PUBLIC_* / REACT_APP_*
change Django project package name
use Flask application factory
use nested FastAPI module paths
```

The system should continue to derive facts from repository evidence.

A mutation that creates genuine ambiguity should produce a deterministic blocker rather than a guessed deployment.

---


# IMPORTANT PRODUCT CONTEXT

DeployGuard now targets a **simple VPS/container runtime**.

Do NOT spend time rebuilding AWS infrastructure.

Do NOT introduce:

```text
ECS
Terraform ECS deployment
ALB
VPC
Route53
AWS-specific networking

```

unless some old AWS code is actively interfering with the current VPS path and must be removed/fixed.

The target runtime is:

```text
Linux VPS
↓
Docker / Swarm
↓
Traefik / ingress
↓
DeployGuard services
↓
Customer containers

```

Focus on repository intelligence, Docker generation, configuration correlation and runtime deployment.

---

# FIRST: UNDERSTAND THE EXISTING PIPELINE

Before modifying code:

1. Inspect the complete backend.
2. Find the existing detection pipeline.
3. Find canonical topology/evidence types.
4. Find deployment profile / deployment contract / BuildPlan generation.
5. Find configuration/environment materialization.
6. Find database requirement generation.
7. Find Docker template generation.
8. Find Docker build orchestration.
9. Find RuntimeSpec generation.
10. Find VPS/runtime-agent deployment.
11. Find all verification/test scripts.
12. Run the existing relevant test suite.

Do not redesign components merely because another design looks cleaner.

Preserve the existing architecture unless a concrete reliability bug requires a change.

---

# ZERO SPECULATIVE BUG REPORTING

Classify findings internally as:

```text
CONFIRMED FAILURE
REPRODUCED with code/test/evidence.

EXPECTED BLOCK
Repository is intentionally unsupported or ambiguous and DeployGuard safely refuses deployment.

PASS
Behavior is proven correct.

UNVERIFIED
Cannot currently prove it.

```

Do not call something broken solely because it looks suspicious.

For every bug:

1. reproduce it,
2. create/regress a test,
3. fix it,
4. run the test,
5. run surrounding tests,
6. continue.

---

# DO NOT CHEAT THE TEST SUITE

You MUST NOT obtain green tests by:

- deleting tests,
- weakening assertions,
- hardcoding fixture names,
- adding repository-specific hacks,
- swallowing errors,
- marking failing supported repositories unsupported without technical justification,
- bypassing actual detection,
- returning generic defaults,
- mocking the exact behavior that needs to be tested,
- changing expected outputs merely to match broken implementation.

Tests must validate real behavior.

---

# JAVASCRIPT / TYPESCRIPT MATRIX

Deeply verify all frameworks that the current code claims to support.

At minimum inspect support for:

### Backend

```text
Express JavaScript
Express TypeScript
Fastify JavaScript
Fastify TypeScript
NestJS

```

### Frontend

```text
React
Vite React
Vite Vue
Angular
Create React App where currently supported
Webpack-based React where currently supported

```

### Full-stack / SSR / SSG

```text
Next.js SSR
Next.js standalone
Next.js static export
Nuxt SSR
Nuxt static
SvelteKit adapter-node
SvelteKit adapter-static
Astro static
Astro Node
Remix Node where currently supported

```

For every framework verify more than dependency presence.

Correlate:

```text
manifest
dependency evidence
scripts
config files
entrypoints
source files
framework-specific config
output directory
runtime mode
adapter
build command
runtime command
port behavior
health behavior
repository layout

```

---

# PYTHON MATRIX

Deeply verify current support for:

```text
Flask
Flask application factory
FastAPI
Django WSGI
Django ASGI
Streamlit

```

Also verify supported dependency/install styles such as those currently implemented:

```text
requirements.txt
pyproject.toml
Poetry if claimed supported
uv if claimed supported
other currently declared Python package-manager paths

```

Do NOT rely only on filenames such as:

```text
main.py
app.py
server.py

```

if the current support contract expects nested Python applications to work.

Correlate:

```text
imports
application object
application factory
module path
production server
ASGI/WSGI
manage.py
settings
migration requirements
collectstatic requirements
dependency files
start command
port

```

Use safe static analysis only.

Never execute arbitrary repository code merely to detect its framework.

---

# REPOSITORY STRUCTURE / TOPOLOGY

Correctly distinguish:

```text
single backend
single frontend
SSR application
static frontend
backend serving frontend
decoupled frontend + backend
bounded monorepo/workspace
multiple independently deployable applications
unsupported/ambiguous repository

```

Do not treat these as interchangeable:

```text
repositoryRoot
appRoot
buildContext
installRoot
workspaceRoot

```

They must remain separate throughout the pipeline.

Example:

```text
repository root = .
app root = apps/web
install root = .
Docker build context = .

```

must remain possible.

This is essential for:

```text
npm workspaces
pnpm workspaces
yarn workspaces
shared packages
root lockfiles
root tsconfig
monorepo configs

```

---

# PACKAGE MANAGER CORRELATION

Verify package manager using repository evidence.

Correlate:

```text
packageManager field
lockfiles
workspace config
scripts
existing package-manager configuration

```

Avoid incorrect fallback behavior when evidence clearly identifies:

```text
npm
pnpm
yarn

```

Install/build/runtime commands must use the same resolved package manager.

---

# ENVIRONMENT VARIABLE ANALYSIS

ENV analysis is CRITICAL.

Detect ENV requirements from all existing supported evidence sources, including where applicable:

```text
.env.example
.env.sample
example env files
README/environment docs
process.env.X
process.env["X"]
import.meta.env.X
Nest configuration APIs
Python os.environ
Python os.getenv
Pydantic settings
framework config
Docker/Compose evidence
ORM configuration

```

Each ENV binding must preserve:

```text
name
component
owner
phase
exposure
required/optional
default if safely inferable
provenance

```

At minimum distinguish:

```text
user-owned
platform-owned
repository-default

```

and:

```text
build-time
runtime

```

and:

```text
public
secret/private

```

---

# COMPONENT-SCOPED ENV IDENTITY

Do not globally merge variables merely because their names match.

The semantic identity should account for at least:

```text
componentId
variable name
phase

```

Example:

```text
frontend.API_URL
backend.API_URL

```

must not accidentally become one binding unless the repository explicitly proves they should share a value.

---

# FRONTEND → BACKEND CORRELATION

This must work end-to-end.

Example repository:

```text
frontend = Vite
backend = Express
frontend calls backend through /api
frontend uses VITE_API_URL

```

If detection concludes:

```text
VITE_API_URL
owner = platform
phase = build
component = frontend

```

then that value MUST actually reach:

```text
DeploymentContract
↓
BuildPlan
↓
configuration materialization
↓
Docker build arguments/config
↓
frontend build

```

Never produce this failure:

```text
detector correctly sees VITE_API_URL
↓
system decides user doesn't need to provide it
↓
Docker build never receives it

```

Test this explicitly.

Also verify equivalents currently supported such as:

```text
NEXT_PUBLIC_*
REACT_APP_*
VITE_*

```

when relevant.

---

# DATABASE DETECTION

Database detection must use all strong evidence currently available.

Verify at minimum:

```text
PostgreSQL
MySQL/MariaDB
MongoDB

```

where currently supported.

Do not depend solely on direct drivers.

Inspect ORM-native configuration where relevant:

```text
Prisma datasource provider
TypeORM datasource type
Sequelize dialect
SQLAlchemy database URL/provider
Mongoose configuration
Django DATABASES where safely detectable

```

Example:

```prisma
datasource db {
  provider = "postgresql"
}

```

must count as strong PostgreSQL evidence even if `pg` is not directly listed as an application dependency.

---

# DATABASE ENV ALIASES

Verify semantic normalization for aliases such as:

```text
DB_USER
DATABASE_USER
POSTGRES_USER
PGUSER

```

→ canonical:

```text
username

```

Similarly verify:

```text
DB_HOST
DATABASE_HOST
POSTGRES_HOST
PGHOST

```

→ host

```text
DB_NAME
DATABASE_NAME
POSTGRES_DB
PGDATABASE

```

→ database

and equivalent supported aliases for password/port/URL.

Alias resolution must remain identical across all stages.

---

# DATABASE IDENTITY — ONE SOURCE OF TRUTH

Audit every place that creates or consumes:

```text
database engine
serviceName
internal hostname
databaseName
databaseUser
password secret
volume identity
network identity

```

Ensure these values are derived once and consumed downstream.

There must never be:

```text
requirements thinks hostname = X
runtime creates hostname = Y

```

or:

```text
contract thinks DB name = X
configuration materializer injects DB name = Y

```

or:

```text
db.user
database.user
database.username

```

representing inconsistent meanings at different stages.

Add tests that assert exact equality across stages.

---

# MIGRATIONS / RELEASE COMMANDS

Where framework/ORM evidence proves migrations or release operations are needed, ensure they survive into the final deployment plan.

Examples where currently supported:

```text
Django migrate
Prisma migrate
other existing migration support

```

Do not infer dangerous migration commands without evidence.

But if detection proves a migration command is required, do not lose it before runtime.

---

# DOCKER / RAILPACK BUILD GENERATION

For the preferred automatic path, verify the Railpack plan and resulting build against the actual repository.

For any proven DeployGuard fallback-template path, verify the generated Docker configuration against the actual repository.

Check:

```text
base image/runtime
working directory
build context
copy paths
dependency files
lockfiles
workspace files
install command
build command
output files
runtime command
environment variables
build variables
port
health check
system dependencies
release command behavior

```

Never generate a Dockerfile merely because the framework name matches a template.

For the Railpack path, the Railpack plan must be compatible with the exact repository evidence and must pass DeployGuard pre-flight correlation.

For the fallback-template path, the Dockerfile must be compatible with the exact repository evidence and covered by executable regression tests.

---

# ACTUAL DOCKER BUILD IS REQUIRED

Static Dockerfile validation is NOT sufficient.

For supported fixtures, actually run:

```bash
docker build ...

```

or the project's actual build path.

When Railpack is the selected build engine, run the actual Railpack/BuildKit production-equivalent build path rather than only snapshot-testing a plan.

A supported fixture is NOT green if image creation fails.

---

# ACTUAL CONTAINER STARTUP IS REQUIRED

After successful image build, start it.

Verify:

```text
container remains running
expected command starts
expected port listens
required ENV is present
health endpoint responds when defined
application responds when health endpoint does not exist but another safe verification path is defined

```

Use bounded timeouts.

Do not treat:

```text
docker build succeeded

```

as deployment success.

---

# DATABASE-BACKED SMOKE TESTS

For supported database-backed fixtures:

1. start required test database,
2. use the same canonical database identity/config mechanism expected in deployment,
3. start application container,
4. run required migrations/release action when applicable,
5. verify application/database connectivity,
6. perform health/readiness verification.

Do not fake database success using mocks for these integration fixtures.

---

# RUNTIME SPEC CORRELATION

Verify every relevant BuildPlan/DeploymentContract value reaching RuntimeSpec.

Assert:

```text
image
component
port
environment
secret references
database identity
network attachment
health configuration
resource configuration where applicable
release/migration behavior
routing metadata

```

Do not allow RuntimeSpec to rediscover repository facts.

RuntimeSpec must consume canonical deployment information.

---

# PERSISTENCE / JSON VALIDATION

Anything serialized to PostgreSQL/JSON and later consumed should be runtime validated.

Inspect:

```text
CanonicalTopology
DeploymentContract
BuildPlan
RuntimeSpec

```

or equivalent persisted structures.

If runtime schemas already exist, test them.

If coarse object checks allow structurally invalid/stale records to pass, strengthen validation using the project's existing validation approach or a suitable schema mechanism.

The goal is to prevent stale forms such as:

```text
db.user

```

from silently reaching code expecting:

```text
database.username

```

A schema mismatch should fail early with an explicit error.

---

# WORKERS / ADDITIONAL PROCESSES

Inspect support for worker/background-process evidence.

Examples:

```text
Celery
RQ
Dramatiq
BullMQ
queue workers
Procfile workers
custom worker scripts

```

If the existing DeployGuard topology does NOT support these safely:

DO NOT silently deploy only the web process.

Instead classify the repository as explicitly unsupported/blocked with a clear reason.

Partial deployments count as failures.

---

# SAFE FAILURE IS A SUCCESSFUL PRODUCT BEHAVIOR

DeployGuard does NOT need to support every repository in existence.

For uncertain repositories, the correct behavior is:

```text
BLOCK DEPLOYMENT
+
explain exactly why

```

instead of guessing.

Examples:

```text
ambiguous application entrypoint
unknown database engine
unsupported serverless adapter
unsupported worker topology
multiple unresolved runnable applications
missing required build evidence
unsupported framework mode

```

A deterministic expected blocker is considered GREEN.

A guessed deployment that fails later is RED.

---

# BUILD AN ADVERSARIAL GOLDEN FIXTURE MATRIX

Use existing fixtures where appropriate and add missing ones.

Do not make all fixtures trivial.

Required categories should include the supported equivalents of:

### JavaScript

```text
Express JS
Express TS
Fastify JS
Fastify TS
NestJS
React/Vite
Vue/Vite
Next SSR
Next standalone
Next static
Nuxt SSR/static
SvelteKit Node/static
Astro static/Node
frontend + backend
frontend + backend + database
Prisma PostgreSQL without direct pg dependency
monorepo/workspace
shared package dependency
nested app directory
custom valid entrypoint
same ENV name in multiple components

```

### Python

```text
Flask
Flask factory
nested Flask app
FastAPI
nested FastAPI package
Django WSGI
Django ASGI
Django + PostgreSQL
Django migration case
Streamlit
requirements.txt case
pyproject case
supported Poetry/uv cases if claimed

```

### Negative / blocker fixtures

```text
ambiguous framework
ambiguous DB engine
unsupported adapter
unsupported worker
multiple unresolved apps
missing required evidence
invalid package manager evidence
unsupported topology

```

---

# EVERY GOLDEN FIXTURE MUST VERIFY THE WHOLE PIPELINE

Do not only test the detector.

For supported fixtures verify:

```text
fixture repository
↓
repository evidence
↓
component discovery
↓
framework detection
↓
topology
↓
environment evidence
↓
database evidence
↓
deployment requirements
↓
deployment contract
↓
BuildPlan
↓
configuration materialization
↓
Railpack plan or proven fallback-template selection
↓
DeployGuard ↔ Railpack pre-flight correlation where Railpack is used
↓
actual OCI/Docker image build
↓
container startup
↓
RuntimeSpec
↓
smoke/health verification

```

Where the full runtime agent cannot reasonably be executed in CI, validate the RuntimeSpec exhaustively and execute the closest real Docker runtime path available.

---

# CROSS-STAGE INVARIANT TESTS

Create explicit invariant tests.

For every supported fixture compare values across stages.

Examples:

```text
detected component root
==
BuildPlan component root
==
Docker app root

```

```text
detected build context
==
Docker build context

```

```text
detected runtime port
==
BuildPlan runtime port
==
Docker EXPOSE/listen expectation
==
RuntimeSpec port

```

```text
canonical databaseName
==
materialized DB_NAME/DATABASE_NAME semantic value
==
RuntimeSpec databaseName

```

```text
canonical databaseUser
==
materialized DB username alias values
==
RuntimeSpec databaseUser

```

```text
platform-owned frontend API build variable
==
materialized build variable
==
actual Docker build argument

```

If any invariant diverges, the test must fail.

---

# SPECIAL ATTENTION: FIELD-NAMING DRIFT

Search the active codebase for synonymous fields representing the same concept.

Examples:

```text
user
username

dbName
databaseName
name

db
database

host
hostname
internalHost

root
appRoot
projectRoot
repositoryRoot

context
buildContext

```

Do not blindly rename them.

Determine whether they represent:

- genuinely different concepts, or
- accidental semantic duplication.

Where they are accidental duplicates, canonicalize the data model and update all consumers safely.

Add regression tests.

---

# DO NOT CREATE ANOTHER MASSIVE REWRITE

Prefer minimal, well-contained fixes.

Good:

```text
centralize database identity
preserve workspace build context
propagate platform build-time ENV
fix component-scoped ENV deduplication
strengthen schema validation
parse proven ORM evidence

```

Bad:

```text
rewrite the entire backend
replace every service
invent a completely new deployment architecture

```

---

# EXISTING TESTS

Run all relevant existing verification scripts.

Inspect what they actually assert.

A test file existing does not mean the behavior is adequately tested.

Strengthen weak tests where necessary.

After modifications run:

1. targeted tests,
2. detection tests,
3. deployment-contract tests,
4. Docker/template tests,
5. runtime tests,
6. integration/smoke tests,
7. complete backend verification/test suite.

---

# TEST EXECUTION MUST BE REAL

If dependencies are missing, install them according to the repository's lockfile.

If a test requires Docker and Docker is available, run it.

If Docker is unavailable in the execution environment, clearly distinguish:

```text
CODE VERIFIED

```

from:

```text
ACTUAL DOCKER EXECUTION NOT POSSIBLE IN THIS ENVIRONMENT

```

Do NOT claim 100% runtime confidence without executing required runtime tests.

---

# ACCEPTANCE CRITERIA

The task is complete only when:

### 1. All declared supported fixture classes are GREEN.

GREEN means:

```text
correct detection
+
correct correlation
+
correct generated deployment artifacts
+
successful Docker build
+
successful startup/smoke test where executable

```

### 2. All intentionally unsupported/ambiguous fixtures produce deterministic expected blockers.

### 3. No supported fixture depends on silent fallback guesses.

### 4. Cross-stage invariants pass.

### 5. Database identity remains identical across relevant stages.

### 6. ENV ownership/phase/component information remains identical across relevant stages.

### 7. Workspace/monorepo build contexts work.

### 8. Frontend→backend build-time variables actually reach frontend builds.

### 9. ORM database providers are correctly correlated where declared supported.

### 10. Railpack plans are generated and correlated for the normal automatic build path.

### 11. Railpack cannot silently override contradictory DeployGuard canonical facts.

### 12. Every production fallback Docker template is covered by executable build/start regression tests.

### 13. DeployGuard stack/repository detection cannot be accidentally disabled on the normal automatic path.

### 14. Railpack version is pinned and recorded/tested as part of build provenance.

### 15. Held-out and mutation tests produce zero confidently wrong deployments.

### 16. The complete relevant test suite passes.

---

# DEFINITION OF “100% GREEN”

“100% GREEN” means:

> 100% of the fixed Tier-1 supported repository shapes/framework modes covered by the regression contract pass the complete deployment path, including DeployGuard repository intelligence, Railpack correlation where used, real image build, and runtime startup verification.

It does NOT mean DeployGuard magically supports every possible JavaScript/Python repository.

Anything outside the supported matrix must be safely blocked rather than guessed.

---

# FINAL RESPONSE FORMAT

Do NOT give me an essay.

Do NOT give numerical quality scores.

After all work is complete, return only:

## RESULT

```text
SUPPORTED FIXTURES: X/X PASS
EXPECTED BLOCKER FIXTURES: X/X PASS
DEPLOYGUARD DETECTION TESTS: X/X PASS
RAILPACK PLAN/CORRELATION TESTS: X/X PASS
FALLBACK TEMPLATE TESTS: X/X PASS
CROSS-STAGE INVARIANTS: X/X PASS
IMAGE BUILD TESTS: X/X PASS
RUNTIME SMOKE TESTS: X/X PASS
HELD-OUT / MUTATION TESTS: X/X PASS
CONFIDENTLY WRONG DEPLOYMENTS: 0
FULL TEST SUITE: PASS/FAIL

```

## CONFIRMED FIXES

For each actual fixed defect:

```text
Problem:
Root cause:
Files changed:
Regression test:
Result:

```

## SUPPORTED MATRIX

```text
Framework/repository shape    PASS
...

```

## EXPECTED BLOCKERS

```text
Unsupported shape             BLOCKS CORRECTLY
...

```

## REMAINING UNVERIFIED ITEMS

Only list something here if environmental limitations genuinely prevented execution.

Do NOT call an unexecuted test PASS.

If there are none:

```text
NONE

```

## FINAL VERDICT

Only write:

```text
DEPLOYGUARD SUPPORTED MATRIX IS 100% GREEN

```

if every acceptance criterion above has actually passed.

Otherwise write:

```text
NOT YET GREEN

```

followed by the exact remaining failing test(s).

---

# MOST IMPORTANT INSTRUCTION

Do not come back after merely identifying problems.

You own the complete loop:

```text
inspect
→ reproduce
→ regression test
→ fix
→ run
→ discover next failure
→ fix
→ rerun
→ continue

```

until the declared supported matrix is genuinely green.

**No speculation. No arbitrary scoring. No architectural praise. No hidden failures. No test weakening. No silent guessing. No shrinking the Tier-1 target to make tests pass. No using Railpack to hide incorrect DeployGuard detection. Prove the complete deployment path with executable tests.**