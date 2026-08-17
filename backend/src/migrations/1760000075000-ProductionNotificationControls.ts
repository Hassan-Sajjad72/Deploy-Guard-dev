import { MigrationInterface, QueryRunner } from "typeorm";

export class ProductionNotificationControls1760000075000 implements MigrationInterface {
  name = "ProductionNotificationControls1760000075000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_preferences" ADD COLUMN IF NOT EXISTS "enabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "notification_subscriptions" ADD COLUMN IF NOT EXISTS "last_error" text`);
    await queryRunner.query(`
      UPDATE "notification_preferences" preference
      SET "enabled" = true
      WHERE EXISTS (
        SELECT 1 FROM "notification_subscriptions" subscription
        WHERE subscription."project_id" = preference."project_id"
          AND subscription."user_id" = preference."user_id"
          AND subscription."status" = 'confirmed'
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_subscriptions" DROP COLUMN IF EXISTS "last_error"`);
    await queryRunner.query(`ALTER TABLE "notification_preferences" DROP COLUMN IF EXISTS "enabled"`);
  }
}
