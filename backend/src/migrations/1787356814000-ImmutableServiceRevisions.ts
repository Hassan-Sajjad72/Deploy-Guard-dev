import { MigrationInterface, QueryRunner } from "typeorm";

/** Establishes generation-wide service revisions and immutable runtime config identity. */
export class ImmutableServiceRevisions1787356814000 implements MigrationInterface {
  name = "ImmutableServiceRevisions1787356814000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE "project_service_runtime_config_revisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "service_id" uuid NOT NULL,
        "created_by_operation_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "configuration_fingerprint" varchar(64) NOT NULL,
        "non_secret_environment" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "secret_references" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "secret_version_ids" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "database_configuration" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "platform_values" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "is_rollback_safe" boolean NOT NULL DEFAULT true,
        "legacy_backfill" boolean NOT NULL DEFAULT false,
        "sealed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_service_runtime_config_revisions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_service_runtime_config_operation" UNIQUE ("created_by_operation_id", "service_id"),
        CONSTRAINT "FK_runtime_config_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_runtime_config_service" FOREIGN KEY ("service_id") REFERENCES "project_deployable_services"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_runtime_config_fingerprint" CHECK ("configuration_fingerprint" ~ '^[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_runtime_config_project" ON "project_service_runtime_config_revisions" ("project_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_runtime_config_service" ON "project_service_runtime_config_revisions" ("service_id")`);

    await queryRunner.query(`
      CREATE TABLE "project_generation_service_revisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "generation_id" uuid NOT NULL,
        "service_id" uuid NOT NULL,
        "service_name" varchar(80) NOT NULL,
        "service_directory" varchar(512) NOT NULL,
        "source_sha" varchar(40) NOT NULL,
        "image_uri" varchar NOT NULL,
        "image_digest" varchar(71) NOT NULL,
        "runtime_config_revision_id" uuid NOT NULL,
        "runtime_identity" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_generation_service_revisions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_generation_service_revision" UNIQUE ("generation_id", "service_id"),
        CONSTRAINT "FK_generation_revision_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_generation_revision_generation" FOREIGN KEY ("generation_id") REFERENCES "project_deployment_generations"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_generation_revision_service" FOREIGN KEY ("service_id") REFERENCES "project_deployable_services"("id") ON DELETE RESTRICT,
        CONSTRAINT "FK_generation_revision_runtime_config" FOREIGN KEY ("runtime_config_revision_id") REFERENCES "project_service_runtime_config_revisions"("id") ON DELETE RESTRICT,
        CONSTRAINT "CHK_generation_revision_source_sha" CHECK ("source_sha" ~ '^[0-9a-fA-F]{40}$'),
        CONSTRAINT "CHK_generation_revision_image_digest" CHECK ("image_digest" ~ '^sha256:[0-9a-f]{64}$')
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_generation_revision_project" ON "project_generation_service_revisions" ("project_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_generation_revision_generation" ON "project_generation_service_revisions" ("generation_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_generation_revision_service" ON "project_generation_service_revisions" ("service_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_generation_revision_runtime_config" ON "project_generation_service_revisions" ("runtime_config_revision_id")`);

    // Historical scalar releases remain readable, but are deliberately marked
    // rollback-unsafe: mutable current configuration cannot be invented as
    // historical authority during migration.
    await queryRunner.query(`
      INSERT INTO "project_service_runtime_config_revisions" (
        "id", "project_id", "service_id", "created_by_operation_id", "environment_name",
        "configuration_fingerprint", "non_secret_environment", "secret_references",
        "secret_version_ids", "database_configuration", "platform_values",
        "is_rollback_safe", "legacy_backfill", "sealed_at"
      )
      SELECT uuid_generate_v4(), release."project_id", service."id", release."deployed_by_pipeline_run_id",
        release."environment_name", md5(release."id"::text || ':' || service."id"::text) || md5(service."id"::text || ':' || release."id"::text),
        '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        jsonb_build_object('legacyBackfill', true), jsonb_build_object('PORT', coalesce(release."app_port", 8080)::text, 'HOST', '0.0.0.0'),
        false, true, release."deployed_at"
      FROM "project_stable_releases" release
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(release."metadata"->'services', '[]'::jsonb)) item
      JOIN "project_deployable_services" service ON service."project_id" = release."project_id" AND service."id"::text = item->>'serviceId'
      WHERE release."generation_id" IS NOT NULL AND release."deployed_by_pipeline_run_id" IS NOT NULL
      ON CONFLICT ("created_by_operation_id", "service_id") DO NOTHING
    `);
    await queryRunner.query(`
      INSERT INTO "project_generation_service_revisions" (
        "project_id", "generation_id", "service_id", "service_name", "service_directory", "source_sha",
        "image_uri", "image_digest", "runtime_config_revision_id", "runtime_identity"
      )
      SELECT release."project_id", release."generation_id", config."service_id",
        item->>'serviceName', item->>'serviceDirectory', release."commit_sha",
        item->>'imageUri', item->>'imageDigest', config."id", item
      FROM "project_stable_releases" release
      CROSS JOIN LATERAL jsonb_array_elements(coalesce(release."metadata"->'services', '[]'::jsonb)) item
      JOIN "project_service_runtime_config_revisions" config
        ON config."created_by_operation_id" = release."deployed_by_pipeline_run_id"
       AND config."service_id"::text = item->>'serviceId'
      WHERE release."generation_id" IS NOT NULL
        AND release."commit_sha" ~ '^[0-9a-fA-F]{40}$'
        AND item->>'imageDigest' ~ '^sha256:[0-9a-f]{64}$'
        AND coalesce(item->>'imageUri', '') <> ''
      ON CONFLICT ("generation_id", "service_id") DO NOTHING
    `);
    await queryRunner.query(`ALTER TABLE "project_stable_releases" ALTER COLUMN "image_uri" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "project_stable_releases" ALTER COLUMN "task_definition_arn" DROP NOT NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_generation_service_revisions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_service_runtime_config_revisions"`);
  }
}
