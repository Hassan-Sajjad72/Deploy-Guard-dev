# M0 verified local report

2026-10-10, Asia/Karachi. **M0 is not release-ready.** Local M0.1–M0.13 slices
passed their checks. The owner approved the stricter v3 destroy contract and
fail-closed historical deletion. M0.10 adds its backend guard; complete production
ownership collection and workflow integration remain unresolved.
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
| Deletion observer | Standalone exact-ID read-only observer for 18 resource types, typed absence/state checks, bounded convergence/transient retries, denial rejection, strict scope, immutable caller snapshot and safe CLI diagnostics. AWS calls are injected in tests. |
| Manifest transport | Atomic, immutable, content-addressed local retention; exact receipt restoration/union; corrupt/missing/narrowed/conflicting/symlinked evidence fails closed. This is not production inventory persistence. |
| Deletion scope | v3 requires complete frozen generation/receipt identity and matching per-resource observations. Historical v2 flags cannot authorize admission, cleanup, state projection or success notifications. No mutable-context reconstruction. |
| Cleanup concurrency | Pending terminal cleanup blocks new lifecycle admission. Actual DB deletion holds configuration/operation locks, revalidates eligibility, and rejects active operations or generation drift before cascading project authority. |
| Durable cleanup authority | Admission and cleanup share one bounded reader. Actual retained journal receipts are restored before SNS/GitHub cleanup and again inside the locked final transaction; missing, corrupt, duplicated, changed or late-attempt authority blocks deletion. Network calls remain outside transactions. |
| Canonical inventory minimum | Complete-family declarations cannot omit retained application/task revisions, pinned runtime secrets or independent database identities. Existing secret intent/owned receipts are validated, without retaining secret values. Whole-project deletion rejects other-environment history/configurations/generations rather than silently cascading their evidence. This is a minimum cross-check, not complete producer inventory certification. |
| Dependency release gate | Targeted locked-version fixes, proxy/IP and bounded indexed-source-map regressions; backend/frontend full `npm audit` reports zero vulnerabilities, including development tooling. Registry failure or any finding fails the aggregate gate. |

NestJS modular monolith, React/Vite, PostgreSQL and existing deployment contracts
remain. No Kestra, Kubernetes, microservices, features, new dependencies or schema
migrations were added. The dispatched reusable workflow and its nine certified
executable byte hashes are unchanged; the local fixture pin remains
`df86ae471140f8fcb8cc893316b64faf8ca37b56`. Neither the standalone observer nor
transport is presented as a certified cloud workflow integration.

## Check results and evidence

| Check | Result / evidence type |
| --- | --- |
| Backend/front-end builds | PASS, local compilation/bundle |
| Full pre-final gate after each final bounded slice | PASS; latest exit 0 in `/tmp/deployguard-m0-canonical-coverage-pre-final.log` |
| Backend/full frontend regressions | PASS, current supported consumers and behavior |
| PostgreSQL migrations/integration | PASS, 111 real migrations in disposable local DBs; isolation, constraints and cascades |
| Cleanup DB contention | PASS, actual service/repositories and second PostgreSQL connection; shared admission lock and authority-row lock contention |
| Playwright full stack | PASS, local Nest/React/PostgreSQL; 9 API mutations, 5 browser surfaces; GitHub selection remains EXPECTED BLOCKER |
| Workflow lint/contracts | PASS, actionlint/ShellCheck and producer/consumer checks; not remote execution |
| Terraform | PASS, fmt/validate and seven mocked product scenarios; no apply/destroy against AWS |
| Lifecycle/property tests | PASS, 1,000 lifecycle model sequences and 250 runtime properties plus real method fixtures |
| Architecture/dependency checks | PASS, zero dependency violations and no active legacy executable references |
| Clean locked installation / dependency security | PASS, backend/frontend default `npm ci` in a separate shallow checkout; both full audits report 0 vulnerabilities; actual consumer regressions pass |
| Additional checks outside aggregate | PASS, direct ECS redeploy/rollback mocks, requirements, export, billing/Stripe/migration, notifications, Trivy and extra frontend regressions; `/tmp/deployguard-m0-extra-checks.log` |
| Root canonical environment | PASS unchanged against a separate credential-free fixture and owned local DB; initially failed with the unsuitable pin-only environment. No production environment was overwritten. |
| Independent archive compatibility review | PASS, standard stored/deflated ZIPs including streamed data descriptors; injected HTTP only |
| Real AWS/GitHub deployment lifecycle | UNVERIFIED, explicitly deferred |

No failing check was disabled or assertion removed to obtain these results.
Baseline defect reproductions and fixture-configuration failures remain recorded
in the progress log. The latest gate used fresh default `npm ci` installations
from reviewed locks, through task-owned symlinks; original dependencies were not
modified. Terraform 1.10.5 was fetched from HashiCorp with its published checksum
verified and used for the entire latest gate, matching the workflow pin. Earlier
gates used 1.15.8. This is local version parity, not AWS execution.
There is no configured general TS/React lint task; available compilation,
architecture checks, workflow lint and regression tests were run, not relabeled
as a nonexistent lint result.

