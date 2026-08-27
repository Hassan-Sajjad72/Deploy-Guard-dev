import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectPipelineTables1760000000000
  implements MigrationInterface
{
  name = "CreateProjectPipelineTables1760000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."project_pipeline_runs_status_enum" AS ENUM ('queued', 'running', 'completed', 'failed', 'cancelled');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_pipeline_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "triggered_by_user_id" integer NOT NULL,
        "preflight_report_id" uuid,
        "detection_profile_id" uuid,
        "repository_url" character varying NOT NULL,
        "repository_full_name" character varying,
        "target_branch" character varying NOT NULL,
        "commit_sha" character varying,
        "image_name" character varying,
        "image_tag" character varying,
        "ecr_repository_name" character varying,
        "ecr_image_uri" character varying,
        "github_workflow_run_id" character varying,
        "github_workflow_status" character varying,
        "status" "public"."project_pipeline_runs_status_enum" NOT NULL DEFAULT 'queued',
        "current_stage" character varying,
        "started_at" TIMESTAMP,
        "completed_at" TIMESTAMP,
        "failed_at" TIMESTAMP,
        "error_message" text,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_pipeline_runs_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_pipeline_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "pipeline_run_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "stage" character varying NOT NULL,
        "status" character varying NOT NULL,
        "message" text NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_pipeline_events_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_pipeline_runs_project_id" ON "project_pipeline_runs" ("project_id")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_pipeline_runs_triggered_by_user_id" ON "project_pipeline_runs" ("triggered_by_user_id")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_pipeline_events_pipeline_run_id" ON "project_pipeline_events" ("pipeline_run_id")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_pipeline_events_project_id" ON "project_pipeline_events" ("project_id")`
    );
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.projects') IS NOT NULL THEN
          ALTER TABLE "project_pipeline_runs"
          ADD CONSTRAINT "FK_project_pipeline_runs_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.users') IS NOT NULL THEN
          ALTER TABLE "project_pipeline_runs"
          ADD CONSTRAINT "FK_project_pipeline_runs_triggered_by_user" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.project_preflight_reports') IS NOT NULL THEN
          ALTER TABLE "project_pipeline_runs"
          ADD CONSTRAINT "FK_project_pipeline_runs_preflight" FOREIGN KEY ("preflight_report_id") REFERENCES "project_preflight_reports"("id") ON DELETE SET NULL;
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.project_detection_profiles') IS NOT NULL THEN
          ALTER TABLE "project_pipeline_runs"
          ADD CONSTRAINT "FK_project_pipeline_runs_detection" FOREIGN KEY ("detection_profile_id") REFERENCES "project_detection_profiles"("id") ON DELETE SET NULL;
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "project_pipeline_events"
        ADD CONSTRAINT "FK_project_pipeline_events_run" FOREIGN KEY ("pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE CASCADE;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.projects') IS NOT NULL THEN
          ALTER TABLE "project_pipeline_events"
          ADD CONSTRAINT "FK_project_pipeline_events_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_pipeline_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_pipeline_runs"`);
    await queryRunner.query(
      `DROP TYPE IF EXISTS "public"."project_pipeline_runs_status_enum"`
    );
  }
}
