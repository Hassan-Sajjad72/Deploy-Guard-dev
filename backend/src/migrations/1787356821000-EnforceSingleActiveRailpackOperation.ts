import { MigrationInterface, QueryRunner } from "typeorm";

/** Database backstop for project-scoped Railpack lifecycle admission. */
export class EnforceSingleActiveRailpackOperation1787356821000 implements MigrationInterface {
  name = "EnforceSingleActiveRailpackOperation1787356821000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_project_active_railpack_operation"
      ON "project_pipeline_runs" ("project_id")
      WHERE "status" IN ('queued', 'running')
        AND "metadata"->>'executionEngine' = 'railpack'
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_project_active_railpack_operation"`);
  }
}
