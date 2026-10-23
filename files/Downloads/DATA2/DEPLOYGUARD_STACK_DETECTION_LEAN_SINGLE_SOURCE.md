# DeployGuard Stack Detection — Lean Single Source of Truth

## Purpose

This is the only active plan for completing DeployGuard stack detection.

The target is production-grade support for the JavaScript/TypeScript and Python web frameworks DeployGuard already claims to deploy.

This is not a universal repository-analysis project.

Do not create another plan, tracker, or audit file.

---

# 1. Supported scope

## JavaScript and TypeScript

- React
- Vite
- Create React App
- Webpack React
- Next.js static
- Next.js SSR
- Express
- NestJS
- Fastify

## Python

- Flask
- FastAPI
- Django
- Streamlit

## Accurately unsupported

- Tkinter and other desktop GUI applications
- Python CLI-only applications
- Python libraries with no web entry point
- React Native/mobile applications
- repositories with no supported web application
- repositories with genuinely ambiguous application roots

Unsupported applications must be classified precisely, not merely reported as an unknown language.

---

# 2. Required detection contract

For a supported repository, one detection result must provide:

- exact commit SHA
- application directory
- build context
- ecosystem and language
- framework and framework variant
- workload type
- package manager
- runtime version or explicit platform default
- install command
- build command
- static output directory when applicable
- entry file and module
- application object or WSGI/ASGI target
- production start command
- application default port
- platform runtime-port behavior
- bind host
- health path
- Docker strategy
- required user-owned variables
- optional user-owned variables
- platform-owned variables
- warnings
- blockers
- confidence and evidence

The same values must flow through:

```text
Detection
→ saved profile
→ deployment contract
→ pre-flight/readiness
→ Dockerfile/template renderer
→ workflow/runtime inputs
```

No downstream component may silently restore assumptions such as:

```text
app.py
main.py
app:app
main:app
build/
dist/
user-provided PORT
```

---

# 3. Application-root selection

Support:

- repository-root applications
- nested `src/`
- nested `app/`
- nested `server/`
- nested `api/`
- nested `backend/`
- nested `frontend/`
- ordinary monorepositories with one clear web application
- explicit application-directory override

Use evidence from:

- dependency manifests
- framework dependencies
- package scripts
- source entrypoints
- Webpack, Vite, or Next configuration
- Dockerfile `WORKDIR`
- Dockerfile `COPY`
- Dockerfile `CMD`
- Dockerfile `ENTRYPOINT`

Repository root, build context, and application source root may be different.

When multiple roots remain equally plausible, block with a precise ambiguity message.

---

# 4. JavaScript and TypeScript requirements

## Static applications

For React, Vite, CRA, Webpack, and Next static:

- detect package manager
- detect install and build commands
- derive the actual output directory
- use a generated static-server strategy
- use a DeployGuard-controlled container port
- use `/` as a clearly labelled fallback when no dedicated health route exists

Output-directory priority:

1. explicit valid override
2. build/framework configuration
3. build-script evidence
4. framework convention

Do not assume every React project outputs to `build/` or `dist/`.

## Server applications

For Express, NestJS, Fastify, and Next SSR:

- detect the real JS/TS entrypoint
- reject development commands
- derive a safe production command
- require public binding
- consume the platform runtime port

Do not accept:

- `vite dev`
- `react-scripts start`
- `next dev`
- `nodemon`
- `ts-node-dev`
- NestJS watch mode

A missing Node version pin should normally be a warning, not a blocker.

---

# 5. Python web requirements

Use safe static inspection. Never import or execute repository code.

## Flask

Detect `Flask(...)` assignments regardless of variable name:

```python
app = Flask(__name__)
server = Flask(__name__)
application = Flask(__name__)
```

Derive:

```text
<module>:<object>
```

Examples:

```text
app.py + app → app:app
server.py + server → server:server
src/server.py + server → server:server
```

Support nested modules and safe application-factory cases.

Block when multiple targets remain genuinely ambiguous.

## FastAPI

Detect `FastAPI(...)` regardless of object name.

Support:

