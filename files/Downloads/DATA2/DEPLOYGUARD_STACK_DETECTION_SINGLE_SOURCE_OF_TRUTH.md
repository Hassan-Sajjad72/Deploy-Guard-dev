# DEPLOYGUARD STACK DETECTION — SINGLE SOURCE OF TRUTH

## Status

This file is the **only source of truth** for the remaining DeployGuard stack-detection work.

It replaces and supersedes:

- `STACK_DETECTION_PRODUCTION_GRADE_PROMPT.md`
- `CODEX_EXECUTION_AND_VERIFICATION_PROTOCOL.md`

Do not maintain duplicate requirements in separate files.

This file defines:

1. what must be implemented;
2. how Codex must execute the work;
3. how each gate is verified;
4. how repairs are controlled;
5. how completion is certified;
6. when the final UI certification may run.

---

# 1. Product objective

DeployGuard must provide production-grade, evidence-based stack detection for supported JavaScript/TypeScript and Python web applications.

The system must:

- inspect repositories safely without executing untrusted code;
- classify supported and unsupported workloads accurately;
- derive one versioned deployment contract;
- preserve exact commit identity;
- select the correct application root and build context;
- infer safe build/runtime commands;
- manage platform-owned values such as `PORT`;
- automatically select the DeployGuard-managed PostgreSQL path when supported;
- propagate detection evidence consistently to pre-flight, templates, workflows, ECS, readiness, and UI;
- preserve the last-known-good contract during transient external failures;
- reject ambiguous or structurally unsafe repositories with precise messages;
- never fabricate evidence, commands, ports, metrics, database support, or runtime compatibility.

---

# 2. Acceptance repositories

These repositories are fixed acceptance cases.

## 2.1 React/Webpack static application

Repository:

```text
Hassan-Sajjad72/react-pomodoro
```

Expected result:

- ecosystem: Node.js
- language: JavaScript
- framework: React
- workload type: static web application
- package manager: npm
- install command: evidence-based
- build command: evidence-based
- output directory: `app`
- production strategy: generated static/Nginx template
- container port: 80
- health path: `/`
- missing Node version pin: advisory only
- deployability: allowed unless another genuine blocker exists

The detector must derive `app` from Webpack evidence, not assume `build` or `dist`.

---

## 2.2 Nested Flask application

Repository:

```text
Hassan-Sajjad72/flask-hello-world
```

Expected result:

- ecosystem: Python
- framework: Flask
- framework variant: Flask WSGI
- repository/build context: repository root
- dependency manifest root: repository root
- application source root: `src`
- entry file: `src/server.py`
- entry module: `server`
- Flask object: `server`
- production target: `server:server`
- expected port: 5000
- health path: `/`
- safe repository-proven or DeployGuard-generated production-server strategy
- no false blocker saying the Python target could not be inferred

The solution must be generalized and must not hardcode this repository or `server:server`.

---

## 2.3 Python desktop application

Repository:

```text
Hassan-Sajjad72/INFORMATION-SECURITY-PROJECT
```

Expected result:

- Python source recognized, including `.pyw`
- workload type: desktop GUI
- framework/evidence: Tkinter where present
- not misreported as unknown language
- not accepted as an HTTP web application
- blocked with a precise unsupported-workload message

Correct example:

```text
Python desktop application detected.
This repository uses Tkinter and does not expose a supported HTTP web service.
DeployGuard currently deploys supported JavaScript/TypeScript and Python web applications.
```

---

## 2.4 Managed PostgreSQL and platform-owned variables

Repository:

```text
Hassan-Sajjad72/smart-retail-pro
```

Expected result:

- PostgreSQL requirement detected
- database strategy: DeployGuard-managed
- provisioning timing: after authorized Deploy operation
- no normal-user database endpoint or credential input required
- `PORT` ownership: DeployGuard
- user-pasted `PORT` not persisted as a user variable
- no missing-PORT warning
- readiness: Ready unless another independent blocker exists
- Deploy remains enabled when no independent blocker exists

Correct readiness example:

```text
PostgreSQL required

DeployGuard will provision and securely connect a managed PostgreSQL database when deployment starts.
No database credentials are required from you.

Runtime networking and PORT are managed automatically by DeployGuard.
```

---

# 3. Supported scope

Production-grade coverage must include:

## JavaScript and TypeScript

- Vite React
- Create React App
- older Webpack React projects
- custom Webpack output paths
- Next.js SSR
- Next.js static export
- Express
- NestJS
- Fastify
- JavaScript and TypeScript entrypoints
- root and nested entrypoints
- npm
- yarn
- pnpm
- supported Bun behavior
- package-manager declaration and lockfile consistency
- development-command rejection
- output-directory inference
- Node-version evidence and advisories

## Python

- Flask
- FastAPI
- Django
- Streamlit
- nested application roots
- nonstandard application object names
- application factories when safely representable
- `.py` and `.pyw`
- desktop GUI classification
- CLI classification
- library classification
- requirements.txt
- pyproject.toml
- Poetry
- Pipenv
- explicit support/blocking for uv and PDM
- safe production-server strategy
- Python-version evidence

