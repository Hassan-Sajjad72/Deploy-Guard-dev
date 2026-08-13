import { MigrationInterface, QueryRunner } from "typeorm";

export class CanonicalProjectConfiguration1760000033000 implements MigrationInterface {
  name = "CanonicalProjectConfiguration1760000033000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_database_tiers" ADD COLUMN IF NOT EXISTS "external_tls_required" boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "normalized_key" varchar`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "source" varchar NOT NULL DEFAULT 'user'`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "protected" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "service_binding_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "detected_reference" varchar`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "repository_default" varchar`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "superseded_by" varchar`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN IF NOT EXISTS "configuration_fingerprint" varchar`);
    await queryRunner.query(`UPDATE "project_environment_variables" SET
      "normalized_key"=upper(trim("key")),
      "owner"=CASE
        WHEN "owner"='platform_generated' THEN 'managed_service'
        WHEN "owner"='platform_detected' THEN 'repository_default'
        WHEN "owner"='external_service_supplied' THEN 'external_service'
        WHEN "is_required"=true THEN 'user_required'
        ELSE 'user_optional'
      END,
      "source"=COALESCE(NULLIF("detected_source", ''), 'legacy_project_variable'),
      "detected_reference"=NULLIF("detected_source", ''),
      "configuration_fingerprint"=md5(concat_ws('|', "project_id"::text, upper(trim("key")), "scope", "environment", "updated_at"::text))
      WHERE "normalized_key" IS NULL OR "configuration_fingerprint" IS NULL OR "owner" IN ('user_supplied','platform_generated','platform_detected','external_service_supplied')`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ALTER COLUMN "normalized_key" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ALTER COLUMN "owner" SET DEFAULT 'user_optional'`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_env_normalized_key" ON "project_environment_variables" ("project_id", "normalized_key")`);
    await queryRunner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_project_env_service_binding') THEN
        ALTER TABLE "project_environment_variables" ADD CONSTRAINT "FK_project_env_service_binding" FOREIGN KEY ("service_binding_id") REFERENCES "project_service_bindings"("id") ON DELETE SET NULL;
      END IF;
    END $$;`);

    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "project_configuration_snapshots" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "project_id" uuid NOT NULL,
      "pipeline_run_id" uuid NOT NULL,
      "environment" varchar NOT NULL DEFAULT 'production',
      "configuration_fingerprint" varchar NOT NULL,
      "plain_values" jsonb NOT NULL DEFAULT '{}',
      "build_values" jsonb NOT NULL DEFAULT '{}',
      "secret_references" jsonb NOT NULL DEFAULT '{}',
      "binding_revisions" jsonb NOT NULL DEFAULT '[]',
      "ownership_manifest" jsonb NOT NULL DEFAULT '{}',
      "source_revisions" jsonb NOT NULL DEFAULT '{}',
      "unresolved_required" jsonb NOT NULL DEFAULT '[]',
      "prohibited_overrides" jsonb NOT NULL DEFAULT '[]',
      "duplicate_conflicts" jsonb NOT NULL DEFAULT '[]',
      "validation_blockers" jsonb NOT NULL DEFAULT '[]',
      "encrypted_secret_payload" text,
      "sanitized_manifest" jsonb NOT NULL DEFAULT '{}',
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_project_configuration_snapshots" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`ALTER TABLE "project_configuration_snapshots" ADD COLUMN IF NOT EXISTS "build_values" jsonb NOT NULL DEFAULT '{}'`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_configuration_snapshot_run" ON "project_configuration_snapshots" ("pipeline_run_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_configuration_snapshot_project" ON "project_configuration_snapshots" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_configuration_snapshot_fingerprint" ON "project_configuration_snapshots" ("configuration_fingerprint")`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN IF NOT EXISTS "configuration_snapshot_id" uuid`);
    await queryRunner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_configuration_snapshots_project') THEN
        ALTER TABLE "project_configuration_snapshots" ADD CONSTRAINT "FK_configuration_snapshots_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_configuration_snapshots_run') THEN
        ALTER TABLE "project_configuration_snapshots" ADD CONSTRAINT "FK_configuration_snapshots_run" FOREIGN KEY ("pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_pipeline_runs_configuration_snapshot') THEN
        ALTER TABLE "project_pipeline_runs" ADD CONSTRAINT "FK_pipeline_runs_configuration_snapshot" FOREIGN KEY ("configuration_snapshot_id") REFERENCES "project_configuration_snapshots"("id") ON DELETE SET NULL;
      END IF;
    END $$;`);

    await queryRunner.query(`UPDATE "project_environment_variables" env SET
      "is_active"=false,
      "protected"=true,
      "owner"='managed_service',
      "superseded_at"=COALESCE("superseded_at", now()),
      "superseded_reason"=COALESCE("superseded_reason", 'Superseded by DeployGuard-managed service binding'),
      "service_binding_id"=(
        SELECT b.id FROM "project_service_bindings" b
        WHERE b.project_id=env.project_id AND b.service_type='database'
        ORDER BY b.created_at DESC LIMIT 1
      ),
      "superseded_by"=COALESCE('service-binding:' || (
        SELECT b.id::text FROM "project_service_bindings" b
        WHERE b.project_id=env.project_id AND b.service_type='database'
        ORDER BY b.created_at DESC LIMIT 1
      ), 'managed-service-binding')
      FROM "project_database_tiers" tier
      WHERE tier.project_id=env.project_id AND tier.provider::text='managed'
        AND env.normalized_key IN (
          'DB_HOST','DATABASE_HOST','POSTGRES_HOST','PGHOST','MYSQL_HOST',
          'DB_PORT','DATABASE_PORT','POSTGRES_PORT','PGPORT','MYSQL_PORT',
          'DB_USER','DATABASE_USER','POSTGRES_USER','PGUSER','MYSQL_USER',
          'DB_PASSWORD','DATABASE_PASSWORD','POSTGRES_PASSWORD','PGPASSWORD','MYSQL_PASSWORD',
          'DB_NAME','DATABASE_NAME','POSTGRES_DB','PGDATABASE','MYSQL_DATABASE',
          'DATABASE_URL','POSTGRES_URL','POSTGRESQL_URL','MYSQL_URL'
        )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP CONSTRAINT IF EXISTS "FK_pipeline_runs_configuration_snapshot"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "configuration_snapshot_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_configuration_snapshots"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP CONSTRAINT IF EXISTS "FK_project_env_service_binding"`);
    for (const column of ["configuration_fingerprint", "superseded_by", "repository_default", "detected_reference", "service_binding_id", "protected", "source", "normalized_key"]) {
      await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "${column}"`);
    }
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ALTER COLUMN "owner" SET DEFAULT 'user_supplied'`);
    await queryRunner.query(`ALTER TABLE "project_database_tiers" DROP COLUMN IF EXISTS "external_tls_required"`);
  }
}
