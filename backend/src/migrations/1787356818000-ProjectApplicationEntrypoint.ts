import { MigrationInterface, QueryRunner } from "typeorm";

export class ProjectApplicationEntrypoint1787356818000 implements MigrationInterface {
  name = "ProjectApplicationEntrypoint1787356818000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_deployable_services" ADD CONSTRAINT "UQ_project_deployable_service_identity_project" UNIQUE ("id", "project_id")`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN "application_entrypoint_service_id" uuid`);
    await queryRunner.query(`
      UPDATE "projects" project
      SET "application_entrypoint_service_id" = single_service."service_id"
      FROM (
        SELECT "project_id", MIN("id"::text)::uuid AS "service_id"
        FROM "project_deployable_services"
        GROUP BY "project_id"
        HAVING COUNT(*) = 1
      ) single_service
      WHERE single_service."project_id" = project."id"
        AND project."application_entrypoint_service_id" IS NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "projects"
      ADD CONSTRAINT "FK_projects_application_entrypoint_service"
      FOREIGN KEY ("application_entrypoint_service_id", "id")
      REFERENCES "project_deployable_services"("id", "project_id")
      ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT "FK_projects_application_entrypoint_service"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN "application_entrypoint_service_id"`);
    await queryRunner.query(`ALTER TABLE "project_deployable_services" DROP CONSTRAINT "UQ_project_deployable_service_identity_project"`);
  }
}
