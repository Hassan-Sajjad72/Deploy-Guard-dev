import { MigrationInterface, QueryRunner, TableColumn } from "typeorm";

export class StoreEncryptedGithubAccessToken1760000011000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn("users", "github_access_token")) return;
    await queryRunner.addColumn("users", new TableColumn({
      name: "github_access_token",
      type: "text",
      isNullable: true,
    }));
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasColumn("users", "github_access_token")) await queryRunner.dropColumn("users", "github_access_token");
  }
}
