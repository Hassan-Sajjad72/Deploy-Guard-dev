import { MigrationInterface, QueryRunner } from "typeorm";

/** Handles pre-repair databases where PostgreSQL folded the old index name. */
export class DropLegacyGenerationStateKeyIndex1787356812000 implements MigrationInterface {
  name = "DropLegacyGenerationStateKeyIndex1787356812000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."UQ_project_deployment_generation_state_key"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "public".uq_project_deployment_generation_state_key`);
  }

  async down(): Promise<void> {}
}
