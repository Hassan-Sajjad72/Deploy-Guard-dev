import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectDatabaseTiers1760000027000 implements MigrationInterface {
  name = "CreateProjectDatabaseTiers1760000027000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type type
          INNER JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
          WHERE type.typname = 'project_database_tiers_provider_enum'
            AND namespace.nspname = current_schema()
        ) THEN
          CREATE TYPE "project_database_tiers_provider_enum" AS ENUM('managed','external','none');
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_type type
          INNER JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
          WHERE type.typname = 'project_database_tiers_status_enum'
            AND namespace.nspname = current_schema()
        ) THEN
          CREATE TYPE "project_database_tiers_status_enum" AS ENUM('not_required','setup_required','pending','provisioning','ready','unhealthy');
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_database_tiers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "required_by_detection" boolean NOT NULL DEFAULT false,
        "engine" character varying,
        "provider" "project_database_tiers_provider_enum",
        "status" "project_database_tiers_status_enum" NOT NULL DEFAULT 'setup_required',
        "external_host" character varying,
        "external_port" integer,
        "internal_host" character varying,
        "database_name" character varying,
        "database_user" character varying,
        "persistence_enabled" boolean NOT NULL DEFAULT true,
        "backup_enabled" boolean NOT NULL DEFAULT true,
        "efs_file_system_id" character varying,
        "efs_access_point_id" character varying,
        "credentials_secret_arn" character varying,
        "database_url_secret_arn" character varying,
        "backup_plan_id" character varying,
        "last_backup_at" TIMESTAMP WITH TIME ZONE,
        "last_restore_at" TIMESTAMP WITH TIME ZONE,
        "restore_metadata" jsonb,
        "last_error" character varying,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "project_database_tiers"
        ADD COLUMN IF NOT EXISTS "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        ADD COLUMN IF NOT EXISTS "project_id" uuid NOT NULL,
        ADD COLUMN IF NOT EXISTS "required_by_detection" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "engine" character varying,
        ADD COLUMN IF NOT EXISTS "provider" "project_database_tiers_provider_enum",
        ADD COLUMN IF NOT EXISTS "status" "project_database_tiers_status_enum" NOT NULL DEFAULT 'setup_required',
        ADD COLUMN IF NOT EXISTS "external_host" character varying,
        ADD COLUMN IF NOT EXISTS "external_port" integer,
        ADD COLUMN IF NOT EXISTS "internal_host" character varying,
        ADD COLUMN IF NOT EXISTS "database_name" character varying,
        ADD COLUMN IF NOT EXISTS "database_user" character varying,
        ADD COLUMN IF NOT EXISTS "persistence_enabled" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "backup_enabled" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "efs_file_system_id" character varying,
        ADD COLUMN IF NOT EXISTS "efs_access_point_id" character varying,
        ADD COLUMN IF NOT EXISTS "credentials_secret_arn" character varying,
        ADD COLUMN IF NOT EXISTS "database_url_secret_arn" character varying,
        ADD COLUMN IF NOT EXISTS "backup_plan_id" character varying,
        ADD COLUMN IF NOT EXISTS "last_backup_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "last_restore_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "restore_metadata" jsonb,
        ADD COLUMN IF NOT EXISTS "last_error" character varying,
        ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = '"project_database_tiers"'::regclass
            AND contype = 'p'
        ) THEN
          ALTER TABLE "project_database_tiers"
            ADD CONSTRAINT "PK_project_database_tiers" PRIMARY KEY ("id");
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = '"project_database_tiers"'::regclass
            AND conname = 'UQ_project_database_tiers_project'
        ) THEN
          ALTER TABLE "project_database_tiers"
            ADD CONSTRAINT "UQ_project_database_tiers_project" UNIQUE ("project_id");
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = '"project_database_tiers"'::regclass
            AND conname = 'FK_project_database_tiers_project'
        ) THEN
          ALTER TABLE "project_database_tiers"
            ADD CONSTRAINT "FK_project_database_tiers_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`ALTER TABLE "project_deployment_contracts" ADD COLUMN IF NOT EXISTS "database_engine" character varying`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "delete_persistent_database_data" boolean NOT NULL DEFAULT false`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "delete_persistent_database_data"`);
    await queryRunner.query(`ALTER TABLE "project_deployment_contracts" DROP COLUMN IF EXISTS "database_engine"`);
    await queryRunner.query(`
      DO $$
      DECLARE
        table_is_empty boolean;
      BEGIN
        IF to_regclass('project_database_tiers') IS NOT NULL THEN
          EXECUTE 'SELECT NOT EXISTS (SELECT 1 FROM "project_database_tiers" LIMIT 1)'
            INTO table_is_empty;
          IF table_is_empty THEN
            DROP TABLE "project_database_tiers";
          END IF;
        END IF;
      END
      $$;
    `);
    await queryRunner.query(`
      DO $$
      BEGIN
        BEGIN
          DROP TYPE IF EXISTS "project_database_tiers_status_enum";
        EXCEPTION WHEN dependent_objects_still_exist THEN
          NULL;
        END;
        BEGIN
          DROP TYPE IF EXISTS "project_database_tiers_provider_enum";
        EXCEPTION WHEN dependent_objects_still_exist THEN
          NULL;
        END;
      END
      $$;
    `);
  }
}
