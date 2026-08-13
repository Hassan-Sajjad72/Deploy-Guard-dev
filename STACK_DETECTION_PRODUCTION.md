Goal

Perform one complete production-grade hardening iteration for DeployGuard stack
detection and its direct deployment-contract path.

This is an implementation task, not an audit-only task.

Inspect the current repository, reproduce the known detection failures, identify
all direct consumers of detection evidence, implement the smallest coherent
production-grade solution, verify it comprehensively, report exact evidence,
and stop.

Known real acceptance repositories

1. Hassan-Sajjad72/react-pomodoro

   Expected:
   - JavaScript
   - React static application
   - npm
   - production build command derived from repository evidence
   - Webpack output directory `app`
   - generated static/Nginx strategy
   - port 80
   - `/` health path with an advisory when no dedicated health endpoint exists
   - unpinned Node version is a warning, not a blocker

2. Hassan-Sajjad72/flask-hello-world

   Expected:
   - Python
   - Flask
   - repository/build context at repository root
   - dependency manifest at repository root
   - application source under `src`
   - entry module `server`
   - Flask object `server`
   - WSGI target `server:server`
   - expected port 5000
   - safe generated or repository-proven production server strategy
   - no false “safe Python web target could not be inferred” blocker

3. Hassan-Sajjad72/INFORMATION-SECURITY-PROJECT

   Expected:
   - Python source recognized, including `.pyw`
   - desktop GUI/Tkinter workload recognized
   - not misreported as an unknown programming language
   - blocked because it is not an HTTP web application
   - precise actionable unsupported-workload message

Scope boundary

Primary production files that may be modified:

- stack-detection.service.ts
- repo-deployability-scanner.service.ts
- template-matching.service.ts
- repository-workspace.service.ts
- deployment-profile.service.ts

Inspect and modify these only when required to propagate or enforce the corrected
contract:

- deployment-contract.service.ts
- deployment-contract entity/schema and a migration, if schema persistence is
  genuinely required
- project-detection-profile.entity.ts
- analysis-fingerprint.ts
- Docker-template generation or rendering services
- GitHub Actions workflow input/rendering and deployment-contract gate
- pre-flight/deployment-requirements services
- canonical current-state or developer-details projection
- minimal frontend Developer details/readiness rendering only when the existing
  UI cannot truthfully show the corrected backend evidence
- existing detection, pre-flight, contract, template and workflow test files
- narrowly scoped new fixture files

Do not modify unrelated:

- authentication flows, except the authorization defect inside detection joining
- general project lifecycle behavior
- AWS/Terraform infrastructure
- deployment retry, redeploy, destroy or rollback behavior
- visual design
- normal-user route structure
- monitoring, Admin, FinOps or unrelated modules
- final product or UI planning documents

Do not create a new planning or audit document.

If another production file must change, first prove that it directly consumes,
persists, renders or executes stack-detection evidence. Include that evidence in
the final report.

Engineering loop

Validate exact scope and evidence → acquire ownership/lock → execute once →
verify state and external results → persist truthful evidence → release
ownership and stop.

Part 1 — Define one explicit, versioned detection contract

Replace implicit assumptions scattered across rawProfile with a clear typed
contract or an equivalently strict persisted structure.

The contract must distinguish:

- repositoryRoot
- scanRoot
- buildContext
- dependencyManifestRoot
- applicationRoot
- runtimeWorkingDirectory, when proven
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
- applicationFactory, when applicable
- productionTarget
- productionServer
- productionCommand
- expectedPort
- portSource
- bindHost
- healthCheckPath
- healthPathSource
- staticOutput
- Dockerfile path and strategy
- required and optional environment-variable names
- database and persistent-storage requirements
- blockers
- warnings/advisories
- confidence
- evidence sources
- detectorVersion
- contractSchemaVersion
- templateVersion

Do not return invented defaults as proven facts.

Use null/unknown with an explanation when evidence is unavailable. A missing
value must not silently become port 8000, runtime type server, source-file count
zero, or another apparently verified value unless it is explicitly a selected
platform default.

