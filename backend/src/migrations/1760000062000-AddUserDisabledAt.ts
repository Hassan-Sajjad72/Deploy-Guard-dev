import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserDisabledAt1760000062000 implements MigrationInterface {
  name = "AddUserDisabledAt1760000062000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" ADD COLUMN "disabled_at" TIMESTAMPTZ`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "disabled_at"`);
  }
}
