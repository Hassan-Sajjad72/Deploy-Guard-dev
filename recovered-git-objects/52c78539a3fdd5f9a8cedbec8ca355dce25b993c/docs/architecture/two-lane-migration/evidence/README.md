# Schema audit evidence

Run `cd backend && npm run schema:export-typeorm-metadata` to write the
deterministic metadata-only inventory at `typeorm-metadata-inventory.json`.
It builds TypeORM decorators without opening a database connection or running
synchronization.

Run `npm run schema:export-postgres-catalog -- <database>` for a read-only
foreign-key, unique-constraint, and index catalog JSON export.

Run `npm run schema:reconcile-inventories` to create `schema-reconciliation.json`
and `.csv`; it matches the persisted inventories only and opens no database.
