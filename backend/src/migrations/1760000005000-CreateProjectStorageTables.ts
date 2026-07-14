import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectStorageTables1760000005000 implements MigrationInterface {
  name = "CreateProjectStorageTables1760000005000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await this.addPipelineRunStatus(queryRunner, "storage_evaluation_running");
    await this.addPipelineRunStatus(queryRunner, "storage_not_required");
    await this.addPipelineRunStatus(queryRunner, "storage_provisioning");
    await this.addPipelineRunStatus(queryRunner, "storage_provisioned");
    await this.addPipelineRunStatus(queryRunner, "storage_failed");
    await this.addPipelineRunStatus(queryRunner, "backup_configuring");
    await this.addPipelineRunStatus(queryRunner, "backup_configured");
    await this.addPipelineRunStatus(queryRunner, "backup_failed");

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_persistent_storage" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "infrastructure_environment_id" uuid,
        "pipeline_run_id" uuid,
        "environment_name" character varying NOT NULL DEFAULT 'dev',
        "enabled" boolean NOT NULL DEFAULT false,
        "required_by_detection" boolean NOT NULL DEFAULT false,
        "user_enabled" boolean NOT NULL DEFAULT false,
        "status" character varying NOT NULL DEFAULT 'not_required',
        "storage_type" character varying NOT NULL DEFAULT 'efs',
        "aws_region" character varying,
        "efs_file_system_id" character varying,
        "efs_file_system_arn" character varying,
        "efs_dns_name" character varying,
        "efs_access_point_id" character varying,
        "efs_access_point_arn" character varying,
        "efs_security_group_id" character varying,
        "kms_key_id" character varying,
        "kms_key_arn" character varying,
        "mount_target_ids" jsonb,
        "root_directory" character varying,
        "posix_uid" integer NOT NULL DEFAULT 1000,
        "posix_gid" integer NOT NULL DEFAULT 1000,
        "root_permissions" character varying NOT NULL DEFAULT '750',
        "encrypted" boolean NOT NULL DEFAULT true,
        "backup_enabled" boolean NOT NULL DEFAULT true,
        "backup_vault_name" character varying,
        "backup_plan_id" character varying,
        "backup_retention_days" integer,
        "ecs_mount_config" jsonb,
        "metadata" jsonb,
        "error_message" text,
        "provisioned_at" TIMESTAMP,
        "failed_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_persistent_storage_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_storage_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "persistent_storage_id" uuid,
        "event_type" character varying NOT NULL,
        "status" character varying NOT NULL,
        "message" text NOT NULL,
        "metadata" jsonb,
        "actor_user_id" integer,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_storage_events_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_backup_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "persistent_storage_id" uuid NOT NULL,
        "backup_provider" character varying NOT NULL DEFAULT 'aws_backup',
        "backup_vault_name" character varying,
        "backup_plan_id" character varying,
        "recovery_point_arn" character varying,
        "status" character varying NOT NULL DEFAULT 'configured',
        "retention_days" integer,
        "schedule" character varying,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_backup_records_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_storage_restore_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "persistent_storage_id" uuid NOT NULL,
        "recovery_point_arn" character varying,
        "status" character varying NOT NULL DEFAULT 'pending',
        "requested_by_user_id" integer,
        "approved_by_user_id" integer,
        "reason" text,
        "completed_at" TIMESTAMP,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_storage_restore_requests_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_persistent_storage_project_id" ON "project_persistent_storage" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_storage_events_project_id" ON "project_storage_events" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_backup_records_project_id" ON "project_backup_records" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_restore_requests_project_id" ON "project_storage_restore_requests" ("project_id")`);
    await this.addForeignKey(queryRunner, "project_persistent_storage", "FK_storage_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_persistent_storage", "FK_storage_infra_env", "infrastructure_environment_id", "project_infrastructure_environments", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_persistent_storage", "FK_storage_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_storage_events", "FK_storage_events_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_storage_events", "FK_storage_events_storage", "persistent_storage_id", "project_persistent_storage", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_storage_events", "FK_storage_events_actor", "actor_user_id", "users", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_backup_records", "FK_backup_records_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_backup_records", "FK_backup_records_storage", "persistent_storage_id", "project_persistent_storage", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_storage_restore_requests", "FK_restore_requests_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_storage_restore_requests", "FK_restore_requests_storage", "persistent_storage_id", "project_persistent_storage", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_storage_restore_requests", "FK_restore_requests_requested_by", "requested_by_user_id", "users", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_storage_restore_requests", "FK_restore_requests_approved_by", "approved_by_user_id", "users", "id", "SET NULL");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_storage_restore_requests"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_backup_records"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_storage_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_persistent_storage"`);
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