Make detector, schema and template versions part of cache invalidation and the
contract fingerprint.

Part 2 — Safe untrusted-repository inspection

Treat every cloned repository as hostile input.

Detection must never execute repository code, import application modules, run
package scripts, run Python files, evaluate configuration files or execute
Dockerfile commands.

Implement bounded, deterministic scanning with:

- canonical real-path containment inside the temporary workspace
- no following symlinks outside the workspace
- explicit symlink handling and tests
- maximum directory depth
- maximum directory-entry count
- maximum source-file count
- maximum individual file size
- maximum total inspected bytes
- maximum scan duration or equivalent bounded cancellation
- ignored generated/vendor directories
- safe behavior for permission errors, malformed files and broken symlinks
- sanitized errors with no access token, authorization header, host path or
  sensitive content
- reliable cleanup that cannot replace an already-successful detection result

Harden repository cloning and remote resolution:

- accept only canonical GitHub HTTPS repository URLs
- verify that URL ownership/repository identity matches the project repository
  identity already authorized by the GitHub App
- do not send the installation token to any non-GitHub host
- do not log the token or authorization header
- classify branch missing, repository missing/access denied, timeout, oversized
  repository and transient GitHub/network failures separately
- preserve the exact cloned commit SHA
- do not deploy a different branch head than the commit that was detected
- enforce reasonable clone and repository-size limits
- keep submodules disabled unless explicitly supported and safely bounded

Part 3 — Application-root and monorepository resolution

Replace filename-only root selection with evidence-based candidate discovery.

Candidate evidence should include, where available:

- dependency manifests
- workspace definitions
- package scripts
- framework dependencies
- actual source entrypoints
- Dockerfile COPY, WORKDIR, CMD and ENTRYPOINT
- Procfile or equivalent process declaration
- framework configuration
- build configuration
- output configuration
- source-directory conventions
- explicit project appDirectory
- explicit deployment overrides

Do not treat repository root, build context, dependency root and runtime
application root as necessarily identical.

Support:

- ordinary single applications
- nested `src`, `app`, `server`, `api`, `frontend`, `backend` and `web` layouts
- monorepositories with one clearly dominant deployable application
- monorepositories with multiple equally plausible applications
- explicit user-selected application directory

When multiple applications remain genuinely plausible, block with an actionable
ambiguity result and list sanitized candidates. Do not pick the alphabetically
first candidate.

Do not combine `preferredAppDirectory` and detected relative directory into a
duplicated path.

Part 4 — JavaScript and TypeScript detection

Production-grade coverage must include:

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
- nested `src/server`, `src/index`, `src/main` and equivalent evidence
- npm, yarn, pnpm and supported Bun behavior
- package.json `packageManager`
- lockfile consistency
- Node version evidence from engines, `.nvmrc` and `.node-version`

Prevent false classifications:

- the presence of `react` must not automatically convert an Express/SSR/custom
  server into a static frontend
- development commands such as Vite dev server, react-scripts start, nodemon,
  ts-node-dev, Next dev or watch-mode Nest must not be accepted as production
  commands
- missing version pins should normally be advisories, not structural blockers
- output directories must be inferred from actual build/configuration evidence
  before using framework conventions
- inferred output paths must remain inside the selected build context

For react-pomodoro, verify from Webpack evidence that the output directory is
`app`, not `build` or `dist`.

Part 5 — Python detection

Use safe static source analysis. Prefer a proper parser or deterministic syntax
analysis over broad regex matching, but never execute imported repository code.

Recognize Python source including `.py` and `.pyw`.

Classify workload type before selecting a deployment template:

- web server/API
- static web application, when genuinely applicable
- worker
- command-line program
- library
- desktop GUI
- unsupported
- ambiguous

Flask:

- discover assignments to Flask(...) regardless of variable name
- support `app`, `server`, `application` and other valid identifiers
- derive `<module>:<object>` safely
- support nested modules such as `src/server.py`
- support package modules such as `app/main.py`
- recognize application factories such as `create_app` only when a safe
  production command can represent them
