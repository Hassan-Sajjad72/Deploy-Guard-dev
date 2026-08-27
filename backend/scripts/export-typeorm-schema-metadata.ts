import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";
import AppDataSource from "../src/data-source";

type ForeignKey = { name: string; table: string; columns: string[]; referencedTable: string; referencedColumns: string[]; onUpdate: string; onDelete: string };
type Index = { name: string; table: string; columns: string[]; unique: boolean; where: string | null; kind: "index" | "unique_constraint" };

async function main() {
  // Deliberately build decorators into metadata only: never initialize/connect/synchronize.
  await (AppDataSource as any).buildMetadatas();
  const tables = AppDataSource.entityMetadatas
    .filter((m) => m.tableType === "regular" && m.tableName !== "migrations")
    .map((m) => ({
      table: m.tableName,
      foreignKeys: m.foreignKeys.map((fk): ForeignKey => ({
        name: fk.name, table: m.tableName,
        columns: fk.columnNames.map(String), referencedTable: fk.referencedEntityMetadata.tableName,
        referencedColumns: fk.referencedColumnNames.map(String), onUpdate: fk.onUpdate, onDelete: fk.onDelete,
      })).sort((a, b) => a.name.localeCompare(b.name)),
      uniqueConstraints: m.uniques.map((u): Index => ({ name: u.name, table: m.tableName, columns: u.columns.map((c:any)=>c.databaseName), unique: true, where: null, kind: "unique_constraint" })).sort((a,b)=>a.name.localeCompare(b.name)),
      indexes: m.indices.map((i): Index => ({ name: i.name, table: m.tableName, columns: i.columns.map((c:any)=>c.databaseName), unique: i.isUnique, where: i.where || null, kind: "index" })).sort((a,b)=>a.name.localeCompare(b.name)),
    })).sort((a, b) => a.table.localeCompare(b.table));
  const output = resolve(process.cwd(), "../docs/architecture/two-lane-migration/evidence/typeorm-metadata-inventory.json");
  mkdirSync(resolve(output, ".."), { recursive: true });
  writeFileSync(output, JSON.stringify({ generatedBy: "export-typeorm-schema-metadata", tables }, null, 2) + "\n");
  console.log(`TYPEORM_METADATA_EXPORT_OK tables=${tables.length} output=${output}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
