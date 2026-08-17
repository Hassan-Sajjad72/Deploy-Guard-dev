import { MigrationInterface, QueryRunner } from "typeorm";

export class StrengthenCloudResourceRegistry1760000023000 implements MigrationInterface {
  name = "StrengthenCloudResourceRegistry1760000023000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "central_cloud_resources" ADD COLUMN IF NOT EXISTS "pipeline_run_id" uuid`);
    await queryRunner.query(`ALTER TABLE "central_cloud_resources" ADD COLUMN IF NOT EXISTS "ownership" varchar NOT NULL DEFAULT 'unknown'`);
    await queryRunner.query(`ALTER TABLE "central_cloud_resources" ADD COLUMN IF NOT EXISTS "cleanup_eligibility" varchar NOT NULL DEFAULT 'manual_review'`);
    await queryRunner.query(`ALTER TABLE "central_cloud_resources" ADD COLUMN IF NOT EXISTS "tags" jsonb`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_central_cloud_resources_run" ON "central_cloud_resources" ("pipeline_run_id")`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_central_cloud_resources_run"`);
    await queryRunner.query(`ALTER TABLE "central_cloud_resources" DROP COLUMN IF EXISTS "tags"`);
    await queryRunner.query(`ALTER TABLE "central_cloud_resources" DROP COLUMN IF EXISTS "cleanup_eligibility"`);
    await queryRunner.query(`ALTER TABLE "central_cloud_resources" DROP COLUMN IF EXISTS "ownership"`);
    await queryRunner.query(`ALTER TABLE "central_cloud_resources" DROP COLUMN IF EXISTS "pipeline_run_id"`);
  }
}
