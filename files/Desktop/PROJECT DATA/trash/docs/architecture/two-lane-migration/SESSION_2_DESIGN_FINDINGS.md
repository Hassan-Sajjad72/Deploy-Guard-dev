# DeployGuard Two-Lane Migration — Session 2 Design Findings

## A. Session result

Contracts are frozen for design version `1`. No implementation was performed.

## B. Infrastructure manifest

The frozen schema is an immutable, per-project/environment infrastructure
revision with canonical spec/hash, Terraform plan/apply integrity, state
identity, sanitized outputs, and explicit desired/applied/superseded/destroyed
states.

## C. Release manifest

The frozen schema binds repository commit, deployment contract, configuration
snapshot, build/runtime fingerprints, image digest, task definition, health
evidence, and promotion history to one exact infrastructure manifest.

## D. Intent and idempotency

Every mutation is represented by a durable deployment intent. The client key is
namespaced and hashed; the request fingerprint prevents reuse with a different
payload. Duplicate identical requests return the original intent. Queue delivery
is at-least-once; side effects are fenced and idempotent.

## E. Revision relationship

Infrastructure and release revisions are independent and immutable. Release-only
reuses the applied infrastructure revision. Infrastructure change creates a new
infrastructure revision and optionally a release blocked until apply completes.
Rollback creates a new release revision.

## F. Transactional planner

The planner runs in a serializable PostgreSQL transaction under a per-project
environment advisory lock. It snapshots DB-owned inputs, classifies, allocates
revisions, creates run/snapshot links, and writes an outbox row. It performs no
external work and does not publish to BullMQ inside the transaction.

## G. Locks

The frozen order is planner transaction → deletion fence → durable operation
lease/fencing token → infrastructure apply advisory lock → persisted Terraform
state lock → S3 native lockfile → short release-promotion lock. Terraform and
release promotion locks are never held together.

## H. BullMQ compatibility

New jobs use a strict `deployguard.worker` v1 envelope, deterministic job ID,
payload hash, lane routing, manifest/intent identities, expiry, and no secrets.
Live worker capabilities are registered before the outbox dispatcher may
publish. Legacy jobs remain protocol `legacy/0` on a distinct queue.

## I. Backfill

Backfill is an explicit, default-dry-run, PostgreSQL-only command. It is
idempotent and conservative: ambiguous evidence becomes `manual_review`;
missing digests and health proof remain unknown. It never enqueues work or calls
cloud services.

## J. Canonical state

The state contract is versioned and separates desired/applied infrastructure,
desired/stable release, active operation, state safety, recovery, progress,
primary action, and winning evidence. A persisted state revision makes cache
invalidation monotonic across backend instances.

## K. First implementation milestone

Session 3 milestone 1 is limited to:

- four additive migrations;
- seven entities plus pure contract types/validators;
- legacy nullable foreign-key links;
- module/data-source registration;
- static migration/contract tests.

It does not alter controllers, current workers, queues, infrastructure
execution, ECS behavior, current-state output, Terraform, or frontend code.

## L. Release-controller boundary

The release controller is intentionally not designed internally or implemented
in Session 2. Its inputs and outputs are constrained by the frozen manifest,
intent, lock, and queue contracts. Detailed release-controller design begins
only after milestone 1 is implemented and verified.

## M. Source alignment

The design preserves:

- existing repository deployability contract
  (`backend/src/projects/project-deployment-contract.entity.ts:54-214`);
- immutable configuration snapshots
  (`backend/src/projects/project-configuration-snapshot.entity.ts:5-29`);
- pipeline execution records
  (`backend/src/projects/project-pipeline-run.entity.ts:61-175`);
- Terraform state key/lock safety;
- exact-plan apply protections;
- stage checkpoints;
- ECS rollback/stable-release history;
- guarded lifecycle destroy.

## N. Documents

- `SESSION_2_FROZEN_CONTRACTS.md`
- `SESSION_2_LOCKS_AND_QUEUE_PROTOCOL.md`
- `SESSION_2_BACKFILL_AND_MILESTONE_1.md`
- `SESSION_2_DESIGN_FINDINGS.md`

## O. Safety statement

Session 2 changed documentation only. It did not modify production source,
entities, migrations, public APIs, frontend, runtime behavior, database, queue,
Terraform, AWS, GitHub, secrets, deployments, approvals, state, or cleanup.

