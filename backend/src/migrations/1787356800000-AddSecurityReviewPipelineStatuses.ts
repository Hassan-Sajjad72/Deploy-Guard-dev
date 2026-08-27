import { MigrationInterface, QueryRunner } from "typeorm";

export class AddSecurityReviewPipelineStatuses1787356800000 implements MigrationInterface {
  name = "AddSecurityReviewPipelineStatuses1787356800000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "project_pipeline_runs_status_enum" ADD VALUE IF NOT EXISTS 'waiting_for_security_review'`);
    await queryRunner.query(`ALTER TYPE "project_pipeline_runs_status_enum" ADD VALUE IF NOT EXISTS 'security_rejected'`);
  }

  async down(): Promise<void> {
    // PostgreSQL enum labels are intentionally retained on rollback.
  }
}
