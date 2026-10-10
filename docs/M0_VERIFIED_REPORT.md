# M0 verified local report

2026-10-10, Asia/Karachi. **M0 is not externally release-certified.** Local
M0.1–M0.18 are checkpointed; **M0 is locally verified** by the final integration
gate (exit 0) at `1286c6254f25c4969b7eaa748b7c2037a6268b71`.
The owner-approved strict v3 contract and fail-closed historical deletion remain.
M0.15–M0.18 complete the local ownership producer/intake/result integration,
diagnostics and bounded terminal recovery; publication and cloud proof are separate.
Live AWS verification was explicitly deferred by the owner. No AWS API query or
mutation, live workflow dispatch, push or merge was performed. Targeted,
same-major dependency security fixes were verified; no new dependency was added.

## Scope and verified changes

Worktree: `/tmp/deployguard-m0-kGHmNq/checkout`, branch
`codex/m0-workflow-identity-20261010`, based on `origin/version1` at
`3ac3d951f9a339a177a627acd306fc54bc6b8ac1`. The original dirty version1 workspace
and its owner-provided master specification were preserved. Authorization covers
M0 maintenance, not unsigned future product milestones.

| Boundary | Verified local outcome |
| --- | --- |
| Dispatch identity | Exact operation correlation, pagination, duplicate rejection and interrupted recovery; an accepted POST retains uncertainty even on malformed/unexpected discovery errors. Regressions verify one POST and zero compensation/provider calls. |
| Existing test consumers | Repaired retired stylesheet/pipeline/navigation/form consumers against supported surfaces, retaining admission, ownership, identity, RBAC, failure and destroy guarantees. API mutations and browser observations are reported separately. |
| Runtime secrets | Identifier-only intent/owned journal in existing pipeline events, before relevant writes; JSONB-stable integrity receipts survive failure/retry. Secrets are not persisted in this journal. HTTP client closes on module shutdown. |
| Terminal artifacts | Bounded HTTP/listing/archive reads and inflation; strict ZIP/identity checks; duplicate/malformed evidence fails closed. Missing evidence and retrieval outages converge through the existing bounded retry window, never release promotion. |
| Deletion observer | Standalone exact-ID read-only observer for 18 resource types, typed absence/state checks, bounded convergence/transient retries, denial rejection, strict scope, immutable caller snapshot and safe CLI diagnostics. Capture rejects explicit foreign/malformed environment tags, including delegated children. AWS calls are injected in tests. |
| Manifest transport | Atomic, immutable, content-addressed local retention; exact receipt restoration/union; corrupt/missing/narrowed/conflicting/symlinked evidence fails closed. This is not production inventory persistence. |
| Deletion scope | v3 requires complete frozen generation/receipt identity and matching per-resource observations. Historical v2 flags cannot authorize admission, cleanup, state projection or success notifications. No mutable-context reconstruction. |
| Cleanup concurrency | Pending terminal cleanup blocks new lifecycle admission. Actual DB deletion holds configuration/operation locks, revalidates eligibility, and rejects active operations or generation drift before cascading project authority. |
| Durable cleanup authority | Admission and cleanup share one bounded reader. Actual retained journal receipts are restored before SNS/GitHub cleanup and again inside the locked final transaction; missing, corrupt, duplicated, changed or late-attempt authority blocks deletion. Network calls remain outside transactions. |
| Canonical inventory minimum | Complete-family declarations cannot omit retained application/task revisions, pinned runtime secrets or independent database identities. Existing secret intent/owned receipts are validated, without retaining secret values. Whole-project deletion rejects other-environment history/configurations/generations rather than silently cascading their evidence. This is a minimum cross-check, not complete producer inventory certification. |
| Dependency release gate | Targeted locked-version fixes, proxy/IP and bounded indexed-source-map regressions; backend/frontend full `npm audit` reports zero vulnerabilities, including development tooling. Registry failure or any finding fails the aggregate gate. |
| Ownership producer/intake | Four runner-owned families plus server-authoritative runtime-secret receipts; exact operation/source/account/region/environment/repository/run/control-plane fingerprint. Intent precedes writes; lost responses and failed Terraform applies remain unresolved. Bounded exact artifact intake is append-only/idempotent under existing DB locks. |
| Strict destroy producer | Current Terraform identifiers must be covered before destroy. Cleanup uses full frozen historical identifiers, not LIVE-only discovery; exact runtime-secret namespace/tags retained. Independent observations of every resource/state/lock must pass before v3 result emission. Empty retry state cannot erase inventory; locks and protected database secrets are never force-cleared. |
| Terminal recovery | Bounded/throttled missing/unavailable ownership reads use frozen repository identity; invalid/conflicting evidence is not auto-recovered. Scoped metadata-only UPDATE cannot overwrite immutable authority or resurrect a deleted row. Real PostgreSQL verifies failed-release authority, recovered receipt idempotency and cascade-deletion race. |
| Diagnostic safety | New identity/ownership guard codes retain UNVERIFIED attribution and NOT_SAFE_YET retry guidance; unrelated build errors cannot replace the guard. No guessed provider/platform blame. |

