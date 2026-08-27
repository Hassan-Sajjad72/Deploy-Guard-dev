import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateGithubAppInstallations1760000060000 implements MigrationInterface {
  name = "CreateGithubAppInstallations1760000060000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE "github_app_installations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "owner_user_id" integer NOT NULL, "installation_id" bigint NOT NULL, "account_login" character varying NOT NULL, "account_id" bigint, "status" character varying NOT NULL DEFAULT 'active', "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_github_app_installations_installation" UNIQUE ("installation_id"), CONSTRAINT "PK_github_app_installations" PRIMARY KEY ("id"), CONSTRAINT "FK_github_app_installations_owner" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE)`);
    await queryRunner.query(`CREATE INDEX "IDX_github_app_installations_owner" ON "github_app_installations" ("owner_user_id")`);
    await queryRunner.query(`ALTER TABLE "projects" ADD "github_installation_id" bigint`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "github_installation_id"`);
    await queryRunner.query(`DROP TABLE "github_app_installations"`);
  }
}
