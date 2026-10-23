You are working on the **DeployGuard backend**.

This is a **FINAL RELIABILITY/HARDENING PASS**, not an architecture brainstorming session.

Your job is to make the existing DeployGuard repository-analysis and deployment pipeline **provably reliable for its declared Python and JavaScript/TypeScript support matrix**.

Do not give ratings such as 7/10, 8/10, etc.

Do not merely review code.

Do not stop after finding defects.

**Find → reproduce → fix → test → re-test until the supported matrix is 100% green.**



**MANDATORY PRESERVATION RULE**

Every requirement in the original hardening prompt remains mandatory.

The additional AWS/detection-defect requirements below are additive only. They do not replace, narrow, weaken, reinterpret, or remove any original framework matrix, repository-analysis requirement, ENV/database requirement, Docker/runtime proof requirement, fixture requirement, cross-stage invariant, blocker rule, acceptance criterion, or test discipline.

If an added requirement overlaps an original requirement, satisfy both. The stricter proof requirement wins.


**MANDATORY DETECTION BASELINE — PRESERVE THE EXISTING EVIDENCE-BASED MODEL**

DeployGuard's existing repository detection is already designed to be evidence-based.

Do NOT redesign it as a new heuristic detector.
Do NOT replace existing canonical repository evidence with confidence scoring, directory-name guessing, generic framework defaults, or a second detection system.

The required repair model is:

```text
existing repository evidence
↓
existing evidence-based detection
↓
canonical normalization
↓
DeploymentContract
↓
BuildPlan
↓
Docker build/runtime configuration
↓
AWS consumers
```

The primary defect class to search for is NOT "the detector guesses everything."

The primary defect class is:

```text
correct evidence-derived fact
↓
fact is remapped, reconstructed, renamed, defaulted, or partially dropped downstream
↓
DeploymentContract / BuildPlan / Docker / AWS consumes a different meaning
```

Therefore:

1. Preserve existing evidence sources and detector architecture where they are already correct.
2. For every critical detected fact, trace the exact evidence that produced it.
3. Normalize that fact once into the canonical model.
4. Pass that same canonical value downstream without rediscovery.
5. Add invariant tests proving the value remains identical across every consuming stage.
6. Only remove guessing where a concrete fallback/heuristic is actually reproduced as a defect.
7. Do not label evidence-based root/application detection itself defective unless a real repository fixture reproduces an incorrect decision.
8. Do not convert a working evidence-based detector into an INPUT_REQUIRED flow merely because a theoretically ambiguous case can be imagined.
9. Preserve supported behavior that is already proven correct.
10. When evidence is genuinely insufficient, block deterministically rather than inventing a value.

For roots and workspace semantics specifically, the requirement is preservation, not redesign:

```text
repositoryRoot
appRoot
workspaceRoot
installRoot
buildContext
```

must remain distinct canonical values when repository evidence proves them.

Example:

```text
repositoryRoot = .
appRoot = apps/web
workspaceRoot = .
installRoot = .
buildContext = .
```

If detection proves those values, downstream stages must consume those exact meanings.

Do not collapse them to:

```text
appRoot = apps/web
installRoot = apps/web
buildContext = apps/web
```

unless repository evidence independently proves that is correct.

The same preservation rule applies to:

```text
framework + variant
package manager
runtime/runtime version
install command
build command
release command
run command
output/runtime files
port
bind behavior
health endpoint
ENV ownership/phase/component/exposure
database identity
service dependency role
topology relationships
Docker image identity
```

Specific reproduced fallback defects such as Angular alphabetical project selection or static-directory-name dependence must be fixed locally without weakening the broader evidence-based detector.


**PRIMARY OBJECTIVE**

Given a real Git repository, DeployGuard must correctly determine everything required to build and deploy it:

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
 runtime deployment
     ↓
 Container starts and becomes reachable
 
 

Correct stack detection alone is NOT sufficient.

A repository is considered supported only when the information remains correct through **every stage** and the generated image can actually build and start.

**NON-NEGOTIABLE RULE**

Every important repository fact must have **one canonical meaning** across the pipeline.

Examples:

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
 
 

Do not allow stage N and stage N+1 to independently recreate the same information using different naming or assumptions.

The rule is:

