# M0.2 — independent deletion observation (local, read-only)

The observer is a bounded verification component, **not** certification of the
existing destroy workflow and **not** authorization to destroy AWS resources.
It adds no dependency and changes no deployment, database, or Terraform contract.

`infrastructure/railpack-runtime/observe-deletion.mjs` exposes:

- `captureDeletionManifest(terraformShowJson, scope)` to retain only exact owned
  resource identifiers from a **pre-destroy** Terraform state snapshot. Its scope
  contains project ID, destroy operation ID, environment, generation IDs, region,
  and AWS account ID. Tagged ownership or an owned parent is required. Shared
  data sources and secret values never enter the resulting manifest. Unknown
  managed resource types and empty snapshots fail closed.
- `observeDeletion(manifest, readOnlyAwsRunner, options)` to observe every listed
  resource independently. It checks STS account identity before resource calls,
  accepts only typed resource-specific not-found responses, validates exact ECS
  identity and state, and bounds retries for resources that remain present or
  return a recognized transient error. Authorization/identity failures do not
  retry. The observer snapshots its input before asynchronous provider reads.

Explicit read-only CLI usage with a previously retained, trusted manifest:

```sh
node infrastructure/railpack-runtime/observe-deletion.mjs --manifest retained-manifest.json
```

The command prints a structured observation report and exits nonzero unless all
listed resources satisfy their absence/deregistration contracts. `PASS` is scoped
only to those identifiers; it does not prove manifest completeness, all project
generations removed, control-plane cleanup, or AWS end-to-end success. It does
not emit `deployguard.destroy-result/v2` or advance any release/project state.
No real AWS invocation was performed during this milestone.

## Tested boundaries

| Resource family | Owner / removal expectation | Local evidence |
| --- | --- | --- |
| ECS clusters/services | Terraform; missing/inactive, no service running/pending tasks | PASS, mocked exact IDs; deleted-cluster errors require separate exact-cluster absence proof |
| ECS task definitions | Terraform bootstrap; revision inactive (AWS retains history) | PASS, mocked active/inactive revisions |
| Individual ECS tasks | Exact retained task ARN and cluster; actual STOPPED or exact MISSING, not merely desired STOPPED | PASS, mocked identity/state/residue/convergence; deleted-cluster error requires exact MISSING cluster proof |
| ALB/listeners/target groups, security groups | Terraform; typed absence | PASS, mocked absence and residue |
| EFS file systems/access points/mount targets | Terraform; typed absence | PASS, mocked absence and residue |
| Managed DB/runtime Secrets Manager secrets | Terraform / DeployGuard respectively; physical absence, not merely scheduled deletion | PASS, mocked absence and scheduled-delete residue |
| Cloud Map namespace/service | Terraform; typed absence | PASS, mocked absence and residue |
| IAM execution role / its policies and attachments | Terraform; role absence proves owned children removed; shared AWS-managed policy is excluded | PASS, mocked observation and capture/delegation |
| CloudWatch groups | Terraform; exact-name absence, no truncated response | PASS, mocked exact-name and pagination checks |
| ECR repository | DeployGuard; exact-name typed absence | PASS, mocked absence and residue |
| State and `.tflock` objects | Terraform backend / DeployGuard cleanup; exact-key typed 404, not 403 | PASS, mocked both objects; bucket itself never selected |

Tests use an injected AWS runner; no credentials or AWS resources are used.
Malformed responses, empty mock-mode payloads, denied access, expired credentials,
wrong accounts, unknown scopes, duplicate IDs, and empty post-destroy snapshots
cannot certify deletion. Capture tests cover every current `main.tf` managed
resource type, including explicit parent delegation and local random passwords.

Run `npm --prefix backend run test:independent-aws-deletion`.

### M0.6 quality review

The observer accepts the same environment-name grammar as the backend, including
digit-first names of at most 40 characters. Scope fields and resource types must
be actual strings; implicit array/numeric coercion fails before provider access.
Task observations reject foreign identities, contradictory failures, pagination,
missing states and duplicate tasks. Retries clear stale diagnostics and remain
bounded. CLI parse/validation errors reveal no manifest bytes or stack traces.
The module is importable through Node 22 without executing the CLI.

