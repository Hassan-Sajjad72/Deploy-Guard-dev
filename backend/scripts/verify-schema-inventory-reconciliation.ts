import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  catalogObjects,
  reconcile,
  semanticIdentity,
} from "./reconcile-schema-inventories";

const metadataFk = {
  kind: "foreign_key",
  schema: "public",
  table: "children",
  name: "FK_metadata_name",
  columns: ["parent_id", "tenant_id"],
  referencedTable: "parents",
  referencedColumns: ["id", "tenant_id"],
  onUpdate: "NO ACTION",
  onDelete: "CASCADE",
};
const catalogFk = {
  kind: "foreign_key",
  schema: "public",
  table_name: "children",
  name: "FK_database_name",
  source_columns: "{parent_id,tenant_id}",
  referenced_schema: "public",
  referenced_table: "parents",
  referenced_columns: "{id,tenant_id}",
  update_action: "a",
  delete_action: "c",
  match_type: "s",
  deferrable: false,
  initially_deferred: false,
};

assert.equal(semanticIdentity(metadataFk), semanticIdentity(catalogFk));
const matching = reconcile([metadataFk], [catalogFk], [catalogFk]);
assert.equal(matching.length, 1);
assert.equal(matching[0].classification, "equivalent");
assert.equal(matching[0].nameOnlyDifference, true);

const metadataUnique = {
  kind: "unique_constraint",
  schema: "public",
  table: "events",
  name: "UQ_metadata",
  columns: ["project_id", "sequence"],
  unique: true,
};
const catalogUnique = {
  kind: "unique_index",
  schema: "public",
  table_name: "events",
  name: "uq_database",
  key_items: ["project_id", "sequence"],
  included_columns: "{}",
  unique: true,
  predicate: null,
  access_method: "btree",
};
const unique = reconcile([metadataUnique], [catalogUnique], [catalogUnique]);
assert.equal(unique.length, 1);
assert.equal(unique[0].representationOnlyDifference, true);

const partial = {
  ...catalogUnique,
  kind: "index",
  name: "idx_partial",
  unique: false,
  predicate: "(status = 'active'::text)",
  included_columns: "{updated_at}",
};
const differentPredicate = { ...partial, predicate: "status = 'failed'::text" };
assert.notEqual(semanticIdentity(partial), semanticIdentity(differentPredicate));

const backing = catalogObjects({ objects: [
  { ...catalogUnique, linked_constraint: "events_project_sequence_key" },
  { ...catalogUnique, linked_constraint: "uq_database" },
  { ...catalogUnique, name: "events_pkey", primary: true, linked_constraint: "events_pkey" },
  { ...catalogUnique, name: "uq_standalone", linked_constraint: null },
] }, "fresh");
assert.equal(backing.objects.length, 1);
assert.equal(backing.excluded.length, 3);
assert.deepEqual(
  backing.excluded.map((object) => object.reason).sort(),
  [
    "constraint_backing_index",
    "duplicate_catalog_join_row",
    "primary_key_backing_index",
  ],
);

const differentAction = { ...catalogFk, delete_action: "n" };
assert.notEqual(semanticIdentity(catalogFk), semanticIdentity(differentAction));
const ambiguous = reconcile([metadataUnique, { ...metadataUnique, name: "UQ_duplicate" }], [], []);
assert.equal(ambiguous[0].unresolvedMatchingAmbiguity, true);
assert.equal(ambiguous[0].classification, "ambiguous");

const catalogExporter = readFileSync(
  resolve(__dirname, "export-postgres-schema-catalog.ts"),
  "utf8",
);
assert.match(
  catalogExporter,
  /k\.conrelid=i\.indrelid AND k\.contype IN \('p','u','x'\)/,
);

process.stdout.write("Schema inventory semantic reconciliation verification passed.\n");
