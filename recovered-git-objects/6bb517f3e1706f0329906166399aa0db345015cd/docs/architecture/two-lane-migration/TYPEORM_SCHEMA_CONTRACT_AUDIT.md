# TypeORM schema contract audit

Date: 2026-07-30

## Outcome

The current application database was not modified. A data-bearing disposable
clone now has an empty TypeORM `schema:log` after entity-only metadata
corrections and four guarded additive compatibility migrations. A newly
migrated empty database still has 520 constraint/index proposals. Those
remaining statements are intentionally retained because their foreign-key and
index semantics are not yet proven safe to remove or replace.

The authoritative decisions completed in this package are:

- identifiers that reference DeployGuard records are UUIDs in PostgreSQL and
  remain TypeScript/API strings at the application boundary;
- JSON defaults are modeled as JSON values rather than SQL-producing callback
  strings, and numeric/timestamp defaults match the migrated database;
- the historical fencing, execution-lane, worker-protocol and initial-service
  hash checks are required runtime invariants;
- `project_stage_checkpoints.id` is the primary key;
- the side-effect journal foreign keys and unique indexes are part of the
  entity contract with their existing definitions and delete rules.

`synchronize` remains prohibited.

The audit also found that the development HTTP composition still defaulted
TypeORM synchronization on, and the example environment advertised the same
unsafe value. The application composition is now hard-coded to
`synchronize: false`, and the example configuration is false. Migration
execution is the only schema-change mechanism.

## Root-cause groups and decisions

### Current-clone 60-statement inventory

Every original current-clone statement maps to the following 17 tables. The
database definitions were already correct; the entity model was incomplete or
used a TypeORM default representation that its PostgreSQL comparator cannot
round-trip.

| Tables | Statements | Evidence and correction | Classification |
| --- | ---: | --- | --- |
| `deployment_side_effects` | 7 | Three existing validated `RESTRICT` foreign keys and two existing unique indexes were added to metadata as `@ForeignKey`/`@Index`; no SQL change. | entity metadata defect |
| `deployment_side_effect_reconciliations` | 9 | Four validated `RESTRICT` foreign keys and two unique indexes were modeled; `inspection_started_at = now()` was added to metadata. | entity metadata defect |
| `deployment_side_effect_reconciliation_leases` | 6 | Three validated `RESTRICT` foreign keys plus the existing origin/acquired/heartbeat defaults were modeled. | entity metadata defect |
| `project_configuration_snapshots` | 11 | Eleven JSON defaults changed from SQL callback strings to JSON metadata values; stored/default values are unchanged. | entity metadata defect |
| `project_deployment_contracts` | 8 | Eight JSON-array defaults use JSON metadata values. | entity metadata defect |
| `project_deployment_requirements` | 6 | Object/array defaults use JSON metadata values. | entity metadata defect |
| `worker_capabilities` | 2 | Array/object defaults use JSON metadata values. | entity metadata defect |
| `cloud_inventory_scans` | 2 | Array defaults use JSON metadata values. | entity metadata defect |
| `project_service_bindings`, `projects`, `ai_analysis_results`, `emergency_cleanup_operations`, `cloud_cleanup_operations`, `project_cloud_states`, `deployment_intents`, `infrastructure_manifests`, `project_operation_leases` | 9 | JSON or decimal defaults were expressed in the TypeORM form that compares equal to PostgreSQL. | entity metadata defect |

This accounts for ten foreign-key drops, four index-to-constraint replacements,
38 same-semantic default rewrites and four proposed default removals: all 60
statements.

### Identifier types

Forty legacy reference columns across 25 tables were inferred as `varchar`
because their entity properties are TypeScript strings. Historical migrations,
referenced primary keys, UUID-shaped API values, joins and query parameters all
identify them as UUID references. The data-bearing clone contained 1,658
examined values: 1,209 non-null UUIDs, 449 nulls and zero invalid values.

Migration `1760000050000` validates every column and all stored values before
taking an alteration lock, accepts only `varchar`/`text`/already-`uuid`,
and uses an in-place `USING column::uuid` conversion. It fails atomically for
missing columns, unexpected types or incompatible rows.

Classification: entity metadata defect plus genuine production schema defect.

### Defaults

Six clean-bootstrap defaults disagreed with both current metadata and the
operational schema: encryption version `0` versus `1`, billing
`demo/demo` versus `none/not_configured`, and an obsolete cloud-state
reason default. Runtime writers explicitly use the authoritative values.

Migration `1760000051000` accepts only the exact historical or target default,
changes future insert behavior without rewriting rows, and fails on any third
state.

Classification: historical migration defect.

### Checks and primary key

Five historical checks protect destroy fencing, legacy execution lane,
protocol/fence positivity and first-service identity hashes. Clone violation
counts were zero. Migration `1760000052000` validates the exact existing
definition or adds each check `NOT VALID` and then validates it. Metadata now
contains the same checks.

The fresh bootstrap omitted the primary key on
`project_stage_checkpoints.id`. Migration `1760000053000` proves no null or
duplicate IDs and adds the exact primary key; an existing different primary
key fails closed.

Classification: genuine production schema defects.

### Remaining clean-bootstrap constraint/index output

After the proven corrections, the fresh database has no column, type,
nullability, default, sequence or check proposal. Its remaining 520 statements
are:

| Proposed operation | Count | Contract decision |
| --- | ---: | --- |
| Drop foreign key | 145 | 84 have identical structure/delete rules and differ only in name; 61 exist only in migration DDL. None may be dropped without a per-relation ownership/deletion audit. |
| Add foreign key | 84 | Same 84 definitions as the name-different migrated keys. This is name drift only. |
| Drop unique constraint | 15 | Five are name-only pairs; ten are uniqueness-constraint versus unique-index representation differences. Uniqueness remains enforced. |
| Add unique constraint | 18 | Five are name-only pairs; thirteen correspond to existing unique indexes. No duplicate or enforcement gap is proven. |
| Drop index | 125 | Ninety-four participate in identical-definition name pairs; 31 are migration-only access paths and remain preserved. |
| Create index | 121 | Ninety-four are name-only pairs; 27 are metadata-only access paths requiring workload evidence. |
| Create unique index | 12 | Representation changes from constraints; uniqueness is already enforced. |

The catalog comparison independently found 84 same-definition FK name pairs,
61 migration-only FKs, 94 identical-definition index name pairs, 31
migration-only indexes and 39 metadata-only indexes (the latter includes
unique/index representation differences). These are classified as intentional
legacy compatibility where definitions are equivalent, and insufficient
evidence where an object exists on only one side. No migration is generated
for either class.

