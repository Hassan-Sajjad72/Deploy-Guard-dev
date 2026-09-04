import { MigrationInterface, QueryRunner } from "typeorm";

export class AutomaticServicePortAuthority1787356822000 implements MigrationInterface {
  name = "AutomaticServicePortAuthority1787356822000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_deployable_services" ALTER COLUMN "service_port" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "project_deployable_services" ALTER COLUMN "service_port" DROP NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "project_deployable_services" SET "service_port" = 8080 WHERE "service_port" IS NULL`);
    await queryRunner.query(`ALTER TABLE "project_deployable_services" ALTER COLUMN "service_port" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "project_deployable_services" ALTER COLUMN "service_port" SET DEFAULT 8080`);
  }
}