## Repository layouts

- ordinary single applications
- nested `src`, `app`, `server`, `api`, `frontend`, `backend`, `web`
- monorepositories with one clear winner
- monorepositories with genuine ambiguity
- explicit application-directory override
- repository Dockerfiles
- generated templates

---

# 4. Non-negotiable Codex operating rules

Codex must follow all rules below.

1. Execute one gate only.
2. Never choose its own next task.
3. Never use a bare `Continue` workflow.
4. Reproduce the named defect before modifying production code.
5. Trace the complete producer-to-consumer path before choosing files.
6. Add or update a regression test that fails for the correct reason before the fix.
7. Modify only directly required files.
8. Do not begin the next gate automatically.
9. Do not provide completion percentages.
10. Do not claim project-wide production readiness during an implementation gate.
11. Do not treat code existence as behavioral proof.
12. Do not treat passing compilation as end-to-end proof.
13. Distinguish isolated test evidence from real local-path evidence.
14. Do not weaken safety rules merely to make an acceptance repository pass.
15. Do not create another planning, tracker, audit, or report file.
16. Update only this file’s Progress Ledger.
17. Preserve unrelated working behavior.
18. Do not deploy, dispatch GitHub Actions, mutate AWS, apply Terraform, or create cloud resources during detection/readiness verification.
19. Use local services, database, terminal, repository, configured credentials, and existing test infrastructure directly.
20. Report a manual prerequisite only when Codex proves it cannot perform the action.
21. Separate implementation from independent verification.
22. Use a fresh Codex context for independent audit.
23. Use targeted repair prompts for verified gaps.
24. Stop after the selected gate.

---

# 5. Evidence classifications

Every acceptance condition must be classified as exactly one of:

## VERIFIED THROUGH REAL LOCAL PATH

Verified through the real local API, persisted state, generated contract, current-state projection, or real UI using the active backend.

## VERIFIED THROUGH ISOLATED TEST ONLY

A focused test passed, but the integrated path was not exercised.

## IMPLEMENTED BUT NOT VERIFIED

Code changed, but adequate proof is missing.

## DELIBERATELY UNSUPPORTED BY POLICY

Intentionally unsupported with a precise product reason and actionable message.

## BLOCKED BY A PROVEN EXTERNAL DEPENDENCY

Cannot be verified because of a genuine external dependency Codex cannot satisfy.

## NOT COMPLETED

The requirement remains unmet.

A gate cannot be marked `VERIFIED` while a required condition is `IMPLEMENTED BUT NOT VERIFIED` or `NOT COMPLETED`.

---

# 6. Required engineering loop

For every implementation gate:

```text
Inspect current state
→ reproduce defect
→ trace producer-to-consumer path
→ add failing regression
→ implement smallest coherent fix
→ prove regression passes
→ run affected regression/build
→ verify real local path
→ inspect diff
→ update ledger
→ stop
```

For high-risk stateful work:

```text
Validate exact scope and evidence
→ acquire ownership/lock
→ execute once
→ verify state and external results
→ persist truthful evidence
→ release ownership
→ stop
```

---

# 7. Gate progression

Codex must work through these gates in order.

---

## Gate 1 — Versioned detection contract and safe repository scanning

### Status

`NOT STARTED`

### Goal

Create one explicit, versioned, evidence-based detection contract and harden repository scanning.

### Required contract fields

The contract must distinguish:

- repositoryRoot
- scanRoot
- buildContext
- dependencyManifestRoot
- applicationRoot
- runtimeWorkingDirectory
- ecosystem
- language
- workloadType
- framework
- frameworkVariant
- packageManager
- runtimeVersion
- installCommand
- buildCommand
- outputDirectory
- entryFile
- entryModule
- applicationObject
- applicationFactory
- productionTarget
- productionServer
- productionCommand
- expectedPort
- portSource
- bindHost
- healthCheckPath
- healthPathSource
- staticOutput
- Dockerfile path
- Docker strategy
- required environment-variable names
- optional environment-variable names
- platform-owned variable names
- database requirement
- database engine
- database strategy
- persistent-storage requirement
- blockers
- warnings/advisories
- confidence
- evidence sources
- detectorVersion
- contractSchemaVersion
- templateVersion

Do not expose invented defaults as proven facts.

Use `null` or an explicit platform default with a source when evidence is unavailable.

### Safe repository inspection

Detection must never:

- execute repository code;
- import application modules;
- run package scripts;
- run Python files;
- evaluate JavaScript/TypeScript configuration;
- execute Dockerfile commands.

Implement:

- canonical real-path containment;
- symlink handling;
- no following symlinks outside workspace;
- maximum depth;
- maximum directory-entry count;
- maximum source-file count;
- maximum individual file size;
- maximum total inspected bytes;
- bounded scan duration or cancellation;
- ignored generated/vendor directories;
- safe permission-error handling;
- malformed-file handling;
- broken-symlink handling;
- sanitized errors;
- cleanup that cannot override a successful result.