NestJS modular monolith, React/Vite, PostgreSQL and existing deployment contracts
remain. No Kestra, Kubernetes, microservices, features, new dependencies or schema
migrations were added. The unpublished local candidate now certifies twelve
executable files at producer pin `f69ee49d2052abb656053d0125e8f6282a874465`.
Source checkpoints: intake `d18207b`, producer `f69ee49`, diagnostic/backfill
`1520aac`, action-contract reconciliation `1286c6254f25c4969b7eaa748b7c2037a6268b71`.
The local fixture pin is not remote activation, publication or cloud certification.

## Check results and evidence

| Check | Result / evidence type |
| --- | --- |
| Backend/front-end builds | PASS, local compilation/bundle |
| Prior M0.14 aggregate | PASS exit 0, `/tmp/deployguard-m0-environment-capture-pre-final.log`; historical source, not new producer evidence |
| Final M0.18 aggregate | PASS exit 0 at source `1286c6254f25c4969b7eaa748b7c2037a6268b71`, `/tmp/deployguard-m0-final-integration-v2-pre-final.log` |
| Backend/full frontend regressions | PASS, current supported consumers and behavior |
| PostgreSQL migrations/integration | PASS, 111 real migrations in disposable local DBs; isolation, constraints and cascades |
| Cleanup DB contention | PASS, actual service/repositories and second PostgreSQL connection; shared admission lock and authority-row lock contention |
| Playwright full stack | PASS, local Nest/React/PostgreSQL; 9 API mutations, 5 browser surfaces; GitHub selection remains EXPECTED BLOCKER |
| Workflow lint/contracts | PASS, actionlint/ShellCheck and producer/consumer checks; not remote execution |
| Terraform | PASS, fmt/validate and seven mocked product scenarios; no apply/destroy against AWS |
| Lifecycle/property tests | PASS, 1,000 lifecycle model sequences and 250 runtime properties plus real method fixtures |
| Architecture/dependency checks | PASS, zero dependency violations and no active legacy executable references |
| Clean locked installation / dependency security | PASS, backend/frontend default `npm ci` in a separate shallow checkout; both full audits report 0 vulnerabilities; actual consumer regressions pass |
| Prior additional checks outside aggregate | Historical PASS, direct ECS redeploy/rollback mocks, requirements, export, billing/Stripe/migration, notifications, Trivy and extra frontend regressions; `/tmp/deployguard-m0-extra-checks.log`. Not a new whole-suite result at M0.18. |
| Prior root canonical environment | Historical PASS against a separate credential-free fixture and owned local DB; initially failed with the unsuitable pin-only environment. Not rerun as a new cloud/configuration certification. No production environment was overwritten. |
| Independent archive compatibility review | PASS, standard stored/deflated ZIPs including streamed data descriptors; injected HTTP only |
| Real AWS/GitHub deployment lifecycle | UNVERIFIED, explicitly deferred |

