import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The original application used TypeORM synchronize for these core tables
 * before feature migrations were introduced.  A clean database therefore had
 * no durable way to establish the prerequisites assumed by the first feature
 * migrations.  Keep this migration deliberately limited to that historical
 * baseline; all feature schema evolution remains in its existing migration.
 */
export class CreateLegacyCoreBootstrap1759999999000 implements MigrationInterface {
  name = "CreateLegacyCoreBootstrap1759999999000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Existing installations received this schema from synchronize before the
    // migration history began.  Do not alter their application schema; this
    // migration is only a clean-database bootstrap boundary.
    const existing = await queryRunner.query(`SELECT to_regclass('public.projects') AS projects`);
    if (existing[0]?.projects) return;
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "users_role_enum" AS ENUM ('admin', 'developer', 'readonly'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "projects_status_enum" AS ENUM ('created', 'configured', 'archived'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);
    await queryRunner.query(`DO $$ BEGIN CREATE TYPE "projects_visibility_enum" AS ENUM ('private', 'workspace'); EXCEPTION WHEN duplicate_object THEN NULL; END $$`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" SERIAL PRIMARY KEY,
        "github_id" varchar UNIQUE,
        "name" varchar,
        "email" varchar,
        "password_hash" varchar,
        "image" varchar,
        "github_login" varchar,
        "last_login_at" timestamptz,
        "role" "users_role_enum" NOT NULL DEFAULT 'developer',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_users_github_id" ON "users" ("github_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "projects" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "owner_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "name" varchar NOT NULL,
        "description" varchar,
        "repository_url" varchar NOT NULL,
        "repository_provider" varchar NOT NULL DEFAULT 'github',
        "repository_full_name" varchar,
        "target_branch" varchar NOT NULL DEFAULT 'main',
        "status" "projects_status_enum" NOT NULL DEFAULT 'created',
        "visibility" "projects_visibility_enum" NOT NULL DEFAULT 'private',
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        "archived_at" timestamptz
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_projects_owner_user_id" ON "projects" ("owner_user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_projects_repository_full_name" ON "projects" ("repository_full_name")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_environment_variables" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "key" varchar NOT NULL,
        "value" varchar NOT NULL,
        "is_secret" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_project_environment_variables_project_key" UNIQUE ("project_id", "key")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_environment_variables_project_id" ON "project_environment_variables" ("project_id")`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_detection_profiles" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "repository_url" varchar NOT NULL,
        "repository_full_name" varchar,
        "target_branch" varchar NOT NULL,
        "commit_sha" varchar,
        "ecosystem" varchar NOT NULL,
        "language" varchar,
        "framework" varchar,
        "framework_variant" varchar,
        "package_manager" varchar,
        "runtime_version" varchar,
        "build_command" varchar,
        "start_command" varchar,
        "expected_port" integer,
        "health_check_path" varchar,
        "requires_database" boolean NOT NULL DEFAULT false,
        "database_type" varchar,
        "requires_persistent_storage" boolean NOT NULL DEFAULT false,
        "static_output" boolean NOT NULL DEFAULT false,
        "dockerfile_required" boolean NOT NULL DEFAULT false,
        "has_dockerfile" boolean NOT NULL DEFAULT false,
        "selected_template" varchar,
        "confidence" varchar NOT NULL,
        "detection_status" varchar NOT NULL,
        "warnings" jsonb,
        "errors" jsonb,
        "raw_profile" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_project_detection_profiles_project" UNIQUE ("project_id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_preflight_reports" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "detection_profile_id" uuid REFERENCES "project_detection_profiles"("id") ON DELETE SET NULL,
        "template_key" varchar NOT NULL,
        "template_display_name" varchar,
        "ecosystem" varchar NOT NULL,
        "framework" varchar,
        "framework_variant" varchar,
        "package_manager" varchar,
        "runtime_version" varchar,
        "expected_port" integer,
        "build_command" varchar,
        "start_command" varchar,
        "health_check_path" varchar,
        "has_dockerfile" boolean NOT NULL DEFAULT false,
        "dockerfile_required" boolean NOT NULL DEFAULT false,
        "generated_dockerfile" text,
        "report" jsonb NOT NULL,
        "validation_status" varchar NOT NULL,
        "warnings" jsonb,
        "errors" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_project_preflight_reports_project" UNIQUE ("project_id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_logs" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "actor_user_id" integer,
        "actor_email" varchar,
        "actor_role" varchar,
        "action" varchar NOT NULL,
        "resource_type" varchar NOT NULL,
        "resource_id" varchar,
        "status" varchar NOT NULL,
        "ip_address" varchar,
        "user_agent" varchar,
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_actor_user_id" ON "audit_logs" ("actor_user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_action" ON "audit_logs" ("action")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_resource_type" ON "audit_logs" ("resource_type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_status" ON "audit_logs" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // This is an initial-baseline migration.  It must never drop a populated
    // legacy schema during a rollback of later feature migrations.
    const populated = await queryRunner.query(`SELECT EXISTS (SELECT 1 FROM "projects" LIMIT 1) AS populated`);
    if (populated[0]?.populated) throw new Error("Refusing to remove a populated DeployGuard baseline schema");
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_preflight_reports"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_detection_profiles"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_environment_variables"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "projects"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "projects_visibility_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "projects_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_role_enum"`);
  }
}
