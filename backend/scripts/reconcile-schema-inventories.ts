import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parsePostgresArray } from "postgres-array";

type RawObject = Record<string, any>;
type Source = "metadata" | "fresh" | "clone";

export type ReconciliationRow = {
  semanticId: string;
  kind: "foreign_key" | "index" | "unique";
  metadata: RawObject[];
  fresh: RawObject[];
  clone: RawObject[];
  nameOnlyDifference: boolean;
  representationOnlyDifference: boolean;
  freshOnly: boolean;
  cloneOnly: boolean;
  metadataOnly: boolean;
  databaseOnly: boolean;
  unresolvedMatchingAmbiguity: boolean;
  classification: "equivalent" | "fresh_clone_difference" | "metadata_only"
    | "database_only" | "ambiguous";
};

export type ExcludedObject = {
  source: Source;
  kind: string;
  table: string;
  name: string;
  linkedConstraint: string | null;
  reason: "primary_key_backing_index" | "constraint_backing_index"
    | "duplicate_catalog_join_row";
};

const evidenceRoot = resolve(
  process.cwd(),
  "../docs/architecture/two-lane-migration/evidence",
);

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value === null || value === undefined || value === "") return [];
  if (typeof value === "string" && value.startsWith("{") && value.endsWith("}")) {
    return parsePostgresArray(value).map(String);
  }
  throw new Error("SCHEMA_RECONCILIATION_LIST_INVALID");
}

function normalizeIdentifier(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim().replace(/^"|"$/g, "");
}

function normalizeExpression(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/"([a-z_][a-z0-9_]*)"/gi, "$1");
}

function normalizePredicate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return normalizeExpression(value).replace(/^\((.*)\)$/s, "$1");
}

function normalizeAction(value: unknown): string {
  const action = String(value ?? "NO ACTION").trim().toUpperCase();
  const actions: Record<string, string> = {
    A: "NO ACTION",
    "NO ACTION": "NO ACTION",
    R: "RESTRICT",
    RESTRICT: "RESTRICT",
    C: "CASCADE",
    CASCADE: "CASCADE",
    N: "SET NULL",
    "SET NULL": "SET NULL",
    D: "SET DEFAULT",
    "SET DEFAULT": "SET DEFAULT",
  };
  const normalized = actions[action];
  if (!normalized) throw new Error("SCHEMA_RECONCILIATION_ACTION_INVALID");
  return normalized;
}

function normalizeMatchType(value: unknown): string {
  const match = String(value ?? "SIMPLE").trim().toUpperCase();
  const matches: Record<string, string> = {
    S: "SIMPLE",
    SIMPLE: "SIMPLE",
    F: "FULL",
    FULL: "FULL",
    P: "PARTIAL",
    PARTIAL: "PARTIAL",
  };
  const normalized = matches[match];
  if (!normalized) throw new Error("SCHEMA_RECONCILIATION_MATCH_INVALID");
  return normalized;
}

function logicalKind(object: RawObject): "foreign_key" | "index" | "unique" {
  if (object.kind === "foreign_key") return "foreign_key";
  if (object.kind === "unique_constraint" || object.kind === "unique_index") {
    return "unique";
  }
  if (object.kind === "index" && object.unique === true) return "unique";
  return "index";
}

export function semanticIdentity(object: RawObject): string {
  const kind = logicalKind(object);
  const schema = normalizeIdentifier(object.schema, "public");
  const table = normalizeIdentifier(object.table_name ?? object.table);
  if (!table) throw new Error("SCHEMA_RECONCILIATION_TABLE_MISSING");

  if (kind === "foreign_key") {
    const sourceColumns = asList(object.source_columns ?? object.columns)
      .map((column) => normalizeIdentifier(column));
    const referencedTable = normalizeIdentifier(
      object.referenced_table ?? object.referencedTable,
    );
    const referencedColumns = asList(
      object.referenced_columns ?? object.referencedColumns,
    ).map((column) => normalizeIdentifier(column));
    if (!sourceColumns.length || !referencedTable || !referencedColumns.length) {
      throw new Error("SCHEMA_RECONCILIATION_FOREIGN_KEY_INCOMPLETE");
    }
    return JSON.stringify({
      kind,
      schema,
      table,
      sourceColumns,
      referencedSchema: normalizeIdentifier(object.referenced_schema, "public"),
      referencedTable,
      referencedColumns,
      updateAction: normalizeAction(object.update_action ?? object.onUpdate),
      deleteAction: normalizeAction(object.delete_action ?? object.onDelete),
      matchType: normalizeMatchType(object.match_type),
      deferrable: Boolean(object.deferrable),
      initiallyDeferred: Boolean(object.initially_deferred),
    });
  }

  const keyItems = asList(
    object.key_items ?? object.key_columns ?? object.columns,
  ).map(normalizeExpression);
  if (!keyItems.length) throw new Error("SCHEMA_RECONCILIATION_INDEX_KEYS_MISSING");
  return JSON.stringify({
    kind,
    schema,
    table,
    keyItems,
    unique: kind === "unique",
    predicate: normalizePredicate(object.predicate ?? object.where),
    includedColumns: asList(object.included_columns)
      .map((column) => normalizeIdentifier(column)),
    accessMethod: normalizeIdentifier(object.access_method, "btree").toLowerCase(),
  });
}

