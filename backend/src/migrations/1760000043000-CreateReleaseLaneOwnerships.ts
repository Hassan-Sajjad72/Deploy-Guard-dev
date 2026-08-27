import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateReleaseLaneOwnerships1760000043000
  implements MigrationInterface
{
  name = "CreateReleaseLaneOwnerships1760000043000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_release_lane_ownerships" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "owner_lane" varchar(16) NOT NULL,
        "lease_id" uuid NOT NULL,
        "actor_id" varchar(160) NOT NULL,
        "idempotency_key" char(64) NOT NULL,
        "request_fingerprint" char(64) NOT NULL,
        "fencing_token" bigint NOT NULL,
        "status" varchar(24) NOT NULL DEFAULT 'acquired',
        "acquired_at" timestamptz NOT NULL DEFAULT now(),
        "heartbeat_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "released_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_release_lane_ownerships" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_release_lane_ownership_project' AND conrelid = 'project_release_lane_ownerships'::regclass) THEN
          ALTER TABLE "project_release_lane_ownerships" ADD CONSTRAINT "FK_release_lane_ownership_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_release_lane_ownership_lane' AND conrelid = 'project_release_lane_ownerships'::regclass) THEN
          ALTER TABLE "project_release_lane_ownerships" ADD CONSTRAINT "CHK_release_lane_ownership_lane" CHECK ("owner_lane" IN ('legacy','v1'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_release_lane_ownership_status' AND conrelid = 'project_release_lane_ownerships'::regclass) THEN
          ALTER TABLE "project_release_lane_ownerships" ADD CONSTRAINT "CHK_release_lane_ownership_status" CHECK ("status" IN ('acquired','heartbeat_active','released','expired'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_release_lane_ownership_fencing_token' AND conrelid = 'project_release_lane_ownerships'::regclass) THEN
          ALTER TABLE "project_release_lane_ownerships" ADD CONSTRAINT "CHK_release_lane_ownership_fencing_token" CHECK ("fencing_token" > 0);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_release_lane_ownership_hashes' AND conrelid = 'project_release_lane_ownerships'::regclass) THEN
          ALTER TABLE "project_release_lane_ownerships" ADD CONSTRAINT "CHK_release_lane_ownership_hashes" CHECK ("idempotency_key" ~ '^[0-9a-f]{64}$' AND "request_fingerprint" ~ '^[0-9a-f]{64}$');
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_release_lane_ownership_scope" ON "project_release_lane_ownerships" ("project_id", "environment_name")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_release_lane_ownership_fencing_token" ON "project_release_lane_ownerships" ("project_id", "environment_name", "fencing_token")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_lane_ownership_project" ON "project_release_lane_ownerships" ("project_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (SELECT 1 FROM "project_release_lane_ownerships" LIMIT 1) THEN
          RAISE EXCEPTION 'Refusing to roll back release-lane ownership while ownership history exists';
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_release_lane_ownerships"`);
  }
}
