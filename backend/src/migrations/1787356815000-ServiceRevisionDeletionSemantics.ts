import { MigrationInterface, QueryRunner } from "typeorm";

/** Project deletion cascades history; ordinary service removal is blocked by the product service. */
export class ServiceRevisionDeletionSemantics1787356815000 implements MigrationInterface {
  name = "ServiceRevisionDeletionSemantics1787356815000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_generation_service_revisions" DROP CONSTRAINT "FK_generation_revision_service"`);
    await queryRunner.query(`ALTER TABLE "project_generation_service_revisions" ADD CONSTRAINT "FK_generation_revision_service" FOREIGN KEY ("service_id") REFERENCES "project_deployable_services"("id") ON DELETE CASCADE`);
    await queryRunner.query(`ALTER TABLE "project_service_runtime_config_revisions" DROP CONSTRAINT "FK_runtime_config_service"`);
    await queryRunner.query(`ALTER TABLE "project_service_runtime_config_revisions" ADD CONSTRAINT "FK_runtime_config_service" FOREIGN KEY ("service_id") REFERENCES "project_deployable_services"("id") ON DELETE CASCADE`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_generation_service_revisions" DROP CONSTRAINT "FK_generation_revision_service"`);
    await queryRunner.query(`ALTER TABLE "project_generation_service_revisions" ADD CONSTRAINT "FK_generation_revision_service" FOREIGN KEY ("service_id") REFERENCES "project_deployable_services"("id") ON DELETE RESTRICT`);
    await queryRunner.query(`ALTER TABLE "project_service_runtime_config_revisions" DROP CONSTRAINT "FK_runtime_config_service"`);
    await queryRunner.query(`ALTER TABLE "project_service_runtime_config_revisions" ADD CONSTRAINT "FK_runtime_config_service" FOREIGN KEY ("service_id") REFERENCES "project_deployable_services"("id") ON DELETE RESTRICT`);
  }
}
