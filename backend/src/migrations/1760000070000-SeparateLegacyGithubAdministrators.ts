import { MigrationInterface, QueryRunner } from "typeorm";

export class SeparateLegacyGithubAdministrators1760000070000 implements MigrationInterface {
  name = "SeparateLegacyGithubAdministrators1760000070000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "users"
      SET "role" = 'developer', "updated_at" = CURRENT_TIMESTAMP
      WHERE "github_id" IS NOT NULL AND "role" = 'admin'
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD CONSTRAINT "CHK_users_admin_not_github"
      CHECK ("github_id" IS NULL OR "role" <> 'admin')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "CHK_users_admin_not_github"`);
  }
}
