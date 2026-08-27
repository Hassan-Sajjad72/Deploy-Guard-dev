import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDeploymentSideEffectJournal1760000039000
implements MigrationInterface {
  name = "CreateDeploymentSideEffectJournal1760000039000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "deployment_side_effects" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "intent_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "operation_id" uuid NOT NULL,
        "effect_type" varchar(96) NOT NULL,
        "idempotency_key" char(64) NOT NULL,
        "request_fingerprint" char(64) NOT NULL,
        "lease_id" uuid NOT NULL,
        "owner_worker_id" varchar NOT NULL,
        "fencing_token" bigint NOT NULL,
        "status" varchar(24) NOT NULL,
        "safe_result_code" varchar(128),
        "result_fingerprint" char(64),
        "external_reference_hash" char(64),
        "failure_code" varchar(128),
        "reconciliation_required" boolean NOT NULL DEFAULT false,
        "attempt_started_at" timestamptz,
        "deadline_at" timestamptz,
        "completed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_deployment_side_effects" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_deployment_side_effect_status"
          CHECK ("status" IN (
            'prepared','started','succeeded','failed','uncertain','reconciled'
          )),
        CONSTRAINT "CHK_deployment_side_effect_hashes"
          CHECK (
            "request_fingerprint" ~ '^[0-9a-f]{64}$'
            AND (
              "result_fingerprint" IS NULL
              OR "result_fingerprint" ~ '^[0-9a-f]{64}$'
            )
            AND (
              "external_reference_hash" IS NULL
              OR "external_reference_hash" ~ '^[0-9a-f]{64}$'
            )
          ),
        CONSTRAINT "CHK_deployment_side_effect_fencing"
          CHECK ("fencing_token" > 0)
      )
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_deployment_side_effect_intent'
            AND conrelid = 'deployment_side_effects'::regclass
        ) THEN
          ALTER TABLE "deployment_side_effects"
            ADD CONSTRAINT "FK_deployment_side_effect_intent"
            FOREIGN KEY ("intent_id") REFERENCES "deployment_intents"("id")
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_deployment_side_effect_project'
            AND conrelid = 'deployment_side_effects'::regclass
        ) THEN
          ALTER TABLE "deployment_side_effects"
            ADD CONSTRAINT "FK_deployment_side_effect_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id")
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_deployment_side_effect_lease'
            AND conrelid = 'deployment_side_effects'::regclass
        ) THEN
          ALTER TABLE "deployment_side_effects"
            ADD CONSTRAINT "FK_deployment_side_effect_lease"
            FOREIGN KEY ("lease_id") REFERENCES "project_operation_leases"("id")
            ON DELETE RESTRICT;
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_deployment_side_effect_operation"
      ON "deployment_side_effects" ("intent_id", "operation_id")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_deployment_side_effect_idempotency"
      ON "deployment_side_effects" ("intent_id", "idempotency_key")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_deployment_side_effect_intent"
      ON "deployment_side_effects" ("intent_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_deployment_side_effect_project"
      ON "deployment_side_effects" ("project_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_deployment_side_effect_reconciliation"
      ON "deployment_side_effects" (
        "reconciliation_required", "status", "updated_at"
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "deployment_side_effects" LIMIT 1
        ) THEN
          RAISE EXCEPTION
            'Refusing to remove deployment side-effect reconciliation history';
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "deployment_side_effects"`,
    );
  }
}
