import { MigrationInterface, QueryRunner } from "typeorm";

export class AddCleanupOperationsAndTtl1760000025000 implements MigrationInterface {
  name = "AddCleanupOperationsAndTtl1760000025000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" ADD COLUMN IF NOT EXISTS "environment_type" varchar NOT NULL DEFAULT 'production'`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" ADD COLUMN IF NOT EXISTS "ttl_expires_at" timestamptz`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" ADD COLUMN IF NOT EXISTS "auto_destroy_enabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" ADD COLUMN IF NOT EXISTS "cleanup_status" varchar NOT NULL DEFAULT 'not_scheduled'`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_infrastructure_environment_type" ON "project_infrastructure_environments" ("environment_type")`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "source" varchar NOT NULL DEFAULT 'manual'`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "emergency_operation_id" uuid`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_infrastructure_destroy_emergency" ON "infrastructure_destroy_operations" ("emergency_operation_id")`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "emergency_cleanup_operations" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" integer NOT NULL, "status" varchar NOT NULL DEFAULT 'queued',
      "queue_job_id" varchar, "target_count" integer NOT NULL DEFAULT 0, "completed_count" integer NOT NULL DEFAULT 0,
      "failed_count" integer NOT NULL DEFAULT 0, "targets" jsonb NOT NULL DEFAULT '[]'::jsonb, "error_message" text,
      "started_at" timestamptz, "completed_at" timestamptz, "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "PK_emergency_cleanup_operations" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_emergency_cleanup_operations_user" ON "emergency_cleanup_operations" ("user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_emergency_cleanup_operations_status" ON "emergency_cleanup_operations" ("status")`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "cloud_cleanup_operations" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" integer NOT NULL, "mode" varchar NOT NULL,
      "status" varchar NOT NULL DEFAULT 'running', "resource_ids" jsonb NOT NULL DEFAULT '[]'::jsonb, "results" jsonb,
      "error_message" text, "completed_at" timestamptz, "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(), CONSTRAINT "PK_cloud_cleanup_operations" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cloud_cleanup_operations_user" ON "cloud_cleanup_operations" ("user_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cloud_cleanup_operations_status" ON "cloud_cleanup_operations" ("status")`);
    await queryRunner.query(`UPDATE "central_cloud_resources" SET "resource_type" = CASE WHEN "arn" LIKE '%:servicediscovery:%:namespace/%' THEN 'cloud_map_namespace' WHEN "arn" LIKE '%:servicediscovery:%:service/%' THEN 'cloud_map_service' ELSE "resource_type" END WHERE "resource_type" = 'other'`);
    // central_cloud_resources.project_id is UUID.  The original migration
    // compared it to a text cast, which only surfaced on an empty bootstrap
    // because PostgreSQL type-checks UPDATE predicates even when no rows exist.
    await queryRunner.query(`UPDATE "central_cloud_resources" r SET "source"='terraform', "cleanup_eligibility"='terraform_destroy', "safe_to_cleanup"=false, "cleanup_supported"=false, "status"=CASE WHEN e."status" IN ('destroyed','destroy_needs_cleanup','destroy_failed') THEN 'cleanup_required' ELSE 'active' END, "reason"='Terraform-managed resource. Run project-scoped Terraform destroy. Direct deletion is disabled to avoid dependency issues.' FROM "project_infrastructure_environments" e WHERE r."project_id"=e."project_id" AND r."protected"=false AND r."resource_type" IN ('vpc','subnet','route_table','internet_gateway','nat_gateway','elastic_ip','security_group','load_balancer','listener','target_group','ecs_cluster','ecs_service','ecs_task_definition','cloud_map_namespace','cloud_map_service','event_rule','efs','efs_access_point','efs_mount_target','iam_role','iam_policy') AND (COALESCE(e."terraform_outputs", '{}'::jsonb)::text LIKE '%' || r."resource_name" || '%' OR COALESCE(e."terraform_outputs", '{}'::jsonb)::text LIKE '%' || COALESCE(r."arn", 'never-match') || '%' OR COALESCE(e."vpc_id", '')=r."resource_name" OR COALESCE(e."internet_gateway_id", '')=r."resource_name" OR COALESCE(e."alb_security_group_id", '')=r."resource_name" OR COALESCE(e."app_security_group_id", '')=r."resource_name" OR COALESCE(e."internal_security_group_id", '')=r."resource_name" OR COALESCE(e."public_subnet_ids", '[]'::jsonb)::text LIKE '%' || r."resource_name" || '%' OR COALESCE(e."private_subnet_ids", '[]'::jsonb)::text LIKE '%' || r."resource_name" || '%' OR COALESCE(e."nat_gateway_ids", '[]'::jsonb)::text LIKE '%' || r."resource_name" || '%' OR COALESCE(e."route_table_ids", '{}'::jsonb)::text LIKE '%' || r."resource_name" || '%')`);
    await queryRunner.query(`UPDATE "central_cloud_resources" r SET "source"='terraform', "cleanup_eligibility"='terraform_destroy', "safe_to_cleanup"=false, "cleanup_supported"=false, "status"=CASE WHEN e."status" IN ('destroyed','destroy_needs_cleanup','destroy_failed') THEN 'cleanup_required' ELSE 'active' END, "reason"='Terraform-managed resource. Run project-scoped Terraform destroy. Direct deletion is disabled to avoid dependency issues.' FROM "project_infrastructure_environments" e WHERE r."project_id"=e."project_id" AND r."protected"=false AND r."source"='discovered_tag' AND r."resource_type" IN ('vpc','subnet','route_table','internet_gateway','nat_gateway','elastic_ip','security_group','load_balancer','listener','target_group','ecs_cluster','ecs_service','ecs_task_definition','cloud_map_namespace','cloud_map_service','event_rule','efs','efs_access_point','efs_mount_target','iam_role','iam_policy') AND r."tags"->>'ManagedBy'='DeployGuard' AND COALESCE(r."tags"->>'ProjectId',r."tags"->>'DeployGuardProjectId')=r."project_id"::text AND (e."terraform_state_key" IS NOT NULL OR e."terraform_outputs" IS NOT NULL)`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "cloud_cleanup_operations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "emergency_cleanup_operations"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_infrastructure_destroy_emergency"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "emergency_operation_id"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "source"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_project_infrastructure_environment_type"`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" DROP COLUMN IF EXISTS "cleanup_status"`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" DROP COLUMN IF EXISTS "auto_destroy_enabled"`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" DROP COLUMN IF EXISTS "ttl_expires_at"`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" DROP COLUMN IF EXISTS "environment_type"`);
  }
}
