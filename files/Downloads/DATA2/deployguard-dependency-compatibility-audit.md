# DeployGuard Dependency / Build Compatibility Audit (read-only)

Repository: Hassan-Sajjad72/Deploy-Guard-dev, branch `test1`, fresh clone.
No files modified. Railpack facts were verified against the pinned upstream tag `railwayapp/railpack@v0.38.0` (cloned to /tmp, outside the workspace) because the pinned binary — not documentation — is the build authority DeployGuard actually runs.

---

## CURRENT_HEAD

`1acd056f29eaabc607d68e6875b27c877c1bd9c9` — "fix: unify structured failure recovery contract" (8 commits after the previously audited `e2a9607`). Control-plane fingerprints in `github-actions-workflow-contract.ts` were re-pinned in `4100f42`. Railpack remains pinned to **v0.38.0** (`railpack-release.ts`, workflow "Install pinned Railpack", sha256 `7c3f0e70…`).

Relevant deltas since `e2a9607`: new `failure-diagnostics/failure-contract.catalog.ts` (single authoritative code→owner table, `DG_RAILPACK_BUILD_FAILED` deliberately excluded as "evidence-dependent umbrella"); `failure-ownership.ts` now delegates to that catalog; `verify-runtime.sh` grew ALB-ingress verification. Nothing in the delta touches dependency/native-build admission.

## CURRENT_COMPATIBILITY_ARCHITECTURE

Actual pre-dispatch order (`railpack-deployment.service.ts#dispatch`, lines ~331–386):

```
control_plane_release → github_authentication → source_resolution (exact 40-hex SHA)
→ build_target_resolution   (BuildTargetResolverService, at exact SHA, per service)
→ service_port_resolution    (ServicePortResolver)
→ deployment_requirement_admission (DeploymentRequirementResolverService: ENV keys only)
→ managed_database_reconciliation
→ caller_reconciliation → oidc_authorization → runtime configuration → releaseOnly gate → dispatch
```

Workflow order (`deployguard-reusable.yml`): validate_release → Install pinned Railpack → **Build immutable Railpack images** (`railpack build --env … --name … "$build_root"`, marker `DG_RAILPACK_BUILD_FAILED stage=railpack_build`) → Validate Application Runtime (docker run + transport probe + optional DB probe) → Publish to ECR (first AWS mutation: `ecr create-repository` only here, line 247) → Terraform.

**There is no dependency-evidence stage anywhere.** `BuildTargetResolverService.pythonEvidence` reads `pyproject.toml`/`requirements.txt`/`Pipfile` only to (a) pick the tool (`poetry|uv|pdm|pipenv|pip|pyproject`), (b) find local path deps, (c) detect uv workspaces. It never parses dependency names. The JS side parses `package.json` only for `name`, `workspaces`, `packageManager`, `scripts`, and local/`workspace:` deps. DeployGuard therefore has **zero knowledge of what will be installed**, native or otherwise. That is by design: AGENTS.md / invariants.md say "Railpack = build/start authority".

Build inputs DeployGuard controls: `buildRoot`, `--build-cmd/--start-cmd` (workspace members only), and `--env KEY` for every project variable with `scope ∈ {build, both}` (non-secret via `buildEnvironment`, secret via Secrets Manager pinned version). Key regex `^[A-Z_][A-Z0-9_]*$`; the reserved-key registry (`configuration-ownership.ts`) blocks `AWS_|GITHUB_|ACTIONS_|TF_|TF_VAR_|DEPLOYGUARD_` and managed aliases — **`RAILPACK_*` is not reserved, not documented, not validated, and passes straight through to `railpack build`.** Railpack also reads a `railpack.json` relative to the build root (core.go `GenerateConfigFromFile`), which DeployGuard neither inspects nor forbids.

## CURRENT_SUPPORTED_CONTRACT

What the source actually promises (BuildTarget contracts `JS_STANDALONE`, `JS_WORKSPACE_MEMBER`, `PYTHON_STANDALONE`; anything else → `DG_DEPLOYMENT_CONTRACT_UNSUPPORTED`):

