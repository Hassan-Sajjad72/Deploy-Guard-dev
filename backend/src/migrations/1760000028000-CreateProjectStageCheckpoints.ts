import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectStageCheckpoints1760000028000 implements MigrationInterface {
  name = "CreateProjectStageCheckpoints1760000028000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "project_stage_checkpoints" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "project_id" uuid NOT NULL,
      "pipeline_run_id" uuid NOT NULL,
      "stage" character varying NOT NULL,
      "fingerprint" character varying NOT NULL,
      "status" character varying NOT NULL DEFAULT 'passed',
      "source_checkpoint_id" uuid,
      "artifact_reference" jsonb,
      "image_tag" character varying,
      "image_digest" character varying,
      "terraform_metadata" jsonb,
      "metadata" jsonb,
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_stage_checkpoints_project" ON "project_stage_checkpoints" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_stage_checkpoints_run" ON "project_stage_checkpoints" ("pipeline_run_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_stage_checkpoints_stage" ON "project_stage_checkpoints" ("stage")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_stage_checkpoints_run_stage" ON "project_stage_checkpoints" ("pipeline_run_id", "stage")`);
    await queryRunner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_stage_checkpoints_project') THEN
        ALTER TABLE "project_stage_checkpoints" ADD CONSTRAINT "FK_stage_checkpoints_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_stage_checkpoints_run') THEN
        ALTER TABLE "project_stage_checkpoints" ADD CONSTRAINT "FK_stage_checkpoints_run" FOREIGN KEY ("pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE CASCADE;
      END IF;
    END $$;`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $$ BEGIN
      IF to_regclass('project_stage_checkpoints') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "project_stage_checkpoints" LIMIT 1) THEN
        DROP TABLE "project_stage_checkpoints";
      END IF;
    END $$;`);
  }
}