*DETECT ONCE → NORMALIZE ONCE → CONSUME DOWNSTREAM.*

**IMPORTANT PRODUCT CONTEXT**

Focus on repository intelligence, Docker generation, configuration correlation and runtime deployment.

**AWS-ONLY SCOPE FOR THIS RUN**

Apply this hardening pass only to the AWS product path.

Ignore VPS/self-hosted-specific runtime logic, Docker Swarm, Traefik, Railpack, and self-hosted OCI-handoff behavior unless shared repository-detection code directly affects the AWS path.

AWS infrastructure is not the redesign target. Its role here is to prove that canonical detection facts are consumed downstream without being re-detected or changed.


**FIRST: UNDERSTAND THE EXISTING PIPELINE**

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
10. Find runtime-agent deployment.
11. Find all verification/test scripts.
12. Run the existing relevant test suite.

Do not redesign components merely because another design looks cleaner.

Preserve the existing architecture unless a concrete reliability bug requires a change.

**ZERO SPECULATIVE BUG REPORTING**

Classify findings internally as:

CONFIRMED FAILURE
 REPRODUCED with code/test/evidence.
 
 EXPECTED BLOCK
 Repository is intentionally unsupported or ambiguous and DeployGuard safely refuses deployment.
 
 PASS
 Behavior is proven correct.
 
 UNVERIFIED
 Cannot currently prove it.
 
 

Do not call something broken solely because it looks suspicious.

For every bug:

1. reproduce it,
2. create/regress a test,
3. fix it,
4. run the test,
5. run surrounding tests,
6. continue.

**DO NOT CHEAT THE TEST SUITE**

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

**JAVASCRIPT / TYPESCRIPT MATRIX**

Deeply verify all frameworks that the current code claims to support.

At minimum inspect support for:

**Backend**

Express JavaScript
 Express TypeScript
 Fastify JavaScript
 Fastify TypeScript
 NestJS
 
 

**Frontend**

React
 Vite React
 Vite Vue
 Angular

**REPRODUCED DEFECT — ANGULAR MULTI-PROJECT SELECTION**

The current AWS detector contains a fallback equivalent to:

`angular.defaultProject || Object.keys(angular.projects || {}).sort()[0]`

in both framework resolution and output-directory resolution.

This can select an Angular application alphabetically when multiple projects exist and no authoritative default/build target proves the intended application.

Required behavior:

one proven Angular application → use it

authoritative default/build target → use it

multiple unresolved Angular applications → INPUT_REQUIRED / EXPECTED BLOCK

Add a regression fixture where alphabetical order differs from the intended application. Never use first/alphabetical project selection as canonical evidence.

 Create React App where currently supported
 Webpack-based React where currently supported
 
 

**Full-stack / SSR / SSG**

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
 
 

For every framework verify more than dependency presence.

Correlate:

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
 
 

**PYTHON MATRIX**

Deeply verify current support for:

Flask
 Flask application factory
 FastAPI
 Django WSGI
 Django ASGI
 Streamlit
 
 

Also verify supported dependency/install styles such as those currently implemented:

requirements.txt
 pyproject.toml
 Poetry if claimed supported
 uv if claimed supported
 other currently declared Python package-manager paths
 
 

Do NOT rely only on filenames such as:

main.py
 app.py
 server.py
 
 

if the current support contract expects nested Python applications to work.

Correlate:

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
 
 

Use safe static analysis only.

Never execute arbitrary repository code merely to detect its framework.

**REPOSITORY STRUCTURE / TOPOLOGY**

Correctly distinguish:

single backend
 single frontend
 SSR application
 static frontend
 backend serving frontend
 decoupled frontend + backend
 bounded monorepo/workspace
 multiple independently deployable applications
 unsupported/ambiguous repository
 
 

Do not treat these as interchangeable:

repositoryRoot
 appRoot
 buildContext
 installRoot
 workspaceRoot
 
 

They must remain separate throughout the pipeline.

**REPRODUCED DEFECT — INSTALL ROOT / BUILD CONTEXT DRIFT**

The AWS detector can correctly derive a workspace repository install root such as `.` while a component root is `apps/web`, but component topology currently stores `buildContext` from the component root and downstream component BuildPlan conversion can recreate `repositoryInstallRoot` from that build context.

This violates the canonical distinction above.

