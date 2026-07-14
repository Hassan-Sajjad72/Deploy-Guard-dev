import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFinopsWarningOverTier1760000008000 implements MigrationInterface {
  name = "AddFinopsWarningOverTier1760000008000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "project_cost_estimates_status_enum" ADD VALUE IF NOT EXISTS 'warning_over_tier'`
    );
  }

  async down(): Promise<void> {
    // PostgreSQL enum values cannot be removed safely without rebuilding the type.
  }
}
