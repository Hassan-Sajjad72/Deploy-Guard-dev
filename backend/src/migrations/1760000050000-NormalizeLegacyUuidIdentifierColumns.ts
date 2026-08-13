import { MigrationInterface, QueryRunner } from "typeorm";

const LEGACY_UUID_COLUMNS = [
  ["project_orchestration_events", "project_id"],
  ["project_orchestration_events", "pipeline_run_id"],
  ["project_rollback_records", "project_id"],
  ["project_rollback_records", "deployment_id"],
  ["project_rollback_records", "pipeline_run_id"],
  ["project_spot_interruption_events", "project_id"],
  ["project_spot_interruption_events", "deployment_id"],
  ["project_spot_interruption_events", "pipeline_run_id"],
  ["project_stable_releases", "deployed_by_pipeline_run_id"],
  ["project_deployment_queue_items", "project_id"],
  ["project_deployment_queue_items", "pipeline_run_id"],
  ["project_state_recovery_requests", "project_id"],
  ["project_state_validation_results", "project_id"],
  ["project_state_validation_results", "infrastructure_environment_id"],
  ["project_terraform_locks", "project_id"],
  ["project_terraform_locks", "pipeline_run_id"],
  ["project_backup_records", "project_id"],
  ["project_storage_events", "project_id"],
  ["project_storage_events", "pipeline_run_id"],
  ["project_storage_restore_requests", "project_id"],
  ["project_storage_restore_requests", "persistent_storage_id"],
  ["project_deployment_requirements", "applied_pipeline_run_id"],
  ["ai_analysis_sessions", "project_id"],
  ["ai_analysis_sessions", "pipeline_run_id"],
  ["ai_analysis_messages", "session_id"],
  ["ai_analysis_results", "session_id"],
  ["notification_preferences", "project_id"],
  ["notification_subscriptions", "project_id"],
  ["notification_deliveries", "project_id"],
  ["notification_deliveries", "pipeline_run_id"],
  ["infrastructure_destroy_challenges", "project_id"],
  ["infrastructure_destroy_operations", "project_id"],
  ["infrastructure_destroy_operations", "infrastructure_environment_id"],
  ["infrastructure_destroy_operations", "emergency_operation_id"],
  ["central_cloud_resources", "project_id"],
  ["central_cloud_resources", "pipeline_run_id"],
  ["terraform_export_artifacts", "project_id"],
  ["cloud_inventory_scans", "project_id"],
  ["project_cloud_states", "last_inventory_scan_id"],
  ["project_stage_checkpoints", "source_checkpoint_id"],
] as const;

const UUID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

type ColumnState = {
  tableName: string;
  columnName: string;
  udtName: string;
};

export class NormalizeLegacyUuidIdentifierColumns1760000050000
implements MigrationInterface {
  name = "NormalizeLegacyUuidIdentifierColumns1760000050000";

  async up(queryRunner: QueryRunner): Promise<void> {
    const states: ColumnState[] = [];

    // Validate every column and every stored value before obtaining any of the
    // ALTER TABLE locks. A conflicting schema or value aborts the transaction
    // without partially normalizing earlier tables.
    for (const [tableName, columnName] of LEGACY_UUID_COLUMNS) {
      const rows: Array<{ udt_name: string }> = await queryRunner.query(
        `
          SELECT udt_name
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = $1
            AND column_name = $2
        `,
        [tableName, columnName],
      );

      if (rows.length !== 1) {
        throw new Error(
          `SCHEMA_UUID_COLUMN_MISSING:${tableName}.${columnName}`,
        );
      }

      const udtName = rows[0].udt_name;
      if (!["uuid", "varchar", "text"].includes(udtName)) {
        throw new Error(
          `SCHEMA_UUID_COLUMN_TYPE_CONFLICT:${tableName}.${columnName}`,
        );
      }

      if (udtName !== "uuid") {
        const invalidRows: Array<{ invalid_count: string }> =
          await queryRunner.query(
            `
              SELECT count(*)::text AS invalid_count
              FROM "${tableName}"
              WHERE "${columnName}" IS NOT NULL
                AND "${columnName}" !~* $1
            `,
            [UUID_PATTERN],
          );

        if (Number(invalidRows[0]?.invalid_count ?? 0) !== 0) {
          throw new Error(
            `SCHEMA_UUID_COLUMN_DATA_CONFLICT:${tableName}.${columnName}`,
          );
        }
      }

      states.push({ tableName, columnName, udtName });
    }

    for (const { tableName, columnName, udtName } of states) {
      if (udtName === "uuid") {
        continue;
      }

      await queryRunner.query(`
        ALTER TABLE "${tableName}"
        ALTER COLUMN "${columnName}" TYPE uuid
        USING "${columnName}"::uuid
      `);
    }
  }

  async down(): Promise<void> {
    throw new Error(
      "Refusing to infer and restore legacy text identifier columns",
    );
  }
}