### Clone and remote-resolution hardening

- canonical GitHub HTTPS URLs only;
- verify repository identity against authorized project identity;
- never send installation token to another host;
- never log token or authorization header;
- classify branch missing;
- classify repository missing/access denied;
- classify timeout;
- classify oversized repository;
- classify transient GitHub/network failure;
- preserve exact cloned commit SHA;
- prevent deployment of a different commit;
- keep submodules disabled unless deliberately supported.

### Acceptance conditions

- [ ] typed/versioned contract exists
- [ ] detector/schema/template versions are persisted
- [ ] versions participate in cache invalidation
- [ ] no untrusted repository code is executed
- [ ] path containment is enforced
- [ ] external symlink escape is blocked
- [ ] scan limits are enforced
- [ ] errors are sanitized
- [ ] cleanup failure cannot replace a successful result
- [ ] exact commit is preserved

### Evidence

- Before evidence:
- Changed files:
- Test commands:
- Test results:
- Local verification:
- Remaining defects:
- Unverified conditions:

### Gate decision

`NOT STARTED`

---

## Gate 2 — Application-root and monorepository resolution

### Status

`NOT STARTED`

### Goal

Replace filename-only selection with evidence-based root and context resolution.

### Candidate evidence

Use:

- dependency manifests;
- workspaces;
- package scripts;
- framework dependencies;
- source entrypoints;
- Dockerfile `COPY`;
- Dockerfile `WORKDIR`;
- Dockerfile `CMD`;
- Dockerfile `ENTRYPOINT`;
- Procfile;
- framework configuration;
- build configuration;
- output configuration;
- source-directory conventions;
- explicit application-directory override;
- explicit deployment overrides.

Do not assume:

```text
repository root = build context = dependency root = application root
```

When multiple applications remain equally plausible, block with sanitized candidate evidence.

Do not pick alphabetically.

Do not duplicate preferred and detected paths.

### Acceptance conditions

- [ ] root application resolves correctly
- [ ] nested application resolves correctly
- [ ] build context and application root can differ
- [ ] explicit application directory is authoritative
- [ ] clear monorepository winner resolves
- [ ] ambiguous monorepository blocks
- [ ] Dockerfile evidence contributes to ranking
- [ ] duplicated path construction is prevented

### Evidence

- Before evidence:
- Changed files:
- Test commands:
- Test results:
- Local verification:
- Remaining defects:
- Unverified conditions:

### Gate decision

`NOT STARTED`

---

## Gate 3 — JavaScript and TypeScript detection

### Status

`NOT STARTED`

### Goal

Make supported Node/React detection evidence-based and production-safe.

### Requirements

Support:

- Vite React
- CRA
- older Webpack React
- custom Webpack output
- Next SSR
- Next static
- Express
- NestJS
- Fastify
- nested JS/TS entrypoints
- npm/yarn/pnpm
- package.json `packageManager`
- lockfile consistency
- Node version evidence

Prevent:

- React dependency alone forcing static classification
- dev commands as production commands
- missing Node version pin becoming a structural blocker
- output directory fallback before actual config evidence
- output path escaping build context
- Fastify inaccessible host
- server applications not consuming platform `PORT`

### Acceptance repository

`Hassan-Sajjad72/react-pomodoro`

Expected:

- React static
- build output `app`
- port 80
- `/` health path advisory
- missing Node version pin advisory only

### Acceptance conditions

- [ ] Webpack custom output is detected
- [ ] Vite output is detected
- [ ] CRA output is detected
- [ ] Next SSR and static are distinguished
- [ ] Express/Nest/Fastify production commands are safe
- [ ] dev commands are blocked
- [ ] lockfile conflicts are detected
- [ ] Node version pin absence is advisory
- [ ] react-pomodoro produces output directory `app`

### Evidence

- Before evidence:
- Changed files:
- Test commands:
- Test results:
- Local verification:
- Remaining defects:
- Unverified conditions:

### Gate decision

`NOT STARTED`

---

## Gate 4 — Python detection and workload classification

### Status

`NOT STARTED`

### Goal

Generalize Python detection and classify web, desktop, CLI, library, worker, and unsupported workloads accurately.

### Static analysis

Use safe parsing or deterministic static analysis.

Never import or execute repository code.

Recognize:

- `.py`
- `.pyw`

### Workload types

- web server/API
- worker
- CLI
- library
- desktop GUI
- unsupported
- ambiguous

### Flask

- detect `Flask(...)` assignments regardless of variable name;
- derive `<module>:<object>`;
- support nested modules;
- support package modules;
- support application factories only when safely representable;
- detect multiple Flask objects;
- block genuine ambiguity;
- do not hardcode repository names or targets.

### FastAPI

- detect `FastAPI(...)` regardless of object name;
- support nested modules;
- support safe factory patterns;
- block genuine ambiguity.

