import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds immutable exact-SHA build topology evidence without changing existing service intent. */
export class CanonicalBuildTargets1787356823000 implements MigrationInterface {
  name = "CanonicalBuildTargets1787356823000";
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_deployable_services" ADD COLUMN IF NOT EXISTS "build_target_override" jsonb`);
    await queryRunner.query(`
      CREATE TABLE "project_build_target_revisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(), "project_id" uuid NOT NULL, "operation_id" uuid NOT NULL,
        "service_id" uuid NOT NULL, "source_sha" varchar(40) NOT NULL, "resolver_version" varchar(80) NOT NULL,
        "fingerprint" varchar(64) NOT NULL, "target" jsonb NOT NULL, "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_build_target_revisions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_build_target_operation_service" UNIQUE ("operation_id", "service_id"),
        CONSTRAINT "CHK_build_target_source_sha" CHECK ("source_sha" ~ '^[0-9a-fA-F]{40}$'),
        CONSTRAINT "CHK_build_target_fingerprint" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "FK_build_target_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_build_target_operation" FOREIGN KEY ("operation_id") REFERENCES "project_pipeline_runs"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_build_target_service" FOREIGN KEY ("service_id") REFERENCES "project_deployable_services"("id") ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_build_target_project" ON "project_build_target_revisions" ("project_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_build_target_service" ON "project_build_target_revisions" ("service_id")`);
    await queryRunner.query(`ALTER TABLE "project_generation_service_revisions" ADD COLUMN IF NOT EXISTS "build_target_revision_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_generation_service_revisions" ADD CONSTRAINT "FK_generation_revision_build_target" FOREIGN KEY ("build_target_revision_id") REFERENCES "project_build_target_revisions"("id") ON DELETE RESTRICT`);
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_generation_service_revisions" DROP CONSTRAINT IF EXISTS "FK_generation_revision_build_target"`);
    await queryRunner.query(`ALTER TABLE "project_generation_service_revisions" DROP COLUMN IF EXISTS "build_target_revision_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_build_target_revisions"`);
    await queryRunner.query(`ALTER TABLE "project_deployable_services" DROP COLUMN IF EXISTS "build_target_override"`);
  }
}
