import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectCloudStates1760000026000 implements MigrationInterface {
  name = "CreateProjectCloudStates1760000026000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_cloud_states" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "last_cloud_verified_at" timestamptz,
        "cloud_verification_status" varchar NOT NULL DEFAULT 'verification_required',
        "last_verified_deployment_status" varchar NOT NULL DEFAULT 'unknown',
        "last_verified_resource_status" varchar NOT NULL DEFAULT 'inventory_required',
        "last_verified_health_status" varchar NOT NULL DEFAULT 'unknown',
        "last_verified_infrastructure_status" varchar NOT NULL DEFAULT 'unknown',
        "last_verified_cleanup_status" varchar NOT NULL DEFAULT 'not_requested',
        "inventory_status" varchar NOT NULL DEFAULT 'not_scanned',
        "admin_action_required" boolean NOT NULL DEFAULT false,
        "next_action" varchar NOT NULL DEFAULT 'verify_cloud_state',
        "last_verification_reason" text NOT NULL DEFAULT 'Cloud verification has not run.',
        "last_inventory_scan_id" uuid,
        "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_cloud_states" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_project_cloud_states_project" UNIQUE ("project_id"),
        CONSTRAINT "FK_project_cloud_states_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_cloud_states"`);
  }
}