### Django

- locate correct settings;
- locate correct WSGI/ASGI module;
- support nested project packages;
- avoid arbitrary first-directory selection;
- preserve DEBUG, ALLOWED_HOSTS, SECRET_KEY safety checks.

### Streamlit

- require real Streamlit application evidence;
- use correct health path;
- use platform-managed port and safe host.

### Desktop/CLI/library

- recognize Tkinter;
- recognize `.pyw`;
- classify desktop GUI precisely;
- reject as non-web;
- do not report as unknown language.

### Packaging

- requirements.txt
- pyproject.toml
- Poetry
- Pipenv
- explicit uv/PDM policy
- Python version evidence

### Production-server strategy

Accept:

- repository-declared supported production server;
- validated custom Dockerfile;
- DeployGuard-generated pinned production server.

Do not require repository Gunicorn in every generated-template case.

Never accept Flask/Django development server as production.

Commands must bind to:

```text
0.0.0.0
platform-provided PORT
```

### Acceptance repositories

- `Hassan-Sajjad72/flask-hello-world`
- `Hassan-Sajjad72/INFORMATION-SECURITY-PROJECT`

### Acceptance conditions

- [ ] `app.py` with `app:app`
- [ ] `server.py` with `server:server`
- [ ] nested `src/server.py`
- [ ] nonstandard Flask object
- [ ] Flask application factory
- [ ] ambiguous Flask objects block
- [ ] FastAPI nested target
- [ ] nonstandard FastAPI object
- [ ] Django nested project
- [ ] Streamlit
- [ ] `.pyw` recognized
- [ ] Tkinter classified as desktop GUI
- [ ] CLI not accepted as web
- [ ] library not accepted as web
- [ ] generated production command uses `0.0.0.0` and platform `PORT`

### Evidence

- Before evidence:
- Changed files:
- Test commands:
- Test results:
- Local verification:
- Remaining defects:
- Unverified conditions:

### Gate decision

`NOT STARTED`

---

## Gate 5 — Dockerfile and generated-template validation

### Status

`NOT STARTED`

### Goal

Ensure Dockerfile presence never automatically means success and all templates consume the final detection contract.

### Dockerfile validation

Inspect without executing:

- exact Dockerfile path
- build context
- stages
- WORKDIR
- COPY/ADD sources
- CMD
- ENTRYPOINT
- EXPOSE as advisory evidence
- runtime process
- dev server commands
- localhost binding
- command/port contradiction
- target-stage evidence when supported

Handle shell-form and exec-form conservatively.

### Custom Dockerfile acceptance

Allow only when:

- workload is supported HTTP application;
- Dockerfile belongs to selected context;
- runtime process exists;
- port/bind behavior is compatible or explicitly overridden;
- no independent deployability blocker remains.

### Generated templates

Must consume:

- build context;
- application root;
- install command;
- build command;
- output directory;
- production command;
- expected port;
- health path;
- template strategy.

Generated templates must not invent:

- `app.py`
- `main.py`
- `build`
- `dist`
- port
- application root

### Acceptance conditions

- [ ] safe custom Dockerfile accepted
- [ ] no-runtime-command Dockerfile blocked
- [ ] dev-server Dockerfile blocked
- [ ] localhost-only Dockerfile blocked
- [ ] port contradiction blocked
- [ ] Dockerfile outside selected context rejected
- [ ] generated React static template uses detected output
- [ ] generated Flask/FastAPI/Django template uses detected target
- [ ] template matching occurs after deployability evaluation

### Evidence

- Before evidence:
- Changed files:
- Test commands:
- Test results:
- Local verification:
- Remaining defects:
- Unverified conditions:

### Gate decision

`NOT STARTED`

---

## Gate 6 — Platform-owned variables and managed PostgreSQL

### Status

`NOT STARTED`

### Goal

Make DeployGuard authoritative for runtime networking and supported managed PostgreSQL.

### Normal user input

The normal user provides only:

- GitHub authorization
- repository
- branch
- optional user-owned application variables
- Deploy

The normal user must not provide:

- PORT
- HOST
- NODE_ENV
- PYTHONUNBUFFERED
- AWS credentials
- GitHub tokens
- Terraform values
- container-port mapping
- managed database host
- managed database port
- managed database username
- managed database password
- managed database URL

### Reserved-variable policy

Backend is authoritative.

At minimum reserve:

- `PORT`
- `HOST`
- `NODE_ENV`
- `PYTHONUNBUFFERED`
- `AWS_*`
- `GITHUB_*`
- `DEPLOYGUARD_*`

For pasted input:

```text
PORT=5000
API_URL=https://example.test
```

Expected:

- `API_URL` accepted according to policy;
- `PORT` not stored as a user variable;
- `PORT` excluded from accepted count;
- `PORT` excluded from missing-variable warnings;
- `PORT` appears only as platform-managed evidence;
- no deployment blocker merely because user pasted `PORT`;
- user value never overrides platform runtime port.

