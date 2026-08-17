import { MigrationInterface, QueryRunner } from "typeorm";

export class AllowSharedGithubAppInstallationLinks1760000061000 implements MigrationInterface {
  name = "AllowSharedGithubAppInstallationLinks1760000061000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "github_app_installations" DROP CONSTRAINT "UQ_github_app_installations_installation"`);
    await queryRunner.query(`ALTER TABLE "github_app_installations" ADD CONSTRAINT "UQ_github_app_installations_owner_installation" UNIQUE ("owner_user_id", "installation_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "github_app_installations" DROP CONSTRAINT "UQ_github_app_installations_owner_installation"`);
    await queryRunner.query(`ALTER TABLE "github_app_installations" ADD CONSTRAINT "UQ_github_app_installations_installation" UNIQUE ("installation_id")`);
  }
}
