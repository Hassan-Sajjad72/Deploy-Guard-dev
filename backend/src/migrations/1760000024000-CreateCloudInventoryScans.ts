import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCloudInventoryScans1760000024000 implements MigrationInterface {
  name = "CreateCloudInventoryScans1760000024000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "cloud_inventory_scans" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "scope" varchar NOT NULL,
      "project_id" uuid, "region" varchar NOT NULL, "status" varchar NOT NULL,
      "resource_count" integer NOT NULL DEFAULT 0, "services_checked" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "errors" jsonb NOT NULL DEFAULT '[]'::jsonb, "started_at" timestamptz NOT NULL,
      "completed_at" timestamptz NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_cloud_inventory_scans" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cloud_inventory_scans_scope" ON "cloud_inventory_scans" ("scope")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_cloud_inventory_scans_project" ON "cloud_inventory_scans" ("project_id")`);
  }
  async down(queryRunner: QueryRunner): Promise<void> { await queryRunner.query(`DROP TABLE IF EXISTS "cloud_inventory_scans"`); }
}