export function metadataObjects(input: any): RawObject[] {
  return input.tables.flatMap((table: any) => [
    ...table.foreignKeys.map((object: RawObject) => ({
      ...object,
      schema: "public",
      table_name: table.table,
      kind: "foreign_key",
    })),
    ...table.uniqueConstraints.map((object: RawObject) => ({
      ...object,
      schema: "public",
      table_name: table.table,
      kind: "unique_constraint",
    })),
    ...table.indexes.map((object: RawObject) => ({
      ...object,
      schema: "public",
      table_name: table.table,
      kind: object.unique ? "unique_index" : "index",
    })),
  ]);
}

export function catalogObjects(input: any, source: "fresh" | "clone") {
  const objects: RawObject[] = [];
  const excluded: ExcludedObject[] = [];
  const catalog = input.objects as RawObject[];
  const indexGroups = new Map<string, RawObject[]>();
  const nonIndexes: RawObject[] = [];
  for (const object of catalog) {
    if (object.kind !== "unique_index" && object.kind !== "index") {
      nonIndexes.push(object);
      continue;
    }
    const identity = JSON.stringify([
      object.schema,
      object.table_name ?? object.table,
      object.name,
      object.definition,
    ]);
    const group = indexGroups.get(identity) ?? [];
    group.push(object);
    indexGroups.set(identity, group);
  }
  objects.push(...nonIndexes);
  for (const group of indexGroups.values()) {
    group.sort((a, b) => String(a.linked_constraint ?? "")
      .localeCompare(String(b.linked_constraint ?? "")));
    const representative = group.find((object) => object.primary === true
      || object.linked_constraint === object.name) ?? group[0];
    const constraintBacked = representative.primary === true
      || group.some((object) => object.linked_constraint === object.name);
    if (constraintBacked) {
      excluded.push({
        source,
        kind: String(representative.kind),
        table: normalizeIdentifier(representative.table_name ?? representative.table),
        name: normalizeIdentifier(representative.name),
        linkedConstraint: representative.linked_constraint ?? null,
        reason: representative.primary
          ? "primary_key_backing_index"
          : "constraint_backing_index",
      });
    } else {
      objects.push({ ...representative, linked_constraint: null });
    }
    for (const duplicate of group.filter((object) => object !== representative)) {
      excluded.push({
        source,
        kind: String(duplicate.kind),
        table: normalizeIdentifier(duplicate.table_name ?? duplicate.table),
        name: normalizeIdentifier(duplicate.name),
        linkedConstraint: duplicate.linked_constraint ?? null,
        reason: "duplicate_catalog_join_row",
      });
    }
  }
  return { objects, excluded };
}

function rawName(object: RawObject): string {
  return normalizeIdentifier(object.name);
}

export function reconcile(
  metadata: RawObject[],
  fresh: RawObject[],
  clone: RawObject[],
): ReconciliationRow[] {
  const map = new Map<string, ReconciliationRow>();
  for (const [source, objects] of [
    ["metadata", metadata],
    ["fresh", fresh],
    ["clone", clone],
  ] as const) {
    for (const object of objects) {
      const semanticId = semanticIdentity(object);
      const row = map.get(semanticId) ?? {
        semanticId,
        kind: JSON.parse(semanticId).kind,
        metadata: [],
        fresh: [],
        clone: [],
        nameOnlyDifference: false,
        representationOnlyDifference: false,
        freshOnly: false,
        cloneOnly: false,
        metadataOnly: false,
        databaseOnly: false,
        unresolvedMatchingAmbiguity: false,
        classification: "equivalent",
      };
      row[source].push(object);
      map.set(semanticId, row);
    }
  }

  return [...map.values()].map((row) => {
    row.metadata.sort((a, b) => rawName(a).localeCompare(rawName(b)));
    row.fresh.sort((a, b) => rawName(a).localeCompare(rawName(b)));
    row.clone.sort((a, b) => rawName(a).localeCompare(rawName(b)));
    row.unresolvedMatchingAmbiguity = [row.metadata, row.fresh, row.clone]
      .some((objects) => objects.length > 1);
    row.metadataOnly = row.metadata.length > 0
      && row.fresh.length === 0 && row.clone.length === 0;
    row.freshOnly = row.fresh.length > 0
      && row.clone.length === 0 && row.metadata.length === 0;
    row.cloneOnly = row.clone.length > 0
      && row.fresh.length === 0 && row.metadata.length === 0;
    row.databaseOnly = row.metadata.length === 0
      && (row.fresh.length > 0 || row.clone.length > 0);
    const present = [row.metadata, row.fresh, row.clone]
      .filter((objects) => objects.length > 0);
    const names = present.flatMap((objects) => objects.map(rawName));
    row.nameOnlyDifference = present.length > 1 && new Set(names).size > 1;
    row.representationOnlyDifference = row.kind === "unique"
      && present.length > 1
      && new Set(present.flatMap((objects) => objects.map((object) => object.kind))).size > 1;
    if (row.unresolvedMatchingAmbiguity) row.classification = "ambiguous";
    else if (row.metadataOnly) row.classification = "metadata_only";
    else if (row.databaseOnly) row.classification = "database_only";
    else if (!row.metadata.length || !row.fresh.length || !row.clone.length) {
      row.classification = "fresh_clone_difference";
    } else row.classification = "equivalent";
    return row;
  }).sort((a, b) => a.semanticId.localeCompare(b.semanticId));
}

