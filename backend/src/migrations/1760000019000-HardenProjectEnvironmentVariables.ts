import { MigrationInterface, QueryRunner } from "typeorm";

export class HardenProjectEnvironmentVariables1760000019000 implements MigrationInterface {
  name = "HardenProjectEnvironmentVariables1760000019000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ALTER COLUMN "value" TYPE text`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "scope" varchar NOT NULL DEFAULT 'runtime'`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "is_required" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "environment" varchar NOT NULL DEFAULT 'production'`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "detected_source" varchar`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "encryption_version" integer NOT NULL DEFAULT 0`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "encryption_version"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "detected_source"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "environment"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "is_required"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "scope"`);
  }
}
