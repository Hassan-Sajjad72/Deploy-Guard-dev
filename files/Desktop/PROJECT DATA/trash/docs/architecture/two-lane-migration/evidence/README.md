# Schema audit evidence

Run `cd backend && npm run schema:export-typeorm-metadata` to write the
deterministic metadata-only inventory at `typeorm-metadata-inventory.json`.
It builds TypeORM decorators without opening a database connection or running
synchronization.

Run `npm run schema:export-postgres-catalog -- <database>` for a read-only
foreign-key, unique-constraint, and index catalog JSON export.

Run `npm run schema:reconcile-inventories` to create `schema-reconciliation.json`
and `.csv`; it matches the persisted inventories only and opens no database.
PostgreSQL array values are decoded from their structured catalog fields,
foreign-key action codes are normalized against TypeORM names, and primary or
unique-constraint backing indexes are recorded as exclusions rather than
double-counted logical objects. Historical catalog exports whose index join
also returned referring foreign-key constraints are deduplicated explicitly;
the exporter query now limits linked constraints to the indexed table and
primary/unique/exclusion constraint types. Run
`npm run test:schema-reconcile-inventories`
for the fixture-free semantic matching checks.

Run `npm run schema:classify-completed-families` to apply only the persisted
object-level decisions from completed audit families to the corrected residual
rows. It writes `completed-family-classifications.json` and `.csv`, marks
unresolved evidence explicitly, leaves unaudited families pending and
authorizes only clone-proven guarded additions. Validate its fail-closed rules with
`npm run test:schema-classify-completed-families`.
The classifier also records the bounded operational-clone audit: 20
type-compatible, zero-orphan keys are bound to additive migration
`1760000057000`; unpredicated operational indexes are retained as sufficient
access-path supersets; and the Terraform-lock pipeline key remains blocked by
two released historical orphans. The read-only pre-migration clone catalog is
`postgres-catalog-dg_p2_clone_20260731.json`.

The classifier also records the repository-only project-identity and
destruction-lifecycle slice. Five index rows have explicit workload or
compatibility decisions; three nullable lineage foreign keys and two partial
active-project unique indexes remain fail-closed pending a new data-bearing
clone check. Generated totals are 90 resolved rows, 34 pending-family rows, 20
already-authorized guarded additions, zero catalog contradictions and six
evidence blockers. This update opened no database connection.

The AI troubleshooting history slice classifies three ordered migration
indexes as database-only workload paths, three single-column metadata/clone
indexes as equivalent leading-key paths, and two session indexes as retained
compatibility. Generated totals are 98 resolved rows, 26 pending-family rows,
20 prior guarded additions, zero catalog contradictions and six unchanged
evidence blockers. No database connection or schema mutation occurred.

The notification slice classifies one ordered migration index as the delivery
history workload path, five single-column indexes as equivalent paths supplied
by ordered or unique composites, and one user index as retained compatibility.
Generated totals are 105 resolved rows, 19 pending-family rows, 20 prior
guarded additions, zero catalog contradictions and six unchanged evidence
blockers. No provider or database connection was opened.

The billing/FinOps slice classifies one chronological usage-ledger index, two
equivalent user paths and two compatibility-only checkout/invoice indexes.
Two fresh-only cost-reviewer `SET NULL` keys remain fail-closed pending clone
type/orphan verification. Generated totals are 110 resolved rows, 12
pending-family rows, 20 prior guarded additions, zero catalog contradictions
and eight evidence blockers. The project-usage regression used a rollback-only
local PostgreSQL transaction; no durable row or schema change remained.

The project activity/configuration slice classifies two ordered user-recency
indexes and the canonical project/normalized-environment-key index as
intentional database support, two simple indexes as equivalent access paths,
one project-activity index as retained compatibility, and the database-tier
project key as duplicate equivalent uniqueness enforcement. Generated totals
are 117 resolved rows, five pending-family rows, 20 prior guarded additions,
zero catalog contradictions and eight unchanged evidence blockers. This slice
opened no database connection and performed no schema or secret mutation.

The Terraform export/orchestration slice completes business-family coverage.
It classifies the canonical orchestration timeline and export expiry indexes
as database-only workload paths and two export owner indexes as retained
compatibility. The fresh-only orchestration-event project key remains
fail-closed pending clone type/orphan verification. Generated totals are 121
resolved rows, zero pending-family rows, 20 prior guarded additions, zero
catalog contradictions and nine evidence blockers. No database or external
service was accessed.