The next safe package is limited to the 61 migration-only foreign keys and the
31/39 one-sided indexes: map every relation to owner/delete behavior, run
orphan and query-plan evidence on a production-sized clone, then add missing
metadata/objects. Existing constraints and indexes must not be removed merely
to make `schema:log` empty.

## Data-bearing clone evidence

- Source: a read-only dump of the operational local DeployGuard database.
- Scope: 80 application tables, excluding migration-history rows from the data
  fingerprint.
- Logical before/after comparison: 80 tables compared, zero row-count or
  row-value fingerprint mismatches.
- UUID conversion: 40 columns, 1,209 non-null values, zero invalid UUIDs.
- Safety-check violations: zero across all five predicates.
- Migration replay: no pending migrations on the second run for both the clone
  and fresh database.
- Final current-clone `schema:log`: empty.
- Final fresh `schema:log`: 520 retained constraint/index statements, all
  classified above.
- Current application database: unchanged.

## Bounded family: intent dispatch and ownership

Date: 2026-07-30

This package selected the four-table intent dispatch and ownership family:
`deployment_intents`, `orchestration_outbox`, `project_operation_leases` and
`project_release_lane_ownerships`. These tables form the transactional path
from immutable planning identity through exact outbox publication, operation
fencing and cross-lane exclusion.

Historical migrations `1760000035000`, `1760000038000`, `1760000043000` and
`1760000044000` define 15 foreign keys and 22 indexes for this family. A fresh
migrated database contained all 15 validated foreign keys. The data-bearing
operational-schema clone contained none of them, despite containing valid
relationships. This is a genuine production-schema defect, not evidence that
the constraints are obsolete.

Migration `1760000054000` is the additive repair. For each relationship it
requires matching source/reference types, one exact referenced primary or
unique key, no existing conflicting or differently named equivalent
constraint, and zero orphan rows. It uses a five-second lock timeout, adds
missing keys `NOT VALID`, validates them, and fails the enclosing transaction
on any conflict. It does not delete or rewrite data. It is forward-only because
removing verified lifecycle integrity is not a safe inferred rollback.

### Foreign-key decisions

All foreign keys use `ON UPDATE NO ACTION`. They remain intentionally
database-only in TypeORM metadata. TypeORM's `@ForeignKey` implementation
requires every target entity in each `DataSource`; the planner and worker
fixtures deliberately compose bounded entity sets. Modeling these keys with
class decorators broke that valid composition with `Entity metadata for
DeploymentIntent was not found`. The database migration is therefore the
authoritative integrity contract, and TypeORM's proposed drops must never be
executed.

| Constraint | Ownership and delete contract | Decision |
| --- | --- | --- |
| `FK_deployment_intents_project` | Project owns its intent history; project deletion cascades. | migration contract authoritative; database-only |
| `FK_deployment_intents_user` | Requesting user is optional audit attribution; user removal preserves the intent and clears attribution. | migration contract authoritative; database-only |
| `FK_deployment_intents_infrastructure_manifest` | Optional planning link; manifest removal clears the link rather than deleting intent history. | migration contract authoritative; database-only |
| `FK_deployment_intents_release_manifest` | Optional release link; release removal clears the link rather than deleting intent history. | migration contract authoritative; database-only |
| `FK_deployment_intents_source_run` | Optional legacy source lineage; run removal clears the link. | migration contract authoritative; database-only |
| `FK_deployment_intents_pipeline_run` | Optional execution lineage; run removal clears the link. | migration contract authoritative; database-only |
| `FK_deployment_intents_destroy_operation` | Optional deletion lineage; operation removal clears the link. | migration contract authoritative; database-only |
| `FK_orchestration_outbox_intent` | Delivery belongs exclusively to its intent and cannot outlive it. | migration contract authoritative; database-only |
| `FK_project_operation_leases_project` | Lease belongs to its project scope; project deletion cascades. | migration contract authoritative; database-only |
| `FK_project_operation_leases_intent` | Lease is an execution child of its intent and cannot outlive it. | migration contract authoritative; database-only |
| `FK_project_operation_leases_pipeline_run` | Optional legacy execution correlation; run removal clears it. | migration contract authoritative; database-only |
| `FK_project_operation_leases_destroy_operation` | Optional deletion correlation; operation removal clears it. | migration contract authoritative; database-only |
| `FK_release_lane_ownership_project` | Cross-lane ownership belongs to the project scope; project deletion cascades. | migration contract authoritative; database-only |
| `FK_release_lane_ownership_intent` | Fencing evidence prevents direct deletion of a correlated intent until the correlation is truthfully released. | migration contract authoritative; database-only |
| `FK_release_lane_ownership_operation_lease` | Fencing evidence prevents direct deletion of a correlated operation lease until release. | migration contract authoritative; database-only |

The clone contained 19 intents, 15 outbox records, 47 operation leases and two
ownership histories. All 15 orphan checks returned zero. Every UUID reference
matched a UUID primary key; `requested_by_user_id` and `users.id` both matched
as `int4`. A rollback-only fixture proved that ownership `RESTRICT` blocks
direct intent deletion while project deletion correctly cascades through all
four tables. An injected orphan caused
`INTENT_OWNERSHIP_FK_ORPHAN_CONFLICT:FK_orchestration_outbox_intent`; no family
constraint or migration-history row was partially persisted.

### Index decisions

No selected index was dropped, recreated or duplicated. The normalized clone
contained zero equivalent duplicate index definitions.

