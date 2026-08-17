import { MigrationInterface, QueryRunner } from "typeorm";

type DeleteAction = "CASCADE" | "SET NULL" | "RESTRICT";

export type OperationalOwnershipForeignKey = {
  tableName: string;
  constraintName: string;
  columnName: string;
  referencedTableName: string;
  referencedColumnName: string;
  onDelete: DeleteAction;
  deleteCode: "c" | "n" | "r";
};

export const OPERATIONAL_OWNERSHIP_FOREIGN_KEYS:
readonly OperationalOwnershipForeignKey[] = [
  { tableName: "project_backup_records", constraintName: "FK_backup_records_project", columnName: "project_id", referencedTableName: "projects", referencedColumnName: "id", onDelete: "CASCADE", deleteCode: "c" },
  { tableName: "project_deployment_queue_items", constraintName: "FK_project_deployment_queue_items_pipeline_run", columnName: "pipeline_run_id", referencedTableName: "project_pipeline_runs", referencedColumnName: "id", onDelete: "CASCADE", deleteCode: "c" },
  { tableName: "project_deployment_queue_items", constraintName: "FK_project_deployment_queue_items_project", columnName: "project_id", referencedTableName: "projects", referencedColumnName: "id", onDelete: "CASCADE", deleteCode: "c" },
  { tableName: "project_deployments", constraintName: "FK_project_deployments_release_manifest", columnName: "release_manifest_id", referencedTableName: "release_manifests", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_infrastructure_environments", constraintName: "FK_infrastructure_environments_applied_manifest", columnName: "applied_manifest_id", referencedTableName: "infrastructure_manifests", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_infrastructure_environments", constraintName: "FK_infrastructure_environments_desired_manifest", columnName: "desired_manifest_id", referencedTableName: "infrastructure_manifests", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_pipeline_runs", constraintName: "FK_pipeline_runs_cross_lane_ownership", columnName: "cross_lane_ownership_id", referencedTableName: "project_release_lane_ownerships", referencedColumnName: "id", onDelete: "RESTRICT", deleteCode: "r" },
  { tableName: "project_pipeline_runs", constraintName: "FK_pipeline_runs_deployment_intent", columnName: "deployment_intent_id", referencedTableName: "deployment_intents", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_pipeline_runs", constraintName: "FK_pipeline_runs_infrastructure_manifest", columnName: "infrastructure_manifest_id", referencedTableName: "infrastructure_manifests", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_pipeline_runs", constraintName: "FK_pipeline_runs_release_manifest", columnName: "release_manifest_id", referencedTableName: "release_manifests", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_rollback_records", constraintName: "FK_rollback_records_cross_lane_ownership", columnName: "cross_lane_ownership_id", referencedTableName: "project_release_lane_ownerships", referencedColumnName: "id", onDelete: "RESTRICT", deleteCode: "r" },
  { tableName: "project_state_recovery_requests", constraintName: "FK_project_state_recovery_requests_project", columnName: "project_id", referencedTableName: "projects", referencedColumnName: "id", onDelete: "CASCADE", deleteCode: "c" },
  { tableName: "project_state_validation_results", constraintName: "FK_project_state_validation_results_environment", columnName: "infrastructure_environment_id", referencedTableName: "project_infrastructure_environments", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_state_validation_results", constraintName: "FK_project_state_validation_results_project", columnName: "project_id", referencedTableName: "projects", referencedColumnName: "id", onDelete: "CASCADE", deleteCode: "c" },
  { tableName: "project_storage_events", constraintName: "FK_storage_events_project", columnName: "project_id", referencedTableName: "projects", referencedColumnName: "id", onDelete: "CASCADE", deleteCode: "c" },
  { tableName: "project_storage_restore_requests", constraintName: "FK_restore_requests_approved_by", columnName: "approved_by_user_id", referencedTableName: "users", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_storage_restore_requests", constraintName: "FK_restore_requests_storage", columnName: "persistent_storage_id", referencedTableName: "project_persistent_storage", referencedColumnName: "id", onDelete: "CASCADE", deleteCode: "c" },
  { tableName: "project_storage_restore_requests", constraintName: "FK_restore_requests_project", columnName: "project_id", referencedTableName: "projects", referencedColumnName: "id", onDelete: "CASCADE", deleteCode: "c" },
  { tableName: "project_storage_restore_requests", constraintName: "FK_restore_requests_requested_by", columnName: "requested_by_user_id", referencedTableName: "users", referencedColumnName: "id", onDelete: "SET NULL", deleteCode: "n" },
  { tableName: "project_terraform_locks", constraintName: "FK_project_terraform_locks_project", columnName: "project_id", referencedTableName: "projects", referencedColumnName: "id", onDelete: "CASCADE", deleteCode: "c" },
];

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export class ReconcileOperationalOwnershipForeignKeys1760000057000
implements MigrationInterface {
  name = "ReconcileOperationalOwnershipForeignKeys1760000057000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`SET LOCAL lock_timeout = '5s'`);
    await queryRunner.query(`SET LOCAL statement_timeout = '30s'`);

    const missing: OperationalOwnershipForeignKey[] = [];
    for (const spec of OPERATIONAL_OWNERSHIP_FOREIGN_KEYS) {
      const sourceTable = `public.${spec.tableName}`;
      const targetTable = `public.${spec.referencedTableName}`;
      const types: Array<{ source_type: string; target_type: string }> =
        await queryRunner.query(
          `SELECT format_type(source_column.atttypid, source_column.atttypmod) AS source_type,
                  format_type(target_column.atttypid, target_column.atttypmod) AS target_type
             FROM pg_attribute source_column
             JOIN pg_attribute target_column
               ON target_column.attrelid = $3::regclass
              AND target_column.attname = $4
              AND NOT target_column.attisdropped
            WHERE source_column.attrelid = $1::regclass
              AND source_column.attname = $2
              AND NOT source_column.attisdropped`,
          [sourceTable, spec.columnName, targetTable, spec.referencedColumnName],
        );
      if (types.length !== 1 || types[0].source_type !== types[0].target_type) {
        throw new Error(`OPERATIONAL_OWNERSHIP_FK_TYPE_CONFLICT:${spec.constraintName}`);
      }

      const keys: Array<{ count: string }> = await queryRunner.query(
        `SELECT count(*)::text AS count
           FROM pg_constraint target_key
          WHERE target_key.conrelid = $1::regclass
            AND target_key.contype IN ('p', 'u')
            AND array_length(target_key.conkey, 1) = 1
            AND target_key.conkey[1] = (
              SELECT attnum FROM pg_attribute
               WHERE attrelid = $1::regclass
                 AND attname = $2
                 AND NOT attisdropped
            )`,
        [targetTable, spec.referencedColumnName],
      );
      if (Number(keys[0]?.count ?? 0) !== 1) {
        throw new Error(`OPERATIONAL_OWNERSHIP_FK_REFERENCE_KEY_CONFLICT:${spec.constraintName}`);
      }

      const named = await this.constraints(
        queryRunner,
        sourceTable,
        spec,
        `AND constraint_row.conname = $5`,
        [spec.constraintName],
      );
      if (named.length > 1) {
        throw new Error(`OPERATIONAL_OWNERSHIP_FK_NAME_CONFLICT:${spec.constraintName}`);
      }
      if (named.length === 1) {
        this.requireExact(named[0], spec, "DEFINITION");
        continue;
      }

      const equivalent = await this.constraints(queryRunner, sourceTable, spec, "", []);
      if (equivalent.length > 1) {
        throw new Error(`OPERATIONAL_OWNERSHIP_FK_EQUIVALENT_CONFLICT:${spec.constraintName}`);
      }
      if (equivalent.length === 1) {
        this.requireExact(equivalent[0], spec, "EQUIVALENT_DEFINITION");
        continue;
      }

      const orphanRows: Array<{ count: string }> = await queryRunner.query(
        `SELECT count(*)::text AS count
           FROM ${quoted(spec.tableName)} source_row
           LEFT JOIN ${quoted(spec.referencedTableName)} target_row
             ON target_row.${quoted(spec.referencedColumnName)} =
                source_row.${quoted(spec.columnName)}
          WHERE source_row.${quoted(spec.columnName)} IS NOT NULL
            AND target_row.${quoted(spec.referencedColumnName)} IS NULL`,
      );
      if (Number(orphanRows[0]?.count ?? 0) !== 0) {
        throw new Error(`OPERATIONAL_OWNERSHIP_FK_ORPHAN_CONFLICT:${spec.constraintName}`);
      }
      missing.push(spec);
    }

    for (const spec of missing) {
      await queryRunner.query(
        `ALTER TABLE ${quoted(spec.tableName)}
           ADD CONSTRAINT ${quoted(spec.constraintName)}
           FOREIGN KEY (${quoted(spec.columnName)})
           REFERENCES ${quoted(spec.referencedTableName)}
             (${quoted(spec.referencedColumnName)})
           ON UPDATE NO ACTION ON DELETE ${spec.onDelete} NOT VALID`,
      );
      await queryRunner.query(
        `ALTER TABLE ${quoted(spec.tableName)}
           VALIDATE CONSTRAINT ${quoted(spec.constraintName)}`,
      );
    }
  }

  async down(): Promise<void> {
    throw new Error(
      "Refusing to remove validated operational ownership foreign keys",
    );
  }

  private async constraints(
    queryRunner: QueryRunner,
    sourceTable: string,
    spec: OperationalOwnershipForeignKey,
    suffix: string,
    suffixParameters: unknown[],
  ): Promise<Array<Record<string, unknown>>> {
    return queryRunner.query(
      `SELECT constraint_row.conname,
              constraint_row.contype,
              constraint_row.convalidated,
              constraint_row.confdeltype,
              constraint_row.confupdtype,
              source_column.attname AS source_column,
              constraint_row.confrelid::regclass::text AS referenced_table,
              target_column.attname AS referenced_column
         FROM pg_constraint constraint_row
         JOIN pg_attribute source_column
           ON source_column.attrelid = constraint_row.conrelid
          AND source_column.attnum = constraint_row.conkey[1]
         JOIN pg_attribute target_column
           ON target_column.attrelid = constraint_row.confrelid
          AND target_column.attnum = constraint_row.confkey[1]
        WHERE constraint_row.conrelid = $1::regclass
          AND constraint_row.contype = 'f'
          AND array_length(constraint_row.conkey, 1) = 1
          AND source_column.attname = $2
          AND constraint_row.confrelid = $3::regclass
          AND target_column.attname = $4
          ${suffix}`,
      [
        sourceTable,
        spec.columnName,
        `public.${spec.referencedTableName}`,
        spec.referencedColumnName,
        ...suffixParameters,
      ],
    );
  }

  private requireExact(
    current: Record<string, unknown>,
    spec: OperationalOwnershipForeignKey,
    conflict: string,
  ): void {
    if (
      current.contype !== "f"
      || current.convalidated !== true
      || current.confdeltype !== spec.deleteCode
      || current.confupdtype !== "a"
      || current.source_column !== spec.columnName
      || current.referenced_table !== spec.referencedTableName
      || current.referenced_column !== spec.referencedColumnName
    ) {
      throw new Error(`OPERATIONAL_OWNERSHIP_FK_${conflict}_CONFLICT:${spec.constraintName}`);
    }
  }
}
