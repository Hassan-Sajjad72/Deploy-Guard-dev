import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProjectAppDirectory1760000010000 implements MigrationInterface {
  name = "AddProjectAppDirectory1760000010000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "app_directory" character varying`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "projects" DROP COLUMN IF EXISTS "app_directory"`
    );
  }
}
