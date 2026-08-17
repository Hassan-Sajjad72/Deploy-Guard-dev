import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProjectDeploymentOverrides1760000017000 implements MigrationInterface {
  name = "AddProjectDeploymentOverrides1760000017000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deployment_overrides" jsonb NOT NULL DEFAULT '{}'::jsonb`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "deployment_overrides"`);
  }
}
