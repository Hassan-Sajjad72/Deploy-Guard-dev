import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectObservabilityTables1760000007000 implements MigrationInterface {
  name = "CreateProjectObservabilityTables1760000007000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_stage_metrics" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "deployment_id" uuid,
        "stage_name" character varying NOT NULL,
        "status" character varying NOT NULL DEFAULT 'pending',
        "started_at" TIMESTAMP,
        "ended_at" TIMESTAMP,
        "duration_ms" integer,
        "source" character varying NOT NULL DEFAULT 'pipeline',
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_stage_metrics_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_pipeline_metric_summaries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid NOT NULL,
        "total_duration_ms" integer,
        "github_actions_duration_ms" integer,
        "docker_build_duration_ms" integer,
        "trivy_scan_duration_ms" integer,
        "ecr_push_duration_ms" integer,
        "terraform_plan_duration_ms" integer,
        "terraform_apply_duration_ms" integer,
        "finops_duration_ms" integer,
        "ecs_deployment_duration_ms" integer,
        "alb_health_check_duration_ms" integer,
        "rollback_duration_ms" integer,
        "status" character varying NOT NULL,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_pipeline_metric_summaries_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_runtime_metric_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "deployment_id" uuid,
        "pipeline_run_id" uuid,
        "source" character varying NOT NULL,
        "metric_name" character varying NOT NULL,
        "metric_unit" character varying,
        "value" numeric NOT NULL,
        "timestamp" TIMESTAMP NOT NULL,
        "labels" jsonb,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_runtime_metric_snapshots_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_log_stream_sessions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "deployment_id" uuid,
        "user_id" integer,
        "status" character varying NOT NULL DEFAULT 'started',
        "source" character varying NOT NULL DEFAULT 'cloudwatch_logs',
        "log_group_name" character varying,
        "log_stream_name" character varying,
        "started_at" TIMESTAMP NOT NULL,
        "stopped_at" TIMESTAMP,
        "error_message" text,
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_log_stream_sessions_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_observability_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "deployment_id" uuid,
        "event_type" character varying NOT NULL,
        "status" character varying NOT NULL,
        "message" text NOT NULL,
        "metadata" jsonb,
        "actor_user_id" integer,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_observability_events_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_stage_metrics_project_id" ON "project_stage_metrics" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_stage_metrics_pipeline_run_id" ON "project_stage_metrics" ("pipeline_run_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_stage_metrics_deployment_id" ON "project_stage_metrics" ("deployment_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_stage_metrics_stage_name" ON "project_stage_metrics" ("stage_name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_pipeline_metric_summaries_project_id" ON "project_pipeline_metric_summaries" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_pipeline_metric_summaries_pipeline_run_id" ON "project_pipeline_metric_summaries" ("pipeline_run_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_runtime_metric_snapshots_project_id" ON "project_runtime_metric_snapshots" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_runtime_metric_snapshots_metric_name" ON "project_runtime_metric_snapshots" ("metric_name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_runtime_metric_snapshots_timestamp" ON "project_runtime_metric_snapshots" ("timestamp")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_log_stream_sessions_project_id" ON "project_log_stream_sessions" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_observability_events_project_id" ON "project_observability_events" ("project_id")`);

    await this.addForeignKey(queryRunner, "project_stage_metrics", "FK_stage_metrics_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_stage_metrics", "FK_stage_metrics_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_stage_metrics", "FK_stage_metrics_deployment", "deployment_id", "project_deployments", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_pipeline_metric_summaries", "FK_pipeline_metric_summaries_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_pipeline_metric_summaries", "FK_pipeline_metric_summaries_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_runtime_metric_snapshots", "FK_runtime_metric_snapshots_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_runtime_metric_snapshots", "FK_runtime_metric_snapshots_deployment", "deployment_id", "project_deployments", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_runtime_metric_snapshots", "FK_runtime_metric_snapshots_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_log_stream_sessions", "FK_log_stream_sessions_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_log_stream_sessions", "FK_log_stream_sessions_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_log_stream_sessions", "FK_log_stream_sessions_deployment", "deployment_id", "project_deployments", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_log_stream_sessions", "FK_log_stream_sessions_user", "user_id", "users", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_observability_events", "FK_observability_events_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_observability_events", "FK_observability_events_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_observability_events", "FK_observability_events_deployment", "deployment_id", "project_deployments", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_observability_events", "FK_observability_events_actor", "actor_user_id", "users", "id", "SET NULL");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_observability_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_log_stream_sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_runtime_metric_snapshots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_pipeline_metric_summaries"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_stage_metrics"`);
  }

  private async addForeignKey(
    queryRunner: QueryRunner,
    tableName: string,
    constraintName: string,
    columnName: string,
    referencedTable: string,
    referencedColumn: string,
    onDelete: string
  ) {
    const exists = await queryRunner.query(
      `SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = $1 AND table_name = $2`,
      [constraintName, tableName]
    );

    if (exists.length > 0) {
      return;
    }

    await queryRunner.query(`
      ALTER TABLE "${tableName}"
      ADD CONSTRAINT "${constraintName}"
      FOREIGN KEY ("${columnName}")
      REFERENCES "${referencedTable}"("${referencedColumn}")
      ON DELETE ${onDelete}
    `);
  }
}
