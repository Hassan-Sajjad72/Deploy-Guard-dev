import { MigrationInterface, QueryRunner } from "typeorm";

/** Default-off legacy queue evidence. No backfill and no execution behaviour. */
export class CreatePipelineJobFinalities1760000046000 implements MigrationInterface {
  name = "CreatePipelineJobFinalities1760000046000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_pipeline_job_finalities" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "pipeline_run_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "bullmq_job_id" varchar(160) NOT NULL,
        "decision" varchar(40) NOT NULL,
        "evidence_hash" char(64) NOT NULL,
        "recorded_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_pipeline_job_finalities" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_pipeline_job_finality_decision"
          CHECK ("decision" IN ('completed','failed_after_retries_exhausted')),
        CONSTRAINT "CHK_pipeline_job_finality_evidence_hash"
          CHECK ("evidence_hash" ~ '^[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_pipeline_job_finality_run' AND conrelid = 'project_pipeline_job_finalities'::regclass) THEN
          ALTER TABLE "project_pipeline_job_finalities" ADD CONSTRAINT "FK_pipeline_job_finality_run"
            FOREIGN KEY ("pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_pipeline_job_finality_project' AND conrelid = 'project_pipeline_job_finalities'::regclass) THEN
          ALTER TABLE "project_pipeline_job_finalities" ADD CONSTRAINT "FK_pipeline_job_finality_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT;
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_pipeline_job_finality_run_job" ON "project_pipeline_job_finalities" ("pipeline_run_id", "bullmq_job_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pipeline_job_finality_run" ON "project_pipeline_job_finalities" ("pipeline_run_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pipeline_job_finality_project_recorded" ON "project_pipeline_job_finalities" ("project_id", "recorded_at")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (SELECT 1 FROM "project_pipeline_job_finalities" LIMIT 1) THEN
          RAISE EXCEPTION 'Refusing to roll back pipeline job finality evidence while history exists';
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_pipeline_job_finalities"`);
  }
}
