import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProjectCloudCleanupInventory1760000021000 implements MigrationInterface {
  name = "AddProjectCloudCleanupInventory1760000021000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "resource_inventory" jsonb`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "cleanup_status" varchar NOT NULL DEFAULT 'not_started'`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "cleanup_result" jsonb`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "cleanup_requested_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "cleanup_completed_at" timestamptz`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "cleanup_completed_at"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "cleanup_requested_at"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "cleanup_result"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "cleanup_status"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "resource_inventory"`);
  }
}
