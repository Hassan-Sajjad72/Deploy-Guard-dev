import { MigrationInterface, QueryRunner } from "typeorm";

/** Railpack updates one project-scoped Terraform runtime across immutable releases. */
export class AllowProjectScopedRailpackStateAcrossReleases1787356811000 implements MigrationInterface {
  name = "AllowProjectScopedRailpackStateAcrossReleases1787356811000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."UQ_project_deployment_generation_state_key"`);
  }

  async down(): Promise<void> {
    // A shared project runtime can legitimately have multiple historical release generations.
  }
}
