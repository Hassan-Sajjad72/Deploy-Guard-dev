import { MigrationInterface, QueryRunner } from "typeorm";

/** Additive immutable initial-release draft; no legacy row is backfilled. */
export class CreateInitialReleaseDrafts1760000048000 implements MigrationInterface {
  name = "CreateInitialReleaseDrafts1760000048000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "initial_release_drafts" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(), "intent_id" uuid NOT NULL,
      "project_id" uuid NOT NULL, "environment_name" varchar(64) NOT NULL,
      "infrastructure_manifest_id" uuid NOT NULL, "infrastructure_revision" bigint NOT NULL,
      "draft_hash" char(64) NOT NULL, "release_draft" jsonb NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_initial_release_drafts" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_initial_release_draft_hash" CHECK ("draft_hash" ~ '^[0-9a-f]{64}$')
    )`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_initial_release_draft_intent" ON "initial_release_drafts" ("intent_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_initial_release_draft_scope" ON "initial_release_drafts" ("project_id", "environment_name", "created_at")`);
    await queryRunner.query(`DO $m$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_initial_release_draft_intent' AND conrelid = 'initial_release_drafts'::regclass) THEN
        ALTER TABLE "initial_release_drafts" ADD CONSTRAINT "FK_initial_release_draft_intent" FOREIGN KEY ("intent_id") REFERENCES "deployment_intents"("id") ON DELETE RESTRICT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_initial_release_draft_infrastructure' AND conrelid = 'initial_release_drafts'::regclass) THEN
        ALTER TABLE "initial_release_drafts" ADD CONSTRAINT "FK_initial_release_draft_infrastructure" FOREIGN KEY ("infrastructure_manifest_id") REFERENCES "infrastructure_manifests"("id") ON DELETE RESTRICT;
      END IF;
    END $m$`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DO $m$ BEGIN IF EXISTS (SELECT 1 FROM "initial_release_drafts" LIMIT 1) THEN RAISE EXCEPTION 'Refusing to remove immutable initial release drafts while history exists'; END IF; END $m$`);
    await queryRunner.query(`DROP TABLE IF EXISTS "initial_release_drafts"`);
  }
}