Required invariant:

detected repositoryInstallRoot
==
DeploymentContract repositoryInstallRoot
==
component BuildPlan repositoryInstallRoot
==
Docker install root

Do not reconstruct repositoryInstallRoot from appRoot or buildContext downstream.

Add a real monorepo/workspace regression fixture with a root lockfile and shared package dependency that fails if installation moves from repository root to the component directory.

**REPRODUCED DEFECT — PLAIN STATIC ROOT NAME DEPENDENCY**

The current plain-static discovery path requires `index.html` + asset evidence but also restricts accepted directory basenames to names such as `frontend`, `client`, `web`, `site`, or `public`.

A valid plain static application under `ui`, `portal`, `dashboard`, `website`, `www`, or another arbitrary repository-relative directory must not be missed solely because of its directory name.

Directory names may be weak evidence only. Static application identity must come from application/artifact evidence.

Add adversarial fixtures that rename an otherwise identical static application directory while preserving all application evidence. Detection outcome must remain semantically identical.


Example:

repository root = .
 app root = apps/web
 install root = .
 Docker build context = .
 
 

must remain possible.

This is essential for:

npm workspaces
 pnpm workspaces
 yarn workspaces
 shared packages
 root lockfiles
 root tsconfig
 monorepo configs
 
 

**PACKAGE MANAGER CORRELATION**

Verify package manager using repository evidence.

Correlate:

packageManager field
 lockfiles
 workspace config
 scripts
 existing package-manager configuration
 
 

Avoid incorrect fallback behavior when evidence clearly identifies:

npm
 pnpm
 yarn
 
 

Install/build/runtime commands must use the same resolved package manager.

**ENVIRONMENT VARIABLE ANALYSIS**

ENV analysis is CRITICAL.

Detect ENV requirements from all existing supported evidence sources, including where applicable:

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
 
 

Each ENV binding must preserve:

name
 component
 owner
 phase
 exposure
 required/optional
 default if safely inferable
 provenance
 
 

At minimum distinguish:

user-owned
 platform-owned
 repository-default
 
 

and:

build-time
 runtime
 
 

and:

public
 secret/private
 
 

**COMPONENT-SCOPED ENV IDENTITY**

Do not globally merge variables merely because their names match.

The semantic identity should account for at least:

componentId
 variable name
 phase
 
 

Example:

frontend.API\_URL
 backend.API\_URL
 
 

must not accidentally become one binding unless the repository explicitly proves they should share a value.

**FRONTEND → BACKEND CORRELATION**

This must work end-to-end.

Example repository:

frontend = Vite
 backend = Express
 frontend calls backend through /api
 frontend uses VITE\_API\_URL
 
 

If detection concludes:

VITE\_API\_URL
 owner = platform
 phase = build
 component = frontend
 
 

then that value MUST actually reach:

DeploymentContract
 ↓
 BuildPlan
 ↓
 configuration materialization
 ↓
 Docker build arguments/config
 ↓
 frontend build
 
 

Never produce this failure:

detector correctly sees VITE\_API\_URL
 ↓
 system decides user doesn't need to provide it
 ↓
 Docker build never receives it
 
 

Test this explicitly.

Also verify equivalents currently supported such as:

NEXT\_PUBLIC\_\*
 REACT\_APP\_\*
 VITE\_\*
 
 

when relevant.

**DATABASE DETECTION**

Database detection must use all strong evidence currently available.

Verify at minimum:

PostgreSQL
 MySQL/MariaDB
 MongoDB
 
 

where currently supported.

**REPRODUCED DEFECT — REDIS SERVICE CLASSIFICATION**

The current AWS deployability scanner includes `redis`, `ioredis`, and `REDIS_URL` in database-evidence/engine logic and can add an `unsupported` database engine beside a proven PostgreSQL/MySQL/MongoDB engine.

That is a semantic classification defect.

Redis must not be treated as a competing primary database engine.

At minimum distinguish:

database
cache
queue/broker
object storage
external service
email

For example:

PostgreSQL + Redis

must not become:

PostgreSQL + unsupported database
→ DATABASE_ENGINE_AMBIGUOUS

If customer Redis is outside the current AWS support contract, return a specific unsupported service/dependency/topology blocker. Do not silently add Redis support and do not misclassify it as a primary database.


