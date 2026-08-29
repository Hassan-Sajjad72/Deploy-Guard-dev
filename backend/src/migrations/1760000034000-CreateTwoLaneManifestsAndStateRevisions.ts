import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTwoLaneManifestsAndStateRevisions1760000034000
  implements MigrationInterface
{
  name = "CreateTwoLaneManifestsAndStateRevisions1760000034000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "infrastructure_manifests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "schema_version" integer NOT NULL DEFAULT 1,
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "revision" bigint NOT NULL,
        "parent_manifest_id" uuid,
        "created_by_intent_id" uuid,
        "created_by_user_id" integer,
        "origin" varchar(32) NOT NULL,
        "status" varchar(32) NOT NULL DEFAULT 'desired',
        "spec_hash" char(64) NOT NULL,
        "terraform_template_version" varchar(128) NOT NULL,
        "state_backend" varchar(16) NOT NULL,
        "state_key" varchar(512) NOT NULL,
        "state_version_id" varchar(512),
        "desired_spec" jsonb NOT NULL,
        "change_set" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "requires_terraform" boolean NOT NULL DEFAULT true,
        "plan_artifact_reference" jsonb,
        "plan_artifact_sha256" char(64),
        "plan_input_fingerprint" char(64),
        "plan_configuration_fingerprint" char(64),
        "terraform_outputs" jsonb,
        "terraform_outputs_hash" char(64),
        "resource_count" integer,
        "failure_code" varchar(128),
        "failure_message" text,
        "planned_at" timestamptz,
        "approved_at" timestamptz,
        "apply_started_at" timestamptz,
        "applied_at" timestamptz,
        "superseded_at" timestamptz,
        "destroyed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_infrastructure_manifests" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "release_manifests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "schema_version" integer NOT NULL DEFAULT 1,
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "revision" bigint NOT NULL,
        "parent_manifest_id" uuid,
        "previous_stable_manifest_id" uuid,
        "infrastructure_manifest_id" uuid NOT NULL,
        "created_by_intent_id" uuid,
        "pipeline_run_id" uuid,
        "deployment_contract_id" uuid,
        "configuration_snapshot_id" uuid,
        "origin" varchar(32) NOT NULL,
        "status" varchar(32) NOT NULL DEFAULT 'desired',
        "spec_hash" char(64) NOT NULL,
        "repository_full_name" varchar NOT NULL,
        "branch" varchar NOT NULL,
        "commit_sha" varchar NOT NULL,
        "app_root" varchar NOT NULL DEFAULT '.',
        "deployment_contract_hash" char(64) NOT NULL,
        "configuration_fingerprint" char(64) NOT NULL,
        "build_fingerprint" char(64) NOT NULL,
        "runtime_fingerprint" char(64) NOT NULL,
        "image_uri" varchar,
        "image_digest" varchar,
        "task_definition_input_hash" char(64),
        "task_definition_arn" varchar,
        "release_spec" jsonb NOT NULL,
        "health_evidence" jsonb,
        "failure_code" varchar(128),
        "failure_message" text,
        "build_started_at" timestamptz,
        "built_at" timestamptz,
        "deployment_started_at" timestamptz,
        "health_verified_at" timestamptz,
        "promoted_at" timestamptz,
        "superseded_at" timestamptz,
        "rollback_started_at" timestamptz,
        "rolled_back_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_release_manifests" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_state_revisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "revision" bigint NOT NULL DEFAULT 0,
        "invalidated_at" timestamptz NOT NULL DEFAULT now(),
        "reason" varchar(255) NOT NULL,
        "source_type" varchar(64) NOT NULL,
        "source_id" varchar,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_state_revisions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_infrastructure_manifest_schema_version'
            AND conrelid = 'infrastructure_manifests'::regclass
        ) THEN
          ALTER TABLE "infrastructure_manifests"
            ADD CONSTRAINT "CHK_infrastructure_manifest_schema_version"
            CHECK ("schema_version" = 1);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_infrastructure_manifest_spec_hash'
            AND conrelid = 'infrastructure_manifests'::regclass
        ) THEN
          ALTER TABLE "infrastructure_manifests"
            ADD CONSTRAINT "CHK_infrastructure_manifest_spec_hash"
            CHECK ("spec_hash" ~ '^[0-9a-f]{64}$');
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_infrastructure_manifest_origin'
            AND conrelid = 'infrastructure_manifests'::regclass
        ) THEN
          ALTER TABLE "infrastructure_manifests"
            ADD CONSTRAINT "CHK_infrastructure_manifest_origin"
            CHECK ("origin" IN ('planner','legacy_backfill','reconciliation_import'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_infrastructure_manifest_status'
            AND conrelid = 'infrastructure_manifests'::regclass
        ) THEN
          ALTER TABLE "infrastructure_manifests"
            ADD CONSTRAINT "CHK_infrastructure_manifest_status"
            CHECK ("status" IN (
              'desired','planning','planned','approval_required','approved',
              'applying','applied','superseded','failed','destroying','destroyed',
              'imported_unverified','manual_review'
            ));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_infrastructure_manifest_state_backend'
            AND conrelid = 'infrastructure_manifests'::regclass
        ) THEN
          ALTER TABLE "infrastructure_manifests"
            ADD CONSTRAINT "CHK_infrastructure_manifest_state_backend"
            CHECK ("state_backend" IN ('s3','local_mock'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_infrastructure_manifest_terraform_lifecycle'
            AND conrelid = 'infrastructure_manifests'::regclass
        ) THEN
          ALTER TABLE "infrastructure_manifests"
            ADD CONSTRAINT "CHK_infrastructure_manifest_terraform_lifecycle"
            CHECK (
              "requires_terraform" = true
              OR "status" NOT IN ('planning','planned','approval_required','approved','applying')
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_release_manifest_schema_version'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "CHK_release_manifest_schema_version"
            CHECK ("schema_version" = 1);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_release_manifest_spec_hash'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "CHK_release_manifest_spec_hash"
            CHECK ("spec_hash" ~ '^[0-9a-f]{64}$');
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_release_manifest_origin'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "CHK_release_manifest_origin"
            CHECK ("origin" IN ('planner','legacy_backfill','rollback'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_release_manifest_status'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "CHK_release_manifest_status"
            CHECK ("status" IN (
              'desired','blocked_on_infrastructure','building','built','deploying',
              'waiting_for_stability','health_checking','healthy','stable','failed',
              'rollback_started','rolled_back','superseded','cancelled',
              'imported_unverified','manual_review'
            ));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_release_manifest_stable_evidence'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "CHK_release_manifest_stable_evidence"
            CHECK (
              "status" <> 'stable' OR (
                "image_digest" IS NOT NULL
                AND "task_definition_arn" IS NOT NULL
                AND "health_verified_at" IS NOT NULL
                AND "promoted_at" IS NOT NULL
              )
            );
        END IF;
      END
      $migration$;
    `);

    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_infrastructure_manifests_project'
            AND conrelid = 'infrastructure_manifests'::regclass
        ) THEN
          ALTER TABLE "infrastructure_manifests"
            ADD CONSTRAINT "FK_infrastructure_manifests_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_infrastructure_manifests_parent'
            AND conrelid = 'infrastructure_manifests'::regclass
        ) THEN
          ALTER TABLE "infrastructure_manifests"
            ADD CONSTRAINT "FK_infrastructure_manifests_parent"
            FOREIGN KEY ("parent_manifest_id") REFERENCES "infrastructure_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_infrastructure_manifests_user'
            AND conrelid = 'infrastructure_manifests'::regclass
        ) THEN
          ALTER TABLE "infrastructure_manifests"
            ADD CONSTRAINT "FK_infrastructure_manifests_user"
            FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_release_manifests_project'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "FK_release_manifests_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_release_manifests_parent'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "FK_release_manifests_parent"
            FOREIGN KEY ("parent_manifest_id") REFERENCES "release_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_release_manifests_previous_stable'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "FK_release_manifests_previous_stable"
            FOREIGN KEY ("previous_stable_manifest_id") REFERENCES "release_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_release_manifests_infrastructure'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "FK_release_manifests_infrastructure"
            FOREIGN KEY ("infrastructure_manifest_id") REFERENCES "infrastructure_manifests"("id") ON DELETE RESTRICT;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_release_manifests_pipeline_run'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "FK_release_manifests_pipeline_run"
            FOREIGN KEY ("pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_release_manifests_deployment_contract'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "FK_release_manifests_deployment_contract"
            FOREIGN KEY ("deployment_contract_id") REFERENCES "project_deployment_contracts"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_release_manifests_configuration_snapshot'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "FK_release_manifests_configuration_snapshot"
            FOREIGN KEY ("configuration_snapshot_id") REFERENCES "project_configuration_snapshots"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_project_state_revisions_project'
            AND conrelid = 'project_state_revisions'::regclass
        ) THEN
          ALTER TABLE "project_state_revisions"
            ADD CONSTRAINT "FK_project_state_revisions_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
      END
      $migration$;
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_infrastructure_manifest_revision" ON "infrastructure_manifests" ("project_id", "environment_name", "revision")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_infrastructure_manifest_project" ON "infrastructure_manifests" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_infrastructure_manifest_status" ON "infrastructure_manifests" ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_infrastructure_manifest_spec_hash" ON "infrastructure_manifests" ("spec_hash")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_infrastructure_manifest_scope_status_created" ON "infrastructure_manifests" ("project_id", "environment_name", "status", "created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_infrastructure_manifest_plan_fingerprints" ON "infrastructure_manifests" ("plan_input_fingerprint", "plan_configuration_fingerprint")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_infrastructure_manifest_current_applied" ON "infrastructure_manifests" ("project_id", "environment_name") WHERE "status" = 'applied'`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_release_manifest_revision" ON "release_manifests" ("project_id", "environment_name", "revision")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_manifest_project" ON "release_manifests" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_manifest_status" ON "release_manifests" ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_manifest_infrastructure" ON "release_manifests" ("infrastructure_manifest_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_manifest_spec_hash" ON "release_manifests" ("spec_hash")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_manifest_scope_status_created" ON "release_manifests" ("project_id", "environment_name", "status", "created_at" DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_release_manifest_fingerprints" ON "release_manifests" ("build_fingerprint", "runtime_fingerprint", "configuration_fingerprint")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_release_manifest_current_stable" ON "release_manifests" ("project_id", "environment_name") WHERE "status" = 'stable'`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_state_revision_scope" ON "project_state_revisions" ("project_id", "environment_name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_state_revision_project" ON "project_state_revisions" ("project_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (SELECT 1 FROM "release_manifests" LIMIT 1)
          OR EXISTS (SELECT 1 FROM "infrastructure_manifests" LIMIT 1)
          OR EXISTS (SELECT 1 FROM "project_state_revisions" LIMIT 1) THEN
          RAISE EXCEPTION 'Refusing to roll back two-lane manifest schema while contract rows exist';
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "release_manifests"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_state_revisions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "infrastructure_manifests"`);
  }
}