- detect multiple Flask objects and block when target selection remains
  ambiguous
- do not hardcode `server:server` or any repository name

FastAPI:

- discover FastAPI(...) objects regardless of object name
- support nested module targets
- support safe application-factory patterns when the production server supports
  them
- block genuine ambiguity

Django:

- locate the real settings and wsgi/asgi module
- support nested Django project packages
- do not select an arbitrary first settings directory
- retain DEBUG, ALLOWED_HOSTS and SECRET_KEY safety checks using accurate source
  evidence

Streamlit:

- retain supported entrypoint and health behavior
- require a genuine Streamlit application entrypoint

Desktop/CLI/library:

- detect Tkinter and other clear desktop-GUI evidence
- classify `.pyw` correctly
- reject non-web workloads with a precise reason
- do not report them merely as unsupported language

Python packaging:

- accurately distinguish requirements.txt, pyproject.toml, Poetry, Pipenv and
  the package managers/templates actually supported by DeployGuard
- avoid treating a pinned requirements.txt as a conflicting second lockfile
  when it is the selected dependency source
- either support uv and PDM end to end or keep explicit actionable blockers
- parse Python-version requirements truthfully

Production-server strategy:

- do not require the repository to contain Gunicorn in every Flask/Django case
  when a validated generated template intentionally supplies a centrally pinned
  production server
- recognize repository-declared Gunicorn, Uvicorn, Hypercorn, Waitress or other
  explicitly supported strategies
- distinguish repository-provided from platform-generated production servers
- never accept Flask’s or Django’s development server as production
- ensure the selected command binds to 0.0.0.0 and consumes the platform PORT
- ensure the generated Docker template actually installs the production server
  it invokes

Part 6 — Dockerfile validation and template selection

The presence of `Dockerfile` must not automatically mean detection success.

Inspect the Dockerfile associated with the selected build context and validate,
without executing it:

- exact Dockerfile path
- build context
- multi-stage structure
- WORKDIR
- relevant COPY/ADD source paths
- CMD and ENTRYPOINT
- EXPOSE as advisory evidence, not sole runtime proof
- development-server commands
- obvious localhost-only binding
- command/port contradictions
- missing runtime process
- static-server versus application-server strategy
- target-stage evidence, when the product supports target stages

Handle shell-form and exec-form commands conservatively. If a dynamic command
cannot be proven safe, require an explicit override or block with a precise
reason.

Template matching must occur after workload and deployability evaluation.

A custom Dockerfile may be selected only when:

- the workload is a supported HTTP application
- the Dockerfile belongs to the selected context
- a runtime process is present
- port and bind behavior are compatible or explicitly overridden
- no independent deployability blocker remains

Generated templates must consume the final contract fields rather than making
new assumptions about `app.py`, `main.py`, `build`, `dist`, port or application
root.

Part 7 — Deployability evidence

Preserve the useful current safety checks, but make their evidence and severity
consistent.

Blockers should include only conditions that make deployment structurally
unsafe or impossible.

Warnings/advisories should include non-fatal reproducibility or operational
guidance.

Review and harden:

- install-command inference
- production-command inference
- bind-host detection
- PORT consumption
- expected-port selection
- health-route detection
- static output-directory detection
- lockfile conflicts
- private registry requirements
- environment-variable ownership
- database requirements and supported engines
- localhost database configuration
- persistent-storage requirements
- repository `.env` handling
- hard-coded secrets
- Dockerfile safety

Do not classify a health path merely because the string appears in a comment,
constant or unrelated source. Preserve `/` as a permitted fallback with a clear
warning when the platform intentionally supports it.

Never persist secret values. Detected defaults must be excluded for secret-like
variables and sanitized before responses, audit logs or hashes.

Part 8 — Detection orchestration and persistence

Fix direct production defects in deployment-profile.service.ts:

