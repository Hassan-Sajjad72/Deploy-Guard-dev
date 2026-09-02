import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAiTroubleshootingDiagnosticDetails1787356820000 implements MigrationInterface {
  name = "AddAiTroubleshootingDiagnosticDetails1787356820000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_analysis_results" ADD COLUMN IF NOT EXISTS "diagnostic_details" jsonb`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ai_analysis_results" DROP COLUMN IF EXISTS "diagnostic_details"`);
  }
}