| Index | Workload/integrity purpose | Decision |
| --- | --- | --- |
| deployment-intent primary key | Exact intent reads, joins and fenced updates. | entity and migration contract authoritative |
| `UQ_deployment_intent_idempotency` | Server-derived planning idempotency and `ON CONFLICT` recovery. | entity metadata authoritative; fresh unique-index representation is equivalent legacy compatibility |
| `IDX_deployment_intent_project` | Project lifecycle/status reads; 347 observed local scans. | migration contract authoritative and modeled |
| `IDX_deployment_intent_status` | Terminal/nonterminal filtering; 190 observed scans. | migration contract authoritative and modeled |
| `IDX_deployment_intent_request_fingerprint` | Immutable-evidence conflict validation. | migration contract authoritative and modeled |
| orchestration-outbox primary key | Exact dispatch and claim finalization. | entity and migration contract authoritative |
| `UQ_orchestration_outbox_payload` | One frozen message per intent/type/payload. | entity metadata authoritative; fresh unique-index representation is equivalent legacy compatibility |
| `IDX_orchestration_outbox_intent` | Intent/outbox joins and terminal closure; 576 observed scans. | migration contract authoritative and modeled |
| `IDX_orchestration_outbox_dispatch` | Pending/failed availability scan with the exact partial predicate. | migration contract authoritative and modeled |
| `IDX_orchestration_outbox_delivery_claim` | Publishing/expired-claim acquisition; 64 observed scans. | migration contract authoritative and modeled |
| operation-lease primary key | Exact fenced lease reads and heartbeats. | entity and migration contract authoritative |
| `IDX_project_operation_lease_project` | Project-scoped lease inspection. | migration contract authoritative and modeled |
| `IDX_project_operation_lease_intent` | Intent/lease ownership joins. | migration contract authoritative and modeled |
| `IDX_project_operation_lease_status` | Lease cleanup and terminal-state inspection. | migration contract authoritative and modeled |
| `UQ_project_operation_lease_active_scope` | At most one active lane/scope lease; 81 observed scans. | migration contract authoritative and modeled |
| `UQ_project_operation_lease_fencing_token` | Monotonic scoped fence uniqueness; 28 observed scans. | migration contract authoritative and modeled |
| release-lane-ownership primary key | Exact ownership correlation. | entity and migration contract authoritative |
| `UQ_release_lane_ownership_scope` | Exactly one cross-lane owner per project/environment; 16 observed scans. | migration contract authoritative and modeled |
| `UQ_release_lane_ownership_fencing_token` | Scoped ownership fence uniqueness. | migration contract authoritative and modeled |
| `IDX_release_lane_ownership_project` | Project ownership inspection. | migration contract authoritative and modeled |
| `IDX_release_lane_ownership_deployment_intent` | Optional intent-correlation checks. | migration predicate authoritative and now modeled |
| `IDX_release_lane_ownership_operation_lease` | Optional lease-correlation checks. | migration predicate authoritative and now modeled |

The last two indexes are partial in fresh migration history
(`IS NOT NULL`) but full in the operational schema. The metadata now records
the intended partial predicates. The existing full indexes are safe supersets;
there is no demonstrated integrity or workload reason to replace them, so the
operational database remains untouched.

Repository evidence includes 38 source files querying deployment intents, 17
querying outbox state, 26 querying operation leases and 16 querying cross-lane
ownership. There are no production lifecycle-row deletes. Queries use exact
UUID/integer parameters, explicit intent/outbox joins, project/environment
scope and fencing-token predicates consistent with the decisions above.
Authenticated project routes validate `projectId` with `ParseUUIDPipe`; they
do not accept client-controlled intent, outbox, lease or ownership identifiers.
Those internal UUIDs come from persisted rows and frozen worker envelopes, and
remain TypeScript strings bound as PostgreSQL UUID parameters.

### Verification and remaining output

- Fresh database: 55 migrations applied; replay reported no pending migration.
- Data-bearing clone: migration applied and replay reported no pending
  migration.
- Selected-table row counts, complete row fingerprints and status
  distributions matched the unmodified operational database exactly.
- PostgreSQL planner, outbox dispatcher, pre-execution ownership and release
  outcome regressions passed against the disposable clone.
- Fresh `schema:log`: 520 statements. The selected 18 are fully explained:
  15 forbidden database-only FK drops plus three equivalent
  unique-index/unique-constraint representation statements.
- Normalized clone `schema:log`: 15 forbidden database-only FK drops and no
  unexplained selected-family statement.
- The 502 statements outside this family were not changed. The unresolved
  one-sided population is now 46 migration-only foreign keys, 31
  migration-only indexes and 39 metadata-only indexes, plus deterministic
  name/representation differences.
- Operational `mini_paas`: no migration or schema change.
- Live AWS: not used.

The next smallest unresolved family is manifest and release lineage:
`infrastructure_manifests`, `release_manifests`, `initial_release_drafts` and
`project_state_revisions` (19 fresh-log statements). It should receive the same
ownership, deletion, orphan and workload audit before any metadata or database
change.

## Bounded family: manifest and release lineage

Date: 2026-07-30

This package classified the 19 fresh-bootstrap `schema:log` statements for
`infrastructure_manifests`, `release_manifests`, `initial_release_drafts`, and
`project_state_revisions`. These records are the immutable lineage from a
desired/applied foundation through candidate, stable, superseded, and rollback
release manifests. They also preserve the original first-release draft and the
project-scoped read-model invalidation revision.

Historical migrations `1760000034000`, `1760000035000`, and `1760000048000`
are authoritative for 15 foreign keys. A fresh database has those 15 keys; the
data-bearing operational-schema clone had none. This is a genuine integrity
gap, not an instruction to let TypeORM drop valid history-retention keys.
Migration `1760000055000` restores only the missing keys. It takes a five
second lock timeout; requires exactly matching source/reference types and one
referenced primary or unique key; rejects same-name or equivalent differently
named conflicts; proves no orphans; adds each key `NOT VALID`; then validates
it in the same transaction. It is forward-only because removing validated
release-history integrity is not a safe inferred rollback.

### Foreign-key decisions

All keys use `ON UPDATE NO ACTION`. They are intentionally database-only in
TypeORM metadata. Adding TypeORM `@ForeignKey` declarations would require
every referenced entity in bounded planner, release, and current-state
`DataSource` compositions; the earlier intent-family proof demonstrated that
such declarations break valid focused composition. The migration, not
synchronization metadata, is therefore the integrity authority.

