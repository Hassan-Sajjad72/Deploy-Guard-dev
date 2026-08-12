import { MigrationInterface, QueryRunner } from "typeorm";

export class PersistentDestroyLifecycle1760000071000 implements MigrationInterface {
  name = "PersistentDestroyLifecycle1760000071000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_destroy_lifecycles" (
        "id" uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
        "generation_id" uuid NOT NULL REFERENCES "project_deployment_generations"("id") ON DELETE CASCADE,
        "operation_id" uuid NOT NULL,
        "environment_name" varchar(64) NOT NULL,
        "status" varchar(32) NOT NULL DEFAULT 'DELETING',
        "phase" varchar(40) NOT NULL DEFAULT 'AWS_CLEANUP',
        "resource_manifest" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "remaining" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "terraform_evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "verification_evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "lease_owner" varchar(160),
        "lease_expires_at" timestamptz,
        "heartbeat_at" timestamptz,
        "retry_count" integer NOT NULL DEFAULT 0,
        "next_retry_at" timestamptz,
        "first_started_at" timestamptz NOT NULL DEFAULT now(),
        "last_attempt_at" timestamptz NOT NULL DEFAULT now(),
        "escalation" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "CHK_project_destroy_lifecycle_status" CHECK ("status" IN ('DELETING','DESTROYING','DESTROY_VERIFYING','DESTROY_INCOMPLETE','DESTROYED','EXTINCT')),
        CONSTRAINT "CHK_project_destroy_lifecycle_phase" CHECK ("phase" IN ('AWS_CLEANUP','AWS_VERIFIED','TERRAFORM_STATE_CLEANUP','EXTERNAL_METADATA_CLEANUP','DATABASE_EXTINCTION','FINAL_404_VERIFY','EXTINCT')),
        CONSTRAINT "CHK_project_destroy_lifecycle_retry_count" CHECK ("retry_count" >= 0),
        CONSTRAINT "CHK_project_destroy_lifecycle_remaining" CHECK (jsonb_typeof("remaining") = 'array')
      )
    `);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "UQ_project_destroy_lifecycle_scope" ON "project_destroy_lifecycles" ("project_id", "environment_name")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_destroy_lifecycle_generation" ON "project_destroy_lifecycles" ("generation_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_destroy_lifecycle_operation" ON "project_destroy_lifecycles" ("operation_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_destroy_lifecycle_due" ON "project_destroy_lifecycles" ("next_retry_at") WHERE "status" IN ('DELETING','DESTROYING','DESTROY_VERIFYING','DESTROY_INCOMPLETE')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_destroy_lifecycles"`);
  }
}