- `main:app`
- `app.main:app`
- nested source roots
- nonstandard object names

Generate or preserve a safe Uvicorn-compatible command.

## Django

Detect:

- `manage.py`
- actual project package
- settings module
- WSGI or ASGI target
- safe production command

Do not select the first directory arbitrarily.

## Streamlit

Require:

- Streamlit dependency
- real application entrypoint
- safe public command
- Streamlit health path

## Unsupported Python

Recognize `.py` and `.pyw`.

Classify Tkinter, desktop GUI, CLI-only, and library-only repositories precisely and block them as non-web workloads.

---

# 6. Production-server policy

A supported app is deployable when one of these is proven:

1. the repository declares a supported production server;
2. a validated custom Dockerfile starts a safe production process;
3. DeployGuard can generate a safe production template.

Supported Python strategies may include:

- Gunicorn
- Uvicorn
- Hypercorn
- Waitress
- framework-specific generated commands

Flask and Django development servers are not production strategies.

Generated server commands must bind to:

```text
0.0.0.0
platform-provided PORT
```

The repository does not need to declare Gunicorn when the selected DeployGuard template safely supplies a pinned production server.

---

# 7. Environment-variable policy

Environment handling is backend-authoritative.

## Categories

Each variable must be classified as:

- required user-owned
- optional user-owned
- platform-owned
- build-time
- runtime
- secret
- unused input

## Platform-owned

At minimum:

- `PORT`
- `HOST`
- `NODE_ENV`
- `PYTHONUNBUFFERED`
- `AWS_*`
- `GITHUB_*`
- `DEPLOYGUARD_*`

When a user pastes a platform-owned variable:

- ignore it before persistence
- do not count it as accepted
- do not show it as missing
- do not create a blocker
- never allow it to override the platform value
- optionally show a short informational message

## Required user-owned

A variable is required only when the selected application consumes it without a safe default.

Missing required variables may block deployment.

Show names only, never secret values.

## Optional user-owned

Optional variables have safe defaults or optional access patterns.

They may be saved when the selected application consumes them.

They must not block deployment when omitted.

## Unused pasted variables

When a pasted variable is not consumed by the selected application:

- ignore it
- do not persist it
- do not count it as accepted
- do not create a warning or blocker
- optionally list its name in a sanitized ignored summary

Example:

```text
PORT=5000
API_URL=https://example.test
UNUSED_VALUE=test
```

Expected:

- `PORT` ignored as platform-owned
- `API_URL` accepted only when the application consumes it
- `UNUSED_VALUE` ignored as unused
- no manual removal required

## Secret safety

Secret values must:

- use the existing encrypted storage boundary
- never appear in logs
- never appear in audit metadata
- never appear in API responses after saving
- never appear in fingerprints
- never appear in frontend state
- never be read from a committed real `.env`

Safe example files may provide variable names and safe non-secret defaults:

- `.env.example`
- `.env.sample`
- `sample.env`

## Build-time versus runtime

Keep build variables separate from runtime variables.

Examples:

- `VITE_*`
- `NEXT_PUBLIC_*`
- `REACT_APP_*`

may be public build-time variables.

Server secrets are runtime variables.

Do not inject all variables into both phases.

## Required enforcement points

Enforce this policy in:

- single-variable save
- bulk `.env` parsing
- bulk save
- detection requirements
- pre-flight
- deployment contract
- template/workflow input
- ECS runtime environment

Frontend validation may provide immediate feedback, but backend validation is mandatory.

---

# 8. Port behavior

Separate:

- application default port
- platform runtime `PORT`
- container port
- ALB target port
- static-server port

Users must not configure these through optional environment input.

A server app is deployable when:

- repository code consumes `PORT`; or
- the generated production command safely supplies `PORT`; or
- a validated Dockerfile safely handles the runtime port.

Block only when the app genuinely:

- binds only to localhost
- hardcodes an incompatible port with no safe strategy
- has contradictory Docker and application ports
- exposes no public web process

The absence of user-provided `PORT` is never a warning or blocker.

---

# 9. Dockerfile audit

