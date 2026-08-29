import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectTerraformStateTables1760000004000
  implements MigrationInterface
{
  name = "CreateProjectTerraformStateTables1760000004000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await this.addPipelineStatus(queryRunner, "state_lock_acquiring");
    await this.addPipelineStatus(queryRunner, "waiting_for_state_lock");
    await this.addPipelineStatus(queryRunner, "state_lock_acquired");
    await this.addPipelineStatus(queryRunner, "state_heartbeat_active");
    await this.addPipelineStatus(queryRunner, "state_validation_running");
    await this.addPipelineStatus(queryRunner, "state_recovery_required");
    await this.addPipelineStatus(queryRunner, "state_lock_released");
    await this.addPipelineStatus(queryRunner, "state_lock_failed");
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_terraform_states" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "infrastructure_environment_id" uuid,
        "environment_name" character varying NOT NULL DEFAULT 'dev',
        "state_bucket" character varying NOT NULL,
        "state_key" character varying NOT NULL,
        "state_region" character varying NOT NULL,
        "current_version_id" character varying,
        "previous_version_id" character varying,
        "checksum" character varying,
        "resource_count" integer,
        "dependency_graph_hash" character varying,
        "status" character varying NOT NULL DEFAULT 'missing',
        "last_validated_at" TIMESTAMP,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_terraform_states_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_terraform_locks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "lock_id" character varying NOT NULL,
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid NOT NULL,
        "deployment_id" character varying,
        "environment_name" character varying NOT NULL DEFAULT 'dev',
        "user_id" integer,
        "status" character varying NOT NULL DEFAULT 'acquired',
        "owner_worker_id" character varying,
        "terraform_pid" integer,
        "acquired_at" TIMESTAMP NOT NULL,
        "heartbeat_at" TIMESTAMP,
        "heartbeat_interval_seconds" integer NOT NULL DEFAULT 30,
        "stale_after_seconds" integer NOT NULL DEFAULT 300,
        "released_at" TIMESTAMP,
        "force_released_at" TIMESTAMP,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_terraform_locks_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_terraform_locks_lock_id" UNIQUE ("lock_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_deployment_queue_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid NOT NULL,
        "environment_name" character varying NOT NULL DEFAULT 'dev',
        "status" character varying NOT NULL DEFAULT 'queued',
        "position" integer,
        "reason" text,
        "started_at" TIMESTAMP,
        "completed_at" TIMESTAMP,
        "failed_at" TIMESTAMP,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_deployment_queue_items_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_state_validation_results" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "infrastructure_environment_id" uuid,
        "environment_name" character varying NOT NULL DEFAULT 'dev',
        "state_version_id" character varying,
        "status" character varying NOT NULL,
        "json_schema_valid" boolean NOT NULL,
        "checksum_valid" boolean NOT NULL,
        "resource_count_valid" boolean NOT NULL,
        "dependency_graph_valid" boolean NOT NULL,
        "resource_count" integer,
        "expected_checksum" character varying,
        "actual_checksum" character varying,
        "issues" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_state_validation_results_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_state_recovery_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "environment_name" character varying NOT NULL DEFAULT 'dev',
        "corrupted_version_id" character varying,
        "recovery_version_id" character varying,
        "status" character varying NOT NULL DEFAULT 'pending',
        "requested_by_user_id" integer,
        "approved_by_user_id" integer,
        "reason" text,
        "completed_at" TIMESTAMP,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_state_recovery_requests_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_terraform_states_project_id" ON "project_terraform_states" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_terraform_locks_project_id" ON "project_terraform_locks" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_deployment_queue_items_project_id" ON "project_deployment_queue_items" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_state_validation_results_project_id" ON "project_state_validation_results" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_state_recovery_requests_project_id" ON "project_state_recovery_requests" ("project_id")`);
    await this.addForeignKey(queryRunner, "project_terraform_states", "FK_project_terraform_states_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_terraform_states", "FK_project_terraform_states_environment", "infrastructure_environment_id", "project_infrastructure_environments", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_terraform_locks", "FK_project_terraform_locks_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_terraform_locks", "FK_project_terraform_locks_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_deployment_queue_items", "FK_project_deployment_queue_items_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_deployment_queue_items", "FK_project_deployment_queue_items_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_state_validation_results", "FK_project_state_validation_results_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_state_validation_results", "FK_project_state_validation_results_environment", "infrastructure_environment_id", "project_infrastructure_environments", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_state_recovery_requests", "FK_project_state_recovery_requests_project", "project_id", "projects", "id", "CASCADE");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_state_recovery_requests"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_state_validation_results"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_deployment_queue_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_terraform_locks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_terraform_states"`);
  }

  private async addPipelineStatus(queryRunner: QueryRunner, status: string) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_pipeline_runs_status_enum') THEN
          ALTER TYPE "project_pipeline_runs_status_enum" ADD VALUE IF NOT EXISTS '${status}';
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