No failing check was disabled or assertion removed to obtain these results.
The first new integration gate exposed missing registered ownership diagnostics;
the next exposed a stale seven-site action consumer after two evidence uploads
were added. Both were fixed at verified checkpoints. Exact action/SHA/count checks
remain and negative cases were added; twelve-file release identity passes.
Logs retain failures: `/tmp/deployguard-m0-producer-consumer-pre-final.log` and
`/tmp/deployguard-m0-final-integration-pre-final.log`. These are not successful runs.
Baseline defect reproductions and fixture-configuration failures remain recorded
in the progress log. The latest gate used fresh default `npm ci` installations
from reviewed locks, through task-owned symlinks; original dependencies were not
modified. Terraform 1.10.5 was fetched from HashiCorp with its published checksum
verified and used for the entire latest gate, matching the workflow pin. Earlier
gates used 1.15.8. This is local version parity, not AWS execution.
There is no configured general TS/React lint task; available compilation,
architecture checks, workflow lint and regression tests were run, not relabeled
as a nonexistent lint result.
Latest gate log SHA-256:
`97926df3e690404e4591672ac1a66cbda550e15ac9f6b70be974e38fa1524ddc`.
This gate covers 313 modules/1,178 dependencies with no architecture violations,
1,000 lifecycle sequences/250 runtime properties, 18 observed resource types,
111 real PostgreSQL migrations, and nine API mutations/five browser surfaces.
GitHub repository selection remains EXPECTED BLOCKER, not a completed live flow.

## Lifecycle certification boundary

| Action | Admission/result/local transition | External execution | Status |
| --- | --- | --- | --- |
| Deploy | Exact source/service/config identity; validated result required before stable promotion; prior healthy release retained on failure | Not run | PASS locally; AWS UNVERIFIED |
| Redeploy | Exact immutable inputs and direct ECS revision fixtures; one correlated dispatch, no unsafe secret compensation | Mocked only | PASS locally; AWS UNVERIFIED |
| Rollback | Complete historical image/runtime revision set, no rebuild/current-config substitution; verification precedes promotion | Mocked only | PASS locally; AWS UNVERIFIED |
| Destroy | Actual local collector/intake/frozen-manifest/independent v3 result round-trip plus strict admission, retry, state, notification and locked finalization contracts | Injected provider only; no live AWS or remote workflow execution | Integrated locally; external release verification pending |

## Resource-specific cleanup evidence

The observer checks identifiers only from a retained owned manifest. A subset PASS
does not prove manifest completeness or all historical/failed attempts cleaned.

| Resource family | Canonical owner / expected removal | Evidence | Status |
| --- | --- | --- | --- |
| ECS clusters/services/tasks | Terraform topology and exact retained task/cluster IDs; no active service/tasks | Mocked identity, state, residue and convergence checks | PASS locally; AWS UNVERIFIED |
| ECS task definitions | Terraform bootstrap and direct immutable release revisions; inactive history is allowed | Actual producer hooks with injected AWS responses; exact frozen historical revision cleanup and independent checks | PASS locally; AWS UNVERIFIED |
| ALB/listeners/target groups | Exact Terraform-owned IDs, typed absence | Mocked absence/residue/denials | PASS locally; AWS UNVERIFIED |
| Security groups | Owned groups only; shared network excluded | Mocked exact-ID checks | PASS locally; AWS UNVERIFIED |
| EFS/storage and DB runtime | Terraform-owned filesystem/access point/mount targets and independent DB topology | Mocked exact-ID checks, no live deletion | PASS locally; AWS UNVERIFIED |
| Secrets Manager | Terraform DB and DeployGuard runtime secrets; physical absence, not scheduled deletion | Actual local server receipt/intake plus injected observer/runtime cleanup; protected DB recovery is not shortened | PASS locally; AWS UNVERIFIED |
| Cloud Map | Owned namespace/service only | Mocked typed absence/residue | PASS locally; AWS UNVERIFIED |
| IAM roles/policies | Owned execution role; parent absence covers owned children; shared managed policies excluded | Mocked capture/observation | PASS locally; AWS UNVERIFIED |
| CloudWatch | Exact owned log-group name, complete response | Mocked presence/absence/truncation rejection | PASS locally; AWS UNVERIFIED |
| ECR | Exact owned repositories across retained historical and failed attempts | Producer intent/response fixtures and exact frozen deletion/independent absence; unknown legacy provenance blocks | PASS locally; AWS UNVERIFIED |
| Terraform state/lock | Exact project/environment state and `.tflock` keys; bucket shared | Actual v3 producer with injected typed 404/denial/residue/current-lock responses; never force-unlock | PASS locally; AWS UNVERIFIED |

