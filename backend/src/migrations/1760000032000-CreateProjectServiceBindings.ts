import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectServiceBindings1760000032000 implements MigrationInterface {
  name = "CreateProjectServiceBindings1760000032000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "project_service_bindings" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "project_id" uuid NOT NULL,
      "pipeline_run_id" uuid NOT NULL,
      "service_type" varchar NOT NULL DEFAULT 'database',
      "provider" varchar NOT NULL,
      "engine" varchar NOT NULL,
      "status" varchar NOT NULL DEFAULT 'pending',
      "database_name" varchar NOT NULL,
      "host_reference" varchar NOT NULL,
      "port" integer NOT NULL,
      "username_reference" varchar,
      "username_secret_reference" varchar,
      "password_secret_reference" varchar,
      "database_url_secret_reference" varchar,
      "cloud_map_namespace" varchar,
      "cloud_map_service_name" varchar,
      "cloud_map_service_arn" varchar,
      "ecs_database_service_arn" varchar,
      "efs_file_system_id" varchar,
      "efs_access_point_id" varchar,
      "terraform_output_revision" varchar,
      "configuration_fingerprint" varchar NOT NULL,
      "sanitized_manifest" jsonb NOT NULL DEFAULT '{}',
      "failure_reason" varchar,
      "ready_at" timestamptz,
      "applied_at" timestamptz,
      "verified_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_project_service_bindings" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_service_bindings_project" ON "project_service_bindings" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_service_bindings_run" ON "project_service_bindings" ("pipeline_run_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_service_bindings_fingerprint" ON "project_service_bindings" ("configuration_fingerprint")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_service_bindings_run_type" ON "project_service_bindings" ("project_id", "pipeline_run_id", "service_type")`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN IF NOT EXISTS "database_service_binding_id" uuid`);
    await queryRunner.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_service_bindings_project') THEN
        ALTER TABLE "project_service_bindings" ADD CONSTRAINT "FK_service_bindings_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_service_bindings_run') THEN
        ALTER TABLE "project_service_bindings" ADD CONSTRAINT "FK_service_bindings_run" FOREIGN KEY ("pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE CASCADE;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='FK_pipeline_runs_database_binding') THEN
        ALTER TABLE "project_pipeline_runs" ADD CONSTRAINT "FK_pipeline_runs_database_binding" FOREIGN KEY ("database_service_binding_id") REFERENCES "project_service_bindings"("id") ON DELETE SET NULL;
      END IF;
    END $$;`);
    await queryRunner.query(`
      INSERT INTO "project_service_bindings" (
        project_id, pipeline_run_id, service_type, provider, engine, status, database_name,
        host_reference, port, username_reference, password_secret_reference,
        database_url_secret_reference, cloud_map_namespace, cloud_map_service_name,
        ecs_database_service_arn, efs_file_system_id, efs_access_point_id,
        terraform_output_revision, configuration_fingerprint, sanitized_manifest,
        ready_at, applied_at
      )
      SELECT tier.project_id, req.applied_pipeline_run_id::uuid, 'database', tier.provider::text,
        COALESCE(tier.engine, 'postgres'), CASE WHEN tier.status::text='ready' THEN 'applied' ELSE 'pending' END,
        COALESCE(tier.database_name, 'app'), COALESCE(tier.internal_host, tier.external_host),
        COALESCE(tier.external_port, CASE WHEN tier.engine='mysql' THEN 3306 ELSE 5432 END),
        tier.database_user, tier.credentials_secret_arn, tier.database_url_secret_arn,
        CASE WHEN tier.provider::text='managed' THEN 'project-' || tier.project_id || '.deployguard.local' ELSE NULL END,
        CASE WHEN tier.provider::text='managed' THEN 'db' ELSE NULL END,
        NULL, tier.efs_file_system_id, tier.efs_access_point_id, tier.updated_at::text,
        md5(concat_ws('|', tier.project_id::text, req.applied_pipeline_run_id::text, tier.provider::text, tier.engine, tier.internal_host, tier.external_host, tier.database_name, tier.database_user, tier.updated_at::text)),
        jsonb_build_object('provider', tier.provider::text, 'engine', tier.engine, 'host', COALESCE(tier.internal_host, tier.external_host), 'port', COALESCE(tier.external_port, CASE WHEN tier.engine='mysql' THEN 3306 ELSE 5432 END), 'databaseName', tier.database_name, 'secretValues', 'not_persisted', 'status', CASE WHEN tier.status::text='ready' THEN 'applied' ELSE 'pending' END),
        CASE WHEN tier.status::text='ready' THEN tier.updated_at ELSE NULL END,
        CASE WHEN tier.status::text='ready' THEN tier.updated_at ELSE NULL END
      FROM project_database_tiers tier
      JOIN project_deployment_requirements req ON req.project_id=tier.project_id
      WHERE req.applied_pipeline_run_id IS NOT NULL
        AND tier.provider IS NOT NULL
        AND COALESCE(tier.internal_host, tier.external_host) IS NOT NULL
      ON CONFLICT (project_id, pipeline_run_id, service_type) DO NOTHING
    `);
    await queryRunner.query(`UPDATE project_pipeline_runs run SET database_service_binding_id=binding.id FROM project_service_bindings binding WHERE binding.pipeline_run_id=run.id AND run.database_service_binding_id IS NULL`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP CONSTRAINT IF EXISTS "FK_pipeline_runs_database_binding"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "database_service_binding_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_service_bindings"`);
  }
}
