import { MigrationInterface, QueryRunner } from "typeorm";
export class HardenPlatformExtensionEvents1760000013000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE billing_subscriptions ADD COLUMN IF NOT EXISTS provider_event_created_at timestamp`);
    await queryRunner.query(`ALTER TABLE billing_invoices ADD COLUMN IF NOT EXISTS provider_event_created_at timestamp`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE billing_invoices DROP COLUMN IF EXISTS provider_event_created_at`);
    await queryRunner.query(`ALTER TABLE billing_subscriptions DROP COLUMN IF EXISTS provider_event_created_at`);
  }
}