| Axis | DeployGuard admits | DeployGuard rejects pre-dispatch | Delegated to Railpack 0.38.0 |
|---|---|---|---|
| Runtimes | Node/JS/TS, Python | Everything else (Go, Java, Ruby, PHP, Rust, Dockerfile-only) | version selection (`.python-version`, `runtime.txt`, `.nvmrc`, `engines`, mise) — default Python **3.13**, Node per provider |
| JS pkg managers | npm, pnpm, yarn, bun (lockfile/`packageManager` evidence) | conflicting lockfiles; invalid `packageManager` | install/build/start commands, frozen-lockfile behavior |
| Python pkg managers | pip (`requirements.txt`), poetry, uv, pdm, pipenv, bare pyproject | uv workspace member; local path dep outside boundary | actual install (`pip install -r requirements.txt`, `uv sync --locked`, `poetry install --only main`, …) |
| Repo structure | standalone dir; JS workspace member; nested service dir inside repo; multi-service | escaping paths; standalone JS with local sibling dep; Python sibling dep; duplicate workspace identities; missing workspace member | — |
| Runtime contract | PORT/HOST injected; port resolved from repo; ENV keys from `.env.example`/Dockerfile ARG-ENV/`deployguard.requirements.json`/`app.json`; managed DB aliases | prohibited overrides, duplicate key conflicts, missing required ENV (`INPUT_REQUIRED`) | start command detection, `0.0.0.0` bind (verified after build by transport probe) |
| Native/system deps | **nothing admitted or rejected** | nothing | everything (see below) |

What Railpack 0.38.0 actually provides (verified in upstream tag):