### Port model

Separate:

- application default port;
- platform runtime `PORT`;
- container port;
- ALB target port;
- evidence source.

Generated server commands must bind to:

```text
0.0.0.0
platform-provided PORT
```

The mere absence of a user-provided `PORT` is not a warning or blocker.

### Database detection responsibility

Detection determines:

- databaseRequired;
- databaseEngine;
- consumed database variable names;
- supported/unsupported engine;
- localhost/service-alias evidence;
- confidence;
- evidence sources.

For supported PostgreSQL:

```text
databaseRequired: true
databaseEngine: postgres
databaseStrategy: deployguard_managed
databaseProvisioning: on_deploy
databaseBindingRequired: true
databaseUserConfigurationRequired: false
```

Detection/readiness must not provision cloud resources.

Provisioning begins only after authorized Deploy.

### Managed database binding

The deployment path must:

1. detect PostgreSQL;
2. select managed strategy automatically;
3. create or reuse project database idempotently;
4. create isolated project credentials;
5. persist credentials only through encrypted secret boundary;
6. inject only variables actually consumed;
7. never return secret values;
8. pass binding to ECS task definition;
9. verify binding before Live;
10. reuse binding for retry/redeploy;
11. avoid duplicate database/users;
12. follow current destroy retention policy;
13. record sanitized audit evidence.

Supported mapping may include:

- DATABASE_URL
- DATABASE_HOST
- DATABASE_PORT
- DATABASE_NAME
- DATABASE_USER
- DATABASE_PASSWORD
- DB_HOST
- DB_PORT
- DB_NAME
- DB_USER
- DB_PASSWORD
- PGHOST
- PGPORT
- PGDATABASE
- PGUSER
- PGPASSWORD

Do not inject every alias blindly.

If variable convention is not safely inferable:

- use a safe framework canonical binding when proven;
- otherwise produce one precise structural blocker;
- do not ask normal user for raw credentials.

If managed PostgreSQL is not genuinely implemented, do not fake Ready. Implement the direct path within authorized scope or report the exact proven blocker.

### Readiness behavior

Supported PostgreSQL should be Ready.

Block only when:

- engine unsupported;
- incompatible engines required;
- evidence unsafe or irreconcilably ambiguous;
- managed database implementation unavailable or misconfigured;
- secure mapping cannot be established;
- custom runtime prevents safe injection.

Do not display an external-endpoint requirement when no such user workflow exists.

### Acceptance repository

`Hassan-Sajjad72/smart-retail-pro`

### Acceptance conditions

- [ ] PostgreSQL + DATABASE_URL selects managed strategy
- [ ] PostgreSQL + DB_* maps correctly
- [ ] PostgreSQL + PG* maps correctly
- [ ] localhost DB configuration is safely replaced where supported
- [ ] MongoDB-only repository blocks precisely
- [ ] PostgreSQL/MySQL conflict blocks
- [ ] existing binding is reused
- [ ] repeated Deploy creates one effective provisioning operation
- [ ] detection/readiness makes no AWS mutation
- [ ] pasted PORT is rejected/ignored before persistence
- [ ] HOST/NODE_ENV/PYTHONUNBUFFERED follow reserved policy
- [ ] Node app consuming process.env.PORT is deployable
- [ ] Python app consuming os.getenv("PORT") is deployable
- [ ] generated Python command uses `0.0.0.0` and platform `PORT`
- [ ] custom incompatible port remains blocked
- [ ] readiness shows managed PostgreSQL informational state
- [ ] Deploy remains enabled
- [ ] secrets never appear in responses/logs/hashes/frontend state

### Evidence

- Before evidence:
- Changed files:
- Test commands:
- Test results:
- Local verification:
- Remaining defects:
- Unverified conditions:

### Gate decision

`NOT STARTED`

---

## Gate 7 — Detection orchestration, persistence, and concurrency

### Status

`NOT STARTED`

### Goal

Make detection safe across callers, instances, transient failures, and configuration changes.

### Requirements

Fix:

- authorization before joining in-flight detection;
- project-only single-flight bypass;
- cross-process duplicate detection;
- configuration ownership/locking;
- exact commit binding;
- changed branch-head handling;
- trusted-field spread ordering;
- detector/schema/template cache invalidation;
- sanitized persisted errors;
- last-known-good profile preservation;
- latest failed attempt separation where required;
- no contract overwrite after transient clone/token/GitHub failure;
- cleanup failure isolation;
- truthful audit events;
- no TEMPLATE_SELECTED event when none selected.

### Acceptance conditions

- [ ] unauthorized caller denied during another caller’s in-flight detection
- [ ] same-process duplicate detection coalesces safely
- [ ] simulated cross-instance duplicate detection is controlled
- [ ] transient remote check preserves successful profile
- [ ] clone failure preserves successful contract
- [ ] detector-version change invalidates cache
- [ ] configuration change during detection prevents stale save
- [ ] branch-head change cannot deploy stale evidence
- [ ] cleanup failure does not replace success
- [ ] raw errors cannot leak token/path/secret
- [ ] actual template selection is audited truthfully

