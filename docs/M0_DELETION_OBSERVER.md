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
  identity and state, and bounds retries for resources that remain present.

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

## Remaining release blocker / next bounded integration

The existing destroy workflow still constructs its v2 success booleans without
this observer. Do not treat that artifact as independent AWS deletion proof.
Before wiring or publishing a changed executable workflow:

1. Persist complete immutable pre-destroy ownership manifests, including failed
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
