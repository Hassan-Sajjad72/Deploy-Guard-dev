import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCentralCloudCleanup1760000022000 implements MigrationInterface {
  name = "CreateCentralCloudCleanup1760000022000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "central_cloud_resources" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "resource_key" varchar(700) NOT NULL,
      "arn" text,
      "resource_name" text NOT NULL,
      "resource_type" varchar NOT NULL,
      "aws_service" varchar NOT NULL,
      "region" varchar NOT NULL,
      "project_id" uuid,
      "source" varchar NOT NULL,
      "status" varchar NOT NULL,
      "cost_risk" varchar NOT NULL,
      "safe_to_cleanup" boolean NOT NULL DEFAULT false,
      "cleanup_supported" boolean NOT NULL DEFAULT false,
      "protected" boolean NOT NULL DEFAULT false,
      "reason" text NOT NULL,
      "metadata" jsonb,
      "first_seen_at" timestamptz NOT NULL,
      "last_seen_at" timestamptz NOT NULL,
      "deleted_at" timestamptz,
      "manual_review_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_central_cloud_resources" PRIMARY KEY ("id"),
      CONSTRAINT "UQ_central_cloud_resources_key" UNIQUE ("resource_key")
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_central_cloud_resources_type" ON "central_cloud_resources" ("resource_type")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_central_cloud_resources_service" ON "central_cloud_resources" ("aws_service")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_central_cloud_resources_region" ON "central_cloud_resources" ("region")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_central_cloud_resources_project" ON "central_cloud_resources" ("project_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_central_cloud_resources_status" ON "central_cloud_resources" ("status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_central_cloud_resources_risk" ON "central_cloud_resources" ("cost_risk")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_central_cloud_resources_last_seen" ON "central_cloud_resources" ("last_seen_at")`);
    await queryRunner.query(`CREATE TABLE IF NOT EXISTS "central_cleanup_challenges" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "user_id" integer NOT NULL,
      "action" varchar NOT NULL,
      "token_hash" varchar NOT NULL,
      "confirmation_phrase" varchar NOT NULL,
      "expires_at" timestamptz NOT NULL,
      "used_at" timestamptz,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT "PK_central_cleanup_challenges" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_central_cleanup_challenges_user" ON "central_cleanup_challenges" ("user_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "central_cleanup_challenges"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "central_cloud_resources"`);
  }
}