| Constraint | Ownership, nullability, and deletion contract | Decision |
| --- | --- | --- |
| `FK_infrastructure_manifests_project` | Non-null project scope owns its infrastructure history; project deletion cascades. | migration contract authoritative; database-only |
| `FK_infrastructure_manifests_parent` | Optional supersession lineage; deleting the predecessor retains the child and clears only the parent pointer. | migration contract authoritative; database-only |
| `FK_infrastructure_manifests_intent` | Optional creation-attribution to the planning intent; history remains if attribution is removed. | migration contract authoritative; database-only |
| `FK_infrastructure_manifests_user` | Optional requesting-user audit attribution; user removal preserves the immutable manifest. | migration contract authoritative; database-only |
| `FK_release_manifests_project` | Non-null project scope owns release history; project deletion cascades. | migration contract authoritative; database-only |
| `FK_release_manifests_parent` | Optional candidate/rollback parent pointer; predecessor removal clears the pointer without deleting immutable child evidence. | migration contract authoritative; database-only |
| `FK_release_manifests_previous_stable` | Optional rollback lineage; predecessor removal clears the pointer, not the successor. | migration contract authoritative; database-only |
| `FK_release_manifests_infrastructure` | Every release has one non-null foundation. `RESTRICT` preserves applied-foundation identity and blocks deletion while any candidate/stable/superseded release refers to it. | migration contract authoritative; database-only |
| `FK_release_manifests_intent` | Optional planner/consumer attribution; intent-history removal clears attribution rather than release evidence. | migration contract authoritative; database-only |
| `FK_release_manifests_pipeline_run` | Optional legacy pipeline correlation; deletion clears only that correlation. | migration contract authoritative; database-only |
| `FK_release_manifests_deployment_contract` | Optional frozen deployment-contract provenance; retention wins over optional source row deletion. | migration contract authoritative; database-only |
| `FK_release_manifests_configuration_snapshot` | Optional frozen configuration provenance; retention wins over optional source row deletion. | migration contract authoritative; database-only |
| `FK_initial_release_draft_intent` | Immutable draft has one non-null originating intent. `RESTRICT` prevents deleting the originating planning history. | migration contract authoritative; database-only |
| `FK_initial_release_draft_infrastructure` | Immutable draft has one non-null frozen foundation. `RESTRICT` prevents deleting the foundation that makes the draft truthful. | migration contract authoritative; database-only |
| `FK_project_state_revisions_project` | Non-null read-model revision belongs to its project scope; project deletion cascades. | migration contract authoritative; database-only |

The clone held seven infrastructure manifests, nine release manifests, and
three immutable drafts. All 15 orphan checks returned zero. Every UUID source
and reference matched its UUID primary key; the optional user attribution
matched `int4` to `users.id`. Release→infrastructure, draft→infrastructure,
draft→intent, release→previous-stable, release→parent, and
infrastructure→parent joins respectively contained 9, 3, 3, 7, 7, and 5
valid rows. Rollback-only clone checks proved release→infrastructure
`RESTRICT` and predecessor `SET NULL`; no clone row was committed or changed.
An injected release `infrastructure_manifest_id` orphan failed with
`MANIFEST_RELEASE_LINEAGE_FK_ORPHAN_CONFLICT:FK_release_manifests_infrastructure`.
The transaction left zero selected constraints and no `1760000055000`
migration-history row in that negative fixture.

### Unique and index decisions

The four remaining selected fresh-log statements add unique *constraints*
where historical migrations created semantically identical unique *indexes*:
`UQ_infrastructure_manifest_revision`, `UQ_release_manifest_revision`,
`UQ_initial_release_draft_intent`, and
`UQ_project_state_revision_scope`. Each has the same ordered columns,
uniqueness semantics, and no predicate. They are equivalent legacy
representations, not structural drift; no duplicate enforcement is added.

All 23 selected physical indexes are present once in the normalized clone.
Their entity and migration definitions agree, including the partial one-current
`applied` infrastructure and one-current `stable` release indexes. No selected
metadata correction, index replacement, or additional index is safe or needed.

| Table | Physical index/constraint purpose | Decision |
| --- | --- | --- |
| `infrastructure_manifests` | Primary key; revision uniqueness; project/status/spec-hash reads; scope/status/creation planning scans; plan fingerprints; one applied foundation per scope. | migration and entity contracts agree; unique representation equivalent |
| `release_manifests` | Primary key; revision uniqueness; project/status/foundation/spec-hash reads; scope/status/creation candidate scans; build/runtime/configuration fingerprints; one stable release per scope. | migration and entity contracts agree; unique representation equivalent |
| `initial_release_drafts` | Primary key; one draft per originating intent; project/environment/creation lookup. | migration and entity contracts agree; unique representation equivalent |
| `project_state_revisions` | Primary key; one invalidation revision per project/environment; project read-model invalidation lookup. | migration and entity contracts agree; unique representation equivalent |

Repository evidence covers transactional planner creation/replay, immutable
manifest validation, initial-release draft identity checks, first- and
later-release candidate/stable lineage, rollback predecessor selection, and
current-state invalidation. Identifiers remain internal persisted UUIDs bound
as typed query parameters; authenticated project boundaries validate only
project UUIDs and do not expose or accept arbitrary lineage mutation IDs.

### Verification and remaining output

- Fresh disposable database: 56 migrations applied; replay had no pending
  migration. All 15 selected keys were already valid historical definitions.
- Data-bearing disposable clone: `1760000055000` added and validated all 15
  missing selected keys. Complete selected-table row counts and row-value
  fingerprints were unchanged: infrastructure `7`/
  `a47230e47c6cbe10f5f8329c6f23d7a4`; release `9`/
  `190f5aeb337fd950cb2a520df4ff476e`; drafts `3`/
  `89cc7179750ccc4cc385907c1c37c1d8`; state revisions `0`/
  `d41d8cd98f00b204e9800998ecf8427e`.
- Clone and fresh replay were no-ops after migration. The guarded orphan
  fixture rolled back atomically as described above.
- Selected-family fresh `schema:log`: 19 statements, all explained: 15
  intentional database-only FK drops and four equivalent unique
  index/constraint representations. The normalized clone has 30 intentional
  database-only FK drops (the prior 15 intent/ownership keys plus these 15),
  and no unexplained selected-family statement.
- Focused planner, later-release, rollback-outcome, and current-state
  regressions passed. The normal-first-release planning script currently fails
  before any database access because its disabled-gate assertion expects
  `fallbackToLegacy: true` while the current declared/runtime contract returns
  `false`; this unrelated legacy-fallback discrepancy is deliberately not
  changed in this schema-only package.
- Operational `mini_paas`: unchanged; its migration count remains 49.
- Isolated evidence: fresh, clone, fail-closed orphan, and rollback-only
  deletion checks. Local evidence: backend regression scripts. Live AWS: not
  used.

The selected family has zero unexplained statements. Of the original 520
fresh-bootstrap statements, 501 remain outside this family. The unresolved
one-sided population is now 31 migration-only foreign keys, 31 migration-only
indexes, and 39 metadata-only indexes, plus deterministic representation/name
differences. The next smallest high-criticality group is release provenance
and stable-projection lineage (`release_image_provenances` and the matching
stable projection records); it should receive the same bounded contract audit
without touching live state.

### Follow-up: retired-legacy planning regression alignment

The schema audit's first-release planning regression is no longer a blocker.
The stale fixtures expected a legacy fallback for disabled/ineligible normal
planning despite the declared and runtime `fallbackToLegacy: false` contract.
Both normal first- and later-release planning services now expose only that
fail-closed value for disabled and blocked states, and their focused frontend
guard confirms that Project Details and Pipeline do not retain a legacy deploy
fallback. This was a test/compatibility correction only: it made no schema,
database, queue, cloud, or release-state change. The next schema family is
unchanged: release provenance and stable-projection lineage.

