import { MigrationInterface, QueryRunner } from "typeorm";

export class CanonicalDeploymentRequirements1760000029000 implements MigrationInterface {
  name = "CanonicalDeploymentRequirements1760000029000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "owner" varchar NOT NULL DEFAULT 'user_supplied'`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "is_active" boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "superseded_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "superseded_reason" varchar`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "applied_at" timestamptz`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_deployment_requirements" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "source_commit" varchar,
        "scan_revision" varchar,
        "status" varchar NOT NULL DEFAULT 'needs_input',
        "application_status" varchar NOT NULL DEFAULT 'detected',
        "architecture" jsonb NOT NULL DEFAULT '{}',
        "required_inputs" jsonb NOT NULL DEFAULT '[]',
        "managed_bindings" jsonb NOT NULL DEFAULT '[]',
        "database" jsonb NOT NULL DEFAULT '{}',
        "blockers" jsonb NOT NULL DEFAULT '[]',
        "ready_to_resume" boolean NOT NULL DEFAULT false,
        "resume_from_stage" varchar,
        "resume_sequence" jsonb NOT NULL DEFAULT '[]',
        "configuration_revision" integer NOT NULL DEFAULT 1,
        "applied_pipeline_run_id" uuid,
        "saved_at" timestamptz,
        "applied_at" timestamptz,
        "verified_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_deployment_requirements" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_deployment_requirements_project" UNIQUE ("project_id"),
        CONSTRAINT "FK_project_deployment_requirements_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_deployment_requirements_project" ON "project_deployment_requirements" ("project_id")`);
    await queryRunner.query(`UPDATE "project_environment_variables" SET "owner" = 'platform_detected' WHERE "detected_source" IS NOT NULL AND "owner" = 'user_supplied'`);
    await queryRunner.query(`
      UPDATE "project_environment_variables" env
      SET "is_active" = false,
          "superseded_at" = COALESCE("superseded_at", now()),
          "superseded_reason" = COALESCE("superseded_reason", 'Superseded by DeployGuard-managed database binding')
      FROM "project_database_tiers" tier
      WHERE tier."project_id" = env."project_id"
        AND tier."provider"::text = 'managed'
        AND env."key" IN ('DB_HOST','DB_PORT','DB_NAME','DB_USER','DB_PASSWORD','DATABASE_URL')
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_deployment_requirements"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "applied_at"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "superseded_reason"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "superseded_at"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "is_active"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "owner"`);
  }
}
