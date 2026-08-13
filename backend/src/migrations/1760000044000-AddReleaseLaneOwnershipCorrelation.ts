import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Adds nullable evidence links only. It neither acquires nor enforces release
 * ownership and deliberately leaves every existing legacy row untouched.
 */
export class AddReleaseLaneOwnershipCorrelation1760000044000
  implements MigrationInterface
{
  name = "AddReleaseLaneOwnershipCorrelation1760000044000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "project_release_lane_ownerships"
        ADD COLUMN IF NOT EXISTS "deployment_intent_id" uuid,
        ADD COLUMN IF NOT EXISTS "operation_lease_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "project_pipeline_runs"
        ADD COLUMN IF NOT EXISTS "cross_lane_ownership_id" uuid,
        ADD COLUMN IF NOT EXISTS "cross_lane_owner_lane" varchar(16),
        ADD COLUMN IF NOT EXISTS "cross_lane_owner_environment_name" varchar(64),
        ADD COLUMN IF NOT EXISTS "cross_lane_owner_lease_id" uuid,
        ADD COLUMN IF NOT EXISTS "cross_lane_owner_actor_id" varchar(160),
        ADD COLUMN IF NOT EXISTS "cross_lane_owner_fencing_token" bigint
    `);
    await queryRunner.query(`
      ALTER TABLE "project_rollback_records"
        ADD COLUMN IF NOT EXISTS "cross_lane_ownership_id" uuid,
        ADD COLUMN IF NOT EXISTS "cross_lane_owner_lane" varchar(16),
        ADD COLUMN IF NOT EXISTS "cross_lane_owner_environment_name" varchar(64),
        ADD COLUMN IF NOT EXISTS "cross_lane_owner_lease_id" uuid,
        ADD COLUMN IF NOT EXISTS "cross_lane_owner_actor_id" varchar(160),
        ADD COLUMN IF NOT EXISTS "cross_lane_owner_fencing_token" bigint
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_release_lane_ownership_intent' AND conrelid = 'project_release_lane_ownerships'::regclass) THEN
          ALTER TABLE "project_release_lane_ownerships" ADD CONSTRAINT "FK_release_lane_ownership_intent"
            FOREIGN KEY ("deployment_intent_id") REFERENCES "deployment_intents"("id") ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_release_lane_ownership_operation_lease' AND conrelid = 'project_release_lane_ownerships'::regclass) THEN
          ALTER TABLE "project_release_lane_ownerships" ADD CONSTRAINT "FK_release_lane_ownership_operation_lease"
            FOREIGN KEY ("operation_lease_id") REFERENCES "project_operation_leases"("id") ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_pipeline_runs_cross_lane_ownership' AND conrelid = 'project_pipeline_runs'::regclass) THEN
          ALTER TABLE "project_pipeline_runs" ADD CONSTRAINT "FK_pipeline_runs_cross_lane_ownership"
            FOREIGN KEY ("cross_lane_ownership_id") REFERENCES "project_release_lane_ownerships"("id") ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_rollback_records_cross_lane_ownership' AND conrelid = 'project_rollback_records'::regclass) THEN
          ALTER TABLE "project_rollback_records" ADD CONSTRAINT "FK_rollback_records_cross_lane_ownership"
            FOREIGN KEY ("cross_lane_ownership_id") REFERENCES "project_release_lane_ownerships"("id") ON DELETE RESTRICT;
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_lane_ownership_deployment_intent" ON "project_release_lane_ownerships" ("deployment_intent_id") WHERE "deployment_intent_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_lane_ownership_operation_lease" ON "project_release_lane_ownerships" ("operation_lease_id") WHERE "operation_lease_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pipeline_runs_cross_lane_ownership" ON "project_pipeline_runs" ("cross_lane_ownership_id") WHERE "cross_lane_ownership_id" IS NOT NULL`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_rollback_records_cross_lane_ownership" ON "project_rollback_records" ("cross_lane_ownership_id") WHERE "cross_lane_ownership_id" IS NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM "project_release_lane_ownerships"
          WHERE "deployment_intent_id" IS NOT NULL OR "operation_lease_id" IS NOT NULL
        ) OR EXISTS (
          SELECT 1 FROM "project_pipeline_runs"
          WHERE "cross_lane_ownership_id" IS NOT NULL
        ) OR EXISTS (
          SELECT 1 FROM "project_rollback_records"
          WHERE "cross_lane_ownership_id" IS NOT NULL
        ) THEN
          RAISE EXCEPTION 'Refusing to roll back release-lane correlation while correlation history exists';
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`ALTER TABLE "project_rollback_records" DROP CONSTRAINT IF EXISTS "FK_rollback_records_cross_lane_ownership"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP CONSTRAINT IF EXISTS "FK_pipeline_runs_cross_lane_ownership"`);
    await queryRunner.query(`ALTER TABLE "project_release_lane_ownerships" DROP CONSTRAINT IF EXISTS "FK_release_lane_ownership_operation_lease"`);
    await queryRunner.query(`ALTER TABLE "project_release_lane_ownerships" DROP CONSTRAINT IF EXISTS "FK_release_lane_ownership_intent"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_rollback_records_cross_lane_ownership"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_pipeline_runs_cross_lane_ownership"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_release_lane_ownership_operation_lease"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_release_lane_ownership_deployment_intent"`);
    await queryRunner.query(`ALTER TABLE "project_rollback_records" DROP COLUMN IF EXISTS "cross_lane_owner_fencing_token", DROP COLUMN IF EXISTS "cross_lane_owner_actor_id", DROP COLUMN IF EXISTS "cross_lane_owner_lease_id", DROP COLUMN IF EXISTS "cross_lane_owner_environment_name", DROP COLUMN IF EXISTS "cross_lane_owner_lane", DROP COLUMN IF EXISTS "cross_lane_ownership_id"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "cross_lane_owner_fencing_token", DROP COLUMN IF EXISTS "cross_lane_owner_actor_id", DROP COLUMN IF EXISTS "cross_lane_owner_lease_id", DROP COLUMN IF EXISTS "cross_lane_owner_environment_name", DROP COLUMN IF EXISTS "cross_lane_owner_lane", DROP COLUMN IF EXISTS "cross_lane_ownership_id"`);
    await queryRunner.query(`ALTER TABLE "project_release_lane_ownerships" DROP COLUMN IF EXISTS "operation_lease_id", DROP COLUMN IF EXISTS "deployment_intent_id"`);
  }
}
