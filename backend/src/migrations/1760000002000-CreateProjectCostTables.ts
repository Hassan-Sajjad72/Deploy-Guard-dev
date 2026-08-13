import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectCostTables1760000002000 implements MigrationInterface {
  name = "CreateProjectCostTables1760000002000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await this.addPipelineStatus(queryRunner, "cost_analysis_running");
    await this.addPipelineStatus(queryRunner, "waiting_for_cost_approval");
    await this.addPipelineStatus(queryRunner, "blocked_by_cost_limit");
    await this.addPipelineStatus(queryRunner, "cost_rejected");
    await this.addPipelineStatus(queryRunner, "cost_analysis_failed");
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "project_cost_estimates_status_enum" AS ENUM (
          'pending',
          'calculating',
          'no_approval_required',
          'approval_required',
          'approved',
          'rejected',
          'blocked_by_tier_limit',
          'failed'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "project_cost_estimates_source_enum" AS ENUM ('mock', 'infracost');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "project_cost_settings_subscription_tier_enum" AS ENUM (
          'free',
          'starter',
          'pro',
          'enterprise'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_cost_estimates" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "created_by_user_id" integer,
        "status" "project_cost_estimates_status_enum" NOT NULL DEFAULT 'pending',
        "source" "project_cost_estimates_source_enum" NOT NULL,
        "currency" character varying NOT NULL DEFAULT 'USD',
        "total_monthly_cost" numeric(12,2) NOT NULL DEFAULT 0,
        "previous_monthly_cost" numeric(12,2),
        "monthly_cost_difference" numeric(12,2),
        "tier_limit_monthly_cost" numeric(12,2),
        "warning_threshold_monthly_cost" numeric(12,2),
        "subscription_tier" character varying NOT NULL,
        "approval_required" boolean NOT NULL DEFAULT false,
        "blocked_by_tier_limit" boolean NOT NULL DEFAULT false,
        "upgrade_prompt_message" text,
        "terraform_plan_summary" jsonb,
        "raw_infracost_response" jsonb,
        "normalized_breakdown" jsonb,
        "metadata" jsonb,
        "error_message" text,
        "approved_by_user_id" integer,
        "approved_at" TIMESTAMP,
        "rejected_by_user_id" integer,
        "rejected_at" TIMESTAMP,
        "rejection_reason" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_cost_estimates_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_cost_resource_breakdowns" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "estimate_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "resource_type" character varying NOT NULL,
        "resource_name" character varying NOT NULL,
        "provider" character varying NOT NULL DEFAULT 'aws',
        "service_name" character varying,
        "monthly_cost" numeric(12,2) NOT NULL DEFAULT 0,
        "hourly_cost" numeric(12,4),
        "unit" character varying,
        "quantity" numeric(12,2),
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_cost_resource_breakdowns_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_cost_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "subscription_tier" "project_cost_settings_subscription_tier_enum" NOT NULL DEFAULT 'free',
        "warning_threshold_monthly_cost" numeric(12,2) NOT NULL DEFAULT 25,
        "currency" character varying NOT NULL DEFAULT 'USD',
        "updated_by_user_id" integer,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_cost_settings_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_cost_settings_project_id" UNIQUE ("project_id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_cost_estimates_project_id" ON "project_cost_estimates" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_cost_estimates_pipeline_run_id" ON "project_cost_estimates" ("pipeline_run_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_cost_resource_breakdowns_estimate_id" ON "project_cost_resource_breakdowns" ("estimate_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_cost_resource_breakdowns_project_id" ON "project_cost_resource_breakdowns" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_cost_resource_breakdowns_pipeline_run_id" ON "project_cost_resource_breakdowns" ("pipeline_run_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_cost_settings_project_id" ON "project_cost_settings" ("project_id")`);
    await this.addForeignKey(queryRunner, "project_cost_estimates", "FK_project_cost_estimates_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_cost_estimates", "FK_project_cost_estimates_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_cost_estimates", "FK_project_cost_estimates_created_by_user", "created_by_user_id", "users", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_cost_estimates", "FK_project_cost_estimates_approved_by_user", "approved_by_user_id", "users", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_cost_estimates", "FK_project_cost_estimates_rejected_by_user", "rejected_by_user_id", "users", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_cost_resource_breakdowns", "FK_project_cost_resource_breakdowns_estimate", "estimate_id", "project_cost_estimates", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_cost_resource_breakdowns", "FK_project_cost_resource_breakdowns_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_cost_resource_breakdowns", "FK_project_cost_resource_breakdowns_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_cost_settings", "FK_project_cost_settings_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_cost_settings", "FK_project_cost_settings_updated_by_user", "updated_by_user_id", "users", "id", "SET NULL");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_cost_resource_breakdowns"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_cost_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_cost_estimates"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "project_cost_settings_subscription_tier_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "project_cost_estimates_source_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "project_cost_estimates_status_enum"`);
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