- authorize every caller before allowing it to join an in-flight detection
- do not let project-only singleFlight sharing bypass caller authorization
- provide cross-process protection or a database-backed lease/advisory strategy
  so multiple backend replicas do not run duplicate authoritative detections
- acquire the appropriate configuration ownership before committing results
- verify project configuration has not changed
- bind detection to the exact commit
- prevent a changed branch head from being deployed under stale evidence
- ensure trusted project-derived fields cannot be overwritten by draft spread
  ordering
- include detector/schema/template versions in cache reuse
- sanitize persisted and returned errors
- do not overwrite a valid last-known-good deployment contract merely because
  a lightweight remote check, token request, clone or GitHub call failed
  transiently
- distinguish “last successful profile” from “latest failed detection attempt”
  when the current persistence model requires it
- do not update an active deployment contract from a transient clone failure
- cleanup failures must be logged safely but must not replace the primary result
- record truthful audit events for reuse, completion, failure, configuration
  conflict and actual template selection
- do not emit TEMPLATE_SELECTED when no template was selected

If a schema migration is required to preserve last-good state or versioned
attempt evidence, keep it narrowly scoped and backwards compatible.

Part 9 — End-to-end contract propagation

Inspect every direct consumer before declaring completion.

Verify that the corrected fields reach:

detection
→ persisted profile
→ deployment contract
→ pre-flight gate
→ Docker/template renderer
→ GitHub Actions inputs
→ image build
→ ECS runtime contract
→ canonical current-state/developer-details response

The workflow and generated Dockerfile must use the same:

- commit SHA
- build context
- application root
- install command
- build command
- output directory
- production command
- port
- health path
- template strategy

No downstream component may silently fall back to obsolete assumptions after
the detector produces correct evidence.

Frontend scope is minimal:

- do not redesign any page
- do not create a detection route
- only update existing readiness/Developer details if necessary to show the
  backend’s accurate workload, application root, production target, warnings
  and blockers
- frontend must not independently redetect or reinterpret the repository
Part 10 — Platform-owned runtime configuration and managed database binding

This section is mandatory and part of the stack-detection production-grade
iteration.

Known current defects

1. A repository requiring PostgreSQL is shown as Blocked with:

   “Database tier required. This app needs PostgreSQL. Configure a
   DeployGuard-managed database or provide an external endpoint.”

   The normal deployment page provides no database configuration control, and
   the intended product behavior is that supported databases are managed by
   DeployGuard automatically.

2. PORT was accepted or surfaced as a user configuration problem, requiring the
   operator to remove it manually.

   PORT, HOST, NODE_ENV and other platform-owned runtime values must not be
   configurable by the normal user.

Product policy

The normal user provides only:

- GitHub authorization
- repository
- branch
- optional user-owned application environment variables
- one Deploy click

The normal user must not provide:

- PORT
- HOST
- NODE_ENV
- PYTHONUNBUFFERED
- AWS credentials
- GitHub tokens
- Terraform values
- container-port mappings
- managed database hostname
- managed database port
- managed database username
- managed database password
- managed database URL

Supported database dependencies must use the DeployGuard-managed database path
by default.

Do not expose an external database endpoint choice in the normal deployment
journey.

External database support may remain only as an internal/admin or explicit
advanced override when it already exists and is securely supported. It must not
be required for the default deployment path.

A. Database detection responsibility

Stack detection must determine only evidence such as:

- databaseRequired
- detected database engine
- repository database variable names
- supported or unsupported engine
- localhost/service-alias evidence
- confidence and evidence sources

For PostgreSQL applications, produce a contract equivalent to:

- databaseRequired: true
- databaseEngine: postgres
- databaseStrategy: deployguard_managed
- databaseProvisioning: on_deploy
- databaseBindingRequired: true
- databaseUserConfigurationRequired: false

Do not mark PostgreSQL deployment blocked merely because an endpoint has not
already been entered by the user.

Detection and readiness must not provision cloud resources. Provisioning begins
only after the user clicks Deploy and one authorized idempotent deployment
operation exists.

