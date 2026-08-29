import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateWorkerCapabilityRegistry1760000037000
  implements MigrationInterface
{
  name = "CreateWorkerCapabilityRegistry1760000037000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "worker_capabilities" (
        "worker_id" varchar NOT NULL,
        "role" varchar(32) NOT NULL,
        "minimum_protocol" integer NOT NULL,
        "maximum_protocol" integer NOT NULL,
        "supported_message_types" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "service_version" varchar NOT NULL,
        "git_sha" varchar NOT NULL,
        "started_at" timestamptz NOT NULL DEFAULT now(),
        "heartbeat_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_worker_capabilities" PRIMARY KEY ("worker_id")
      )
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_worker_capability_role'
            AND conrelid = 'worker_capabilities'::regclass
        ) THEN
          ALTER TABLE "worker_capabilities"
            ADD CONSTRAINT "CHK_worker_capability_role"
            CHECK ("role" IN ('legacy_pipeline','release','infrastructure','deletion','outbox_dispatcher'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_worker_capability_protocol_range'
            AND conrelid = 'worker_capabilities'::regclass
        ) THEN
          ALTER TABLE "worker_capabilities"
            ADD CONSTRAINT "CHK_worker_capability_protocol_range"
            CHECK (
              "minimum_protocol" > 0
              AND "maximum_protocol" >= "minimum_protocol"
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_worker_capability_message_types'
            AND conrelid = 'worker_capabilities'::regclass
        ) THEN
          ALTER TABLE "worker_capabilities"
            ADD CONSTRAINT "CHK_worker_capability_message_types"
            CHECK (jsonb_typeof("supported_message_types") = 'array');
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_worker_capability_role" ON "worker_capabilities" ("role")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_worker_capability_expires_at" ON "worker_capabilities" ("expires_at")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_worker_capability_protocol" ON "worker_capabilities" ("role", "minimum_protocol", "maximum_protocol")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (SELECT 1 FROM "worker_capabilities" LIMIT 1) THEN
          RAISE EXCEPTION 'Refusing to roll back worker capability schema while registrations exist';
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "worker_capabilities"`);
  }
}