## Lifecycle certification boundary

| Action | Admission/result/local transition | External execution | Status |
| --- | --- | --- | --- |
| Deploy | Exact source/service/config identity; validated result required before stable promotion; prior healthy release retained on failure | Not run | PASS locally; AWS UNVERIFIED |
| Redeploy | Exact immutable inputs and direct ECS revision fixtures; one correlated dispatch, no unsafe secret compensation | Mocked only | PASS locally; AWS UNVERIFIED |
| Rollback | Complete historical image/runtime revision set, no rebuild/current-config substitution; verification precedes promotion | Mocked only | PASS locally; AWS UNVERIFIED |
| Destroy | Strict v3 receipt/observation guard; legacy v2 cannot authorize admission, retry cleanup, state or success notifications | Not run; complete production collector and producer integration absent | Backend fail-closed locally; end-to-end release remains blocked |

## Resource-specific cleanup evidence

The observer checks identifiers only from a retained owned manifest. A subset PASS
does not prove manifest completeness or all historical/failed attempts cleaned.

| Resource family | Canonical owner / expected removal | Evidence | Status |
| --- | --- | --- | --- |
| ECS clusters/services/tasks | Terraform topology and exact retained task/cluster IDs; no active service/tasks | Mocked identity, state, residue and convergence checks | PASS locally; AWS UNVERIFIED |
| ECS task definitions | Terraform bootstrap and direct immutable release revisions; inactive history is allowed | Mocked exact revision checks; complete historical collector absent | Local observer PASS; complete cleanup UNVERIFIED |
| ALB/listeners/target groups | Exact Terraform-owned IDs, typed absence | Mocked absence/residue/denials | PASS locally; AWS UNVERIFIED |
| Security groups | Owned groups only; shared network excluded | Mocked exact-ID checks | PASS locally; AWS UNVERIFIED |
| EFS/storage and DB runtime | Terraform-owned filesystem/access point/mount targets and independent DB topology | Mocked exact-ID checks, no live deletion | PASS locally; AWS UNVERIFIED |
| Secrets Manager | Terraform DB and DeployGuard runtime secrets; physical absence, not scheduled deletion | Mocked checks plus real local runtime-secret ownership journal | Partial collector PASS; complete AWS cleanup UNVERIFIED |
| Cloud Map | Owned namespace/service only | Mocked typed absence/residue | PASS locally; AWS UNVERIFIED |
| IAM roles/policies | Owned execution role; parent absence covers owned children; shared managed policies excluded | Mocked capture/observation | PASS locally; AWS UNVERIFIED |
| CloudWatch | Exact owned log-group name, complete response | Mocked presence/absence/truncation rejection | PASS locally; AWS UNVERIFIED |
| ECR | Exact owned repositories across historical and failed attempts | Mocked checks; complete production collector absent | Local observer PASS; complete cleanup UNVERIFIED |
| Terraform state/lock | Exact project/environment state and `.tflock` keys; bucket shared | Mocked typed 404 vs denial/provider-error checks | PASS locally; producer cleanup still defective; AWS UNVERIFIED |

## Unresolved critical release blocker

The unchanged reusable workflow constructs destroy v2 success booleans after
Terraform destroy and limited LIVE-service cleanup. Its state-head failure can
be mistaken for absence, and it lacks complete retained Terraform/ECR/direct-ECS
ownership/observation evidence across every successful, failed and historical
attempt. The backend now rejects these v2 flags rather than treating them as
independent proof. The v3 guard consumes a frozen manifest and exact observer
result, but no complete production Terraform/ECR/direct-ECS journal is emitted or
ingested yet. Current historical runs therefore fail closed before destroy
admission. Local positive fixtures simulate retained coverage; they do not certify
that the production workflow collects every owned resource or contacts AWS.

Required replacement: complete server-authoritative ownership coverage, durable
pre-mutation receipts surviving partial failure/retry, exact restoration, and an
identity-bound observer result covering every retained resource. Missing evidence,
unresolved creation intents, partial/truncated reads, residue and authorization
errors must block completion and cleanup. No broad tag/name discovery may become
deletion authority, and no empty post-destroy state may erase history.

Historical runs cannot acquire missing provenance merely by changing a JSON
version. A stricter versioned contract must reject unprovable legacy destruction
until approved ownership recovery. This compatibility-affecting decision was
approved by the owner on 2026-10-10. Local replacement work is authorized;
publication and AWS execution still require separate approval.

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

Skills used: `aws-infrastructure-auditor` constrained exact ownership and evidence
labels; `lifecycle-certifier` drove transition/retry checks;
`architecture-consistency-auditor` constrained canonical contracts;
`investigate` constrained dependency fixes to reproduced defects and audited,
same-major versions, with failing-before/passing-after regression evidence;
`review` drove adversarial security/concurrency/diff review and the explicit
legacy-compatibility approval boundary. Local review is complete with the above
critical concern; M0 completion/release approval is not claimed.