B. Managed database binding

Inspect the current database-service-binding, deployment-requirements,
pre-flight, Terraform, workflow and environment-injection path.

Use the existing supported DeployGuard-managed database implementation when it
is genuine and complete.

The deployment path must:

1. detect that PostgreSQL is required;
2. select the managed PostgreSQL strategy automatically;
3. create or reuse the project database idempotently during deployment;
4. create isolated project credentials;
5. persist credentials only through the existing encrypted secret boundary;
6. inject the variables actually consumed by the repository;
7. never return or render database secret values;
8. pass the binding into the ECS task definition;
9. verify that the binding exists before the application is labelled Live;
10. reuse the existing binding for retry and redeploy;
11. avoid creating duplicate databases or users after repeated Deploy clicks;
12. handle destroy according to the currently intended resource-retention
    policy;
13. record sanitized audit evidence.

Map the managed binding to repository-consumed variables when supported, for
example:

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

Determine which names the application consumes and inject only the required
compatible variables, plus any platform-owned values required by the selected
runtime.

When repository evidence proves that a supported PostgreSQL dependency exists
but does not identify the exact variable convention:

- prefer a framework-supported canonical managed binding when safe;
- otherwise produce one precise structural blocker explaining the ambiguity;
- do not ask the normal user to provide raw database credentials.

If DeployGuard does not genuinely have working managed PostgreSQL provisioning
and binding, do not merely change the UI to Ready. Implement the missing direct
path in this iteration or report the exact proven blocker. Never fabricate
managed database support.

C. Readiness behavior

For a supported PostgreSQL application with a valid managed binding strategy,
the readiness UI must show an informational Ready state such as:

“PostgreSQL required. DeployGuard will provision and connect a managed
PostgreSQL database automatically when deployment starts.”

This must not disable Deploy.

The readiness result may block only when:

- the database engine is unsupported;
- multiple incompatible engines are genuinely required;
- repository evidence is unsafe or irreconcilably ambiguous;
- the managed database implementation is unavailable or incorrectly
  configured;
- secure variable mapping cannot be established;
- a custom Docker/runtime strategy prevents safe injection.

Do not display an external-endpoint instruction when the normal user has no such
workflow.

D. Platform-owned environment variables

Use one authoritative reserved-variable policy in both frontend and backend.

At minimum, reserve:

- PORT
- HOST
- NODE_ENV
- PYTHONUNBUFFERED
- AWS_*
- GITHUB_*
- DEPLOYGUARD_*

The backend is authoritative.

The frontend may provide immediate feedback, but backend parsing and bulk
configuration saving must independently reject or ignore reserved names.

For a pasted environment file containing:

PORT=5000
API_URL=https://example.test

the result must be equivalent to:

- API_URL accepted and encrypted/saved according to its classification;
- PORT not stored as a user variable;
- PORT excluded from the accepted-value count;
- PORT excluded from missing-user-configuration warnings;
- PORT excluded from requiredEnvironmentVariables;
- PORT listed only as platform-managed evidence when Developer details are
  authorized;
- no deployment blocker merely because the user pasted PORT;
- a concise inline informational message may state that PORT is managed by
  DeployGuard.

Do not silently allow a user value to override the platform runtime port.

Apply the same ownership decision consistently to:

- environment parser
- environment persistence
- deployment contract
- deployment requirements
- pre-flight
- Docker templates
- GitHub Actions inputs
- ECS task environment
- current-state projection
- readiness UI
- audit logs

E. Port inference and runtime behavior

Separate:

- detected application default port
- platform runtime PORT
- container port
- ALB target port
- source of the port evidence

The user must not configure these through the optional .env field.

Generated server commands must bind to:

- host: 0.0.0.0
- port: platform-provided PORT with a safe framework default fallback

Static applications must use the generated static-server contract and its
platform-controlled container port.

A repository is deployable when the generated or repository-proven production
strategy safely consumes the platform port.