Do not depend solely on direct drivers.

Inspect ORM-native configuration where relevant:

Prisma datasource provider
 TypeORM datasource type
 Sequelize dialect
 SQLAlchemy database URL/provider
 Mongoose configuration
 Django DATABASES where safely detectable
 
 

Example:

datasource db {
   provider = "postgresql"
 }
 
 

must count as strong PostgreSQL evidence even if pg is not directly listed as an application dependency.

**DATABASE ENV ALIASES**

Verify semantic normalization for aliases such as:

DB\_USER
 DATABASE\_USER
 POSTGRES\_USER
 PGUSER
 
 

→ canonical:

username
 
 

Similarly verify:

DB\_HOST
 DATABASE\_HOST
 POSTGRES\_HOST
 PGHOST
 
 

→ host

DB\_NAME
 DATABASE\_NAME
 POSTGRES\_DB
 PGDATABASE
 
 

→ database

and equivalent supported aliases for password/port/URL.

Alias resolution must remain identical across all stages.

**DATABASE IDENTITY — ONE SOURCE OF TRUTH**

Audit every place that creates or consumes:

database engine
 serviceName
 internal hostname
 databaseName
 databaseUser
 password secret
 volume identity
 network identity
 
 

Ensure these values are derived once and consumed downstream.

There must never be:

requirements thinks hostname = X
 runtime creates hostname = Y
 
 

or:

contract thinks DB name = X
 configuration materializer injects DB name = Y
 
 

or:

db.user
 database.user
 database.username
 
 

representing inconsistent meanings at different stages.

Add tests that assert exact equality across stages.

**MIGRATIONS / RELEASE COMMANDS**

Where framework/ORM evidence proves migrations or release operations are needed, ensure they survive into the final deployment plan.

Examples where currently supported:

Django migrate
 Prisma migrate
 other existing migration support
 
 

Do not infer dangerous migration commands without evidence.

But if detection proves a migration command is required, do not lose it before runtime.

**DOCKER GENERATION**

For every supported fixture, verify generated Docker configuration against the actual repository.

Check:

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
 
 

Never generate a Dockerfile merely because the framework name matches a template.

The Dockerfile must be compatible with the exact repository evidence.

**ACTUAL DOCKER BUILD IS REQUIRED**

Static Dockerfile validation is NOT sufficient.

For supported fixtures, actually run:

docker build ...
 
 

or the project's actual build path.

A supported fixture is NOT green if Docker image creation fails.

**ACTUAL CONTAINER STARTUP IS REQUIRED**

After successful image build, start it.

Verify:

container remains running
 expected command starts
 expected port listens
 required ENV is present
 health endpoint responds when defined
 application responds when health endpoint does not exist but another safe verification path is defined
 
 

Use bounded timeouts.

Do not treat:

docker build succeeded
 
 

as deployment success.

**DATABASE-BACKED SMOKE TESTS**

For supported database-backed fixtures:

1. start required test database,
2. use the same canonical database identity/config mechanism expected in deployment,
3. start application container,
4. run required migrations/release action when applicable,
5. verify application/database connectivity,
6. perform health/readiness verification.

Do not fake database success using mocks for these integration fixtures.

**RUNTIME SPEC CORRELATION**

Verify every relevant BuildPlan/DeploymentContract value reaching RuntimeSpec.

Assert:

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
 
 

Do not allow RuntimeSpec to rediscover repository facts.

RuntimeSpec must consume canonical deployment information.

**PERSISTENCE / JSON VALIDATION**

Anything serialized to PostgreSQL/JSON and later consumed should be runtime validated.

Inspect:

CanonicalTopology
 DeploymentContract
 BuildPlan
 RuntimeSpec
 
 

or equivalent persisted structures.

If runtime schemas already exist, test them.

If coarse object checks allow structurally invalid/stale records to pass, strengthen validation using the project's existing validation approach or a suitable schema mechanism.

The goal is to prevent stale forms such as:

db.user
 
 

from silently reaching code expecting:

database.username
 
 

A schema mismatch should fail early with an explicit error.

**WORKERS / ADDITIONAL PROCESSES**

Inspect support for worker/background-process evidence.

Examples:

