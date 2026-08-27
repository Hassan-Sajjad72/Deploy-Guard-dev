import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSideEffectReconciliationLeases1760000041000
implements MigrationInterface {
  name = "CreateSideEffectReconciliationLeases1760000041000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS
        "deployment_side_effect_reconciliation_leases" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "side_effect_id" uuid NOT NULL,
        "intent_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "owner_worker_id" varchar NOT NULL,
        "fencing_token" bigint NOT NULL,
        "status" varchar(24) NOT NULL,
        "origin" varchar(24) NOT NULL DEFAULT 'coordinator',
        "legacy_operation_lease_id" uuid,
        "acquired_at" timestamptz NOT NULL DEFAULT now(),
        "heartbeat_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "released_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_side_effect_reconciliation_leases"
          PRIMARY KEY ("id"),
        CONSTRAINT "CHK_side_effect_reconciliation_lease_status"
          CHECK (
            "status" IN (
              'acquired','heartbeat_active','released','expired','failed'
            )
          ),
        CONSTRAINT "CHK_side_effect_reconciliation_lease_fencing"
          CHECK ("fencing_token" > 0),
        CONSTRAINT "CHK_side_effect_reconciliation_lease_origin"
          CHECK ("origin" IN ('coordinator','legacy_backfill'))
      )
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_side_effect_reconciliation_lease_effect'
            AND conrelid =
              'deployment_side_effect_reconciliation_leases'::regclass
        ) THEN
          ALTER TABLE "deployment_side_effect_reconciliation_leases"
            ADD CONSTRAINT "FK_side_effect_reconciliation_lease_effect"
            FOREIGN KEY ("side_effect_id")
            REFERENCES "deployment_side_effects"("id")
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_side_effect_reconciliation_lease_intent'
            AND conrelid =
              'deployment_side_effect_reconciliation_leases'::regclass
        ) THEN
          ALTER TABLE "deployment_side_effect_reconciliation_leases"
            ADD CONSTRAINT "FK_side_effect_reconciliation_lease_intent"
            FOREIGN KEY ("intent_id") REFERENCES "deployment_intents"("id")
            ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_side_effect_reconciliation_lease_project'
            AND conrelid =
              'deployment_side_effect_reconciliation_leases'::regclass
        ) THEN
          ALTER TABLE "deployment_side_effect_reconciliation_leases"
            ADD CONSTRAINT "FK_side_effect_reconciliation_lease_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id")
            ON DELETE RESTRICT;
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM pg_constraint constraint_row
          INNER JOIN pg_class referenced
            ON referenced.oid = constraint_row.confrelid
          WHERE constraint_row.conname =
            'FK_side_effect_reconciliation_lease'
            AND constraint_row.conrelid =
              'deployment_side_effect_reconciliations'::regclass
            AND referenced.relname = 'project_operation_leases'
        ) THEN
          CREATE TEMP TABLE reconciliation_lease_migration_map
          ON COMMIT DROP AS
          SELECT legacy.side_effect_id, legacy.old_lease_id,
                 gen_random_uuid() AS new_lease_id
          FROM (
            SELECT DISTINCT reconciliation.side_effect_id,
                            reconciliation.lease_id AS old_lease_id
            FROM deployment_side_effect_reconciliations reconciliation
          ) legacy;

          INSERT INTO deployment_side_effect_reconciliation_leases (
            id, side_effect_id, intent_id, project_id, environment_name,
            owner_worker_id, fencing_token, status, origin,
            legacy_operation_lease_id, acquired_at, heartbeat_at,
            expires_at, released_at, created_at, updated_at
          )
          SELECT DISTINCT ON (mapping.new_lease_id)
            mapping.new_lease_id, reconciliation.side_effect_id,
            reconciliation.intent_id, reconciliation.project_id,
            reconciliation.environment_name,
            reconciliation.owner_worker_id,
            reconciliation.fencing_token, 'expired', 'legacy_backfill',
            mapping.old_lease_id,
            reconciliation.inspection_started_at,
            reconciliation.inspection_started_at,
            reconciliation.inspection_started_at,
            COALESCE(
              reconciliation.completed_at,
              reconciliation.inspection_started_at
            ),
            reconciliation.created_at, clock_timestamp()
          FROM reconciliation_lease_migration_map mapping
          INNER JOIN deployment_side_effect_reconciliations reconciliation
            ON reconciliation.side_effect_id = mapping.side_effect_id
           AND reconciliation.lease_id = mapping.old_lease_id
          ORDER BY mapping.new_lease_id, reconciliation.created_at DESC
          ON CONFLICT ("id") DO NOTHING;

          ALTER TABLE "deployment_side_effect_reconciliations"
            DROP CONSTRAINT "FK_side_effect_reconciliation_lease";

          UPDATE deployment_side_effect_reconciliations reconciliation
          SET lease_id = mapping.new_lease_id
          FROM reconciliation_lease_migration_map mapping
          WHERE reconciliation.side_effect_id = mapping.side_effect_id
            AND reconciliation.lease_id = mapping.old_lease_id;

          ALTER TABLE "deployment_side_effect_reconciliations"
            ADD CONSTRAINT "FK_side_effect_reconciliation_lease"
            FOREIGN KEY ("lease_id")
            REFERENCES "deployment_side_effect_reconciliation_leases"("id")
            ON DELETE RESTRICT;
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_side_effect_reconciliation_lease_active"
      ON "deployment_side_effect_reconciliation_leases" ("side_effect_id")
      WHERE "status" IN ('acquired','heartbeat_active')
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS
        "UQ_side_effect_reconciliation_lease_fencing"
      ON "deployment_side_effect_reconciliation_leases" (
        "side_effect_id", "fencing_token"
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_side_effect_reconciliation_lease_effect"
      ON "deployment_side_effect_reconciliation_leases" ("side_effect_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS
        "IDX_side_effect_reconciliation_lease_status"
      ON "deployment_side_effect_reconciliation_leases" ("status")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM deployment_side_effect_reconciliation_leases
          WHERE origin = 'coordinator'
          LIMIT 1
        ) THEN
          RAISE EXCEPTION
            'Refusing to remove active reconciliation coordinator history';
        END IF;

        IF EXISTS (
          SELECT 1 FROM deployment_side_effect_reconciliation_leases lease
          LEFT JOIN project_operation_leases operation_lease
            ON operation_lease.id = lease.legacy_operation_lease_id
          WHERE lease.origin = 'legacy_backfill'
            AND operation_lease.id IS NULL
          LIMIT 1
        ) THEN
          RAISE EXCEPTION
            'Cannot restore a missing legacy operation lease reference';
        END IF;

        ALTER TABLE "deployment_side_effect_reconciliations"
          DROP CONSTRAINT IF EXISTS "FK_side_effect_reconciliation_lease";

        UPDATE deployment_side_effect_reconciliations reconciliation
        SET lease_id = lease.legacy_operation_lease_id
        FROM deployment_side_effect_reconciliation_leases lease
        WHERE reconciliation.lease_id = lease.id
          AND lease.origin = 'legacy_backfill';

        ALTER TABLE "deployment_side_effect_reconciliations"
          ADD CONSTRAINT "FK_side_effect_reconciliation_lease"
          FOREIGN KEY ("lease_id")
          REFERENCES "project_operation_leases"("id")
          ON DELETE RESTRICT;
      END
      $migration$;
    `);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "deployment_side_effect_reconciliation_leases"`,
    );
  }
}