The production runtime-secret SDK client now releases its HTTP connections on
Nest module shutdown. Its PostgreSQL regression fixture always stops its own
container even if database teardown fails. No dependency or workflow pin changed.

## M0.4 — retained ownership evidence transport (local)

`retain-deletion-manifest.mjs` now stores validated identifier manifests as
immutable, content-addressed local snapshots. It publishes complete bytes
atomically, synchronizes them to disk, and returns a SHA-256 receipt. Repeating
the same manifest with reordered resources is idempotent; corrupt same-name
objects are never overwritten. Unexpected root fields (including raw state or
secret payloads) are rejected by the shared manifest validator.

The caller must retain **every receipt** in its authoritative durable operation
history before destructive work. Restoration takes exact receipts rather than
discovering files/tags, verifies each object's hash and schema, and unions all
resources. It allows a new retry operation ID but requires unchanged project,
environment, account and region, and an exact union of recorded generation IDs.
Lost/corrupt objects, generation narrowing/widening, conflicting resource parents,
or symlinked stores/objects fail closed. Partially removed or empty current
Terraform state is not an input to restoration and cannot erase prior evidence.

Local API:

```js
const receipt = retainDeletionManifest(evidenceDirectory, ownedManifest);
// Persist receipt durably in the canonical operation history before mutation.
const retained = restoreDeletionManifest(evidenceDirectory, retryScope, allReceipts);
const observation = await observeDeletion(retained, readOnlyAwsRunner);
```

The transport CLI can retain a previously captured manifest or restore one from
a request containing `{scope, receipts}`:

```sh
node infrastructure/railpack-runtime/retain-deletion-manifest.mjs --retain owned-manifest.json --directory retained-evidence
node infrastructure/railpack-runtime/retain-deletion-manifest.mjs --restore retry-request.json --directory retained-evidence
```

Both print identifier-only JSON. Restore output is compatible with the existing
observer's `--manifest` input. The retention CLI performs local file writes only;
it never calls AWS, Terraform, GitHub, or a control-plane finalizer.

This is a tested evidence transport, **not yet production persistence**. Local
hash integrity is not an authenticated ownership claim, and caller-supplied
receipts do not prove inventory completeness. Tests supply direct/historical
task revisions, ECR, runtime secrets, and exact state/lock keys explicitly;
production collectors and durable receipt retention are still required. No
workflow currently calls this component, no backend deletion rule changed, and
no new destroy-result contract or cloud executable fingerprint was certified.

`test:independent-aws-deletion` runs both observer and retention checks and is now
included in `test:pre-final-certification` so the new regressions cannot be
omitted from that gate. Tests cover real temporary filesystem operations and
concurrent CLI publication; AWS observation remains injected/mocked.

## M0.5 — production runtime-secret ownership journal

The actual `RailpackDeploymentService.dispatch` path now supplies a mandatory
durable recorder to `GithubActionsRuntimeSecretService.materialize`. The recorder
inserts new rows in existing `project_pipeline_events` (source
`runtime_secret_ownership`); there is no schema migration or second release
authority. Rows contain identifier-only
`deployguard.runtime-secret-ownership/v1` evidence and a SHA-256 receipt. Hashing
sorts the flat evidence keys so PostgreSQL JSONB ordering does not invalidate it.

- `intent` is committed before provider work. It retains project, operation,
  service, environment, configured AWS account/region, exact secret name and
  immutable version token. A create whose response is lost leaves an intent,
  **not** an invented owned ARN or deletion authority.
- `owned` is committed after creation returns its ARN or an existing secret's
  exact namespace/ownership tags are validated, before any existing-secret
  restore/version mutation. ARN account/region/name must match the admitted scope.
  This proves a recorded identity, **not** materialization success or absence.
- Rows are inserted, never rewritten by this collector, and survive run-metadata
  replacement, terminal failure, compensation and a new retry operation. As with
  existing event history, they cascade only when verified control-plane deletion
  removes their project/operation; database administrators are not cryptographically
  prevented from editing them. Hashes are integrity receipts, not signatures.
- Persistence/scope failure blocks dispatch. The failure is platform-owned and
  `NOT_SAFE_YET`; restore persistence/scope and reconcile any ambiguous provider
  write first. Secret values, environment payloads, raw database errors and raw
  provider exceptions do not enter the journal or public diagnostic.
