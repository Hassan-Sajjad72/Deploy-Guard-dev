import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateDeploymentIntentsOutboxAndOperationLeases1760000035000
  implements MigrationInterface
{
  name = "CreateDeploymentIntentsOutboxAndOperationLeases1760000035000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "deployment_intents" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "schema_version" integer NOT NULL DEFAULT 1,
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "requested_by_user_id" integer,
        "kind" varchar(32) NOT NULL,
        "classification" varchar(32),
        "status" varchar(32) NOT NULL DEFAULT 'received',
        "client_idempotency_key" varchar(255) NOT NULL,
        "canonical_idempotency_key" char(64) NOT NULL,
        "request_fingerprint" char(64) NOT NULL,
        "request_payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "decision" jsonb,
        "infrastructure_manifest_id" uuid,
        "release_manifest_id" uuid,
        "source_pipeline_run_id" uuid,
        "pipeline_run_id" uuid,
        "destroy_operation_id" uuid,
        "failure_code" varchar(128),
        "failure_message" text,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        "planned_at" timestamptz,
        "enqueued_at" timestamptz,
        "started_at" timestamptz,
        "completed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_deployment_intents" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "orchestration_outbox" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "intent_id" uuid NOT NULL,
        "aggregate_type" varchar(32) NOT NULL,
        "aggregate_id" uuid NOT NULL,
        "event_type" varchar(64) NOT NULL,
        "worker_envelope" jsonb NOT NULL,
        "payload_sha256" char(64) NOT NULL,
        "status" varchar(24) NOT NULL DEFAULT 'pending',
        "attempt_count" integer NOT NULL DEFAULT 0,
        "available_at" timestamptz NOT NULL DEFAULT now(),
        "claimed_by" varchar,
        "claim_expires_at" timestamptz,
        "published_job_id" varchar,
        "last_error" text,
        "published_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_orchestration_outbox" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_operation_leases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "lane" varchar(24) NOT NULL,
        "scope" varchar(32) NOT NULL,
        "intent_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "destroy_operation_id" uuid,
        "owner_worker_id" varchar NOT NULL,
        "fencing_token" bigint NOT NULL,
        "status" varchar(24) NOT NULL DEFAULT 'acquired',
        "acquired_at" timestamptz NOT NULL DEFAULT now(),
        "heartbeat_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        "released_at" timestamptz,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_operation_leases" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deletion_fence_token" bigint`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deletion_intent_id" uuid`);
    await queryRunner.query(`ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "deletion_started_at" timestamptz`);

    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_deployment_intent_schema_version'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "CHK_deployment_intent_schema_version"
            CHECK ("schema_version" = 1);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_deployment_intent_kind'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "CHK_deployment_intent_kind"
            CHECK ("kind" IN ('deploy','retry','resume','plan','apply','rollback','destroy','cleanup','legacy_import'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_deployment_intent_classification'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "CHK_deployment_intent_classification"
            CHECK (
              "classification" IS NULL OR "classification" IN (
                'release_only','infrastructure_change','no_op','unsafe_or_unknown','deletion'
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_deployment_intent_status'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "CHK_deployment_intent_status"
            CHECK ("status" IN ('received','planned','enqueued','running','completed','failed','cancelled','no_op','rejected'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_deployment_intent_hashes'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "CHK_deployment_intent_hashes"
            CHECK (
              "canonical_idempotency_key" ~ '^[0-9a-f]{64}$'
              AND "request_fingerprint" ~ '^[0-9a-f]{64}$'
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_orchestration_outbox_status'
            AND conrelid = 'orchestration_outbox'::regclass
        ) THEN
          ALTER TABLE "orchestration_outbox"
            ADD CONSTRAINT "CHK_orchestration_outbox_status"
            CHECK ("status" IN ('pending','publishing','published','failed','dead_letter'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_orchestration_outbox_payload_hash'
            AND conrelid = 'orchestration_outbox'::regclass
        ) THEN
          ALTER TABLE "orchestration_outbox"
            ADD CONSTRAINT "CHK_orchestration_outbox_payload_hash"
            CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$');
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_project_operation_lease_lane'
            AND conrelid = 'project_operation_leases'::regclass
        ) THEN
          ALTER TABLE "project_operation_leases"
            ADD CONSTRAINT "CHK_project_operation_lease_lane"
            CHECK ("lane" IN ('release','infrastructure','deletion'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_project_operation_lease_scope'
            AND conrelid = 'project_operation_leases'::regclass
        ) THEN
          ALTER TABLE "project_operation_leases"
            ADD CONSTRAINT "CHK_project_operation_lease_scope"
            CHECK ("scope" IN ('execute','plan','apply','promote','destroy'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_project_operation_lease_status'
            AND conrelid = 'project_operation_leases'::regclass
        ) THEN
          ALTER TABLE "project_operation_leases"
            ADD CONSTRAINT "CHK_project_operation_lease_status"
            CHECK ("status" IN ('acquired','heartbeat_active','released','expired','failed'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_project_operation_lease_fencing_token'
            AND conrelid = 'project_operation_leases'::regclass
        ) THEN
          ALTER TABLE "project_operation_leases"
            ADD CONSTRAINT "CHK_project_operation_lease_fencing_token"
            CHECK ("fencing_token" > 0);
        END IF;
      END
      $migration$;
    `);

    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_deployment_intents_project'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "FK_deployment_intents_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_deployment_intents_user'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "FK_deployment_intents_user"
            FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_deployment_intents_infrastructure_manifest'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "FK_deployment_intents_infrastructure_manifest"
            FOREIGN KEY ("infrastructure_manifest_id") REFERENCES "infrastructure_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_deployment_intents_release_manifest'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "FK_deployment_intents_release_manifest"
            FOREIGN KEY ("release_manifest_id") REFERENCES "release_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_deployment_intents_source_run'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "FK_deployment_intents_source_run"
            FOREIGN KEY ("source_pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_deployment_intents_pipeline_run'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "FK_deployment_intents_pipeline_run"
            FOREIGN KEY ("pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_deployment_intents_destroy_operation'
            AND conrelid = 'deployment_intents'::regclass
        ) THEN
          ALTER TABLE "deployment_intents"
            ADD CONSTRAINT "FK_deployment_intents_destroy_operation"
            FOREIGN KEY ("destroy_operation_id") REFERENCES "infrastructure_destroy_operations"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_infrastructure_manifests_intent'
            AND conrelid = 'infrastructure_manifests'::regclass
        ) THEN
          ALTER TABLE "infrastructure_manifests"
            ADD CONSTRAINT "FK_infrastructure_manifests_intent"
            FOREIGN KEY ("created_by_intent_id") REFERENCES "deployment_intents"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_release_manifests_intent'
            AND conrelid = 'release_manifests'::regclass
        ) THEN
          ALTER TABLE "release_manifests"
            ADD CONSTRAINT "FK_release_manifests_intent"
            FOREIGN KEY ("created_by_intent_id") REFERENCES "deployment_intents"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_orchestration_outbox_intent'
            AND conrelid = 'orchestration_outbox'::regclass
        ) THEN
          ALTER TABLE "orchestration_outbox"
            ADD CONSTRAINT "FK_orchestration_outbox_intent"
            FOREIGN KEY ("intent_id") REFERENCES "deployment_intents"("id") ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_project_operation_leases_project'
            AND conrelid = 'project_operation_leases'::regclass
        ) THEN
          ALTER TABLE "project_operation_leases"
            ADD CONSTRAINT "FK_project_operation_leases_project"
            FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_project_operation_leases_intent'
            AND conrelid = 'project_operation_leases'::regclass
        ) THEN
          ALTER TABLE "project_operation_leases"
            ADD CONSTRAINT "FK_project_operation_leases_intent"
            FOREIGN KEY ("intent_id") REFERENCES "deployment_intents"("id") ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_project_operation_leases_pipeline_run'
            AND conrelid = 'project_operation_leases'::regclass
        ) THEN
          ALTER TABLE "project_operation_leases"
            ADD CONSTRAINT "FK_project_operation_leases_pipeline_run"
            FOREIGN KEY ("pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_project_operation_leases_destroy_operation'
            AND conrelid = 'project_operation_leases'::regclass
        ) THEN
          ALTER TABLE "project_operation_leases"
            ADD CONSTRAINT "FK_project_operation_leases_destroy_operation"
            FOREIGN KEY ("destroy_operation_id") REFERENCES "infrastructure_destroy_operations"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_projects_deletion_intent'
            AND conrelid = 'projects'::regclass
        ) THEN
          ALTER TABLE "projects"
            ADD CONSTRAINT "FK_projects_deletion_intent"
            FOREIGN KEY ("deletion_intent_id") REFERENCES "deployment_intents"("id") ON DELETE SET NULL;
        END IF;
      END
      $migration$;
    `);

    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_deployment_intent_idempotency" ON "deployment_intents" ("project_id", "environment_name", "canonical_idempotency_key")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_deployment_intent_project" ON "deployment_intents" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_deployment_intent_status" ON "deployment_intents" ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_deployment_intent_request_fingerprint" ON "deployment_intents" ("request_fingerprint")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_orchestration_outbox_payload" ON "orchestration_outbox" ("intent_id", "event_type", "payload_sha256")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_orchestration_outbox_intent" ON "orchestration_outbox" ("intent_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_orchestration_outbox_dispatch" ON "orchestration_outbox" ("status", "available_at") WHERE "status" IN ('pending','failed')`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_operation_lease_project" ON "project_operation_leases" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_operation_lease_intent" ON "project_operation_leases" ("intent_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_operation_lease_status" ON "project_operation_leases" ("status")`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_operation_lease_active_scope" ON "project_operation_leases" ("project_id", "environment_name", "lane", "scope") WHERE "status" IN ('acquired','heartbeat_active')`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_operation_lease_fencing_token" ON "project_operation_leases" ("project_id", "environment_name", "fencing_token")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_projects_deletion_intent" ON "projects" ("deletion_intent_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF EXISTS (SELECT 1 FROM "deployment_intents" LIMIT 1)
          OR EXISTS (SELECT 1 FROM "orchestration_outbox" LIMIT 1)
          OR EXISTS (SELECT 1 FROM "project_operation_leases" LIMIT 1) THEN
          RAISE EXCEPTION 'Refusing to roll back intent schema while orchestration rows exist';
        END IF;
        IF EXISTS (
          SELECT 1 FROM "projects"
          WHERE "deletion_fence_token" IS NOT NULL
             OR "deletion_intent_id" IS NOT NULL
             OR "deletion_started_at" IS NOT NULL
          LIMIT 1
        ) THEN
          RAISE EXCEPTION 'Refusing to remove a live project deletion fence';
        END IF;
      END
      $migration$;
    `);
    await queryRunner.query(`ALTER TABLE "infrastructure_manifests" DROP CONSTRAINT IF EXISTS "FK_infrastructure_manifests_intent"`);
    await queryRunner.query(`ALTER TABLE "release_manifests" DROP CONSTRAINT IF EXISTS "FK_release_manifests_intent"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP CONSTRAINT IF EXISTS "FK_projects_deletion_intent"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_projects_deletion_intent"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "deletion_started_at"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "deletion_intent_id"`);
    await queryRunner.query(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "deletion_fence_token"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_operation_leases"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "orchestration_outbox"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "deployment_intents"`);
  }
}