function csv(rows: ReconciliationRow[]): string {
  const fields = [
    "semantic_id", "kind", "metadata", "fresh", "clone", "classification",
    "metadata_only", "database_only", "ambiguity", "name_only",
    "representation_only",
  ];
  const values = rows.map((row) => [
    row.semanticId,
    row.kind,
    row.metadata.length,
    row.fresh.length,
    row.clone.length,
    row.classification,
    row.metadataOnly,
    row.databaseOnly,
    row.unresolvedMatchingAmbiguity,
    row.nameOnlyDifference,
    row.representationOnlyDifference,
  ].map((value) => JSON.stringify(value)).join(","));
  return `${fields.join(",")}\n${values.join("\n")}\n`;
}

function main() {
  const metadataInventory = JSON.parse(readFileSync(resolve(
    evidenceRoot,
    "typeorm-metadata-inventory.json",
  ), "utf8"));
  const freshInventory = JSON.parse(readFileSync(resolve(
    evidenceRoot,
    "postgres-catalog-dg_inventory_fresh_20260730.json",
  ), "utf8"));
  const cloneInventory = JSON.parse(readFileSync(resolve(
    evidenceRoot,
    "postgres-catalog-dg_inventory_clone_20260730.json",
  ), "utf8"));
  const metadata = metadataObjects(metadataInventory);
  const fresh = catalogObjects(freshInventory, "fresh");
  const clone = catalogObjects(cloneInventory, "clone");
  const rows = reconcile(metadata, fresh.objects, clone.objects);
  const exclusions = [...fresh.excluded, ...clone.excluded]
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const linked = {
    metadata: rows.reduce((count, row) => count + row.metadata.length, 0),
    fresh: rows.reduce((count, row) => count + row.fresh.length, 0),
    clone: rows.reduce((count, row) => count + row.clone.length, 0),
  };
  const excluded = {
    fresh: exclusions.filter((object) => object.source === "fresh").length,
    clone: exclusions.filter((object) => object.source === "clone").length,
  };
  const input = {
    metadata: metadata.length,
    fresh: freshInventory.objects.length,
    clone: cloneInventory.objects.length,
  };
  if (linked.metadata !== input.metadata
    || linked.fresh + excluded.fresh !== input.fresh
    || linked.clone + excluded.clone !== input.clone) {
    throw new Error("SCHEMA_RECONCILIATION_COVERAGE_INCOMPLETE");
  }
  const summary = {
    rows: rows.length,
    equivalent: rows.filter((row) => row.classification === "equivalent").length,
    freshCloneDifference: rows.filter((row) => row.classification === "fresh_clone_difference").length,
    metadataOnly: rows.filter((row) => row.metadataOnly).length,
    databaseOnly: rows.filter((row) => row.databaseOnly).length,
    ambiguous: rows.filter((row) => row.unresolvedMatchingAmbiguity).length,
    nameOnlyDifference: rows.filter((row) => row.nameOnlyDifference).length,
    representationOnlyDifference: rows.filter((row) => row.representationOnlyDifference).length,
    input,
    linked,
    excluded,
  };
  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(
    resolve(evidenceRoot, "schema-reconciliation.json"),
    `${JSON.stringify({ summary, exclusions, rows }, null, 2)}\n`,
  );
  writeFileSync(
    resolve(evidenceRoot, "schema-reconciliation.csv"),
    csv(rows),
  );
  process.stdout.write(`SCHEMA_RECONCILIATION_OK ${JSON.stringify(summary)}\n`);
}

if (require.main === module) main();
