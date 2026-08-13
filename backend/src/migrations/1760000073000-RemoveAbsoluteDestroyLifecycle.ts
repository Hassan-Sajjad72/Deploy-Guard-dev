import { MigrationInterface, QueryRunner } from "typeorm";

/** The generation model uses operation history; the project-wide Destroy state machine is retired. */
export class RemoveAbsoluteDestroyLifecycle1760000073000 implements MigrationInterface {
  name = "RemoveAbsoluteDestroyLifecycle1760000073000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_destroy_lifecycles"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_project_deployment_generation_live"`);
    await queryRunner.query(`UPDATE "project_deployment_generations" SET "status" = 'live' WHERE "status" = 'legacy_live'`);
    await queryRunner.query(`UPDATE "project_deployment_generations" SET "status" = 'retired' WHERE "status" = 'legacy_retired'`);
    await queryRunner.query(`ALTER TABLE "project_deployment_generations" DROP CONSTRAINT IF EXISTS "CHK_project_deployment_generation_status_v2"`);
    await queryRunner.query(`
      ALTER TABLE "project_deployment_generations"
      ADD CONSTRAINT "CHK_project_deployment_generation_status_v3"
      CHECK ("status" IN ('deploying','live','failed','retired','cleanup_pending','cleaned'))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_project_deployment_generation_live"
      ON "project_deployment_generations"("project_id", "environment_name")
      WHERE "status" = 'live'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The removed table represented an obsolete competing lifecycle. Reverting
    // code does not safely reconstruct its operational lease state.
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_project_deployment_generation_live"`);
    await queryRunner.query(`ALTER TABLE "project_deployment_generations" DROP CONSTRAINT IF EXISTS "CHK_project_deployment_generation_status_v3"`);
    await queryRunner.query(`
      ALTER TABLE "project_deployment_generations"
      ADD CONSTRAINT "CHK_project_deployment_generation_status_v2"
      CHECK ("status" IN ('deploying','live','failed','retired','cleanup_pending','cleaned','legacy_live','legacy_retired'))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_project_deployment_generation_live"
      ON "project_deployment_generations"("project_id", "environment_name")
      WHERE "status" IN ('live','legacy_live')
    `);
  }
}