### Evidence

- Before evidence:
- Changed files:
- Test commands:
- Test results:
- Local verification:
- Remaining defects:
- Unverified conditions:

### Gate decision

`NOT STARTED`

---

## Gate 8 — End-to-end contract propagation

### Status

`NOT STARTED`

### Goal

Verify every direct consumer uses the same corrected detection contract.

### Required chain

```text
repository and exact commit
→ clone/workspace
→ stack/workload detection
→ deployability
→ persisted profile
→ deployment contract
→ pre-flight/readiness
→ Docker/template renderer
→ GitHub Actions inputs
→ image/runtime contract
→ ECS task definition
→ current-state/developer-details projection
```

The same values must propagate:

- commit SHA
- build context
- application root
- install command
- build command
- output directory
- production command
- port
- health path
- database strategy
- template strategy

No downstream component may silently restore obsolete assumptions.

### Frontend scope

Only minimal direct rendering changes are allowed:

- workload type;
- application root;
- production target;
- warnings;
- blockers;
- platform-managed variables;
- managed PostgreSQL readiness.

Frontend must not redetect repository behavior.

No page redesign or new route.

### Acceptance conditions

- [ ] persisted profile matches detection result
- [ ] deployment contract matches profile
- [ ] pre-flight uses contract
- [ ] template renderer uses contract
- [ ] workflow inputs use contract
- [ ] runtime contract uses same port/command/root
- [ ] current-state/developer-details render canonical evidence
- [ ] frontend does not independently infer
- [ ] no obsolete fallback remains

### Evidence

- Before evidence:
- Changed files:
- Test commands:
- Test results:
- Local verification:
- Remaining defects:
- Unverified conditions:

### Gate decision

`NOT STARTED`

---

## Gate 9 — Independent stack-detection certification

### Status

`NOT STARTED`

### Goal

Read-only certification of Gates 1–8.

No code modification.

### Required repository matrix

- react-pomodoro
- flask-hello-world
- INFORMATION-SECURITY-PROJECT
- smart-retail-pro

### Required report for each repository

- exact commit
- application root
- build context
- workload type
- language/framework
- production target
- template/Docker strategy
- port ownership
- health path
- database strategy
- blockers
- advisories
- final readiness decision
- evidence level

### Additional certification checks

- cache invalidation
- last-known-good preservation
- unauthorized/concurrent behavior
- reserved-variable handling
- secret/path redaction
- no detection/readiness cloud mutation
- no obsolete downstream fallback

### Final decision

`CERTIFIED` or `NOT CERTIFIED`

No percentage.

### Evidence

- Certification commands:
- Results:
- Failed conditions:
- Unproven conditions:
- Repair scope:

### Gate decision

`NOT STARTED`

---

## Gate 10 — Final UI simplification certification

### Status

`NOT STARTED`

### Goal

Run the existing final UI simplification certification only after Gate 9 is `CERTIFIED`.

This gate remains read-only unless a separate targeted UI repair is authorized.

Do not run while backend detection/readiness contracts are still changing.

### Prerequisites

- [ ] Gates 1–8 verified
- [ ] Gate 9 certified
- [ ] no backend contract repair pending
- [ ] readiness/blocker/warning behavior stable

### Gate decision

`NOT STARTED`

---

# 8. Required regression matrix

## Repository safety

- root application
- nested application
- explicit application directory
- clear monorepository winner
- ambiguous monorepository
- path traversal attempt
- symlink outside workspace
- broken symlink
- oversized file
- excessive file count/depth
- malformed manifest
- empty repository

## JavaScript/TypeScript

- Vite React with dist
- CRA with build
- Webpack React with custom `app`
- Next SSR
- Next static export
- Express JavaScript
- Express TypeScript/nested source
- NestJS
- Fastify safe host
- Fastify unsafe/default host
- npm with package-lock
- yarn
- pnpm
- conflicting lockfiles
- development-only start command
- React dependency inside server application

## Python

- Flask app.py with app:app
- Flask server.py with server:server
- nested src/server.py
- nonstandard Flask object
- Flask application factory
- ambiguous Flask objects
- Flask development-server-only
- generated production-server strategy
- repository-declared production server
- FastAPI main:app
- nested FastAPI target
- nonstandard FastAPI object
- Django nested project
- Streamlit
- `.pyw` Tkinter desktop application
- Python CLI
- Python library
- requirements.txt
- pyproject.toml
- Poetry
- Pipenv
- supported and unsupported lock-manager cases

## Docker

- safe custom Dockerfile
- no runtime command
- development-server Dockerfile
- port contradiction
- localhost-only command
- Dockerfile outside selected context
- generated static template
- generated Node server template
- generated Flask/FastAPI/Django template

## Orchestration