## Bounded family: release provenance and stable projection

Date: 2026-07-30

This package classified the fresh-bootstrap `schema:log` surface for
`release_image_provenances` and `project_stable_releases`, together with the
directly referenced deployment intent, infrastructure manifest, release
manifest, project, and legacy pipeline-run lineage. These tables are evidence,
not execution control: provenance makes an immutable image digest attributable
to one fenced operation, while the stable projection is the compatibility
read-model for current-state and rollback lineage.

Historical migrations `1760000006000`, `1760000036000`, `1760000042000`, and
`1760000047000` are authoritative. A fresh schema had five historical foreign
keys, but the operational-schema clone retained only TypeORM's equivalent
project key. The four missing retention/integrity keys and one metadata-owned
provenance lookup index are a proven database gap. Additive migration
`1760000056000` repairs only those five objects. It is forward-only: removing
validated immutable evidence relationships is not a safe inferred rollback.

### Foreign-key decisions

All keys use `ON UPDATE NO ACTION`. The four repaired keys intentionally stay
database-only: declaring them in entity metadata would force all referenced
entities into bounded provenance, promotion, rollback, and current-state
`DataSource` compositions. The project key is an equivalent representation:
the clone already owns `project_stable_releases.project_id` through TypeORM's
deterministic `FK_1ab97bde4ebd8c417e4f748a4dd` with the same `CASCADE`
semantics, so the historical `FK_releases_project` is neither recreated nor
renamed.

| Object | Ownership, nullability, and deletion contract | Decision |
| --- | --- | --- |
| `FK_release_image_provenance_intent` | Every provenance row has one non-null generating deployment intent. `RESTRICT` preserves the operation attribution behind an immutable digest. | migration contract authoritative; repaired database-only FK |
| `FK_release_image_provenance_infrastructure` | Every provenance row has one non-null frozen infrastructure manifest. `RESTRICT` prevents losing the foundation identity that makes the image evidence meaningful. | migration contract authoritative; repaired database-only FK |
| `FK_releases_run` | A stable projection may retain optional legacy pipeline correlation. Removing that historical run clears the optional pointer only. | migration contract authoritative; repaired database-only FK with `SET NULL` |
| `FK_project_stable_releases_release_manifest` | A stable/superseded compatibility projection may retain an optional manifest reference. Historical manifest removal clears the projection pointer rather than deleting the read-model history. | migration contract authoritative; repaired database-only FK with `SET NULL` |
| historical `FK_releases_project` / `FK_1ab97bde4ebd8c417e4f748a4dd` | Each projection belongs to one non-null project; project deletion owns the projection lifecycle. | equivalent representation; no duplicate FK |

The data-bearing clone has seven provenance rows and eight stable projections.
All five relationship orphan checks returned zero; the source and referenced
columns are UUIDs and each target has exactly one `id` primary/unique key.
The clone contains seven provenance→intent links, seven
provenance→infrastructure links, one stable→pipeline link, seven
stable→release-manifest links, and eight stable→project links. Rollback-only
deletion checks proved stable-manifest `SET NULL` and provenance-infrastructure
`RESTRICT`. An injected provenance-intent orphan failed migration `1760000056000`
with `RELEASE_PROVENANCE_FK_ORPHAN_CONFLICT:FK_release_image_provenance_intent`;
the transaction rolled back with zero selected constraints and no migration
history row.

### Unique and index decisions

| Object | Workload/immutability evidence | Decision |
| --- | --- | --- |
| `UQ_release_image_provenance_operation` | Image preparation/replay queries resolve the provenance once by `(intent_id, operation_id)`. The fresh unique index and clone unique constraint have identical ordered keys and uniqueness semantics. | equivalent representation; preserve one enforcement path |
| `UQ_release_image_provenance_idempotency` | Reconciliation reuses immutable provenance by `(intent_id, idempotency_key)`. The fresh unique index and clone unique constraint are semantically identical. | equivalent representation; preserve one enforcement path |
| `IDX_release_image_provenance_intent` | Provenance replay/reconciliation begins with the frozen intent and joins to its journal/manifest evidence. The entity declares this non-unique, unpredicated lookup index; the fresh historical schema lacked it while the clone had it. | entity metadata authoritative; added once by `1760000056000` |
| `IDX_project_stable_releases_project_id` / `IDX_1ab97bde4ebd8c417e4f748a4d` | Promotion locks and supersedes projections by project/environment; current-state and rollback read the one current projection by project. Both names represent the same non-unique `project_id` access path. | equivalent representation; no rename or duplicate index |
| `UQ_project_stable_release_scope` | The projection store atomically supersedes then selects one `status = 'stable'` row per project/environment. | migration and entity contracts agree; retain partial unique index |
| `UQ_project_stable_release_manifest_projection` | Promotion locks/reuses one compatibility projection per non-null release manifest, preventing duplicate stable views. | migration and entity contracts agree; retain partial unique index |

`InactiveV1StableReleaseProjectionStore` performs the promotion transaction:
it supersedes the old stable projection, locks/reuses the release-manifest
projection, and selects the one current stable scope. Image preparation,
first-release handoff recovery, and later-release reconciliation use immutable
intent/operation provenance before task-definition or service effects. These
repository reads establish the index order and the retention semantics; no
live workload or cloud inspection was needed.

### Verification and remaining output

- Fresh disposable database: 57 migrations, including `1760000056000`, applied;
  a second migration run reported no pending migration. Its `schema:log`
  reduced from 520 to 519 statements because the entity-owned provenance
  intent index is now present.
- Data-bearing disposable clone: the same migration added and validated the
  four missing database-only keys, preserved the existing equivalent project
  FK/index, and replayed as a no-op. Row counts and complete row fingerprints
  matched the unmodified operational database exactly: stable projections
  `8` / `2c91b4a2cc97e2f8d161919e1a778538`; image provenance `7` /
  `89ebe81e8eaaca1584c37803e5e44dae`.
- The selected fresh family has ten `schema:log` statements, all explained:
  four intentional database-only FK drop proposals, the historical/generated
  project-FK representation pair, the historical/generated project-index
  representation pair, and two unique-index/unique-constraint representation
  pairs. The selected clone surface contains only the four intentional
  database-only FK drop proposals.
