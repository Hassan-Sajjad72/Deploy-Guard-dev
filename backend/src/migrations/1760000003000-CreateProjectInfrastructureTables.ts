import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectInfrastructureTables1760000003000
  implements MigrationInterface
{
  name = "CreateProjectInfrastructureTables1760000003000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_infrastructure_environments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "environment_name" character varying NOT NULL DEFAULT 'dev',
        "status" character varying NOT NULL DEFAULT 'not_provisioned',
        "aws_region" character varying,
        "vpc_id" character varying,
        "public_subnet_ids" jsonb,
        "private_subnet_ids" jsonb,
        "internet_gateway_id" character varying,
        "nat_gateway_ids" jsonb,
        "route_table_ids" jsonb,
        "alb_security_group_id" character varying,
        "app_security_group_id" character varying,
        "internal_security_group_id" character varying,
        "cloud_map_namespace_id" character varying,
        "cloud_map_namespace_name" character varying,
        "cloud_map_service_discovery_domain" character varying,
        "terraform_workspace_path" character varying,
        "terraform_state_key" character varying,
        "terraform_plan_summary" jsonb,
        "terraform_outputs" jsonb,
        "readiness_snapshot" jsonb,
        "metadata" jsonb,
        "error_message" text,
        "provisioned_at" TIMESTAMP,
        "failed_at" TIMESTAMP,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_infrastructure_environments_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_infrastructure_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "infrastructure_environment_id" uuid,
        "event_type" character varying NOT NULL,
        "status" character varying NOT NULL,
        "message" text NOT NULL,
        "metadata" jsonb,
        "actor_user_id" integer,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_infrastructure_events_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_service_discovery_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "infrastructure_environment_id" uuid NOT NULL,
        "service_name" character varying NOT NULL,
        "namespace_id" character varying NOT NULL,
        "namespace_name" character varying NOT NULL,
        "dns_name" character varying NOT NULL,
        "cloud_map_service_id" character varying,
        "status" character varying NOT NULL DEFAULT 'ready',
        "metadata" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_service_discovery_records_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_deployment_readiness_snapshots" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "ready" boolean NOT NULL,
        "checks" jsonb NOT NULL,
        "blocking_reasons" jsonb NOT NULL,
        "created_by_user_id" integer,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_deployment_readiness_snapshots_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_infra_env_project_id" ON "project_infrastructure_environments" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_infra_env_pipeline_run_id" ON "project_infrastructure_environments" ("pipeline_run_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_infra_events_project_id" ON "project_infrastructure_events" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_service_discovery_project_id" ON "project_service_discovery_records" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_readiness_snapshots_project_id" ON "project_deployment_readiness_snapshots" ("project_id")`);
    await this.addForeignKey(queryRunner, "project_infrastructure_environments", "FK_project_infra_env_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_infrastructure_environments", "FK_project_infra_env_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_infrastructure_events", "FK_project_infra_events_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_infrastructure_events", "FK_project_infra_events_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_infrastructure_events", "FK_project_infra_events_environment", "infrastructure_environment_id", "project_infrastructure_environments", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_infrastructure_events", "FK_project_infra_events_actor", "actor_user_id", "users", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_service_discovery_records", "FK_project_service_discovery_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_service_discovery_records", "FK_project_service_discovery_environment", "infrastructure_environment_id", "project_infrastructure_environments", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_deployment_readiness_snapshots", "FK_project_readiness_snapshots_project", "project_id", "projects", "id", "CASCADE");
    await this.addForeignKey(queryRunner, "project_deployment_readiness_snapshots", "FK_project_readiness_snapshots_pipeline_run", "pipeline_run_id", "project_pipeline_runs", "id", "SET NULL");
    await this.addForeignKey(queryRunner, "project_deployment_readiness_snapshots", "FK_project_readiness_snapshots_created_by", "created_by_user_id", "users", "id", "SET NULL");
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_deployment_readiness_snapshots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_service_discovery_records"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_infrastructure_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_infrastructure_environments"`);
  }

  private async addForeignKey(
    queryRunner: QueryRunner,
    tableName: string,
    constraintName: string,
    columnName: string,
    referencedTableName: string,
    referencedColumnName: string,
    onDelete: string
  ) {
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.${referencedTableName}') IS NOT NULL THEN
          ALTER TABLE "${tableName}"
          ADD CONSTRAINT "${constraintName}"
          FOREIGN KEY ("${columnName}") REFERENCES "${referencedTableName}"("${referencedColumnName}") ON DELETE ${onDelete};
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
  }
}
