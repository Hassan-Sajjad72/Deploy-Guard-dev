import { MigrationInterface, QueryRunner } from "typeorm";

export class StripeRecurringSubscriptions1788977100000 implements MigrationInterface {
  name = "StripeRecurringSubscriptions1788977100000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" ADD COLUMN IF NOT EXISTS "provider_customer_id" varchar`);
    await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" ADD COLUMN IF NOT EXISTS "provider_subscription_id" varchar`);
    await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" ADD COLUMN IF NOT EXISTS "provider_price_id" varchar`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_billing_checkout_customer" ON "billing_checkout_sessions" ("provider_customer_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_billing_checkout_subscription" ON "billing_checkout_sessions" ("provider_subscription_id")`);

    await queryRunner.query(`ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "provider_price_id" varchar`);
    await queryRunner.query(`ALTER TABLE "billing_subscriptions" ADD COLUMN IF NOT EXISTS "ended_at" timestamptz`);

    await queryRunner.query(`ALTER TABLE "billing_invoices" ALTER COLUMN "provider_transaction_id" DROP NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`UPDATE "billing_invoices" SET "provider_transaction_id" = "provider_invoice_id" WHERE "provider_transaction_id" IS NULL`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ALTER COLUMN "provider_transaction_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "billing_subscriptions" DROP COLUMN IF EXISTS "ended_at"`);
    await queryRunner.query(`ALTER TABLE "billing_subscriptions" DROP COLUMN IF EXISTS "provider_price_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_billing_checkout_subscription"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_billing_checkout_customer"`);
    await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" DROP COLUMN IF EXISTS "provider_price_id"`);
    await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" DROP COLUMN IF EXISTS "provider_subscription_id"`);
    await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" DROP COLUMN IF EXISTS "provider_customer_id"`);
  }
}
