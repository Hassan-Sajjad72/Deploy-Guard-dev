import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { DataSource } from "typeorm";

const requiredColumns = [
  ["project_deployable_services", "id"],
  ["project_deployable_services", "project_id"],
  ["project_deployable_services", "service_directory"],
  ["project_deployable_services", "service_port"],
  ["project_environment_variables", "service_id"],
  ["project_pipeline_runs", "id"],
  ["project_pipeline_runs", "project_id"],
  ["project_pipeline_runs", "triggered_by_user_id"],
  ["project_pipeline_runs", "status"],
  ["project_pipeline_runs", "metadata"],
  ["project_pipeline_runs", "created_at"],
  ["project_pipeline_events", "id"],
  ["project_pipeline_events", "pipeline_run_id"],
  ["project_pipeline_events", "project_id"],
  ["project_deployment_generations", "id"],
  ["project_deployment_generations", "project_id"],
  ["project_deployment_generations", "status"],
  ["project_deployment_generations", "cleanup_metadata"],
  ["project_deployment_generations", "updated_at"],
  ["project_stable_releases", "id"],
  ["project_stable_releases", "project_id"],
  ["project_stable_releases", "generation_id"],
  ["project_stable_releases", "status"],
  ["project_database_tiers", "active_generation_id"],
  ["project_database_tiers", "attached_service_id"],
  ["project_database_tiers", "external_host"],
  ["project_database_tiers", "external_port"],
  ["project_database_tiers", "external_tls_required"],
  ["project_database_tiers", "efs_file_system_id"],
  ["project_database_tiers", "efs_access_point_id"],
  ["project_database_tiers", "credentials_secret_arn"],
  ["project_database_tiers", "database_url_secret_arn"],
  ["project_environment_routes", "id"],
  ["project_environment_routes", "project_id"],
  ["project_environment_routes", "environment_name"],
  ["project_environment_routes", "listener_priority"],
  ["project_environment_routes", "live_generation_id"],
  ["project_environment_routes", "candidate_generation_id"],
  ["notification_preferences", "id"],
  ["notification_preferences", "user_id"],
  ["notification_preferences", "project_id"],
  ["notification_preferences", "enabled"],
  ["notification_preferences", "critical_enabled"],
  ["notification_preferences", "success_enabled"],
  ["notification_preferences", "stage_updates_enabled"],
  ["notification_preferences", "channel"],
  ["notification_preferences", "created_at"],
  ["notification_preferences", "updated_at"],
  ["notification_subscriptions", "id"],
  ["notification_subscriptions", "user_id"],
  ["notification_subscriptions", "project_id"],
  ["notification_subscriptions", "destination"],
  ["notification_subscriptions", "protocol"],
  ["notification_subscriptions", "status"],
  ["notification_subscriptions", "provider_subscription_arn"],
  ["notification_subscriptions", "provider_topic_arn"],
  ["notification_subscriptions", "confirmed_at"],
  ["notification_subscriptions", "last_error"],
  ["notification_subscriptions", "created_at"],
  ["notification_subscriptions", "updated_at"],
  ["notification_deliveries", "id"],
  ["notification_deliveries", "user_id"],
  ["notification_deliveries", "project_id"],
  ["notification_deliveries", "pipeline_run_id"],
  ["notification_deliveries", "event_type"],
  ["notification_deliveries", "deduplication_key"],
  ["notification_deliveries", "status"],
  ["notification_deliveries", "provider_message_id"],
  ["notification_deliveries", "attempts"],
  ["notification_deliveries", "last_error"],
  ["notification_deliveries", "subject"],
  ["notification_deliveries", "message"],
  ["notification_deliveries", "safe_metadata"],
  ["notification_deliveries", "sent_at"],
  ["notification_deliveries", "created_at"],
  ["notification_deliveries", "updated_at"],
  ["project_pipeline_runs", "failure_owner"],
  ["project_pipeline_runs", "failure_code"],
  ["project_pipeline_runs", "failure_service_id"],
] as const;

export type MappedSchemaColumn = {
  tableName: string;
  columnName: string;
};

/**
 * Returns every physical column TypeORM will address for regular mapped entities.
 * Metadata drives this list so a newly mapped column cannot evade regression tests.
 */
export function mappedEntityColumns(dataSource: DataSource): MappedSchemaColumn[] {
  return dataSource.entityMetadatas
    .filter((entity) => entity.tableType === "regular")
    .flatMap((entity) => entity.columns
      .filter((column) => !column.isVirtual)
      .map((column) => ({ tableName: entity.tableName, columnName: column.databaseName })))
    .filter((column, index, columns) => columns.findIndex((candidate) =>
      candidate.tableName === column.tableName && candidate.columnName === column.columnName,
    ) === index)
    .sort((left, right) => left.tableName.localeCompare(right.tableName) || left.columnName.localeCompare(right.columnName));
}

export async function assertMappedEntitySchemaIntegrity(dataSource: DataSource) {
  const expected = mappedEntityColumns(dataSource);
  const existing = await dataSource.query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
    `,
  ) as Array<{ table_name: string; column_name: string }>;
  const actual = new Set(existing.map((column) => `${column.table_name}.${column.column_name}`));
  const missing = expected.filter((column) => !actual.has(`${column.tableName}.${column.columnName}`));

  if (missing.length) {
    throw new Error(
      `DeployGuard mapped database schema is incomplete (${missing.map((column) => `${column.tableName}.${column.columnName}`).join(", ")}). Run the registered migrations before using these entities.`,
    );
  }
}

export async function assertProductStartSchemaIntegrity(dataSource: DataSource) {
  const missing = await dataSource.query(
    `
      WITH required(table_name, column_name) AS (
        VALUES ${requiredColumns.map(([table, column]) => `('${table}', '${column}')`).join(", ")}
      )
      SELECT required.table_name, required.column_name
      FROM required
      LEFT JOIN information_schema.columns columns
        ON columns.table_schema = 'public'
       AND columns.table_name = required.table_name
       AND columns.column_name = required.column_name
      WHERE columns.column_name IS NULL
      ORDER BY required.table_name, required.column_name
    `,
  ) as Array<{ table_name: string; column_name: string }>;

  if (missing.length) {
    const details = missing.map((entry) => `${entry.table_name}.${entry.column_name}`).join(", ");
    throw new Error(
      `DeployGuard database schema is incomplete (${details}). Run the registered migrations before starting the product.`,
    );
  }
}

@Injectable()
export class ProductStartSchemaIntegrityService {
  constructor(private readonly dataSource: DataSource) {}

  async assertReady() {
    try {
      await assertProductStartSchemaIntegrity(this.dataSource);
    } catch (error) {
      throw new ServiceUnavailableException(
        error instanceof Error ? error.message : "DeployGuard database schema is incomplete.",
      );
    }
  }
}