- The migration uses a five-second lock timeout, verifies source/reference
  types, exact target keys, existing-name/equivalent conflicts and orphans,
  then adds each missing FK `NOT VALID` and validates it in the same
  transaction. Its negative orphan fixture proves fail-closed atomicity.
- Isolated evidence: fresh migration/replay, clone migration/replay,
  zero-orphan checks, rollback-only deletion checks, and the atomic negative
  fixture. Local evidence: focused provenance, first-release, later-release,
  promotion/rollback, and current-state regression commands (recorded with
  this package). Live AWS: not used.
- Operational `mini_paas` was read only; its migration history remains at 49.

The selected family has zero unexplained statements. The remaining unclassified
one-sided population is 26 migration-only foreign keys, 31 migration-only
indexes, and 38 metadata-only indexes, plus deterministic representation/name
differences already being tracked separately. The next smallest unresolved
family is the remaining planner/current-state support-index group; it should
be selected and audited as one bounded table family rather than normalized by
TypeORM synchronization.

## Bounded family: preparation evidence snapshots

Date: 2026-07-30

This planner/current-state family is `project_detection_profiles`,
`project_deployment_contracts`, and `project_preflight_reports`. It is the
one-row-per-project evidence chain used by detection, deployment-contract
freezing, preflight and normal current-state reads. Pipeline/deployment history
is deliberately deferred to its own status-history family.

All five fresh foreign-key drop proposals are equivalent to TypeORM metadata:
detection→project is `CASCADE`; contract→project is `CASCADE` and
contract→detection is nullable `SET NULL`; preflight→project is `CASCADE` and
preflight→detection is nullable `SET NULL`. The data-bearing clone has 17
detections, 4 contracts and 15 preflight reports; all five orphan joins were
zero and UUID source/reference types matched UUID primary keys. They are
metadata-authoritative equivalent representations, not missing integrity.

| Index / relationship | Evidence and decision |
| --- | --- |
| Detection, contract, and preflight `project_id` indexes | Exact `findOne({ projectId })` reads in detection, deployment-contract, pipeline preparation and current-state services. The generated non-unique indexes duplicate the same leading key already covered by the one-per-project unique constraints; fresh historical names and TypeORM names are equivalent representation. No duplicate/rename is warranted. |
| `IDX_project_deployment_contracts_commit(project_id, detection_source_commit)` | Historical migration-only index. Repository reads resolve the current contract by unique `project_id`; no committed query filters this pair. The clone lacks it and planner statistics are zero, so it is intentionally database-only/obsolete-for-current-workload, preserved where historical but not added elsewhere. |
| `IDX_detection_input_fingerprint` and `IDX_preflight_input_fingerprint` | Historical composite fingerprint lookups support immutable detection/preflight replay; they are migration contract authoritative and retained. No metadata-only index is added solely to reduce `schema:log`. |

Fresh migration applied 57 migrations and replayed cleanly. The clone replayed
cleanly with unchanged fingerprints: detection `17` /
`27dccac4274a5d9867d21af377cd9f74`; contracts `4` /
`ee3b88876dcbba13706d01863da6e57d`; preflight `15` /
`ac90c457b9befa45eecf3db8d36af857`. All selected fresh-log statements are
explained; no migration or entity correction is safe or needed. Isolated
evidence is fresh/clone migration and replay plus zero-orphan/index-catalog
checks. Local evidence is the focused planner/preflight/current-state tests.
Live AWS was not used; operational `mini_paas` was not modified.

This family consumes no additional one-sided object: unresolved totals remain
26 migration-only foreign keys, 31 migration-only indexes and 38 metadata-only
indexes. The next smallest family is pipeline/deployment status history,
including `project_pipeline_runs` and `project_deployments`.

### Pipeline/deployment status-history audit — 2026-07-30

`project_pipeline_runs`, `project_deployments`, `project_pipeline_events`, and
`project_pipeline_job_finalities` were inspected as the bounded history family.
Fresh `schema:log` proposals are historical FK/index names versus TypeORM's
equivalent deterministic relation names: run→project/user `CASCADE`, optional
run→preflight/detection/configuration/service-binding/manifests/ownership
`SET NULL`, deployment→project `CASCADE`, and optional
deployment→run/infrastructure/release `SET NULL`. Event→run/project remains
`CASCADE`; finality→run/project remains `RESTRICT` to preserve terminal queue
evidence. These are migration-authoritative retention rules and intentionally
database-only where bounded DataSources must omit their parent entities.

Project-scoped history reads use `project_id` plus `created_at DESC`; exact
run reads use `id, project_id`; pipeline events use `project_id, pipeline_run_id`
and canonical occurrence ordering. The historical project/run and deployment
lookup indexes preserve those access paths. Metadata proposals with mismatched
historical names are equivalent representations; no duplicate, rename, or new
index is justified. The unique `(pipeline_run_id, bullmq_job_id)` finality key
preserves retry terminality. No migration or entity change was made.

Focused current-state, normal release-lane current-state, and retired legacy
rollback-shadow guards passed, along with backend type-check/build and
`git diff --check`. This was local/isolated schema inspection only; no AWS,
Redis, queue, release, or operational-database mutation occurred. The next
family remains the remaining infrastructure/observability support indexes.

### Infrastructure and observability support-index audit — 2026-07-30

The bounded family is `project_infrastructure_environments`, `project_infrastructure_events`, `project_observability_events`, and `project_runtime_metric_snapshots`. Fresh-log FK proposals are historical names versus equivalent TypeORM relations: project ownership is `CASCADE`; optional pipeline, environment, deployment, and actor links are `SET NULL`. Historical canonical-event ordering and project, metric-name, and timestamp lookup indexes match timeline/current-state query shapes. No index or FK was conclusively missing, so no migration/metadata change was made.

Fixture setup used separate non-transactional administrative termination, drop, and create commands. Fresh replay was a no-op. Clone fingerprints: environments `5` / `40725c3b22bb471392c83e9a0a2438ca`; infrastructure events `558` / `d3772cc3e537f10eeb144ce4d92a2c15`; observability events `0` / `d41d8cd98f00b204e9800998ecf8427e`; metric snapshots `81` / `411304b883a8476066ca20f17b833c9b`. Project/environment orphan checks were zero. Observability evidence is schema/query-only because that clone table is empty. No operational database, queue, cloud, or release mutation occurred.

## Complete implicated-table inventory

The “current” count is from the original 60-statement operational-schema clone
log. The “fresh” count is the retained post-correction log. Runtime ownership
is represented by the registered entity; service reads/writes use these entity
properties as TypeScript strings/numbers/objects, while DTOs validate UUIDs as
strings where identifiers cross HTTP boundaries.

