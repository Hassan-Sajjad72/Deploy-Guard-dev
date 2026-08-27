import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Repairs installations whose TypeORM history recorded the legacy pipeline
 * migrations although the pipeline tables were later removed from `public`.
 * Every statement is additive: existing rows and tables are retained.
 */
export class RepairProjectPipelineSchemaDrift1787356802000 implements MigrationInterface {
  name = "RepairProjectPipelineSchemaDrift1787356802000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE TYPE "public"."project_pipeline_runs_status_enum" AS ENUM (
          'queued', 'running',
          'cost_analysis_running', 'waiting_for_cost_approval', 'blocked_by_cost_limit', 'cost_rejected', 'cost_analysis_failed',
          'state_lock_acquiring', 'waiting_for_state_lock', 'state_lock_acquired', 'state_heartbeat_active', 'state_validation_running', 'state_recovery_required', 'state_lock_released', 'state_lock_failed',
          'storage_evaluation_running', 'storage_not_required', 'storage_provisioning', 'storage_provisioned', 'storage_failed', 'backup_configuring', 'backup_configured', 'backup_failed',
          'ecs_deployment_queued', 'ecs_task_definition_registering', 'ecs_service_updating', 'ecs_waiting_for_stability', 'ecs_service_healthy', 'ecs_service_unhealthy', 'ecs_deployment_failed',
          'rollback_started', 'rollback_succeeded', 'rollback_failed', 'spot_interruption_handled', 'apply_disabled',
          'completed', 'failed', 'cancelled', 'waiting_for_security_review', 'security_rejected'
        );
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    for (const status of [
      "cost_analysis_running", "waiting_for_cost_approval", "blocked_by_cost_limit", "cost_rejected", "cost_analysis_failed",
      "state_lock_acquiring", "waiting_for_state_lock", "state_lock_acquired", "state_heartbeat_active", "state_validation_running", "state_recovery_required", "state_lock_released", "state_lock_failed",
      "storage_evaluation_running", "storage_not_required", "storage_provisioning", "storage_provisioned", "storage_failed", "backup_configuring", "backup_configured", "backup_failed",
      "ecs_deployment_queued", "ecs_task_definition_registering", "ecs_service_updating", "ecs_waiting_for_stability", "ecs_service_healthy", "ecs_service_unhealthy", "ecs_deployment_failed",
      "rollback_started", "rollback_succeeded", "rollback_failed", "spot_interruption_handled", "apply_disabled", "waiting_for_security_review", "security_rejected",
    ]) {
      await queryRunner.query(`ALTER TYPE "public"."project_pipeline_runs_status_enum" ADD VALUE IF NOT EXISTS '${status}'`);
    }

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "public"."project_pipeline_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "generation_id" uuid,
        "triggered_by_user_id" integer NOT NULL,
        "preflight_report_id" uuid,
        "detection_profile_id" uuid,
        "repository_url" varchar NOT NULL,
        "repository_full_name" varchar,
        "target_branch" varchar NOT NULL,
        "commit_sha" varchar,
        "image_name" varchar,
        "image_tag" varchar,
        "ecr_repository_name" varchar,
        "ecr_image_uri" varchar,
        "database_service_binding_id" uuid,
        "configuration_snapshot_id" uuid,
        "deployment_intent_id" uuid,
        "execution_lane" varchar(24),
        "infrastructure_manifest_id" uuid,
        "release_manifest_id" uuid,
        "worker_protocol_version" integer,
        "operation_fencing_token" bigint,
        "cross_lane_ownership_id" uuid,
        "cross_lane_owner_lane" varchar(16),
        "cross_lane_owner_environment_name" varchar(64),
        "cross_lane_owner_lease_id" uuid,
        "cross_lane_owner_actor_id" varchar(160),
        "cross_lane_owner_fencing_token" bigint,
        "github_workflow_run_id" varchar,
        "github_workflow_status" varchar,
        "status" "public"."project_pipeline_runs_status_enum" NOT NULL DEFAULT 'queued',
        "current_stage" varchar,
        "started_at" timestamptz,
        "current_stage_started_at" timestamptz,
        "completed_at" timestamptz,
        "failed_at" timestamptz,
        "error_message" text,
        "metadata" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_pipeline_runs_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "public"."project_pipeline_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "pipeline_run_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "stage" varchar NOT NULL,
        "status" varchar NOT NULL,
        "message" text NOT NULL,
        "metadata" jsonb,
        "occurred_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "ingested_at" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "duration_ms" bigint,
        "source" varchar NOT NULL DEFAULT 'pipeline_worker',
        "sequence_number" integer NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_pipeline_events_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "generation_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "database_service_binding_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "configuration_snapshot_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "deployment_intent_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "execution_lane" varchar(24)`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "infrastructure_manifest_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "release_manifest_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "worker_protocol_version" integer`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "operation_fencing_token" bigint`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "cross_lane_ownership_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "cross_lane_owner_lane" varchar(16)`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "cross_lane_owner_environment_name" varchar(64)`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "cross_lane_owner_lease_id" uuid`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "cross_lane_owner_actor_id" varchar(160)`);
    await queryRunner.query(`ALTER TABLE "public"."project_pipeline_runs" ADD COLUMN IF NOT EXISTS "cross_lane_owner_fencing_token" bigint`);

    for (const [name, definition] of [
      ["IDX_project_pipeline_runs_project_id", `("project_id")`],
      ["IDX_project_pipeline_runs_triggered_by_user_id", `("triggered_by_user_id")`],
      ["IDX_pipeline_runs_generation", `("generation_id")`],
      ["IDX_pipeline_runs_deployment_intent", `("deployment_intent_id")`],
      ["IDX_pipeline_runs_execution_lane", `("execution_lane")`],
      ["IDX_pipeline_runs_infrastructure_manifest", `("infrastructure_manifest_id")`],
      ["IDX_pipeline_runs_release_manifest", `("release_manifest_id")`],
      ["IDX_pipeline_runs_cross_lane_ownership", `("cross_lane_ownership_id") WHERE "cross_lane_ownership_id" IS NOT NULL`],
      ["IDX_project_pipeline_events_pipeline_run_id", `("pipeline_run_id")`],
      ["IDX_project_pipeline_events_project_id", `("project_id")`],
    ]) {
      const table = name.includes("events") ? "project_pipeline_events" : "project_pipeline_runs";
      await queryRunner.query(`CREATE INDEX IF NOT EXISTS "${name}" ON "public"."${table}" ${definition}`);
    }

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_project_pipeline_runs_execution_lane' AND conrelid = 'public.project_pipeline_runs'::regclass) THEN
          ALTER TABLE "public"."project_pipeline_runs" ADD CONSTRAINT "CHK_project_pipeline_runs_execution_lane" CHECK ("execution_lane" IS NULL OR "execution_lane" IN ('release','infrastructure','deletion'));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_project_pipeline_runs_worker_protocol' AND conrelid = 'public.project_pipeline_runs'::regclass) THEN
          ALTER TABLE "public"."project_pipeline_runs" ADD CONSTRAINT "CHK_project_pipeline_runs_worker_protocol" CHECK ("worker_protocol_version" IS NULL OR "worker_protocol_version" > 0);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CHK_project_pipeline_runs_fencing_token' AND conrelid = 'public.project_pipeline_runs'::regclass) THEN
          ALTER TABLE "public"."project_pipeline_runs" ADD CONSTRAINT "CHK_project_pipeline_runs_fencing_token" CHECK ("operation_fencing_token" IS NULL OR "operation_fencing_token" > 0);
        END IF;
      END $$;
    `);
    await this.addForeignKey(queryRunner, "project_pipeline_runs", "FK_project_pipeline_runs_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_pipeline_runs", "FK_project_pipeline_runs_triggered_by_user", "triggered_by_user_id", "users", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_pipeline_runs", "FK_project_pipeline_runs_preflight", "preflight_report_id", "project_preflight_reports", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_pipeline_runs", "FK_project_pipeline_runs_detection", "detection_profile_id", "project_detection_profiles", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_pipeline_runs", "FK_pipeline_runs_database_binding", "database_service_binding_id", "project_service_bindings", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_pipeline_runs", "FK_pipeline_runs_configuration_snapshot", "configuration_snapshot_id", "project_configuration_snapshots", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_pipeline_events", "FK_project_pipeline_events_run", "pipeline_run_id", "project_pipeline_runs", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_pipeline_events", "FK_project_pipeline_events_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_configuration_snapshots", "FK_configuration_snapshots_run", "pipeline_run_id", "project_pipeline_runs", "id", "CASCADE");
  }

  async down(): Promise<void> {
    // This is a data-preserving repair migration and is intentionally irreversible.
  }

  private async addForeignKey(
    queryRunner: QueryRunner,
    table: string,
    name: string,
    column: string,
    referencedTable: string,
    referencedColumn: string,
    onDelete: string,
  ) {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.${table}') IS NOT NULL
          AND to_regclass('public.${referencedTable}') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = '${column}'
          )
          AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = '${referencedTable}' AND column_name = '${referencedColumn}'
          )
          AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}' AND conrelid = 'public.${table}'::regclass) THEN
          ALTER TABLE "public"."${table}" ADD CONSTRAINT "${name}"
            FOREIGN KEY ("${column}") REFERENCES "public"."${referencedTable}"("${referencedColumn}") ON DELETE ${onDelete};
        END IF;
      END $$;
    `);
  }
}
