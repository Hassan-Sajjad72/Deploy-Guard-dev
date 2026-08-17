import { MigrationInterface, QueryRunner } from "typeorm";

/** Additive first-release push evidence. Rows are immutable release provenance. */
export class CreateReleaseImageProvenances1760000047000 implements MigrationInterface {
  name = "CreateReleaseImageProvenances1760000047000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "release_image_provenances" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "intent_id" uuid NOT NULL,
        "operation_id" uuid NOT NULL,
        "idempotency_key" char(64) NOT NULL,
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "infrastructure_manifest_id" uuid NOT NULL,
        "infrastructure_revision" bigint NOT NULL,
        "commit_sha" varchar(64) NOT NULL,
        "build_fingerprint" char(64) NOT NULL,
        "image_uri" varchar NOT NULL,
        "image_digest" varchar(71) NOT NULL,
        "evidence_fingerprint" char(64) NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_release_image_provenances" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_release_image_provenance_digest" CHECK ("image_digest" ~ '^sha256:[0-9a-f]{64}$'),
        CONSTRAINT "CHK_release_image_provenance_hashes" CHECK ("build_fingerprint" ~ '^[0-9a-f]{64}$' AND "evidence_fingerprint" ~ '^[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_release_image_provenance_intent' AND conrelid = 'release_image_provenances'::regclass) THEN
          ALTER TABLE "release_image_provenances" ADD CONSTRAINT "FK_release_image_provenance_intent" FOREIGN KEY ("intent_id") REFERENCES "deployment_intents"("id") ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_release_image_provenance_infrastructure' AND conrelid = 'release_image_provenances'::regclass) THEN
          ALTER TABLE "release_image_provenances" ADD CONSTRAINT "FK_release_image_provenance_infrastructure" FOREIGN KEY ("infrastructure_manifest_id") REFERENCES "infrastructure_manifests"("id") ON DELETE RESTRICT;
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_release_image_provenance_operation" ON "release_image_provenances" ("intent_id", "operation_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_release_image_provenance_idempotency" ON "release_image_provenances" ("intent_id", "idempotency_key")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_image_provenance_scope" ON "release_image_provenances" ("project_id", "environment_name", "created_at")`);
    await queryRunner.query(`ALTER TABLE "release_manifests" ADD COLUMN IF NOT EXISTS "initial_service_input_hash" char(64)`);
    await queryRunner.query(`ALTER TABLE "release_manifests" ADD COLUMN IF NOT EXISTS "initial_service_arn" varchar`);
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_release_manifest_initial_service_hash' AND conrelid = 'release_manifests'::regclass) THEN
          ALTER TABLE "release_manifests" ADD CONSTRAINT "CHK_release_manifest_initial_service_hash"
            CHECK ("initial_service_input_hash" IS NULL OR "initial_service_input_hash" ~ '^[0-9a-f]{64}$');
        END IF;
      END
      $migration$
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (SELECT 1 FROM "release_image_provenances" LIMIT 1) THEN
          RAISE EXCEPTION 'Refusing to remove immutable release image provenance while history exists';
        END IF;
      END
      $migration$
    `);
    await queryRunner.query(`ALTER TABLE "release_manifests" DROP CONSTRAINT IF EXISTS "CHK_release_manifest_initial_service_hash"`);
    await queryRunner.query(`ALTER TABLE "release_manifests" DROP COLUMN IF EXISTS "initial_service_arn"`);
    await queryRunner.query(`ALTER TABLE "release_manifests" DROP COLUMN IF EXISTS "initial_service_input_hash"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "release_image_provenances"`);
  }
}