## Resolved local integration and outstanding release gates

The local workflow no longer constructs optimistic v2 flags or limits cleanup
authority to selected LIVE services. It produces identifier-only evidence joined
with server receipts, validates current Terraform coverage, cleans exact frozen
out-of-Terraform IDs and emits independently observed v3 proof. Actual producer
output round-trips through the existing strict backend. Interruptions before final
upload and unresolved/lost write responses intentionally remain non-deletable;
pre-write intent is not a complete physical resource inventory.

Publication/activation of the immutable candidate requires approval. Real AWS
account/region/resource lifecycle, IAM compatibility, eventual convergence and
absence remain UNVERIFIED. Protected database-secret scheduled deletion must reach
physical absence before proof; this work does not shorten recovery or add a new
persistent-data deletion policy. No unresolved critical local check remains in
the completed integration gate; external release approval is not implied.

Historical runs cannot acquire missing provenance merely by changing a JSON
version. A stricter versioned contract must reject unprovable legacy destruction
until approved ownership recovery. This compatibility-affecting decision was
approved by the owner on 2026-10-10. Local replacement work is authorized;
publication and AWS execution still require separate approval.
Historical manual recovery and retention/offboarding policy remain roadmap C8;
there is no approved automatic adoption mechanism. S02 is blocked by G0 founder
approval of the PROPOSED PRD and applicable compatibility decisions.

## Prerequisites for later milestones

- Intelligence Harness: complete M0 and approved requirements; M0S permission,
  ownership and safety controls; versioned source/build/ENV evidence, freshness,
  uncertainty and redaction; explicit optional AI consent/provider/retention/cost
  decisions. Existing troubleshooting code is not complete Harness certification.
- Multi-client workflow: approved agency/client/environment ownership model,
  per-client state/secret/resource isolation and negative authorization tests,
  account/BYOC strategy, quotas/cost attribution, audit and handoff contracts.
  Current project RBAC is not multi-tenant certification.
- AWS cleanup verification: owner-supplied account, region and exact disposable
  project; separately approved read scope, lifecycle mutations/destruction, spend
  bounds and teardown; exact published producer SHA/fingerprints and fixture caller.
  This work remains pending as explicitly requested.

Skills used: `deployguard-build` bounded this local integration; `writing-for-agents`
removed obsolete documentation-only pauses without approving future features.
`aws-infrastructure-auditor` constrained exact ownership and evidence
labels; `lifecycle-certifier` drove transition/retry checks;
`architecture-consistency-auditor` constrained canonical contracts;
`investigate` constrained dependency fixes to reproduced defects and audited,
same-major versions, with failing-before/passing-after regression evidence;
`review` drove adversarial security/concurrency/diff review and the explicit
legacy-compatibility approval boundary in earlier slices. Final self-review traces
producer/consumer authority, security, bounded I/O, conditional Bash failures,
await-boundary identity, lock/idempotency and stale-row deletion races. No new
dependency, schema migration, product feature or unrelated owner edit was added;
this is not an external independent review or AWS/release approval.
