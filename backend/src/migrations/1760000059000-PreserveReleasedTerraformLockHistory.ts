import { MigrationInterface, QueryRunner } from "typeorm";

export const TERRAFORM_LOCK_PIPELINE_HISTORY_FOREIGN_KEY = {
  tableName: "project_terraform_locks",
  constraintName: "FK_project_terraform_locks_pipeline_run",
  columnName: "pipeline_run_id",
  referencedTableName: "project_pipeline_runs",
  referencedColumnName: "id",
  onDelete: "SET NULL" as const,
  deleteCode: "n" as const,
};

type CurrentForeignKey = {
  conname: string;
  contype: string;
  convalidated: boolean;
  confdeltype: string;
  confupdtype: string;
  source_column: string;
  referenced_table: string;
  referenced_column: string;
};

/**
 * Preserves released Terraform-lock history after legacy pipeline retention.
 * Only conclusively orphaned released references are cleared; lock rows and
 * all other historical evidence remain unchanged.
 */
export class PreserveReleasedTerraformLockHistory1760000059000
implements MigrationInterface {
  name = "PreserveReleasedTerraformLockHistory1760000059000";

  async up(queryRunner: QueryRunner): Promise<void> {
    const spec = TERRAFORM_LOCK_PIPELINE_HISTORY_FOREIGN_KEY;
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);
    await queryRunner.query(
      `SELECT pg_advisory_xact_lock(hashtext('schema:project_terraform_locks:pipeline_history'))`,
    );

    const types: Array<{ source_type: string; target_type: string }> =
      await queryRunner.query(
        `SELECT format_type(source_column.atttypid, source_column.atttypmod) AS source_type,
                format_type(target_column.atttypid, target_column.atttypmod) AS target_type
           FROM pg_attribute source_column
           JOIN pg_attribute target_column
             ON target_column.attrelid = 'public.project_pipeline_runs'::regclass
            AND target_column.attname = 'id'
            AND NOT target_column.attisdropped
          WHERE source_column.attrelid = 'public.project_terraform_locks'::regclass
            AND source_column.attname = 'pipeline_run_id'
            AND NOT source_column.attisdropped`,
      );
    if (types.length !== 1 || types[0].source_type !== types[0].target_type) {
      throw new Error("TERRAFORM_LOCK_HISTORY_FK_TYPE_CONFLICT");
    }

    const targetKeys: Array<{ count: string }> = await queryRunner.query(
      `SELECT count(*)::text AS count
         FROM pg_constraint target_key
        WHERE target_key.conrelid = 'public.project_pipeline_runs'::regclass
          AND target_key.contype IN ('p', 'u')
          AND array_length(target_key.conkey, 1) = 1
          AND target_key.conkey[1] = (
            SELECT attnum FROM pg_attribute
             WHERE attrelid = 'public.project_pipeline_runs'::regclass
               AND attname = 'id' AND NOT attisdropped
          )`,
    );
    if (Number(targetKeys[0]?.count ?? 0) !== 1) {
      throw new Error("TERRAFORM_LOCK_HISTORY_REFERENCE_KEY_CONFLICT");
    }

    const unsafeOrphans: Array<{ count: string }> = await queryRunner.query(
      `SELECT count(*)::text AS count
         FROM project_terraform_locks lock_row
         LEFT JOIN project_pipeline_runs pipeline_run
           ON pipeline_run.id = lock_row.pipeline_run_id
        WHERE lock_row.pipeline_run_id IS NOT NULL
          AND pipeline_run.id IS NULL
          AND (lock_row.status <> 'released' OR lock_row.released_at IS NULL)`,
    );
    if (Number(unsafeOrphans[0]?.count ?? 0) !== 0) {
      throw new Error("TERRAFORM_LOCK_HISTORY_ACTIVE_ORPHAN_CONFLICT");
    }

    const invalidNulls: Array<{ count: string }> = await queryRunner.query(
      `SELECT count(*)::text AS count
         FROM project_terraform_locks
        WHERE pipeline_run_id IS NULL
          AND (status <> 'released' OR released_at IS NULL)`,
    );
    if (Number(invalidNulls[0]?.count ?? 0) !== 0) {
      throw new Error("TERRAFORM_LOCK_HISTORY_NULL_REFERENCE_CONFLICT");
    }

    const foreignKeys = await this.foreignKeys(queryRunner);
    if (foreignKeys.length > 1) {
      throw new Error("TERRAFORM_LOCK_HISTORY_FK_EQUIVALENT_CONFLICT");
    }
    if (foreignKeys.length === 1) {
      const current = foreignKeys[0];
      this.requireBaseDefinition(current);
      if (current.confdeltype !== spec.deleteCode && current.confdeltype !== "c") {
        throw new Error("TERRAFORM_LOCK_HISTORY_FK_DELETE_ACTION_CONFLICT");
      }
    }

    const named: CurrentForeignKey[] = await queryRunner.query(
      `SELECT constraint_row.conname, constraint_row.contype,
              constraint_row.convalidated, constraint_row.confdeltype,
              constraint_row.confupdtype, source_column.attname AS source_column,
              constraint_row.confrelid::regclass::text AS referenced_table,
              target_column.attname AS referenced_column
         FROM pg_constraint constraint_row
         LEFT JOIN pg_attribute source_column
           ON source_column.attrelid = constraint_row.conrelid
          AND source_column.attnum = constraint_row.conkey[1]
         LEFT JOIN pg_attribute target_column
           ON target_column.attrelid = constraint_row.confrelid
          AND target_column.attnum = constraint_row.confkey[1]
        WHERE constraint_row.conrelid = 'public.project_terraform_locks'::regclass
          AND constraint_row.conname = $1`,
      [spec.constraintName],
    );
    if (named.length > 1) {
      throw new Error("TERRAFORM_LOCK_HISTORY_FK_NAME_CONFLICT");
    }
    if (named.length === 1) {
      this.requireBaseDefinition(named[0]);
      if (named[0].confdeltype !== spec.deleteCode && named[0].confdeltype !== "c") {
        throw new Error("TERRAFORM_LOCK_HISTORY_FK_NAMED_DEFINITION_CONFLICT");
      }
    }

    await queryRunner.query(
      `ALTER TABLE "project_terraform_locks"
         ALTER COLUMN "pipeline_run_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `UPDATE project_terraform_locks lock_row
          SET pipeline_run_id = NULL
        WHERE lock_row.pipeline_run_id IS NOT NULL
          AND lock_row.status = 'released'
          AND lock_row.released_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM project_pipeline_runs pipeline_run
             WHERE pipeline_run.id = lock_row.pipeline_run_id
          )`,
    );

    const remainingOrphans: Array<{ count: string }> = await queryRunner.query(
      `SELECT count(*)::text AS count
         FROM project_terraform_locks lock_row
         LEFT JOIN project_pipeline_runs pipeline_run
           ON pipeline_run.id = lock_row.pipeline_run_id
        WHERE lock_row.pipeline_run_id IS NOT NULL
          AND pipeline_run.id IS NULL`,
    );
    if (Number(remainingOrphans[0]?.count ?? 0) !== 0) {
      throw new Error("TERRAFORM_LOCK_HISTORY_ORPHAN_REPAIR_INCOMPLETE");
    }

    if (foreignKeys.length === 1 && foreignKeys[0].confdeltype === "c") {
      await queryRunner.query(
        `ALTER TABLE "project_terraform_locks"
           DROP CONSTRAINT "${foreignKeys[0].conname.replaceAll('"', '""')}"`,
      );
    }
    if (foreignKeys.length === 0 || foreignKeys[0].confdeltype === "c") {
      await queryRunner.query(
        `ALTER TABLE "project_terraform_locks"
           ADD CONSTRAINT "FK_project_terraform_locks_pipeline_run"
           FOREIGN KEY ("pipeline_run_id")
           REFERENCES "project_pipeline_runs" ("id")
           ON UPDATE NO ACTION ON DELETE SET NULL NOT VALID`,
      );
      await queryRunner.query(
        `ALTER TABLE "project_terraform_locks"
           VALIDATE CONSTRAINT "FK_project_terraform_locks_pipeline_run"`,
      );
    }
  }

  async down(): Promise<void> {
    throw new Error("Refusing to discard preserved Terraform-lock history");
  }

  private async foreignKeys(queryRunner: QueryRunner): Promise<CurrentForeignKey[]> {
    return queryRunner.query(
      `SELECT constraint_row.conname, constraint_row.contype,
              constraint_row.convalidated, constraint_row.confdeltype,
              constraint_row.confupdtype, source_column.attname AS source_column,
              constraint_row.confrelid::regclass::text AS referenced_table,
              target_column.attname AS referenced_column
         FROM pg_constraint constraint_row
         JOIN pg_attribute source_column
           ON source_column.attrelid = constraint_row.conrelid
          AND source_column.attnum = constraint_row.conkey[1]
         JOIN pg_attribute target_column
           ON target_column.attrelid = constraint_row.confrelid
          AND target_column.attnum = constraint_row.confkey[1]
        WHERE constraint_row.conrelid = 'public.project_terraform_locks'::regclass
          AND constraint_row.contype = 'f'
          AND array_length(constraint_row.conkey, 1) = 1
          AND source_column.attname = 'pipeline_run_id'
          AND constraint_row.confrelid = 'public.project_pipeline_runs'::regclass
          AND target_column.attname = 'id'`,
    );
  }

  private requireBaseDefinition(current: CurrentForeignKey): void {
    if (
      current.contype !== "f"
      || current.convalidated !== true
      || current.confupdtype !== "a"
      || current.source_column !== "pipeline_run_id"
      || current.referenced_table !== "project_pipeline_runs"
      || current.referenced_column !== "id"
    ) {
      throw new Error("TERRAFORM_LOCK_HISTORY_FK_DEFINITION_CONFLICT");
    }
  }
}
