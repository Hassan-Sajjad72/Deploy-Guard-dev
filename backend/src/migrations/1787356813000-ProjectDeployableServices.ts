import { MigrationInterface, QueryRunner } from "typeorm";

/** Establishes service identity as the only executable application scope. */
export class ProjectDeployableServices1787356813000 implements MigrationInterface {
  name = "ProjectDeployableServices1787356813000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "project_deployable_services" (
        "id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "name" varchar(80) NOT NULL,
        "service_directory" varchar(512) NOT NULL DEFAULT '.',
        "position" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_deployable_services" PRIMARY KEY ("id"),
        CONSTRAINT "FK_project_deployable_services_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
        CONSTRAINT "UQ_project_deployable_service_name" UNIQUE ("project_id", "name"),
        CONSTRAINT "UQ_project_deployable_service_position" UNIQUE ("project_id", "position"),
        CONSTRAINT "CHK_project_deployable_service_directory" CHECK ("service_directory" = '.' OR ("service_directory" !~ '^/' AND "service_directory" !~ '(^|/)\\.\\.(/|$)'))
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_project_deployable_services_project_id" ON "project_deployable_services" ("project_id")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "UQ_project_deployable_service_name_ci" ON "project_deployable_services" ("project_id", lower("name"))`);
    await queryRunner.query(`
      INSERT INTO "project_deployable_services" ("id", "project_id", "name", "service_directory", "position")
      SELECT (
        substr(md5("id"::text || ':deployguard-default-service'), 1, 8) || '-' ||
        substr(md5("id"::text || ':deployguard-default-service'), 9, 4) || '-4' ||
        substr(md5("id"::text || ':deployguard-default-service'), 14, 3) || '-8' ||
        substr(md5("id"::text || ':deployguard-default-service'), 18, 3) || '-' ||
        substr(md5("id"::text || ':deployguard-default-service'), 21, 12)
      )::uuid,
      "id", 'Web',
      CASE
        WHEN nullif(trim(both '/' from regexp_replace(replace(coalesce("app_directory", ''), chr(92), '/'), '/+', '/', 'g')), '') IS NULL THEN '.'
        WHEN trim(both '/' from regexp_replace(replace("app_directory", chr(92), '/'), '/+', '/', 'g')) ~ '(^|/)\\.\\.(/|$)' THEN '.'
        ELSE regexp_replace(trim(both '/' from regexp_replace(replace("app_directory", chr(92), '/'), '/+', '/', 'g')), '^\\./', '')
      END,
      0
      FROM "projects"
    `);

    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD COLUMN "service_id" uuid`);
    await queryRunner.query(`
      UPDATE "project_environment_variables" variable
      SET "service_id" = service."id"
      FROM "project_deployable_services" service
      WHERE service."project_id" = variable."project_id" AND service."position" = 0
    `);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ALTER COLUMN "service_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD CONSTRAINT "FK_project_environment_variables_service" FOREIGN KEY ("service_id") REFERENCES "project_deployable_services"("id") ON DELETE CASCADE`);
    await queryRunner.query(`CREATE INDEX "IDX_project_environment_variables_service_id" ON "project_environment_variables" ("service_id")`);
    await queryRunner.query(`
      DO $$ DECLARE item record;
      BEGIN
        FOR item IN
          SELECT conname FROM pg_constraint
          WHERE conrelid = 'project_environment_variables'::regclass
            AND contype = 'u'
            AND pg_get_constraintdef(oid) IN ('UNIQUE (project_id, key)', 'UNIQUE (project_id, normalized_key)')
        LOOP EXECUTE format('ALTER TABLE project_environment_variables DROP CONSTRAINT %I', item.conname); END LOOP;
      END $$
    `);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD CONSTRAINT "UQ_project_environment_service_key" UNIQUE ("project_id", "service_id", "normalized_key")`);

    await queryRunner.query(`ALTER TABLE "project_database_tiers" ADD COLUMN "attached_service_id" uuid`);
    await queryRunner.query(`
      UPDATE "project_database_tiers" tier SET "attached_service_id" = service."id"
      FROM "project_deployable_services" service
      WHERE service."project_id" = tier."project_id" AND service."position" = 0
        AND tier."provider" = 'managed'
    `);
    await queryRunner.query(`ALTER TABLE "project_database_tiers" ADD CONSTRAINT "FK_project_database_tiers_attached_service" FOREIGN KEY ("attached_service_id") REFERENCES "project_deployable_services"("id") ON DELETE RESTRICT`);
    await queryRunner.query(`CREATE INDEX "IDX_project_database_tiers_attached_service_id" ON "project_database_tiers" ("attached_service_id")`);

    await queryRunner.query(`
      UPDATE "project_stable_releases" release
      SET "metadata" = coalesce(release."metadata", '{}'::jsonb) || jsonb_build_object('services', jsonb_build_array(jsonb_build_object(
        'serviceId', service."id", 'serviceName', service."name", 'serviceDirectory', service."service_directory",
        'imageUri', release."image_uri", 'imageDigest', coalesce(release."metadata"->>'imageDigest', ''),
        'taskDefinitionArn', release."task_definition_arn", 'ecsServiceArn', release."ecs_service_arn",
        'publicUrl', release."metadata"->>'deployedUrl'
      )))
      FROM "project_deployable_services" service
      WHERE service."project_id" = release."project_id" AND service."position" = 0
        AND NOT (coalesce(release."metadata", '{}'::jsonb) ? 'services')
    `);
    await queryRunner.query(`
      UPDATE "project_deployment_generations" generation
      SET "resource_manifest" = coalesce(generation."resource_manifest", '{}'::jsonb) || jsonb_build_object('services', jsonb_build_array(jsonb_build_object(
        'serviceId', service."id", 'serviceName', service."name", 'serviceDirectory', service."service_directory",
        'imageUri', generation."resource_manifest"->>'imageUri', 'imageDigest', generation."resource_manifest"->>'imageDigest',
        'taskDefinitionArn', generation."resource_manifest"->>'taskDefinitionArn', 'ecsServiceArn', generation."resource_manifest"->>'ecsServiceArn',
        'publicUrl', generation."resource_manifest"->>'publicUrl'
      )))
      FROM "project_deployable_services" service
      WHERE service."project_id" = generation."project_id" AND service."position" = 0
        AND NOT (coalesce(generation."resource_manifest", '{}'::jsonb) ? 'services')
    `);

    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "app_directory"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "deployment_overrides"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN "failure_owner" varchar(40)`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN "external_provider" varchar(24)`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN "failure_code" varchar(80)`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN "failure_service_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD CONSTRAINT "CHK_project_pipeline_failure_owner" CHECK ("failure_owner" IS NULL OR "failure_owner" IN ('REPOSITORY_APPLICATION','DEPLOYGUARD_PLATFORM','EXTERNAL_PROVIDER','UNVERIFIED'))`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD CONSTRAINT "CHK_project_pipeline_external_provider" CHECK ("external_provider" IS NULL OR "external_provider" IN ('aws','github','railpack','network','other'))`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "failure_service_id"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "failure_code"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "external_provider"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "failure_owner"`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "app_directory" varchar`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deployment_overrides" jsonb NOT NULL DEFAULT '{}'::jsonb`);
    await queryRunner.query(`UPDATE "projects" project SET "app_directory" = NULLIF(service."service_directory", '.') FROM "project_deployable_services" service WHERE service."project_id" = project."id" AND service."position" = 0`);
    await queryRunner.query(`ALTER TABLE "project_database_tiers" DROP CONSTRAINT IF EXISTS "FK_project_database_tiers_attached_service"`);
    await queryRunner.query(`ALTER TABLE "project_database_tiers" DROP COLUMN IF EXISTS "attached_service_id"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP CONSTRAINT IF EXISTS "UQ_project_environment_service_key"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP CONSTRAINT IF EXISTS "FK_project_environment_variables_service"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" DROP COLUMN IF EXISTS "service_id"`);
    await queryRunner.query(`ALTER TABLE "project_environment_variables" ADD CONSTRAINT "UQ_project_environment_variables_project_key" UNIQUE ("project_id", "key")`);
    await queryRunner.query(`DROP TABLE "project_deployable_services"`);
  }
}
