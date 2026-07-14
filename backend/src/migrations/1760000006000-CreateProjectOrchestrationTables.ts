import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectOrchestrationTables1760000006000 implements MigrationInterface {
  name = "CreateProjectOrchestrationTables1760000006000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    for (const status of [
      "ecs_deployment_queued",
      "ecs_task_definition_registering",
      "ecs_service_updating",
      "ecs_waiting_for_stability",
      "ecs_service_healthy",
      "ecs_service_unhealthy",
      "ecs_deployment_failed",
      "rollback_started",
      "rollback_succeeded",
      "rollback_failed",
      "spot_interruption_handled",
    ]) {
      await this.addPipelineRunStatus(queryRunner, status);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_deployments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "infrastructure_environment_id" uuid,
        "environment_name" character varying NOT NULL DEFAULT 'dev',
        "status" character varying NOT NULL DEFAULT 'queued',
        "commit_sha" character varying,
        "short_commit_sha" character varying,
        "image_uri" character varying,
        "task_definition_arn" character varying,
        "previous_task_definition_arn" character varying,
        "ecs_cluster_arn" character varying,
        "ecs_cluster_name" character varying,
        "ecs_service_arn" character varying,
        "ecs_service_name" character varying,
        "alb_arn" character varying,
        "alb_dns_name" character varying,
        "target_group_arn" character varying,
        "listener_arn" character varying,
        "health_check_path" character varying NOT NULL DEFAULT '/health',
        "app_port" integer,
        "desired_count" integer NOT NULL DEFAULT 1,
        "min_tasks" integer NOT NULL DEFAULT 1,
        "max_tasks" integer NOT NULL DEFAULT 3,
        "cpu_target_percent" integer NOT NULL DEFAULT 60,
        "capacity_provider_strategy" jsonb,
        "efs_mount_config" jsonb,
        "cloud_map_namespace_id" character varying,
        "cloud_map_service_name" character varying,
        "deployment_started_at" TIMESTAMP,
        "deployment_completed_at" TIMESTAMP,
        "failed_at" TIMESTAMP,
        "rollback_started_at" TIMESTAMP,
        "rollback_completed_at" TIMESTAMP,
        "stable" boolean NOT NULL DEFAULT false,
        "metadata" jsonb,
        "error_message" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_deployments_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_stable_releases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "environment_name" character varying NOT NULL DEFAULT 'dev',
        "commit_sha" character varying NOT NULL,
        "short_commit_sha" character varying NOT NULL,
        "image_uri" character varying NOT NULL,
        "task_definition_arn" character varying NOT NULL,
        "ecs_service_arn" character varying,
        "health_check_path" character varying NOT NULL DEFAULT '/health',
        "app_port" integer,
        "deployed_by_pipeline_run_id" uuid,
        "deployed_at" TIMESTAMP NOT NULL,
        "status" character varying NOT NULL DEFAULT 'stable',
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_stable_releases_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_orchestration_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "deployment_id" uuid,
        "event_type" character varying NOT NULL,
        "status" character varying NOT NULL,
        "message" text NOT NULL,
        "metadata" jsonb,
        "actor_user_id" integer,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_orchestration_events_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_spot_interruption_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "deployment_id" uuid,
        "pipeline_run_id" uuid,
        "ecs_cluster_arn" character varying,
        "ecs_service_arn" character varying,
        "task_arn" character varying,
        "event_id" character varying,
        "event_time" TIMESTAMP,
        "reason" character varying,
        "status" character varying NOT NULL DEFAULT 'received',
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_spot_interruption_events_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_rollback_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "deployment_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "from_commit_sha" character varying,
        "to_commit_sha" character varying NOT NULL,
        "from_task_definition_arn" character varying,
        "to_task_definition_arn" character varying,
        "reason" text NOT NULL,
        "status" character varying NOT NULL DEFAULT 'started',
        "started_at" TIMESTAMP NOT NULL,
        "completed_at" TIMESTAMP,
        "metadata" jsonb,
        "error_message" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_rollback_records_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_deployments_project_id" ON "project_deployments" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_stable_releases_project_id" ON "project_stable_releases" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_orchestration_events_project_id" ON "project_orchestration_events" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_spot_events_project_id" ON "project_spot_interruption_events" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_rollback_records_project_id" ON "project_rollback_records" ("project_id")`);
    await this.addForeignKey(queryRunner, "project_deployments", "FK_deployments_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_deployments", "FK_deployments_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_deployments", "FK_deployments_infra", "infrastructure_environment_id", "project_infrastructure_environments", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_stable_releases", "FK_releases_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_stable_releases", "FK_releases_run", "deployed_by_pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_orchestration_events", "FK_orchestration_events_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_orchestration_events", "FK_orchestration_events_deployment", "deployment_id", "project_deployments", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_orchestration_events", "FK_orchestration_events_actor", "actor_user_id", "users", "id", "SET NULL");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_rollback_records"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_spot_interruption_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_orchestration_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_stable_releases"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_deployments"`);
  }

  private async addPipelineRunStatus(queryRunner: QueryRunner, value: string) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_pipeline_runs_status_enum') THEN
          ALTER TYPE "project_pipeline_runs_status_enum" ADD VALUE IF NOT EXISTS '${value}';
        END IF;
      END $$;
    `);
  }

  private async addForeignKey(
    queryRunner: QueryRunner,
    tableName: string,
    constraintName: string,
    columnName: string,
    referencedTableName: string,
    referencedColumnName: string,
    onDelete: string
  ) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.${referencedTableName}') IS NOT NULL THEN
          ALTER TABLE "${tableName}"
          ADD CONSTRAINT "${constraintName}"
          FOREIGN KEY ("${columnName}") REFERENCES "${referencedTableName}"("${referencedColumnName}") ON DELETE ${onDelete};
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
  }
}
