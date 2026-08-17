import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOutboxDeliveryFencing1760000038000 implements MigrationInterface {
  name = "AddOutboxDeliveryFencing1760000038000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "orchestration_outbox"
      ADD COLUMN IF NOT EXISTS "claim_fencing_token" bigint NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_orchestration_outbox_claim_fencing'
            AND conrelid = 'orchestration_outbox'::regclass
        ) THEN
          ALTER TABLE "orchestration_outbox"
            ADD CONSTRAINT "CHK_orchestration_outbox_claim_fencing"
            CHECK ("claim_fencing_token" >= 0);
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_orchestration_outbox_delivery_claim"
      ON "orchestration_outbox" ("status", "claim_expires_at", "available_at")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "orchestration_outbox"
          WHERE "status" = 'publishing' OR "claim_fencing_token" > 0
          LIMIT 1
        ) THEN
          RAISE EXCEPTION 'Refusing to remove outbox delivery fencing while delivery history exists';
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_orchestration_outbox_delivery_claim"`);
    await queryRunner.query(`
      ALTER TABLE "orchestration_outbox"
      DROP CONSTRAINT IF EXISTS "CHK_orchestration_outbox_claim_fencing"
    `);
    await queryRunner.query(`
      ALTER TABLE "orchestration_outbox"
      DROP COLUMN IF EXISTS "claim_fencing_token"
    `);
  }
}