- A valid post-create identity remains compensable when receipt insertion fails;
  an invalid/cross-account identity never becomes a compensating-delete candidate.
  Ambiguous version writes retain their prior-version candidate before the write.
  Existing compensation stays disabled after possible remote workflow acceptance.

`npm --prefix backend run test:runtime-secret-ownership` exercises real PostgreSQL
after all 111 migrations, actual journal inserts, JSONB receipt stability, failure
and retry retention, an ambiguous mocked create, and a database-triggered receipt
failure after mocked creation. Provider calls and compensation are injected;
these tests do not change AWS resources. The check is part of the pre-final gate.

This closes one production collector boundary only. No historical backfill,
Terraform/ECR/direct-ECS collector, complete inventory reader, or destroy
finalization integration is implemented here. The local manifest transport from
M0.4 remains separate: a future complete collector must validate these journal
receipts and translate eligible identities into retained manifests. An intent
requires exact-name ownership reconciliation; it must never be converted to an
owned-resource manifest merely because creation was attempted. Legacy operations
without journals cannot claim complete coverage. Existing destroy-result/v2
success flags remain unverified until the complete observer gate is integrated.

## Remaining release blocker / next bounded integration

The existing destroy workflow still constructs its v2 success booleans without
this observer. Do not treat that artifact as independent AWS deletion proof.
Before wiring or publishing a changed executable workflow:

1. Integrate the local retention transport with authoritative durable operation
   history and complete immutable pre-destroy ownership manifests, including failed
   creates, every generation, externally registered active/historical ECS
   revisions, runtime secrets, ECR repositories, and exact state/lock keys.
   Terraform state alone does not describe all direct ECS release revisions or
   non-Terraform resources. Missing provenance/completeness must remain a blocker.
2. Retain those manifests through partial destroy and cleanup retries. Never
   recapture an empty state and infer that no resources existed.
3. Run the observer after existing Terraform/non-Terraform cleanup and persist
   resource-specific observations. Finalize only after complete verified scope;
   do not turn provider errors or missing evidence into success flags.
4. Pass producer/consumer contract tests, update certified 64-character SHA-256
   fingerprints, publish an exact 40-character control-plane commit, and pin
   the fixture caller to it. The standalone observer is not yet a certified
   executable in the dispatched reusable workflow; existing fingerprints remain
   unchanged.
5. Obtain explicit approval for a scoped disposable AWS lifecycle exercise and
   collect exact-SHA deploy/redeploy/rollback/destroy evidence. Neither mocked
   tests nor local database migrations constitute AWS E2E proof.

## M0.10 — approved v3 consumer boundary

The owner approved stricter versioned destruction and fail-closed historical
deletion. The backend now rejects v2 success flags as cleanup authority. V3 binds
the exact frozen manifest and retained journal receipts to operation identity and
to a complete per-resource observer report. The observer records explicit
`absent`, `inactive` or `stopped` bases; denial, arbitrary provider codes, missing
resources and narrowed reports cannot satisfy the consumer. State and `.tflock`
must both be included. Cleanup eligibility is shared by finalization, retry,
current-state projection and notifications.

Local injected observer-to-consumer tests and the full release gate pass. Complete
production Terraform/ECR/direct-ECS collection, durable receipt revalidation and
the changed executable workflow are still pending. The existing dispatched
workflow and certified fingerprints remain unchanged. Legacy records are not
backfilled or granted authority by a JSON version change. No AWS execution or
publication is authorized by this approval.

## M0.11 — durable cleanup revalidation

The same bounded authority reader now serves admission and cleanup. Before any
SNS/GitHub cleanup and again under the final configuration/operation DB locks,
the service restores all retained operation journals and compares their complete
normalized union/receipts to the immutable frozen ownership. Missing, corrupt,
duplicate or changed records and late failed attempts block cleanup. Actual
PostgreSQL tests exercise receipt drift at both boundaries and preserve history
on failed final revalidation. Provider calls remain outside transactions.

Canonical revision/secret omission checks and complete production collection are
still pending. Durable revalidation proves consistency with retained journals,
not that a future producer has captured every resource. AWS remains unverified.