Celery
 RQ
 Dramatiq
 BullMQ
 queue workers
 Procfile workers
 custom worker scripts

**REPRODUCED DEFECT — WORKER DETECTION COVERAGE**

The current bounded topology check proves a required worker essentially through a root-level `package.json` `scripts.worker` entry. That is too narrow for the worker-safety requirement in this section.

Add safe static evidence detection for credible required worker/background-process forms including the supported equivalents of:

Celery
RQ
Dramatiq
Bull/BullMQ
Procfile worker entries
queue consumers
scheduled/cron processes
nested workspace worker packages
custom worker commands/scripts

The objective is not to add AWS worker deployment support automatically.

If the AWS topology does not support the proven required process, block the repository explicitly as unsupported topology.

A repository must never become deployable merely because the web process was detected while a required worker was missed.

 
 

If the existing DeployGuard topology does NOT support these safely:

DO NOT silently deploy only the web process.

Instead classify the repository as explicitly unsupported/blocked with a clear reason.

Partial deployments count as failures.

**SAFE FAILURE IS A SUCCESSFUL PRODUCT BEHAVIOR**

DeployGuard does NOT need to support every repository in existence.

For uncertain repositories, the correct behavior is:

BLOCK DEPLOYMENT
 +
 explain exactly why
 
 

instead of guessing.

Examples:

ambiguous application entrypoint
 unknown database engine
 unsupported serverless adapter
 unsupported worker topology
 multiple unresolved runnable applications
 missing required build evidence
 unsupported framework mode
 
 

A deterministic expected blocker is considered GREEN.

A guessed deployment that fails later is RED.

**BUILD AN ADVERSARIAL GOLDEN FIXTURE MATRIX**

Use existing fixtures where appropriate and add missing ones.

Do not make all fixtures trivial.

Required categories should include the supported equivalents of:

**JavaScript**

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
 
 

**Python**

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
 
 

**Negative / blocker fixtures**

ambiguous framework
 ambiguous DB engine
 unsupported adapter
 unsupported worker
 multiple unresolved apps
 missing required evidence
 invalid package manager evidence
 unsupported topology

Also add regression/adversarial fixtures specifically for the reproduced defects:

Angular multi-project repository with no authoritative default
plain static application under arbitrary/renamed directory
workspace appRoot != repositoryInstallRoot
PostgreSQL + Redis service classification
required worker without a root-level scripts.worker entry

 
 

**EVERY GOLDEN FIXTURE MUST VERIFY THE WHOLE PIPELINE**

Do not only test the detector.

For supported fixtures verify:

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
 Docker generation
 ↓
 actual Docker build
 ↓
 container startup
 ↓
 RuntimeSpec
 ↓
 smoke/health verification
 
 

Where the full runtime agent cannot reasonably be executed in CI, validate the RuntimeSpec exhaustively and execute the closest real Docker runtime path available.

**CROSS-STAGE INVARIANT TESTS**

Create explicit invariant tests.

For every supported fixture compare values across stages.

Examples:

detected component root
 ==
 BuildPlan component root
 ==
 Docker app root
 
 

detected build context
 ==
 Docker build context
 
 

detected runtime port
 ==
 BuildPlan runtime port
 ==
 Docker EXPOSE/listen expectation
 ==
 RuntimeSpec port
 
 

canonical databaseName
 ==
 materialized DB\_NAME/DATABASE\_NAME semantic value
 ==
 RuntimeSpec databaseName
 
 

canonical databaseUser
 ==
 materialized DB username alias values
 ==
 RuntimeSpec databaseUser
 
 

platform-owned frontend API build variable
 ==
 materialized build variable
 ==
 actual Docker build argument
 
 

If any invariant diverges, the test must fail.

For the AWS path, extend the same invariant principle only to downstream consumers of detected facts:

detected runtime port
==
BuildPlan runtime port
==
Docker/container port
==
ECS task container port
==
ALB target-group port

detected health endpoint
==
BuildPlan health endpoint
==
container smoke-test endpoint
==
ALB target-group health endpoint

canonical environment ownership/phase/component
==
configuration materialization
==
Docker build/runtime configuration
==
ECS task-definition environment/secrets

canonical immutable image identity
==
ECR digest identity
==
ECS task-definition image identity

AWS stages must consume canonical facts. They must not rediscover repository facts independently.