- unauthorized caller during in-flight detection
- same-process concurrency
- cross-instance concurrency
- transient remote-check failure with successful profile
- clone failure with successful contract
- detector-version cache invalidation
- configuration change during detection
- branch head changes after clone
- cleanup failure after successful save
- raw error redaction

## Platform ownership and database

- PORT pasted by user
- HOST pasted by user
- NODE_ENV pasted by user
- PYTHONUNBUFFERED pasted by user
- PostgreSQL + DATABASE_URL
- PostgreSQL + DB_*
- PostgreSQL + PG*
- localhost database configuration
- MongoDB unsupported
- conflicting engines
- existing managed binding reuse
- repeated Deploy idempotency
- no cloud mutation during readiness
- secret non-disclosure

---

# 9. File-scope control

Before implementation, Codex must list expected production files.

After implementation, compare expected and actual changes.

Every unexpected file must be:

- proven directly required; or
- reverted.

Do not leave:

- generated builds;
- temporary repositories;
- screenshots;
- logs;
- database dumps;
- credentials;
- `.env` values;
- coverage output;
- unrelated formatting;
- unexplained lockfile churn.

---

# 10. Test-quality rules

A valid test verifies behavior, not implementation shape.

Prefer:

- repository fixture → final detection contract;
- pasted variables → persisted accepted/rejected values;
- managed DB requirement → readiness decision;
- profile → contract → renderer input;
- unauthorized caller → denied during in-flight call;
- transient failure → successful contract preserved.

Avoid relying only on:

- private-method tests;
- broad snapshots;
- mocks that bypass the broken consumer;
- string-presence assertions;
- tests created after implementation that never demonstrated pre-fix failure;
- compile-only evidence.

---

# 11. Required gate result format

Every implementation or repair result must use:

```markdown
## Gate result

### Before evidence

Exact failing test, API response, state, or generated contract.

### Producer-to-consumer path

Exact path traced before implementation.

### Expected file scope

- `path` — reason

### Changed files

- `path` — direct reason

### Regression-first evidence

- Command:
- Expected pre-fix failure:
- Actual pre-fix failure:
- Post-fix result:

### Affected regression and build

- Command:
- Result:

### Real local verification

- Request/action:
- Response/state:
- Persisted/downstream evidence:

### Acceptance classification

| Condition | Classification | Evidence |
|---|---|---|

### Remaining defects

Only defects still relevant to this gate.

### External/operator blocker

Exact action only when Codex cannot perform it.

### Gate decision

VERIFIED | REPAIR REQUIRED | BLOCKED
```

No percentage.

---

# 12. Gate closure rule

A gate may be marked `VERIFIED` only when:

1. every acceptance condition is classified;
2. no required condition is `IMPLEMENTED BUT NOT VERIFIED`;
3. no required condition is `NOT COMPLETED`;
4. deliberate unsupported cases are intentional and precisely messaged;
5. external blockers are genuine and documented;
6. required tests pass;
7. required build/type-check passes;
8. real local evidence exists where required;
9. no unrelated file changes remain;
10. an independent read-only audit approves the gate.

If audit fails, mark `REPAIR REQUIRED`.

---

# 13. Implementation launch prompt

Use one gate at a time.

```text
Read DEPLOYGUARD_STACK_DETECTION_SINGLE_SOURCE_OF_TRUTH.md completely.

Execute only Gate <NUMBER> — <NAME>.

Follow every operating rule, scope boundary, acceptance condition, evidence
classification, and reporting requirement in the file.

Before modifying production code:

1. inspect the current implementation, tests, callers, consumers, persisted
   entities, API projections, generated contracts, and current diff;
2. reproduce every named failing scenario in this gate;
3. trace the complete producer-to-consumer path;
4. list the smallest expected production-file scope;
5. add or update a regression test that fails for the correct reason;
6. record exact before evidence.

Then implement only the smallest coherent correction required by this gate.

After implementation:

1. prove the same regression now passes;
2. run the affected regression suite and production build/type-check;
3. verify the real non-mutating local API/UI/contract path where available;
4. inspect the final diff and revert unrelated changes;
5. classify every acceptance condition using the file’s evidence states;
6. update only this gate’s Progress Ledger evidence/status in the same file;
7. report exact changed files, commands, results, real local evidence, remaining
   defects, unverified conditions, and any genuine external blocker;
8. stop.

Do not begin another gate.
Do not provide a completion percentage.
Do not create another planning, audit, tracker, or report file.
Do not deploy, dispatch GitHub Actions, mutate AWS, or apply Terraform.
```

---

# 14. Independent audit prompt

Run in a fresh Codex context.

