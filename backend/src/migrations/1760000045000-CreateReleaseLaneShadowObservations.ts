import { MigrationInterface, QueryRunner } from "typeorm";

/** Default-off observer evidence only; this migration does not backfill rows. */
export class CreateReleaseLaneShadowObservations1760000045000 implements MigrationInterface {
  name = "CreateReleaseLaneShadowObservations1760000045000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_release_lane_shadow_observations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "proposed_lane" varchar(16) NOT NULL,
        "operation_class" varchar(64) NOT NULL,
        "insertion_source" varchar(128) NOT NULL,
        "canonical_operation_key" char(64) NOT NULL,
        "decision" varchar(32) NOT NULL,
        "current_owner_lane" varchar(16),
        "current_fencing_token" bigint,
        "evidence_hash" char(64) NOT NULL,
        "observed_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_release_lane_shadow_observations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_release_lane_shadow_lane' AND conrelid = 'project_release_lane_shadow_observations'::regclass) THEN
          ALTER TABLE "project_release_lane_shadow_observations" ADD CONSTRAINT "CHK_release_lane_shadow_lane" CHECK ("proposed_lane" IN ('legacy','v1'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_release_lane_shadow_decision' AND conrelid = 'project_release_lane_shadow_observations'::regclass) THEN
          ALTER TABLE "project_release_lane_shadow_observations" ADD CONSTRAINT "CHK_release_lane_shadow_decision" CHECK ("decision" IN ('acquirable','would_block_legacy','would_block_v1','unsafe_stale','insufficient_evidence'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_release_lane_shadow_hashes' AND conrelid = 'project_release_lane_shadow_observations'::regclass) THEN
          ALTER TABLE "project_release_lane_shadow_observations" ADD CONSTRAINT "CHK_release_lane_shadow_hashes" CHECK ("canonical_operation_key" ~ '^[0-9a-f]{64}$' AND "evidence_hash" ~ '^[0-9a-f]{64}$');
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_release_lane_shadow_operation" ON "project_release_lane_shadow_observations" ("canonical_operation_key")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_lane_shadow_scope" ON "project_release_lane_shadow_observations" ("project_id", "environment_name", "insertion_source")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (SELECT 1 FROM "project_release_lane_shadow_observations" LIMIT 1) THEN
          RAISE EXCEPTION 'Refusing to roll back release-lane shadow observations while history exists';
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_release_lane_shadow_observations"`);
  }
}
