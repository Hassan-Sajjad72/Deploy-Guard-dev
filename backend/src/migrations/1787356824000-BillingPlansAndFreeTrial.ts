import { MigrationInterface, QueryRunner } from "typeorm";

export class BillingPlansAndFreeTrial1787356824000 implements MigrationInterface {
  name = "BillingPlansAndFreeTrial1787356824000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "trial_started_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "trial_ends_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "trial_project_id" uuid`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "billing_subscriptions" DROP COLUMN IF EXISTS "trial_project_id"`);
    await queryRunner.query(`ALTER TABLE "billing_subscriptions" DROP COLUMN IF EXISTS "trial_ends_at"`);
    await queryRunner.query(`ALTER TABLE "billing_subscriptions" DROP COLUMN IF EXISTS "trial_started_at"`);
  }
}
