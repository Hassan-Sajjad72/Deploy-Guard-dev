import { strict as assert } from "node:assert";
import { QueryRunner } from "typeorm";
import {
  ReconcileVerifiedLifecycleIntegrity1760000058000,
  VERIFIED_LIFECYCLE_FOREIGN_KEYS,
  VERIFIED_PROJECT_IDENTITY_INDEXES,
} from "../src/migrations/1760000058000-ReconcileVerifiedLifecycleIntegrity";

type Mode = "valid" | "orphan" | "conflicting_index";

class CatalogFixture {
  readonly statements: string[] = [];

  constructor(private readonly mode: Mode) {}

  async query(sql: string): Promise<unknown[]> {
    this.statements.push(sql);
    if (sql.includes("format_type(source_column")) {
      return [{ source_type: "uuid", target_type: "uuid" }];
    }
    if (sql.includes("FROM pg_constraint target_key")) {
      return [{ count: "1" }];
    }
    if (sql.includes("SELECT constraint_row.conname")) {
      return [];
    }
    if (sql.includes("LEFT JOIN") && sql.includes("source_row")) {
      return [{ count: this.mode === "orphan" ? "1" : "0" }];
    }
    if (sql.includes("attribute.attname AS column_name")) {
      return [
        { column_name: "archived_at", column_type: "timestamp with time zone" },
        { column_name: "environment_name", column_type: "character varying" },
        { column_name: "github_repository_id", column_type: "character varying" },
        { column_name: "owner_user_id", column_type: "integer" },
        { column_name: "repository_full_name", column_type: "character varying" },
        { column_name: "target_branch", column_type: "character varying" },
      ];
    }
    if (sql.includes("FROM pg_index index_row")) {
      return this.mode === "conflicting_index"
        ? [{
          index_name: VERIFIED_PROJECT_IDENTITY_INDEXES[0].indexName,
          indisunique: false,
          indisvalid: true,
          indisready: true,
          access_method: "btree",
          key_count: 4,
          key_items: [...VERIFIED_PROJECT_IDENTITY_INDEXES[0].keyItems],
          predicate: VERIFIED_PROJECT_IDENTITY_INDEXES[0].predicate,
        }]
        : [];
    }
    if (sql.includes("duplicate_group")) {
      return [{ count: "0" }];
    }
    return [];
  }
}

async function run() {
  assert.equal(VERIFIED_LIFECYCLE_FOREIGN_KEYS.length, 6);
  assert.equal(VERIFIED_PROJECT_IDENTITY_INDEXES.length, 2);
  assert.equal(
    VERIFIED_LIFECYCLE_FOREIGN_KEYS.some((spec) =>
      spec.tableName === "project_terraform_locks"),
    false,
  );

  const migration = new ReconcileVerifiedLifecycleIntegrity1760000058000();
  const valid = new CatalogFixture("valid");
  await migration.up(valid as unknown as QueryRunner);
  assert.equal(
    valid.statements.filter((sql) => sql.includes("NOT VALID")).length,
    VERIFIED_LIFECYCLE_FOREIGN_KEYS.length,
  );
  assert.equal(
    valid.statements.filter((sql) => sql.includes("VALIDATE CONSTRAINT")).length,
    VERIFIED_LIFECYCLE_FOREIGN_KEYS.length,
  );
  assert.equal(
    valid.statements.filter((sql) => sql.startsWith("CREATE UNIQUE INDEX")).length,
    VERIFIED_PROJECT_IDENTITY_INDEXES.length,
  );
  assert(valid.statements.some((sql) => sql.includes("SET LOCAL lock_timeout = '5s'")));
  assert(valid.statements.some((sql) => sql.includes("SET LOCAL statement_timeout = '30s'")));

  await assert.rejects(
    migration.up(new CatalogFixture("orphan") as unknown as QueryRunner),
    /VERIFIED_LIFECYCLE_FK_ORPHAN_CONFLICT/,
  );
  await assert.rejects(
    migration.up(new CatalogFixture("conflicting_index") as unknown as QueryRunner),
    /VERIFIED_PROJECT_IDENTITY_INDEX_DEFINITION_CONFLICT/,
  );
  await assert.rejects(
    migration.down(),
    /Refusing to remove verified lifecycle integrity constraints and indexes/,
  );

  process.stdout.write("Verified lifecycle integrity migration checks passed.\n");
}

void run();
