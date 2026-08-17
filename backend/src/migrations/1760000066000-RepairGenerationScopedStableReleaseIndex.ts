import { MigrationInterface, QueryRunner } from "typeorm";

export class RepairGenerationScopedStableReleaseIndex1760000066000 implements MigrationInterface {
  name = "RepairGenerationScopedStableReleaseIndex1760000066000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_project_stable_release_scope"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_project_stable_release_scope"
      ON "project_stable_releases" ("project_id", "environment_name", "generation_id")
      WHERE "status" = 'stable'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_stable_release_operation"
      ON "project_stable_releases" ("deployed_by_pipeline_run_id")
      WHERE "deployed_by_pipeline_run_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_project_stable_release_operation"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_project_stable_release_scope"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_project_stable_release_scope"
      ON "project_stable_releases" ("project_id", "environment_name")
      WHERE "status" = 'stable'
    `);
  }
}