```text
Read DEPLOYGUARD_STACK_DETECTION_SINGLE_SOURCE_OF_TRUTH.md completely.

Audit only Gate <NUMBER> — <NAME>.

This is a read-only verification pass.

Do not modify code, tests, migrations, documentation, plans, fixtures, database
records, workflows, or infrastructure.

Inspect:

- the gate requirements;
- the exact diff;
- every changed production file;
- every direct consumer;
- tests and fixtures;
- build results;
- persisted/API/contract evidence;
- acceptance repository behavior;
- mocked, stale, or bypassed paths.

Do not accept implementation existence, compilation, or newly written tests as
sufficient proof.

Classify every acceptance condition as:

- VERIFIED THROUGH REAL LOCAL PATH;
- VERIFIED THROUGH ISOLATED TEST ONLY;
- IMPLEMENTED BUT NOT VERIFIED;
- DELIBERATELY UNSUPPORTED BY POLICY;
- BLOCKED BY A PROVEN EXTERNAL DEPENDENCY;
- NOT COMPLETED.

Return only:

1. verified conditions;
2. isolated-only conditions;
3. failed or unproven conditions;
4. regressions;
5. unexpected or out-of-scope changes;
6. inaccurate completion claims;
7. the smallest exact repair scope;
8. whether this gate may be marked VERIFIED.

Do not provide a percentage.
Do not suggest broad refactoring.
Stop after the audit.
```

---

# 15. Targeted repair prompt

Use only after independent audit finds concrete gaps.

```text
Read DEPLOYGUARD_STACK_DETECTION_SINGLE_SOURCE_OF_TRUTH.md completely.

Repair only the failed and unproven conditions from the latest independent audit
of Gate <NUMBER> — <NAME>.

Verified defects:

1. <DEFECT>
2. <DEFECT>
3. <DEFECT>

Do not revisit or rewrite behavior already verified by the audit.

Before changing production code:

1. reproduce each defect;
2. trace its exact producer-to-consumer break;
3. add or correct regression coverage that fails for the correct reason;
4. list the smallest expected file scope.

Then implement the smallest repair, run the affected tests/build and real local
verification, inspect the diff, update only the existing Gate <NUMBER> evidence,
classify all repaired conditions, report remaining unverified items, and stop.

Do not broaden scope.
Do not continue to another gate.
Do not provide a completion percentage.
Do not create another report or planning file.
```

---

# 16. Final stack-detection certification prompt

Run only after Gates 1–8 are independently verified.

```text
Read DEPLOYGUARD_STACK_DETECTION_SINGLE_SOURCE_OF_TRUTH.md completely.

Perform Gate 9 — Independent stack-detection certification.

This is read-only.

Do not modify code, tests, migrations, documentation, plans, fixtures, database
records, GitHub repositories, workflows, AWS resources, or infrastructure.

Verify the complete non-mutating chain:

repository and exact commit
→ safe clone/workspace
→ application-root selection
→ stack/workload detection
→ deployability decision
→ persisted profile
→ deployment contract
→ pre-flight/readiness
→ template/workflow contract
→ current-state/developer-details projection

Run the required regression matrix and production build.

Verify:

- Hassan-Sajjad72/react-pomodoro
- Hassan-Sajjad72/flask-hello-world
- Hassan-Sajjad72/INFORMATION-SECURITY-PROJECT
- Hassan-Sajjad72/smart-retail-pro

For each, report:

- exact commit;
- application root;
- build context;
- workload type;
- language/framework;
- production target;
- Docker/template strategy;
- port ownership;
- health path;
- database strategy;
- blockers;
- advisories;
- readiness decision;
- evidence level.

Also verify:

- cache invalidation;
- last-known-good preservation;
- concurrent and unauthorized behavior;
- reserved-variable handling;
- secret/path redaction;
- no detection/readiness cloud mutation;
- no obsolete downstream fallback.

Return:

1. certified conditions;
2. isolated-only conditions;
3. failed conditions;
4. unproven conditions;
5. deliberate unsupported policy;
6. genuine external blockers;
7. exact repair scope if certification fails;
8. final decision: CERTIFIED or NOT CERTIFIED.

Do not provide a percentage.
Stop after certification.
```

---

# 17. Operator workflow

Use this exact sequence:

```text
1. Select one gate.
2. Run the implementation launch prompt.
3. Review changed files and evidence.
4. Open a fresh Codex context.
5. Run the independent audit prompt.
6. If gaps exist, run one targeted repair prompt.
7. Re-run the independent audit.
8. Mark the gate VERIFIED only after audit approval.
9. Move to the next gate.
10. Run Gate 9 final stack-detection certification.
11. Run Gate 10 final UI simplification certification.
```

Never use a bare `Continue`.

---

# 18. Stop conditions

Codex must stop when:

- selected gate is verified;
- selected gate is blocked by a proven external dependency;
- another production subsystem is required but not authorized;
- behavior conflicts with current product policy;
- acceptance repository lacks claimed evidence;
- a destructive migration/action needs a separate decision;
- implementation would weaken a genuine safety control.

Report the smallest next decision. Do not improvise a broader task.

---

# 19. Core completion principle

Codex is the implementer.

This file, its gate acceptance conditions, regression-first evidence, real local-path verification, and independent certification are the judge.

A requirement is not complete because Codex says it is complete.

It is complete only when the required evidence proves it.
