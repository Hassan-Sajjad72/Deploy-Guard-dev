import { MigrationInterface, QueryRunner } from "typeorm";

/** Restores the current generation projection when applied history lost its table. */
export class RepairDeploymentGenerationSchemaDrift1787356803000 implements MigrationInterface {
  name = "RepairDeploymentGenerationSchemaDrift1787356803000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "public"."project_deployment_generations" (
        "id" uuid PRIMARY KEY,
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "ordinal" integer NOT NULL CHECK ("ordinal" > 0),
        "candidate_listener_priority" integer,
        "status" varchar NOT NULL DEFAULT 'deploying',
        "terraform_state_key" varchar NOT NULL,
        "resource_manifest" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "cleanup_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_by_operation_id" uuid,
        "retired_by_operation_id" uuid,
        "activated_at" timestamptz,
        "retired_at" timestamptz,
        "failed_at" timestamptz,
        "cleaned_at" timestamptz,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_project_deployment_generation_ordinal" UNIQUE ("project_id", "environment_name", "ordinal"),
        CONSTRAINT "CHK_project_deployment_generation_status_v3" CHECK ("status" IN ('deploying','live','failed','retired','cleanup_pending','cleaned')),
        CONSTRAINT "CHK_project_deployment_generation_candidate_listener_priority" CHECK ("candidate_listener_priority" IS NULL OR "candidate_listener_priority" BETWEEN 20000 AND 50000)
      )
    `);
    await queryRunner.query(`ALTER TABLE "public"."project_deployment_generations" ADD COLUMN IF NOT EXISTS "candidate_listener_priority" integer`);
    await queryRunner.query(`ALTER TABLE "public"."project_deployment_generations" ADD COLUMN IF NOT EXISTS "terraform_state_key" varchar`);
    await queryRunner.query(`ALTER TABLE "public"."project_deployment_generations" ADD COLUMN IF NOT EXISTS "resource_manifest" jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`ALTER TABLE "public"."project_deployment_generations" ADD COLUMN IF NOT EXISTS "cleanup_metadata" jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`ALTER TABLE "public"."project_deployment_generations" ADD COLUMN IF NOT EXISTS "failed_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "public"."project_deployment_generations" ADD COLUMN IF NOT EXISTS "cleaned_at" timestamptz`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_deployment_generation_live" ON "public"."project_deployment_generations" ("project_id", "environment_name") WHERE "status" = 'live'`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_deployment_generation_candidate" ON "public"."project_deployment_generations" ("project_id", "environment_name") WHERE "status" = 'deploying'`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_deployment_generation_candidate_listener_priority" ON "public"."project_deployment_generations" ("candidate_listener_priority") WHERE "candidate_listener_priority" IS NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_deployment_generation_state_key" ON "public"."project_deployment_generations" ("terraform_state_key")`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.projects') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_project_deployment_generations_project' AND conrelid = 'public.project_deployment_generations'::regclass) THEN
          ALTER TABLE "public"."project_deployment_generations" ADD CONSTRAINT "FK_project_deployment_generations_project"
            FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE;
        END IF;
        IF to_regclass('public.project_pipeline_runs') IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_pipeline_runs_generation' AND conrelid = 'public.project_pipeline_runs'::regclass) THEN
          ALTER TABLE "public"."project_pipeline_runs" ADD CONSTRAINT "FK_pipeline_runs_generation"
            FOREIGN KEY ("generation_id") REFERENCES "public"."project_deployment_generations"("id") ON DELETE RESTRICT;
        END IF;
      END $$;
    `);
  }

  async down(): Promise<void> {
    // The repair is intentionally irreversible to preserve recovered records.
  }
}
