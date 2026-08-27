import { strict as assert } from "node:assert";
import { getMetadataArgsStorage, QueryRunner } from "typeorm";
import { ProjectTerraformLock } from "../src/state-management/project-terraform-lock.entity";
import {
  PreserveReleasedTerraformLockHistory1760000059000,
  TERRAFORM_LOCK_PIPELINE_HISTORY_FOREIGN_KEY,
} from "../src/migrations/1760000059000-PreserveReleasedTerraformLockHistory";

type Mode = "missing" | "historical_cascade" | "unsafe_orphan";

const historicalCascade = {
  conname: "FK_project_terraform_locks_pipeline_run",
  contype: "f",
  convalidated: true,
  confdeltype: "c",
  confupdtype: "a",
  source_column: "pipeline_run_id",
  referenced_table: "project_pipeline_runs",
  referenced_column: "id",
};

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
    if (sql.includes("lock_row.status <> 'released'")) {
      return [{ count: this.mode === "unsafe_orphan" ? "1" : "0" }];
    }
    if (sql.includes("pipeline_run_id IS NULL")) {
      return [{ count: "0" }];
    }
    if (sql.includes("SELECT constraint_row.conname")) {
      return this.mode === "historical_cascade" ? [historicalCascade] : [];
    }
    if (sql.includes("remainingOrphans") || (
      sql.includes("LEFT JOIN project_pipeline_runs")
      && !sql.includes("lock_row.status <> 'released'")
    )) {
      return [{ count: "0" }];
    }
    return [];
  }
}

async function run() {
  assert.equal(TERRAFORM_LOCK_PIPELINE_HISTORY_FOREIGN_KEY.onDelete, "SET NULL");
  const pipelineColumn = getMetadataArgsStorage().columns.find((column) =>
    column.target === ProjectTerraformLock
    && column.options.name === "pipeline_run_id");
  assert.equal(pipelineColumn?.options.nullable, true);

  const migration = new PreserveReleasedTerraformLockHistory1760000059000();
  const missing = new CatalogFixture("missing");
  await migration.up(missing as unknown as QueryRunner);
  assert(missing.statements.some((sql) => sql.includes("ALTER COLUMN \"pipeline_run_id\" DROP NOT NULL")));
  assert(missing.statements.some((sql) => sql.includes("SET pipeline_run_id = NULL")));
  assert(missing.statements.some((sql) => sql.includes("ON DELETE SET NULL NOT VALID")));
  assert(missing.statements.some((sql) => sql.includes("VALIDATE CONSTRAINT")));
  assert.equal(missing.statements.some((sql) => sql.includes("DELETE FROM project_terraform_locks")), false);

  const historical = new CatalogFixture("historical_cascade");
  await migration.up(historical as unknown as QueryRunner);
  assert(historical.statements.some((sql) => sql.includes("DROP CONSTRAINT")));
  assert(historical.statements.some((sql) => sql.includes("ON DELETE SET NULL NOT VALID")));

  await assert.rejects(
    migration.up(new CatalogFixture("unsafe_orphan") as unknown as QueryRunner),
    /TERRAFORM_LOCK_HISTORY_ACTIVE_ORPHAN_CONFLICT/,
  );
  await assert.rejects(
    migration.down(),
    /Refusing to discard preserved Terraform-lock history/,
  );

  process.stdout.write("Released Terraform-lock history migration checks passed.\n");
}

void run();
