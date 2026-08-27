import { MigrationInterface, QueryRunner } from "typeorm";

/** Restores the stable-release read projection required by startup monitoring. */
export class RepairStableReleaseSchemaDrift1787356804000 implements MigrationInterface {
  name = "RepairStableReleaseSchemaDrift1787356804000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "public"."project_stable_releases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "generation_id" uuid,
        "release_manifest_id" uuid,
        "environment_name" varchar NOT NULL DEFAULT 'dev',
        "commit_sha" varchar NOT NULL,
        "short_commit_sha" varchar NOT NULL,
        "image_uri" varchar NOT NULL,
        "task_definition_arn" varchar NOT NULL,
        "ecs_service_arn" varchar,
        "health_check_path" varchar NOT NULL DEFAULT '/health',
        "app_port" integer,
        "deployed_by_pipeline_run_id" uuid,
        "deployed_at" timestamptz NOT NULL,
        "status" varchar NOT NULL DEFAULT 'stable',
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_stable_releases_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`ALTER TABLE "public"."project_stable_releases" ADD COLUMN IF NOT EXISTS "generation_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."project_stable_releases" ADD COLUMN IF NOT EXISTS "release_manifest_id" uuid`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_stable_releases_project_id" ON "public"."project_stable_releases" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_stable_releases_generation" ON "public"."project_stable_releases" ("generation_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_stable_releases_release_manifest" ON "public"."project_stable_releases" ("release_manifest_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_stable_release_scope" ON "public"."project_stable_releases" ("project_id", "environment_name") WHERE "status" = 'stable'`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_stable_release_manifest_projection" ON "public"."project_stable_releases" ("release_manifest_id") WHERE "release_manifest_id" IS NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_stable_release_operation" ON "public"."project_stable_releases" ("deployed_by_pipeline_run_id") WHERE "deployed_by_pipeline_run_id" IS NOT NULL`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.projects') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_releases_project' AND conrelid = 'public.project_stable_releases'::regclass) THEN
          ALTER TABLE "public"."project_stable_releases" ADD CONSTRAINT "FK_releases_project" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;
        END IF;
        IF to_regclass('public.project_pipeline_runs') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_releases_run' AND conrelid = 'public.project_stable_releases'::regclass) THEN
          ALTER TABLE "public"."project_stable_releases" ADD CONSTRAINT "FK_releases_run" FOREIGN KEY ("deployed_by_pipeline_run_id") REFERENCES "public"."project_pipeline_runs"("id") ON DELETE SET NULL;
        END IF;
        IF to_regclass('public.project_deployment_generations') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_stable_releases_generation' AND conrelid = 'public.project_stable_releases'::regclass) THEN
          ALTER TABLE "public"."project_stable_releases" ADD CONSTRAINT "FK_stable_releases_generation" FOREIGN KEY ("generation_id") REFERENCES "public"."project_deployment_generations"("id") ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
  }

  async down(): Promise<void> {
    // The repair is intentionally irreversible to preserve recovered records.
  }
}