- **Builder image** `ghcr.io/railwayapp/railpack-builder` (images/debian/build/Dockerfile) already contains `build-essential, cmake, make, pkg-config, autoconf, automake, libtool, git, libssl-dev, zlib1g-dev, libbz2-dev, liblzma-dev, libzstd-dev, libreadline-dev, libsqlite3-dev, libncursesw5-dev, tk-dev, libxml2-dev, libicu-dev, libxmlsec1-dev, libffi-dev, libjpeg-dev, libpng-dev, libtiff-dev, default-libmysqlclient-dev, libpq-dev, jq, curl, wget, zip, unzip, ssh, rsync`. So gcc/g++/make/pkg-config/Python headers/libpq/libmysqlclient/OpenSSL headers/basic image libs are **present at build time for every build**.
- **Runtime image** `railpack-runtime` = `debian:trixie-slim` + `ca-certificates pkg-config openssl tzdata locales` only. Runtime shared libraries are **not** carried over unless the provider adds them.
- Python provider (`core/providers/python/python.go`): `usesPostgres()` = substring `psycopg2` or `psycopg` in any `**/{requirements.txt,pyproject.toml,Pipfile}` (or `django.db.backends.postgresql` in `*.py`), **unless** `psycopg2-binary`/`psycopg[binary]` present. When true → `libpq-dev` in build (already there) **and `libpq5` in the runtime image**. `usesMysql()` (`mysqlclient`) → `default-libmysqlclient-dev` / `default-mysql-client`. Fixed table: `pycairo`, `pdf2image`, `pydub`, `pymovie`. Upstream ships examples `python-django` (psycopg2 from source) and `python-latest-psycopg`.
- Generic escape hatches (core.go 291–297): `RAILPACK_BUILD_APT_PACKAGES`, `RAILPACK_DEPLOY_APT_PACKAGES` (space-separated; `...` keeps Railpack's own list), `RAILPACK_PACKAGES` (mise tools, e.g. `rust@latest`, `java@21`), `RAILPACK_PYTHON_VERSION`, `RAILPACK_BUILD_CMD/START_CMD/INSTALL_CMD`, and `railpack.json` (`buildAptPackages`, `deploy.aptPackages`, `packages`).
- Not provided by default: Rust/Cargo (needs `RAILPACK_PACKAGES=rust@…`), JDK, ffmpeg/poppler/cairo unless in the fixed table, arbitrary `.so` at runtime, Alpine/musl variants.

## PSYCOPG2_FAILURE_CLASSIFICATION

Trace of the motivating pattern under the pinned toolchain:

```
requirements.txt: Flask, SQLAlchemy, psycopg2
→ BuildTargetResolver: PYTHON_STANDALONE (kind=pip)  ✔ admitted
→ RequirementResolver: env keys only                  ✔ READY (if DATABASE_URL etc. provided/managed)
→ railpack build <serviceDir>
   → builder image already has gcc + libpq-dev + python3 headers  → psycopg2 sdist compiles
   → usesPostgres()=true → runtime gets libpq5                    → import works at runtime
→ Validate Application Runtime → ECR → Terraform
```

Under Railpack 0.38.0 the *pattern* `SQLAlchemy + psycopg2 (source)` is inside the supported envelope. It should not fail for lack of a compiler or `pg_config`. Therefore a real failure of this class must come from one of:

| Sub-case | Deterministic signal | Owner |
|---|---|---|
| `psycopg2` pinned `< 2.9.10` with no Python pin → Railpack defaults to **Python 3.13** → C-extension compile error (`_PyInterpreterState_Get`, `Py_UNICODE`) | requirements pin + absence of `.python-version`/`runtime.txt`/`RAILPACK_PYTHON_VERSION` | Repository (undeclared runtime version) — EXPECTED_REPOSITORY_COMPATIBILITY_BLOCKER |
| `psycopg2` reached only transitively (e.g. `sqlalchemy[postgresql]`, a private wheel, `-r other.txt` outside `**` scan) → build OK, runtime `ImportError: libpq.so.5` | dependency never appears literally in scanned manifests | Repository per Railpack contract; DeployGuard captures it as `DG_APPLICATION_RUNTIME_FAILED` (REPOSITORY_APPLICATION) — correct owner, poor explanation |
| Both `psycopg2-binary` and `psycopg2` listed → `usesBinaryPsycopg` short-circuits → no `libpq5` at runtime | manifest contents | Repository |
| requirements.txt not at `buildRoot` (e.g. `requirements/prod.txt`) → `hasRequirements` false → bare `pyproject` path or no install | file layout | Repository / EXPECTED_BLOCKER (DeployGuard admits `kind=pip` only when `requirements.txt` exists at the service dir — consistent) |
| PyPI/GitHub release download failure | network errors in log | EXTERNAL_BUILD_PROVIDER_FAILURE |
| Builder image regression (missing libpq-dev) | would contradict upstream Dockerfile at v0.38.0 | not the case at this pin |

**Classification of the reported failure: `UNVERIFIED`.** No terminal log was supplied, and the pattern itself is supported by the pinned Railpack. Every plausible concrete cause is repository-owned or provider-owned; none is a DeployGuard platform defect. If a log is produced, the sub-case table above resolves it deterministically.

### Question A — does DeployGuard claim this should deploy?
Implicitly yes: `PYTHON_STANDALONE` with `kind=pip` is admitted, and nothing in the contract narrows "pip" to pure-Python. The claim is honoured by Railpack's builder image.

### Question B — could DeployGuard have detected it pre-dispatch?
Only the *Python-version × psycopg2-pin* sub-case is deterministically detectable from the manifest (both facts are in-repo). The libpq5-at-runtime sub-cases require knowing the resolved dependency graph, which only the installer produces. General native-build failure is **not** deterministically knowable without running the build.

### Question C — does Railpack already have a mechanism DeployGuard failed to expose?
Yes, and DeployGuard *does* expose it — accidentally. Build-scoped project variables named `RAILPACK_BUILD_APT_PACKAGES`, `RAILPACK_DEPLOY_APT_PACKAGES`, `RAILPACK_PACKAGES`, `RAILPACK_PYTHON_VERSION` pass through `--env` untouched, and `railpack.json` in the service directory is honoured. This is undocumented, unsealed (not part of `configurationFingerprint`'s intent), unvalidated, and invisible to the UI/diagnostics. It is neither promised nor blocked.

### Question D — is the repository responsible for declaring native requirements?
Under the current contract: yes, via Railpack's own declaration surface (`railpack.json` / `RAILPACK_*`), the same way Railway users do. DeployGuard adds no declaration format of its own and should not invent one.

### Question E — would auto-installing be generic or a hack?
`if psycopg2 → libpq-dev` in DeployGuard would be a hack **and redundant**: Railpack already owns exactly that mapping. Generic behaviour is: (1) keep Railpack's tables as the authority, (2) make the generic declaration channel a first-class, validated, sealed contract, (3) classify build evidence correctly.

## IS_DEPLOYGUARD_DEFECT

**NO** for the psycopg2 failure itself. **PARTIAL** for the surrounding contract: the declaration channel is unsealed pass-through, and the failure-diagnosis layer cannot tell a native-compile failure from any other build failure (`DG_RAILPACK_BUILD_FAILED` → `INSUFFICIENT_EVIDENCE`, owner UNVERIFIED).

## WHY

- DeployGuard's declared boundary is "Railpack = build authority" (AGENTS.md, invariants.md). It does not generate Dockerfiles, install commands, or apt lists; it only selects `buildRoot` and forwards env. There is no DeployGuard-generated artifact that could have *dropped* a native requirement.
- The pinned builder already satisfies the specific capability (compiler + libpq headers). Failure of the motivating case can only arise from repository-declared versions, undeclared runtime version, manifest layout, or provider outages.
- Build failures happen **before** any AWS mutation (ECR repo creation is in the Publish step, after build and runtime validation). The "no unnecessary AWS/Terraform mutation" property already holds for this class; only GitHub Actions minutes are spent.
- The one platform-side weakness is *classification*, not *execution*: a `gcc … failed`, `fatal error: libpq-fe.h`, `pg_config executable not found`, or `Building wheel for X … error: subprocess-exited-with-error` log produces `DG_FAILURE_CAUSE_UNVERIFIED`-class output with `retryDecision=INSUFFICIENT_EVIDENCE`, so the developer is told "review evidence" instead of "pin Python / declare apt package / use binary wheel".

## EXISTING_COMPATIBILITY_CONTRACTS

| CONTRACT | AUTHORITY | WHAT IT VALIDATES | WHEN IT RUNS | WHAT IT BLOCKS | WHAT IT MISSES |
|---|---|---|---|---|---|
| BuildTarget | `build-target-resolver.service.ts` (+`build-target.ts`, `verify-build-target-resolution.ts`) | service dir containment, JS workspace ownership, package identity, local deps, Python tool kind, uv workspace | pre-dispatch `build_target_resolution` | `DG_BUILD_TARGET_*`, `DG_DEPLOYMENT_CONTRACT_UNSUPPORTED` | dependency names, native requirements, runtime version pins, `railpack.json` presence |
| Package manager | same resolver (`packageManager()`), `pythonEvidence().kind` | lockfile/`packageManager` agreement (JS); tool by lockfile (Py) | same | conflicting managers, invalid declaration | manager *version* (corepack/mise decides), Python version |
| Service port | `service-port-resolver.ts` | single canonical port from repo evidence | `service_port_resolution` | `DG_SERVICE_PORT_*` | — |
| Deployment requirement | `deployment-requirement-resolver.service.ts` | ENV key presence/ownership; PORT/HOST; managed aliases | `deployment_requirement_admission` | `DG_DEPLOYMENT_INPUT_REQUIRED/REQUIREMENTS_BLOCKED` | anything that is not an env key |
| Railpack workflow contract | `railpack-workflow-contract.ts`, `github-actions-workflow-contract.ts` | input shape, secret refs, key validity, control-plane fingerprints | dispatch + workflow `validate_release` | `DG_WORKFLOW_CONTRACT_INVALID`, `DG_CONTROL_PLANE_VERSION_MISMATCH` | semantics of `RAILPACK_*` keys |
| Application runtime validation | workflow "Validate Application Runtime" | image id, `0.0.0.0` bind via transport probe, DB engine reachability | post-build, pre-ECR | `DG_APPLICATION_RUNTIME_FAILED`, `DG_APPLICATION_EXTERNAL_BINDING_FAILED` | distinguishing "missing shared library" from app crash |
| Managed DB | `database-tier.service.ts`, `managed-database-*` | engine ∈ {postgres,mysql,mongodb}, aliases, reconciliation | settings + pre-dispatch | conflicts, stale/lost states | — |
| Failure ownership/diagnostics | `failure-contract.catalog.ts`, `failure-ownership.ts`, `failure-diagnostic.service.ts` | marker code → owner; regex signatures for lockfile/resolution/TS/module/build-script/startup | terminal capture | — | native compile signatures; Python version mismatch; apt failures; runtime `.so` missing |
| Reserved ENV registry | `configuration-ownership.ts` | platform/managed/prohibited keys | env CRUD + admission | AWS_/GITHUB_/TF_/DEPLOYGUARD_ … | `RAILPACK_*` |

Decision: native-dependency compatibility does **not** need a new subsystem. It belongs to (a) Railpack (execution), (b) the existing reserved-ENV/requirement admission (declaration validation), and (c) the existing failure catalog + signature classifier (ownership).

## CONTRACT_GAPS

| # | Gap | Class |
|---|---|---|
| G1 | `RAILPACK_*` build variables pass through undocumented/unvalidated; `railpack.json` unrecognised. Neither promised nor blocked; not reflected in `resolvedBuildTarget`/fingerprint intent nor UI. | MISSING_CONTRACT |
| G2 | No diagnosis signatures for native build failures (`error: command '/usr/bin/gcc' failed`, `fatal error: *.h: No such file`, `pg_config executable not found`, `Building wheel for … did not run successfully`, `subprocess-exited-with-error`, `node-gyp rebuild … failed`, `error: linker 'cc' not found`, `E: Unable to locate package` from apt step) → everything is `INSUFFICIENT_EVIDENCE`. | MISSING_CONTRACT |
| G3 | No signature for Python-version incompatibility (`Python 3.13` + old C-extension) and no pre-dispatch surfacing that the runtime version is undeclared. | MISSING_CONTRACT (low) |
| G4 | Runtime `ImportError: lib*.so.*: cannot open shared object file` is classified `DG_APPLICATION_STARTUP_OR_RUNTIME_FAILED` (owner correct, remediation generic). | MISSING_CONTRACT (low) |
| G5 | Multi-service: build loop stops at first failing service (`exit 1`), so evidence for later services is never produced; the failing `serviceId` is on the marker, so isolation of *attribution* is correct. | PASS (attribution) / UNVERIFIED (UX) |
| G6 | Pre-dispatch dependency admission does not exist. | PASS by design — see PRE_DISPATCH_POSITION |

No CONFIRMED_DEFECT in this area.

## PLATFORM_RESPONSIBILITY_BOUNDARY

| Capability | Generic PaaS answer | DeployGuard today |
|---|---|---|
| C/C++ toolchain, make, pkg-config, Python headers, OpenSSL/zlib/ffi headers, libpq-dev, libmysqlclient-dev, libjpeg/png/tiff-dev, git, curl | **Solve automatically** (build image) | ✔ via Railpack builder |
| Runtime `.so` for the above where a provider mapping exists (libpq5, mysql client, cairo, ffmpeg, poppler) | Solve automatically when the dependency is declared literally | ✔ via Railpack provider tables |
| Any other apt package, Rust/Cargo, JDK, image codecs | **Declare-and-provide**: repository declares (`railpack.json` / `RAILPACK_*`), platform validates & forwards | ✔ works, but unsealed (G1) |
| Unknown compile failure | **Let the build prove it**, classify from evidence, no cloud mutation | ✔ mutation-free; ✘ classification (G2) |
| Undeclared runtime version incompatible with pinned deps | Repository blocker; platform should say so | ✘ silent (G3) |
| Alpine/musl, architecture-specific binaries, privileged builds | Out of contract → explicit UNSUPPORTED | implicit (build fails) |

## DEPENDENCY_COMPATIBILITY_MODEL

Recommended: **not** a new "Build Capability Contract" with dependency evidence fields. The correct abstraction for this repo is

```
Compatibility Admission (existing) + Declared Build Capability pass-through (validated) + Failure Classification (extended)
```

Concretely:

1. **Declaration surface = Railpack's own.** Recognise exactly `RAILPACK_BUILD_APT_PACKAGES`, `RAILPACK_DEPLOY_APT_PACKAGES`, `RAILPACK_PACKAGES`, `RAILPACK_PYTHON_VERSION`, `RAILPACK_NODE_VERSION` (and optionally `railpack.json` presence) as a `build_time_public` reserved category in `RESERVED_VARIABLE_REGISTRY` — allowed, forced `scope=build`, non-secret, value-validated (`^[a-z0-9][a-z0-9.+-]*$` tokens for apt; `name@version` for mise). Reject every other `RAILPACK_*` key (e.g. `RAILPACK_BUILD_CMD`, `RAILPACK_START_CMD`, `RAILPACK_INSTALL_CMD`, `RAILPACK_CONFIG_FILE`) because they would override the BuildTarget execution contract that DeployGuard already seals.
2. **Seal it.** Include the recognised declarations in the BuildTarget revision (`evidence.buildCapabilities`) so redeploy/rollback identity is complete and the workflow can assert them.
3. **Classify, don't infer.** Extend the signature table with capability-oriented codes (below). Owner stays REPOSITORY_APPLICATION for compile/link/header/apt-not-found failures because the declaration channel exists and is repository-controlled; EXTERNAL_PROVIDER for registry/network; DEPLOYGUARD_PLATFORM only if the declared `RAILPACK_*` values were dropped by DeployGuard (verifiable by comparing sealed evidence to the workflow's `--env` list).

No allowlist of package names. The only name-keyed logic stays inside Railpack.

States: reuse existing `RequirementAdmission.status` (`READY | INPUT_REQUIRED | BLOCKED`) for declaration validation; no new state enum.

## WHERE_THE_CONTRACT_SHOULD_LIVE

- Declaration validation: `configuration-ownership.ts` (`RESERVED_VARIABLE_REGISTRY`, new category values) + `deployment-requirement-resolver.service.ts` (treat recognised `RAILPACK_*` as `platform`-owned build inputs with value validation; unrecognised `RAILPACK_*` → `prohibitedOverrides`).
- Sealing: `build-target.ts` (`CanonicalBuildTarget.evidence`) and `railpack-deployment.service.ts#persistBuildTargetRevisions`.
- Forwarding assertion: `deployguard-reusable.yml` build step already forwards `buildEnvironment`; add a contract check that the recognised keys present in `runtime.json` are exported.
- Classification: `failure-diagnostic.service.ts` signature table + `failure-contract.catalog.ts` for any new authoritative code.

## PRE_DISPATCH_POSITION

Keep dependency/native compatibility **out of the pre-dispatch chain** except for the declaration-validation slice, which slots into the existing `deployment_requirement_admission` stage (it is already reading project variables). Rationale from the repo's own cost/mutation boundaries: the Railpack build runs before ECR and Terraform, so a build failure costs runner minutes only; duplicating pip/npm resolution in the backend would violate "Railpack authority" and cannot be made deterministic. The lifecycle the prompt prefers is therefore already satisfied by:

```
exact SHA → BuildTarget → package manager → [declared build capabilities validated] → port → ENV → managed DB → dispatch → Railpack proves the rest
```

## FAILURE_OWNERSHIP_MODEL

| Evidence | Owner | Retry |
|---|---|---|
| resolution errors (existing signatures) | REPOSITORY_APPLICATION | SAFE_AFTER_FIX |
| compile/link/header/`pg_config`/node-gyp failure | REPOSITORY_APPLICATION (declare capability, use binary wheel, or pin runtime) | SAFE_AFTER_FIX |
| `E: Unable to locate package` / apt failure for a repository-declared package | REPOSITORY_APPLICATION | SAFE_AFTER_FIX |
| apt failure for a Railpack-provider-added package | EXTERNAL_PROVIDER / railpack | SAFE_NOW |
| declared `RAILPACK_*` present in sealed revision but absent from build env | DEPLOYGUARD_PLATFORM | NOT_SAFE_YET |
| PyPI/npm/GitHub download timeouts, 5xx | EXTERNAL_PROVIDER / network | SAFE_NOW |
| runtime `ImportError: *.so` | REPOSITORY_APPLICATION (declare `RAILPACK_DEPLOY_APT_PACKAGES`) | SAFE_AFTER_FIX |
| anything else under `DG_RAILPACK_BUILD_FAILED` | UNVERIFIED (current behaviour, correct) | INSUFFICIENT_EVIDENCE |

The current system already refuses to label build failures `DEPLOYGUARD_PLATFORM` by default (catalog excludes the umbrella code) — that principle is PASS.

## PROPOSED_STATUS_CODES

Reuse: `DG_PYTHON_DEPENDENCY_RESOLUTION_FAILED`, `DG_REPOSITORY_DEPENDENCY_RESOLUTION_FAILED`, `DG_REPOSITORY_LOCKFILE_OUTDATED`, `DG_APPLICATION_MODULE_MISSING`, `DG_DEPLOYMENT_REQUIREMENTS_BLOCKED` (for invalid `RAILPACK_*` declarations), `DG_RAILPACK_BUILD_FAILED` (umbrella).

Add as **root-cause codes** (diagnosis layer, not new terminal markers):
- `DG_NATIVE_BUILD_CAPABILITY_REQUIRED` — compiler/header/pkg-config/`pg_config`/node-gyp/cargo failure; remediation: declare via `RAILPACK_BUILD_APT_PACKAGES`/`RAILPACK_PACKAGES` or switch to a binary distribution.
- `DG_RUNTIME_SYSTEM_LIBRARY_MISSING` — `.so` ImportError at runtime validation; remediation: `RAILPACK_DEPLOY_APT_PACKAGES`.
- `DG_RUNTIME_VERSION_INCOMPATIBLE` — C-extension vs interpreter version signature; remediation: pin runtime version.
- `DG_BUILD_CAPABILITY_DECLARATION_INVALID` — rejected `RAILPACK_*` key/value at admission.
- `DG_BUILD_CAPABILITY_DECLARATION_DROPPED` — platform-owned; sealed declaration not forwarded.

Not recommended: `DG_DEPENDENCY_COMPATIBILITY_UNSUPPORTED` / `DG_DEPENDENCY_REQUIREMENT_UNVERIFIED` as pre-dispatch states — DeployGuard has no deterministic source for them.

## TEST_MATRIX

Python: pure-Python Flask (PASS today); Flask+SQLAlchemy (PASS); +`psycopg2` source with pinned Python ≤3.12 (expect build PASS, runtime libpq5 present); `psycopg2==2.9.9` with no Python pin (expect `DG_RUNTIME_VERSION_INCOMPATIBLE`, repository); `psycopg2-binary` (PASS); `sqlalchemy[postgresql]` only (expect runtime `DG_RUNTIME_SYSTEM_LIBRARY_MISSING`); `pycairo` (Railpack table, PASS); `weasyprint` without declaration (native capability required) vs with `RAILPACK_DEPLOY_APT_PACKAGES` (PASS); invalid requirements (existing resolution signature); conflicting versions (existing).
Node: plain npm (PASS); `sharp`/`bcrypt` (prebuilt binaries → PASS; forced source build → native capability); `canvas` (needs cairo → native capability unless declared); npm/pnpm/yarn/bun (existing); conflicting lockfiles (existing unsupported); workspace member, local sibling, missing member (existing); package needing OS binary at runtime (e.g. `fluent-ffmpeg`) → runtime failure, repository.
Multi-service: A pure + B native-failing → marker carries B's serviceId, A's evidence untouched; declaration on B must not leak to A (per-service `buildEnvironment`).
Declaration admission: valid `RAILPACK_BUILD_APT_PACKAGES="... libvips-dev"` accepted & sealed; `RAILPACK_START_CMD` rejected; `RAILPACK_PACKAGES="rust@1.80"` accepted; malformed token rejected; secret-scoped `RAILPACK_*` rejected.

## FILES_THAT_WOULD_NEED_CHANGE

`backend/src/projects/configuration-ownership.ts`; `backend/src/projects/deployment-requirement-resolver.service.ts`; `backend/src/projects/build-target.ts` + `build-target-resolver.service.ts` (evidence field only); `backend/src/projects/railpack-deployment.service.ts` (`runtimeConfiguration` build-env split already exists — only sealing); `backend/src/projects/failure-diagnostics/failure-diagnostic.service.ts`; `backend/src/projects/failure-diagnostics/failure-contract.catalog.ts` (only if a new authoritative marker is added); `.github/workflows/deployguard-reusable.yml` (assert forwarded keys; optional `DG_SERVICE_STAGE` echo of declared capabilities); `frontend/src/components/projects/EnvVarForm.jsx` (surface the recognised keys); AGENTS.md support-matrix text.

## EXISTING_TESTS_TO_EXTEND

`backend/scripts/verify-failure-diagnostics.ts` (signature cases), `verify-reserved-environment-boundary.ts` and `verify-service-env-isolation.ts` (RAILPACK_* handling), `verify-deployment-requirements.ts`, `verify-build-target-resolution.ts` (Python evidence), `verify-railpack-runtime-contract.ts` (input shape).

## NEW_TESTS_REQUIRED

A fixture-driven `verify-build-capability-declarations.ts` (accept/reject/seal), plus real-log fixtures for each new signature (gcc/header/pg_config/node-gyp/apt/ImportError/3.13-incompat) — collected from actual Railpack 0.38.0 runs, not synthesised strings.

## RISKS_OF_THE_PROPOSED_CONTRACT

- Signature regexes are heuristics; keep them narrow and owner-conservative (fall back to UNVERIFIED, as today). Existing precedence issue (regex runs before catalog for umbrella codes) is acceptable here because `DG_RAILPACK_BUILD_FAILED` is explicitly evidence-classifiable.
- Exposing `RAILPACK_*_APT_PACKAGES` lets repositories install arbitrary Debian packages in the build/runtime image. That is the same trust model as Railway; it does not widen the AWS blast radius, but it should be documented as repository-owned.
- Rejecting `RAILPACK_BUILD_CMD/START_CMD/INSTALL_CMD` may break a repo that currently relies on the accidental pass-through; that is a contract clarification, and the reject message should say so.
- Upgrading Railpack changes the builder image contents and provider tables; the support matrix must be re-derived per pin (fingerprint it alongside `RAILPACK_VERSION`).
- Any attempt to parse dependency graphs in the backend would create a second build authority and must stay out of scope.

## FINAL_RECOMMENDATION

**Do not implement a Dependency/Build Compatibility subsystem.** The psycopg2/SQLAlchemy failure is not a DeployGuard platform defect: the pinned Railpack builder already supplies the compiler and PostgreSQL headers, and the provider supplies `libpq5` at runtime; the failure (once a log is examined) will resolve to a repository-owned version/declaration issue or a provider outage. Nothing here mutates AWS before the build proves itself.

Implementation is justified only for the two narrow gaps that are already inside existing contracts:
1. **Seal the declaration channel** (G1) — recognise, validate, and fingerprint the small set of Railpack capability variables in the reserved-ENV registry and requirement admission; reject the execution-override variants.
2. **Extend failure classification** (G2–G4) — capability-oriented root-cause codes with deterministic signatures, owner REPOSITORY_APPLICATION/EXTERNAL_PROVIDER, keeping UNVERIFIED as the default.

Both changes touch existing authorities only, add no package-name database, and preserve Railpack as the build authority.
