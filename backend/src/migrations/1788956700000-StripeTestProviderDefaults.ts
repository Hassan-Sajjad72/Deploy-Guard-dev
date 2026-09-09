import { MigrationInterface, QueryRunner } from "typeorm";

export class StripeTestProviderDefaults1788956700000 implements MigrationInterface {
  name = "StripeTestProviderDefaults1788956700000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "billing_invoices" ALTER COLUMN "provider" SET DEFAULT 'stripe'`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ALTER COLUMN "mode" SET DEFAULT 'test'`);
    await queryRunner.query(`ALTER TABLE "billing_payments" ALTER COLUMN "provider" SET DEFAULT 'stripe'`);
    await queryRunner.query(`ALTER TABLE "billing_payments" ALTER COLUMN "mode" SET DEFAULT 'test'`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "billing_payments" ALTER COLUMN "mode" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "billing_payments" ALTER COLUMN "provider" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ALTER COLUMN "mode" DROP DEFAULT`);
    await queryRunner.query(`ALTER TABLE "billing_invoices" ALTER COLUMN "provider" DROP DEFAULT`);
  }
}