A repository remains blocked when it genuinely:

- binds only to localhost;
- hardcodes an incompatible port with no safe override;
- exposes contradictory Dockerfile and application ports;
- has no provable public server;
- uses a custom runtime that cannot consume the platform contract.

Do not turn the mere absence of a user-provided PORT into a warning or blocker.

F. Direct file scope

Inspect and modify only direct participants, which may include:

- stack-detection.service.ts
- repo-deployability-scanner.service.ts
- deployment-contract.service.ts
- deployment requirements/pre-flight services
- database-service-binding service
- environment parsing and encrypted configuration services
- project/deployment contract entities and a narrowly scoped migration when
  genuinely required
- Docker-template rendering
- GitHub Actions contract inputs
- Terraform managed-database resources and ECS binding
- canonical current-state projection
- the existing /deploy readiness component
- directly related tests and fixtures

Do not modify unrelated authentication, navigation, monitoring, Admin,
rollback, billing, notification or visual-design code.

Before modifying any additional production file, prove that it directly
detects, persists, validates, provisions, injects or renders database/port
ownership evidence.

G. Required regression tests

Add or update tests for:

1. PostgreSQL dependency with DATABASE_URL:
   - managed strategy selected;
   - Ready, not Blocked;
   - no user database input required.

2. PostgreSQL dependency with decomposed DB_* variables:
   - correct variable mapping;
   - credentials remain encrypted and hidden.

3. PostgreSQL dependency with PG* variables:
   - correct variable mapping.

4. Supported PostgreSQL application with localhost database configuration:
   - local configuration replaced by the managed binding when safe;
   - no runtime localhost database endpoint remains.

5. Unsupported MongoDB-only repository:
   - blocked with a precise unsupported-engine message;
   - no misleading PostgreSQL/external-endpoint advice.

6. Conflicting PostgreSQL and MySQL evidence:
   - blocked as genuinely ambiguous.

7. Existing managed binding:
   - retry/redeploy reuses it;
   - no duplicate database or credentials.

8. Repeated Deploy click:
   - one effective database provisioning operation.

9. Detection/readiness request:
   - creates no cloud database and makes no AWS mutation.

10. PORT pasted by the user:
    - rejected or ignored before persistence;
    - excluded from accepted count;
    - no missing-PORT warning;
    - no user override.

11. HOST, NODE_ENV and PYTHONUNBUFFERED pasted by the user:
    - handled according to the authoritative platform-owned policy.

12. Repository safely consumes process.env.PORT:
    - deployable.

13. Python repository safely consumes os.getenv("PORT"):
    - deployable.

14. Generated Flask/FastAPI/Django command:
    - binds to 0.0.0.0 and platform PORT.

15. Hard-coded incompatible port/custom Dockerfile:
    - remains blocked.

16. Frontend readiness:
    - shows managed PostgreSQL informational state;
    - Deploy remains enabled;
    - no nonexistent external configuration action is offered.

17. Secret safety:
    - database passwords, URLs and tokens never appear in responses, logs,
      accepted-value summaries, contract hashes or frontend state.

H. Acceptance repository

Use Hassan-Sajjad72/smart-retail-pro as a non-mutating detection and readiness
acceptance case when authenticated local repository access is available.

Expected readiness evidence:

- database required: yes
- database engine: PostgreSQL
- strategy: DeployGuard-managed
- provisioning timing: after Deploy only
- normal-user database input: none
- PORT ownership: DeployGuard
- structurally deployable unless another independent genuine blocker exists
- Deploy action enabled when no independent blocker remains

Do not dispatch GitHub Actions or mutate AWS during detection/readiness
verification.

Final report

Report:

- the exact source of the incorrect database blocker;
- the exact path that accepted or warned about user-supplied PORT;
- every changed file and why it was directly required;
- managed database lifecycle behavior;
- environment-variable ownership behavior;
- tests and builds executed;
- non-mutating smart-retail-pro readiness evidence;
- any remaining genuine blocker.