**SPECIAL ATTENTION: FIELD-NAMING DRIFT**

Search the active codebase for synonymous fields representing the same concept.

Examples:

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
 
 

Do not blindly rename them.

Determine whether they represent:

- genuinely different concepts, or
- accidental semantic duplication.

Where they are accidental duplicates, canonicalize the data model and update all consumers safely.

Add regression tests.

**DO NOT CREATE ANOTHER MASSIVE REWRITE**

Prefer minimal, well-contained fixes.

Good:

centralize database identity
 preserve workspace build context
 propagate platform build-time ENV
 fix component-scoped ENV deduplication
 strengthen schema validation
 parse proven ORM evidence
 
 

Bad:

rewrite the entire backend
 replace every service
 invent a completely new deployment architecture
 
 

**EXISTING TESTS**

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

**TEST EXECUTION MUST BE REAL**

If dependencies are missing, install them according to the repository's lockfile.

If a test requires Docker and Docker is available, run it.

If Docker is unavailable in the execution environment, clearly distinguish:

CODE VERIFIED
 
 

from:

ACTUAL DOCKER EXECUTION NOT POSSIBLE IN THIS ENVIRONMENT
 
 

Do NOT claim 100% runtime confidence without executing required runtime tests.

**ACCEPTANCE CRITERIA**

The task is complete only when:

**1. All declared supported fixture classes are GREEN.**

GREEN means:

correct detection
 +
 correct correlation
 +
 correct generated deployment artifacts
 +
 successful Docker build
 +
 successful startup/smoke test where executable
 
 

**2. All intentionally unsupported/ambiguous fixtures produce deterministic expected blockers.**

**3. No supported fixture depends on silent fallback guesses.**

**4. Cross-stage invariants pass.**

**5. Database identity remains identical across relevant stages.**

**6. ENV ownership/phase/component information remains identical across relevant stages.**

**7. Workspace/monorepo build contexts work.**

**8. Frontend→backend build-time variables actually reach frontend builds.**

**9. ORM database providers are correctly correlated where declared supported.**

**10. The complete relevant test suite passes.**

**DEFINITION OF “100% GREEN”**

“100% GREEN” means:

*100% of the repository shapes/framework modes that DeployGuard explicitly claims to support are covered by executable regression fixtures and pass the complete supported deployment path.*

It does NOT mean DeployGuard magically supports every possible JavaScript/Python repository.

Anything outside the supported matrix must be safely blocked rather than guessed.

**FINAL RESPONSE FORMAT**

Do NOT give me an essay.

Do NOT give numerical quality scores.

After all work is complete, return only:

**RESULT**

SUPPORTED FIXTURES: X/X PASS
 EXPECTED BLOCKER FIXTURES: X/X PASS
 CROSS-STAGE INVARIANTS: X/X PASS
 DOCKER BUILD TESTS: X/X PASS
 RUNTIME SMOKE TESTS: X/X PASS
 FULL TEST SUITE: PASS/FAIL
 
 

**CONFIRMED FIXES**

For each actual fixed defect:

Problem:
 Root cause:
 Files changed:
 Regression test:
 Result:
 
 

**SUPPORTED MATRIX**

Framework/repository shape    PASS
 ...
 
 

**EXPECTED BLOCKERS**

Unsupported shape             BLOCKS CORRECTLY
 ...
 
 

**REMAINING UNVERIFIED ITEMS**

Only list something here if environmental limitations genuinely prevented execution.

Do NOT call an unexecuted test PASS.

If there are none:

NONE
 
 

**FINAL VERDICT**

Only write:

DEPLOYGUARD SUPPORTED MATRIX IS 100% GREEN
 
 

if every acceptance criterion above has actually passed.

Otherwise write:

NOT YET GREEN
 
 

followed by the exact remaining failing test(s).

**MOST IMPORTANT INSTRUCTION**

Do not come back after merely identifying problems.

You own the complete loop:

inspect
 → reproduce
 → regression test
 → fix
 → run
 → discover next failure
 → fix
 → rerun
 → continue
 
 

until the declared supported matrix is genuinely green.

**No speculation. No arbitrary scoring. No architectural praise. No hidden failures. No test weakening. No silent guessing. Prove the deployment path with executable tests.**