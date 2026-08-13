import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSideEffectReconciliationJournal1760000040000
implements MigrationInterface {
  name = "CreateSideEffectReconciliationJournal1760000040000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "deployment_side_effect_reconciliations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "side_effect_id" uuid NOT NULL,
        "intent_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "operation_id" uuid NOT NULL,
        "idempotency_key" char(64) NOT NULL,
        "adapter_id" varchar(96) NOT NULL,
        "request_fingerprint" char(64) NOT NULL,
        "lease_id" uuid NOT NULL,
        "owner_worker_id" varchar NOT NULL,
        "fencing_token" bigint NOT NULL,
        "classification" varchar(24),
        "safe_evidence_code" varchar(128),
        "evidence_fingerprint" char(64),
        "result_fingerprint" char(64),
        "external_reference_hash" char(64),
        "failure_code" varchar(128),
        "inspection_started_at" timestamptz NOT NULL DEFAULT now(),
        "completed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_deployment_side_effect_reconciliations"
          PRIMARY KEY ("id"),
        CONSTRAINT "CHK_side_effect_reconciliation_classification"
          CHECK (
            "classification" IS NULL
            OR "classification" IN (
              'succeeded','failed','pending','manual_review'
            )
          ),
        CONSTRAINT "CHK_side_effect_reconciliation_hashes"
          CHECK (
            "request_fingerprint" ~ '^[0-9a-f]{64}$'
            AND (
              "evidence_fingerprint" IS NULL
              OR "evidence_fingerprint" ~ '^[0-9a-f]{64}$'
            )
            AND (
              "result_fingerprint" IS NULL
              OR "result_fingerprint" ~ '^[0-9a-f]{64}$'
            )
            AND (
              "external_reference_hash" IS NULL
              OR "external_reference_hash" ~ '^[0-9a-f]{64}$'
            )
          ),
        CONSTRAINT "CHK_side_effect_reconciliation_fencing"
          CHECK ("fencing_token" > 0)
      )
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_side_effect_reconciliation_effect'
            AND conrelid =
              'deployment_side_effect_reconciliations'::regclass
        ) THEN
          ALTER TABLE "deployment_side_effect_reconciliations"
            ADD CONSTRAINT "FK_side_effect_reconciliation_effect"
            FOREIGN KEY ("side_effect_id")
            REFERENCES "deployment_side_effects"("id")
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_side_effect_reconciliation_intent'
            AND conrelid =
              'deployment_side_effect_reconciliations'::regclass
        ) THEN
          ALTER TABLE "deployment_side_effect_reconciliations"
            ADD CONSTRAINT "FK_side_effect_reconciliation_intent"
            FOREIGN KEY ("intent_id") REFERENCES "deployment_intents"("id")
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_side_effect_reconciliation_project'
            AND conrelid =
              'deployment_side_effect_reconciliations'::regclass
        ) THEN
          ALTER TABLE "deployment_side_effect_reconciliations"
            ADD CONSTRAINT "FK_side_effect_reconciliation_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id")
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_side_effect_reconciliation_lease'
            AND conrelid =
              'deployment_side_effect_reconciliations'::regclass
        ) THEN
          ALTER TABLE "deployment_side_effect_reconciliations"
            ADD CONSTRAINT "FK_side_effect_reconciliation_lease"
            FOREIGN KEY ("lease_id")
            REFERENCES "project_operation_leases"("id")
            ON DELETE RESTRICT;
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_side_effect_reconciliation_operation"
      ON "deployment_side_effect_reconciliations" (
        "side_effect_id", "operation_id"
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_side_effect_reconciliation_idempotency"
      ON "deployment_side_effect_reconciliations" (
        "side_effect_id", "idempotency_key"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_side_effect_reconciliation_effect"
      ON "deployment_side_effect_reconciliations" (
        "side_effect_id", "created_at"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_side_effect_reconciliation_incomplete"
      ON "deployment_side_effect_reconciliations" ("created_at")
      WHERE "classification" IS NULL
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "deployment_side_effect_reconciliations" LIMIT 1
        ) THEN
          RAISE EXCEPTION
            'Refusing to remove side-effect reconciliation evidence';
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "deployment_side_effect_reconciliations"`,
    );
  }
}