Dockerfile presence must not automatically mean success.

## Custom Dockerfile

Inspect without executing:

- path and build context
- `FROM`
- stages
- `WORKDIR`
- `COPY` and `ADD`
- `CMD`
- `ENTRYPOINT`
- `EXPOSE`
- production process
- bind host
- port consistency
- development-server usage

Accept only when:

- Dockerfile belongs to the selected context
- it starts a supported web process
- it uses a production command
- it binds publicly
- port behavior is compatible with DeployGuard
- no independent blocker remains

`EXPOSE` is supporting evidence only.

## Generated Dockerfiles

Generated templates must use the final detection contract.

They must not independently assume:

- source directory
- entry file
- target
- output directory
- build command
- start command
- port

Required generated strategies:

- React/Vite/CRA/Webpack static
- Next static
- Next SSR
- Express
- NestJS
- Fastify
- Flask
- FastAPI
- Django
- Streamlit

When a repository Dockerfile is unsafe, use a generated template only when current product policy safely permits replacement. Otherwise block precisely.

---

# 10. Direct file scope

Inspect and modify only direct participants, such as:

- `stack-detection.service.ts`
- `repo-deployability-scanner.service.ts`
- `template-matching.service.ts`
- `repository-workspace.service.ts`
- `deployment-profile.service.ts`
- `deployment-contract.service.ts`
- detection profile/entity and fingerprint
- environment parser, validator, and persistence
- deployment requirements and pre-flight
- Docker/template renderer
- workflow contract renderer
- current readiness response
- focused tests and fixtures

Minimal frontend changes are allowed only when the existing readiness UI cannot truthfully show:

- framework/workload
- warnings
- blockers
- ignored variables
- platform-managed variables
- correct Deploy enabled/disabled state

Do not redesign pages or add routes.

Do not modify unrelated:

- authentication
- monitoring
- FinOps
- billing
- notifications
- Admin
- rollback
- general UI simplification
- AWS/Terraform architecture

Another production file may change only when Codex proves it directly consumes or executes this contract.

---

# 11. Three implementation iterations

## Iteration 1 — Detection accuracy

Fix:

- application-root selection
- React/Webpack output-directory detection
- Next static versus SSR
- Express/Nest/Fastify production commands
- Flask target detection
- FastAPI target detection
- Django project detection
- Streamlit entrypoint
- `.pyw`
- Tkinter/CLI/library classification
- precise warnings and blockers

Acceptance repositories:

### `Hassan-Sajjad72/react-pomodoro`

Expected:

- React static
- output `app`
- port 80
- `/` health fallback
- unpinned Node warning only

### `Hassan-Sajjad72/flask-hello-world`

Expected:

- Python Flask
- source root `src`
- target `server:server`
- safe production strategy
- port 5000
- `/` health fallback
- no false target blocker

### `Hassan-Sajjad72/INFORMATION-SECURITY-PROJECT`

Expected:

- Python recognized
- `.pyw` recognized
- Tkinter desktop GUI
- precise unsupported non-web blocker

Status: `NOT STARTED`

Evidence:

- Before:
- Changed files:
- Tests:
- Build:
- Local verification:
- Remaining defects:

---

## Iteration 2 — Environment and Dockerfile correctness

Fix:

- platform-owned variables
- ignored unused pasted variables
- required versus optional variables
- build-time versus runtime variables
- secret-safe persistence
- backend-authoritative enforcement
- runtime-port behavior
- custom Dockerfile validation
- generated Dockerfile correctness

Focused tests:

- pasted `PORT`, `HOST`, and `NODE_ENV` ignored
- consumed user variable accepted
- unused variable ignored
- required missing variable blocks
- optional missing variable does not block
- secret never returned or logged
- real `.env` values not ingested
- safe custom Dockerfile accepted
- development-server Dockerfile blocked
- localhost-only Dockerfile blocked
- port contradiction blocked
- generated React template uses detected output
- generated Python template uses detected target

Status: `NOT STARTED`

Evidence:

- Before:
- Changed files:
- Tests:
- Build:
- Local verification:
- Remaining defects:

---

## Iteration 3 — Contract propagation and certification

Verify:

```text
Detection
→ saved profile
→ deployment contract
→ pre-flight/readiness
→ Docker/template renderer
→ workflow/runtime inputs
```

Search for and correct obsolete fallbacks related to:

- `app.py`
- `main.py`
- `app:app`
- `main:app`
- `build`
- `dist`
- user-provided `PORT`
- frontend-only environment enforcement

Final verification repositories:

- react-pomodoro
- flask-hello-world
- INFORMATION-SECURITY-PROJECT

For each report:

- commit
- application directory
- framework/workload
- build command
- output directory
- production target/command
- port behavior
- Docker strategy
- required variables
- ignored variables
- blockers
- warnings
- readiness decision

Status: `NOT STARTED`

Evidence:

- Tests:
- Backend build:
- Frontend build if directly changed:
- Local readiness verification:
- Final decision:

---

# 12. Focused regression coverage

## JavaScript/TypeScript

- Vite React
- CRA
- Webpack custom output
- Next SSR
- Next static
- Express
- NestJS
- Fastify
- nested TypeScript server
- development command rejection
- lockfile conflict
- missing Node version warning

## Python

- Flask `app:app`
- Flask `server:server`
- nested Flask
- ambiguous Flask targets
- FastAPI `main:app`
- nested FastAPI
- Django nested project
- Streamlit
- Tkinter `.pyw`
- CLI-only
- library-only
- development-server rejection

## Environment

- platform-owned ignored
- unused input ignored
- required input
- optional input
- build-time/public input
- runtime secret
- secret non-disclosure
- real `.env` non-ingestion

## Docker

- safe custom Dockerfile
- generated static Dockerfile
- generated Python web Dockerfile
- dev server
- localhost binding
- contradictory port
- wrong build context
- no runtime command

Do not expand this into an exhaustive universal test matrix.

---

# 13. Codex working rules

For each iteration:

1. work on one iteration only;
2. reproduce the named failures;
3. trace direct producers and consumers;
4. add focused regression tests;
5. implement the smallest coherent fix;
6. run affected tests and build;
7. verify the real non-mutating local path when available;
8. update only this file’s iteration evidence/status;
9. report exact changed files and remaining defects;
10. stop.

Do not:

- provide completion percentages
- create another plan or audit file
- begin the next iteration automatically
- broaden into unsupported frameworks
- redesign the product
- mutate AWS
- dispatch workflows
- apply Terraform
- claim tests were run without actual results

---

# 14. Codex launch prompt

```text
Read DEPLOYGUARD_STACK_DETECTION_LEAN_SINGLE_SOURCE.md completely.

Execute only Iteration <NUMBER> — <NAME>.

Before changing production code:

1. reproduce the named failures;
2. trace the direct producer-to-consumer path;
3. identify the smallest required file scope;
4. add or update focused regression tests that fail for the correct reason.

Then implement only the smallest coherent correction required by this iteration.

After implementation:

1. prove the regressions pass;
2. run affected tests and production build/type-check;
3. verify the real non-mutating local API/readiness path when available;
4. inspect the diff and revert unrelated changes;
5. update only this iteration’s evidence and status in this file;
6. report exact changed files, commands, results, remaining defects, and genuine
   external blockers;
7. stop.

Do not begin another iteration.
Do not create another planning or audit file.
Do not provide a completion percentage.
Do not deploy or mutate AWS.
```

---

# 15. Completion definition

Complete when:

- supported JS/TS web frameworks are detected reliably
- supported Python web frameworks are detected reliably
- unsupported desktop/CLI/library workloads are classified accurately
- platform-owned and unused pasted variables are ignored automatically
- required, optional, build-time, runtime, and secret variables are handled correctly
- users never need to remove `PORT` manually
- custom Dockerfiles are validated rather than trusted automatically
- generated Dockerfiles use the real detection contract
- readiness and downstream inputs use the same contract
- focused regression coverage passes
- the three acceptance repositories produce expected decisions
- Iteration 3 returns `CERTIFIED`
