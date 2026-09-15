import { MigrationInterface, QueryRunner } from "typeorm";

export class VerifiedBillingPayments1787356825000 implements MigrationInterface {
  name = "VerifiedBillingPayments1787356825000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" ADD COLUMN IF NOT EXISTS "merchant_order_id" varchar`);
    await queryRunner.query(`UPDATE "billing_checkout_sessions" SET "merchant_order_id" = "id"::text WHERE "merchant_order_id" IS NULL`);
    await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" ALTER COLUMN "merchant_order_id" SET NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_checkout_merchant_order" ON "billing_checkout_sessions" ("merchant_order_id")`);
    await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" ADD COLUMN IF NOT EXISTS "amount_due" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" ADD COLUMN IF NOT EXISTS "currency" varchar NOT NULL DEFAULT 'USD'`);

    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "invoice_number" varchar`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "provider_transaction_id" varchar`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "provider" varchar NOT NULL DEFAULT 'stripe'`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "mode" varchar NOT NULL DEFAULT 'test'`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "plan" varchar NOT NULL DEFAULT 'free'`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "paid_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "billing_period_start" timestamptz`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "billing_period_end" timestamptz`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "subscription_status" varchar NOT NULL DEFAULT 'active'`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "invalidated_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ADD COLUMN IF NOT EXISTS "invalidation_reason" varchar`);
    await queryRunner.query(`UPDATE "billing_invoices" SET
      "invoice_number" = COALESCE("invoice_number", 'LEGACY-' || upper(substr("id"::text, 1, 12))),
      "provider_transaction_id" = COALESCE("provider_transaction_id", "provider_invoice_id"),
      "provider" = CASE WHEN "provider_invoice_id" LIKE 'mock-%' THEN 'mock' ELSE 'stripe' END,
      "mode" = CASE WHEN "provider_invoice_id" LIKE 'mock-%' THEN 'mock' ELSE 'legacy' END,
      "paid_at" = CASE WHEN "status" = 'paid' THEN COALESCE("issued_at", "created_at") ELSE NULL END`);
    await queryRunner.query(`UPDATE "billing_invoices" SET "invalidated_at" = COALESCE("invalidated_at", now()), "invalidation_reason" = 'legacy_mock_row_without_verified_payment' WHERE "provider_invoice_id" LIKE 'mock-%'`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ALTER COLUMN "invoice_number" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ALTER COLUMN "provider_transaction_id" SET NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_invoice_number" ON "billing_invoices" ("invoice_number")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_billing_invoice_provider_transaction" ON "billing_invoices" ("provider_transaction_id")`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "billing_payments" (
      "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(), "user_id" integer NOT NULL,
      "provider_transaction_id" varchar NOT NULL UNIQUE, "checkout_session_id" uuid,
      "provider" varchar NOT NULL DEFAULT 'stripe', "mode" varchar NOT NULL DEFAULT 'test',
      "plan" varchar NOT NULL, "status" varchar NOT NULL DEFAULT 'paid', "amount" integer NOT NULL,
      "currency" varchar NOT NULL DEFAULT 'USD', "paid_at" timestamptz NOT NULL,
      "safe_metadata" jsonb, "created_at" timestamptz NOT NULL DEFAULT now())`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_billing_payments_user" ON "billing_payments" ("user_id", "created_at" DESC)`);

    await queryRunner.query(`UPDATE "billing_subscriptions" SET "plan" = 'free', "provider" = 'none', "mode" = 'not_configured', "billing_period_start" = NULL, "billing_period_end" = NULL WHERE "provider" = 'mock' OR "mode" = 'mock'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "billing_payments"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_billing_invoice_provider_transaction"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_billing_invoice_number"`);
    for (const column of ["invalidation_reason", "invalidated_at", "subscription_status", "billing_period_end", "billing_period_start", "paid_at", "plan", "mode", "provider", "provider_transaction_id", "invoice_number"]) {
      await queryRunner.query(`ALTER TABLE "billing_invoices" DROP COLUMN IF EXISTS "${column}"`);
    }
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_billing_checkout_merchant_order"`);
    for (const column of ["currency", "amount_due", "merchant_order_id"]) await queryRunner.query(`ALTER TABLE "billing_checkout_sessions" DROP COLUMN IF EXISTS "${column}"`);
  }
}
