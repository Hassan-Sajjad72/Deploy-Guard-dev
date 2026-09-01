import { MigrationInterface, QueryRunner } from "typeorm";

export class DeployableServicePort1787356819000 implements MigrationInterface {
  name = "DeployableServicePort1787356819000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_deployable_services" ADD COLUMN "service_port" integer NOT NULL DEFAULT 8080`);
    await queryRunner.query(`ALTER TABLE "project_deployable_services" ADD CONSTRAINT "CHK_project_deployable_service_port" CHECK ("service_port" BETWEEN 1 AND 65535)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_deployable_services" DROP CONSTRAINT "CHK_project_deployable_service_port"`);
    await queryRunner.query(`ALTER TABLE "project_deployable_services" DROP COLUMN "service_port"`);
  }
}