| Table | Entity/runtime owner | Original current proposals | Retained fresh proposals | Decision |
| --- | --- | ---: | ---: | --- |
| `ai_analysis_messages` | `backend/src/ai-troubleshooting/ai-analysis-message.entity.ts` | 0 | 2 | UUID normalized; constraint/index decision retained |
| `ai_analysis_results` | `backend/src/ai-troubleshooting/ai-analysis-result.entity.ts` | 1 | 2 | metadata corrected; UUID normalized; constraint/index decision retained |
| `ai_analysis_sessions` | `backend/src/ai-troubleshooting/ai-analysis-session.entity.ts` | 0 | 4 | UUID normalized; constraint/index decision retained |
| `audit_logs` | `backend/src/audit-log/audit-log.entity.ts` | 0 | 10 | constraint/index decision retained |
| `billing_accounts` | `backend/src/billing/billing-account.entity.ts` | 0 | 4 | default normalized; constraint/index decision retained |
| `billing_checkout_sessions` | `backend/src/billing/billing-checkout-session.entity.ts` | 0 | 3 | constraint/index decision retained |
| `billing_invoices` | `backend/src/billing/billing-invoice.entity.ts` | 0 | 3 | constraint/index decision retained |
| `billing_subscriptions` | `backend/src/billing/billing-subscription.entity.ts` | 0 | 4 | default normalized; constraint/index decision retained |
| `billing_usage_counters` | `backend/src/billing/billing-usage-counter.entity.ts` | 0 | 3 | constraint/index decision retained |
| `billing_usage_events` | `backend/src/billing/billing-usage-event.entity.ts` | 0 | 4 | constraint/index decision retained |
| `billing_webhook_events` | `backend/src/billing/billing-webhook-event.entity.ts` | 0 | 2 | constraint/index decision retained |
| `central_cleanup_challenges` | `backend/src/infrastructure-lifecycle/central-cleanup-challenge.entity.ts` | 0 | 2 | constraint/index decision retained |
| `central_cloud_resources` | `backend/src/infrastructure-lifecycle/central-cloud-resource.entity.ts` | 0 | 18 | UUID normalized; constraint/index decision retained |
| `cloud_cleanup_operations` | `backend/src/infrastructure-lifecycle/cloud-cleanup-operation.entity.ts` | 1 | 4 | metadata corrected; constraint/index decision retained |
| `cloud_inventory_scans` | `backend/src/infrastructure-lifecycle/cloud-inventory-scan.entity.ts` | 2 | 4 | metadata corrected; UUID normalized; constraint/index decision retained |
| `deployment_intents` | `backend/src/orchestration-contracts/entities/deployment-intent.entity.ts` | 1 | 9 | metadata corrected; constraint/index decision retained |
| `deployment_side_effect_reconciliation_leases` | `backend/src/orchestration-contracts/entities/deployment-side-effect-reconciliation-lease.entity.ts` | 6 | 0 | metadata corrected |
| `deployment_side_effect_reconciliations` | `backend/src/orchestration-contracts/entities/deployment-side-effect-reconciliation.entity.ts` | 9 | 0 | metadata corrected |
| `deployment_side_effects` | `backend/src/orchestration-contracts/entities/deployment-side-effect.entity.ts` | 7 | 0 | metadata corrected |
| `emergency_cleanup_operations` | `backend/src/infrastructure-lifecycle/emergency-cleanup-operation.entity.ts` | 1 | 4 | metadata corrected; constraint/index decision retained |
| `infrastructure_destroy_challenges` | `backend/src/infrastructure-lifecycle/destroy-challenge.entity.ts` | 0 | 2 | UUID normalized; constraint/index decision retained |
| `infrastructure_destroy_operations` | `backend/src/infrastructure-lifecycle/destroy-operation.entity.ts` | 0 | 7 | UUID normalized; check validated; constraint/index decision retained |
| `infrastructure_manifests` | `backend/src/orchestration-contracts/entities/infrastructure-manifest.entity.ts` | 1 | 6 | metadata corrected; constraint/index decision retained |
| `initial_release_drafts` | `backend/src/orchestration-contracts/entities/initial-release-draft.entity.ts` | 0 | 4 | constraint/index decision retained |
| `notification_deliveries` | `backend/src/notifications/notification-delivery.entity.ts` | 0 | 5 | UUID normalized; constraint/index decision retained |
| `notification_preferences` | `backend/src/notifications/notification-preference.entity.ts` | 0 | 4 | UUID normalized; constraint/index decision retained |
| `notification_subscriptions` | `backend/src/notifications/notification-subscription.entity.ts` | 0 | 4 | UUID normalized; constraint/index decision retained |
| `orchestration_outbox` | `backend/src/orchestration-contracts/entities/orchestration-outbox.entity.ts` | 0 | 3 | constraint/index decision retained |
| `project_backup_records` | `backend/src/storage/project-backup-record.entity.ts` | 0 | 5 | UUID normalized; constraint/index decision retained |
| `project_cloud_states` | `backend/src/infrastructure-lifecycle/project-cloud-state.entity.ts` | 1 | 3 | metadata corrected; UUID normalized; default normalized; constraint/index decision retained |
| `project_configuration_snapshots` | `backend/src/projects/project-configuration-snapshot.entity.ts` | 11 | 11 | metadata corrected; constraint/index decision retained |
| `project_cost_estimates` | `backend/src/finops/project-cost-estimate.entity.ts` | 0 | 12 | constraint/index decision retained |
| `project_cost_resource_breakdowns` | `backend/src/finops/project-cost-resource-breakdown.entity.ts` | 0 | 12 | constraint/index decision retained |
| `project_cost_settings` | `backend/src/finops/project-cost-settings.entity.ts` | 0 | 6 | constraint/index decision retained |
| `project_database_tiers` | `backend/src/projects/project-database-tier.entity.ts` | 0 | 3 | constraint/index decision retained |
| `project_deployment_contracts` | `backend/src/projects/project-deployment-contract.entity.ts` | 8 | 7 | metadata corrected; constraint/index decision retained |
| `project_deployment_queue_items` | `backend/src/state-management/project-deployment-queue-item.entity.ts` | 0 | 4 | UUID normalized; constraint/index decision retained |
| `project_deployment_readiness_snapshots` | `backend/src/infrastructure/project-deployment-readiness-snapshot.entity.ts` | 0 | 8 | constraint/index decision retained |
| `project_deployment_requirements` | `backend/src/projects/project-deployment-requirements.entity.ts` | 6 | 4 | metadata corrected; UUID normalized; constraint/index decision retained |
| `project_deployments` | `backend/src/orchestration/project-deployment.entity.ts` | 0 | 11 | constraint/index decision retained |
| `project_detection_profiles` | `backend/src/projects/project-detection-profile.entity.ts` | 0 | 4 | constraint/index decision retained |
| `project_environment_variables` | `backend/src/projects/project-environment-variable.entity.ts` | 0 | 9 | default normalized; constraint/index decision retained |
| `project_infrastructure_environments` | `backend/src/infrastructure/project-infrastructure-environment.entity.ts` | 0 | 16 | constraint/index decision retained |
| `project_infrastructure_events` | `backend/src/infrastructure/project-infrastructure-event.entity.ts` | 0 | 11 | constraint/index decision retained |
| `project_log_stream_sessions` | `backend/src/observability/project-log-stream-session.entity.ts` | 0 | 10 | constraint/index decision retained |
| `project_observability_events` | `backend/src/observability/project-observability-event.entity.ts` | 0 | 10 | constraint/index decision retained |
| `project_operation_leases` | `backend/src/orchestration-contracts/entities/project-operation-lease.entity.ts` | 1 | 4 | metadata corrected; constraint/index decision retained |
| `project_orchestration_events` | `backend/src/orchestration/project-orchestration-event.entity.ts` | 0 | 8 | UUID normalized; constraint/index decision retained |
| `project_persistent_storage` | `backend/src/storage/project-persistent-storage.entity.ts` | 0 | 8 | constraint/index decision retained |
| `project_pipeline_events` | `backend/src/projects/project-pipeline-event.entity.ts` | 0 | 9 | constraint/index decision retained |
| `project_pipeline_job_finalities` | `backend/src/projects/pipeline/project-pipeline-job-finality.entity.ts` | 0 | 6 | constraint/index decision retained |
| `project_pipeline_metric_summaries` | `backend/src/observability/project-pipeline-metric-summary.entity.ts` | 0 | 8 | constraint/index decision retained |
| `project_pipeline_runs` | `backend/src/projects/project-pipeline-run.entity.ts` | 0 | 28 | check validated; constraint/index decision retained |
| `project_preflight_reports` | `backend/src/projects/project-preflight-report.entity.ts` | 0 | 6 | constraint/index decision retained |
| `project_release_lane_ownerships` | `backend/src/orchestration-contracts/entities/release-lane-ownership.entity.ts` | 0 | 3 | constraint/index decision retained |
| `project_release_lane_shadow_observations` | `backend/src/orchestration-contracts/entities/release-lane-shadow-observation.entity.ts` | 0 | 2 | constraint/index decision retained |
| `project_rollback_records` | `backend/src/orchestration/project-rollback-record.entity.ts` | 0 | 3 | UUID normalized; constraint/index decision retained |
| `project_runtime_metric_snapshots` | `backend/src/observability/project-runtime-metric-snapshot.entity.ts` | 0 | 12 | constraint/index decision retained |
| `project_security_findings` | `backend/src/projects/project-security-finding.entity.ts` | 0 | 20 | constraint/index decision retained |
| `project_security_scans` | `backend/src/projects/project-security-scan.entity.ts` | 0 | 10 | constraint/index decision retained |
| `project_service_bindings` | `backend/src/projects/project-service-binding.entity.ts` | 1 | 12 | metadata corrected; constraint/index decision retained |
| `project_service_discovery_records` | `backend/src/infrastructure/project-service-discovery-record.entity.ts` | 0 | 6 | constraint/index decision retained |
| `project_spot_interruption_events` | `backend/src/orchestration/project-spot-interruption-event.entity.ts` | 0 | 2 | UUID normalized; constraint/index decision retained |
| `project_stable_releases` | `backend/src/orchestration/project-stable-release.entity.ts` | 0 | 6 | UUID normalized; constraint/index decision retained |
| `project_stage_checkpoints` | `backend/src/projects/recovery/project-stage-checkpoint.entity.ts` | 0 | 12 | UUID normalized; PK required; constraint/index decision retained |
| `project_stage_metrics` | `backend/src/observability/project-stage-metric.entity.ts` | 0 | 14 | constraint/index decision retained |
| `project_state_recovery_requests` | `backend/src/state-management/project-state-recovery-request.entity.ts` | 0 | 3 | UUID normalized; constraint/index decision retained |
| `project_state_revisions` | `backend/src/orchestration-contracts/entities/project-state-revision.entity.ts` | 0 | 3 | constraint/index decision retained |
| `project_state_validation_results` | `backend/src/state-management/project-state-validation-result.entity.ts` | 0 | 4 | UUID normalized; constraint/index decision retained |
| `project_storage_events` | `backend/src/storage/project-storage-event.entity.ts` | 0 | 7 | UUID normalized; constraint/index decision retained |
| `project_storage_restore_requests` | `backend/src/storage/project-storage-restore-request.entity.ts` | 0 | 6 | UUID normalized; constraint/index decision retained |
| `project_terraform_locks` | `backend/src/state-management/project-terraform-lock.entity.ts` | 0 | 4 | UUID normalized; constraint/index decision retained |
| `project_terraform_states` | `backend/src/state-management/project-terraform-state.entity.ts` | 0 | 6 | constraint/index decision retained |
| `project_user_activity` | `backend/src/projects/project-user-activity.entity.ts` | 0 | 10 | constraint/index decision retained |
| `projects` | `backend/src/projects/project.entity.ts` | 1 | 13 | metadata corrected; constraint/index decision retained |
| `release_image_provenances` | `backend/src/orchestration-contracts/entities/release-image-provenance.entity.ts` | 0 | 7 | constraint/index decision retained |
| `release_manifests` | `backend/src/orchestration-contracts/entities/release-manifest.entity.ts` | 0 | 10 | check validated; constraint/index decision retained |
| `terraform_export_artifacts` | `backend/src/terraform-export/terraform-export-artifact.entity.ts` | 0 | 3 | UUID normalized; constraint/index decision retained |
| `users` | `backend/src/users/user.entity.ts` | 0 | 2 | constraint/index decision retained |
| `worker_capabilities` | `backend/src/orchestration-contracts/entities/worker-capability.entity.ts` | 2 | 0 | metadata corrected |

## Closure status

The operational database contract is compatible with current TypeORM metadata,
and the proven type/default/check/primary-key defects now have guarded additive
migrations. Project closure is not yet complete because 61 migration-only
foreign keys and 70 one-sided indexes (31 migrated, 39 metadata) still require
relation-ownership and workload evidence. Live AWS was not used.