Stop after completing the stack-detection, platform-variable ownership and
managed-database readiness iteration.

Part 11 — Required regression matrix

Use existing test infrastructure where possible and add narrowly scoped fixtures.

Application roots and security:

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

JavaScript:

- Vite React with dist
- CRA with build
- Webpack React with custom `app` output
- Next SSR
- Next static export
- Express JavaScript
- Express TypeScript/nested source
- NestJS
- Fastify safe host
- Fastify unsafe/default host case
- npm with package-lock
- yarn
- pnpm
- conflicting lockfiles
- development-only start command
- React dependency inside a server application

Python:

- Flask app.py with app:app
- Flask server.py with server:server
- nested src/server.py
- nonstandard Flask object
- Flask application factory
- ambiguous Flask objects
- Flask development-server-only case
- generated production-server strategy
- repository-declared safe production server
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

Docker:

- safe custom Dockerfile
- Dockerfile with no runtime command
- development-server Dockerfile
- port contradiction
- localhost-only command
- Dockerfile outside selected application context
- generated static template
- generated Node server template
- generated Flask/FastAPI/Django template

Orchestration:

- unauthorized caller while another caller has an in-flight detection
- concurrent detections in one process
- concurrent detections across simulated instances
- transient remote-commit failure with an existing successful profile
- clone failure with an existing successful contract
- detector-version change invalidates cache
- configuration change during detection
- branch head changes after clone
- cleanup failure after successful save
- raw errors cannot leak token/path/secret evidence

Part 12 — Verification

Do not deploy, dispatch GitHub Actions, mutate AWS, create ECR images or apply
Terraform in this iteration.

Run all existing relevant commands discovered in the repository, including the
equivalents of:

- detection tests
- deployability/pre-flight tests
- deployment-requirements tests
- detection-contract gate tests
- Docker-template tests
- current-state consistency tests
- authentication/authorization tests affected by detection
- backend production build
- frontend tests/build only if a direct response projection was changed
- migration validation if a migration was added
- git diff validation
- secret-signature scan on changed lines

Use authenticated, non-mutating local API verification for the three known
repositories when configured credentials and services are available.

A detection request must not create a pipeline operation or dispatch a workflow.

For every acceptance repository, report:

- selected commit
- selected application root
- build context
- workload type
- framework
- entry target
- template/Docker strategy
- port
- health path
- blockers
- warnings
- final deployability decision

Constraints

- Do not hardcode repository names, commit SHAs, paths or targets.
- Do not weaken a genuine safety gate simply to make the sample repositories
  pass.
- Do not execute untrusted repository code during detection.
- Do not expose repository secrets, GitHub tokens, host filesystem contents or
  raw sensitive errors.
- Do not perform broad refactoring outside the detection and direct contract
  chain.
- Preserve currently working JavaScript and Python cases.
- Unsupported workloads must remain unsupported but be classified precisely.
- Do not claim production grade from unit tests alone; verify the complete
  non-mutating contract path.
- Do not continue into unrelated work.

Done when

1. The three known repositories produce the expected generalized decisions.
2. Valid common JavaScript/TypeScript and Python web layouts are handled through
   one evidence-based contract.
3. Unsupported desktop/CLI/library workloads are identified accurately.
4. Monorepositories are either selected correctly or blocked with actionable
   ambiguity.
5. Custom and generated Docker strategies use the same final contract.
6. Detection cache is versioned and cannot reuse stale detector logic.
7. Transient GitHub failures do not destroy the last successful contract.
8. Concurrent and unauthorized detection behavior is safe.
9. Untrusted repository scanning cannot escape the workspace or exhaust the
   backend without a bounded failure.
10. Relevant tests, builds and non-mutating local verification pass.
11. Report:
    - exact files changed and why;
    - migrations added;
    - test commands and results;
    - acceptance evidence for the three known repositories;
    - any remaining unsupported cases by deliberate policy;
    - any genuine external/manual blocker.
12. Stop after this stack-detection iteration.