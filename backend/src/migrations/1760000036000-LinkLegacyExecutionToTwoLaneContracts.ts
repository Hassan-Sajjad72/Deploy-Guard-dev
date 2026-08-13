import { MigrationInterface, QueryRunner } from "typeorm";

export class LinkLegacyExecutionToTwoLaneContracts1760000036000
  implements MigrationInterface
{
  name = "LinkLegacyExecutionToTwoLaneContracts1760000036000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN IF NOT EXISTS "deployment_intent_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN IF NOT EXISTS "execution_lane" varchar(24)`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN IF NOT EXISTS "infrastructure_manifest_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN IF NOT EXISTS "release_manifest_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN IF NOT EXISTS "worker_protocol_version" integer`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" ADD COLUMN IF NOT EXISTS "operation_fencing_token" bigint`);
    await queryRunner.query(`ALTER TABLE "project_deployments" ADD COLUMN IF NOT EXISTS "release_manifest_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_stable_releases" ADD COLUMN IF NOT EXISTS "release_manifest_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" ADD COLUMN IF NOT EXISTS "desired_manifest_id" uuid`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" ADD COLUMN IF NOT EXISTS "applied_manifest_id" uuid`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "deployment_intent_id" uuid`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "infrastructure_manifest_id" uuid`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" ADD COLUMN IF NOT EXISTS "operation_fencing_token" bigint`);

    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_project_pipeline_runs_execution_lane'
            AND conrelid = 'project_pipeline_runs'::regclass
        ) THEN
          ALTER TABLE "project_pipeline_runs"
            ADD CONSTRAINT "CHK_project_pipeline_runs_execution_lane"
            CHECK ("execution_lane" IS NULL OR "execution_lane" IN ('release','infrastructure','deletion'));
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_project_pipeline_runs_worker_protocol'
            AND conrelid = 'project_pipeline_runs'::regclass
        ) THEN
          ALTER TABLE "project_pipeline_runs"
            ADD CONSTRAINT "CHK_project_pipeline_runs_worker_protocol"
            CHECK ("worker_protocol_version" IS NULL OR "worker_protocol_version" > 0);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_project_pipeline_runs_fencing_token'
            AND conrelid = 'project_pipeline_runs'::regclass
        ) THEN
          ALTER TABLE "project_pipeline_runs"
            ADD CONSTRAINT "CHK_project_pipeline_runs_fencing_token"
            CHECK ("operation_fencing_token" IS NULL OR "operation_fencing_token" > 0);
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'CHK_destroy_operations_fencing_token'
            AND conrelid = 'infrastructure_destroy_operations'::regclass
        ) THEN
          ALTER TABLE "infrastructure_destroy_operations"
            ADD CONSTRAINT "CHK_destroy_operations_fencing_token"
            CHECK ("operation_fencing_token" IS NULL OR "operation_fencing_token" > 0);
        END IF;
      END
      $migration$;
    `);

    await queryRunner.query(`
      DO $migration$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_pipeline_runs_deployment_intent'
            AND conrelid = 'project_pipeline_runs'::regclass
        ) THEN
          ALTER TABLE "project_pipeline_runs"
            ADD CONSTRAINT "FK_pipeline_runs_deployment_intent"
            FOREIGN KEY ("deployment_intent_id") REFERENCES "deployment_intents"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_pipeline_runs_infrastructure_manifest'
            AND conrelid = 'project_pipeline_runs'::regclass
        ) THEN
          ALTER TABLE "project_pipeline_runs"
            ADD CONSTRAINT "FK_pipeline_runs_infrastructure_manifest"
            FOREIGN KEY ("infrastructure_manifest_id") REFERENCES "infrastructure_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_pipeline_runs_release_manifest'
            AND conrelid = 'project_pipeline_runs'::regclass
        ) THEN
          ALTER TABLE "project_pipeline_runs"
            ADD CONSTRAINT "FK_pipeline_runs_release_manifest"
            FOREIGN KEY ("release_manifest_id") REFERENCES "release_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_project_deployments_release_manifest'
            AND conrelid = 'project_deployments'::regclass
        ) THEN
          ALTER TABLE "project_deployments"
            ADD CONSTRAINT "FK_project_deployments_release_manifest"
            FOREIGN KEY ("release_manifest_id") REFERENCES "release_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_project_stable_releases_release_manifest'
            AND conrelid = 'project_stable_releases'::regclass
        ) THEN
          ALTER TABLE "project_stable_releases"
            ADD CONSTRAINT "FK_project_stable_releases_release_manifest"
            FOREIGN KEY ("release_manifest_id") REFERENCES "release_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_infrastructure_environments_desired_manifest'
            AND conrelid = 'project_infrastructure_environments'::regclass
        ) THEN
          ALTER TABLE "project_infrastructure_environments"
            ADD CONSTRAINT "FK_infrastructure_environments_desired_manifest"
            FOREIGN KEY ("desired_manifest_id") REFERENCES "infrastructure_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_infrastructure_environments_applied_manifest'
            AND conrelid = 'project_infrastructure_environments'::regclass
        ) THEN
          ALTER TABLE "project_infrastructure_environments"
            ADD CONSTRAINT "FK_infrastructure_environments_applied_manifest"
            FOREIGN KEY ("applied_manifest_id") REFERENCES "infrastructure_manifests"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_destroy_operations_deployment_intent'
            AND conrelid = 'infrastructure_destroy_operations'::regclass
        ) THEN
          ALTER TABLE "infrastructure_destroy_operations"
            ADD CONSTRAINT "FK_destroy_operations_deployment_intent"
            FOREIGN KEY ("deployment_intent_id") REFERENCES "deployment_intents"("id") ON DELETE SET NULL;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'FK_destroy_operations_infrastructure_manifest'
            AND conrelid = 'infrastructure_destroy_operations'::regclass
        ) THEN
          ALTER TABLE "infrastructure_destroy_operations"
            ADD CONSTRAINT "FK_destroy_operations_infrastructure_manifest"
            FOREIGN KEY ("infrastructure_manifest_id") REFERENCES "infrastructure_manifests"("id") ON DELETE SET NULL;
        END IF;
      END
      $migration$;
    `);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pipeline_runs_deployment_intent" ON "project_pipeline_runs" ("deployment_intent_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pipeline_runs_execution_lane" ON "project_pipeline_runs" ("execution_lane")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pipeline_runs_infrastructure_manifest" ON "project_pipeline_runs" ("infrastructure_manifest_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_pipeline_runs_release_manifest" ON "project_pipeline_runs" ("release_manifest_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_deployments_release_manifest" ON "project_deployments" ("release_manifest_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_stable_releases_release_manifest" ON "project_stable_releases" ("release_manifest_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_infrastructure_environments_desired_manifest" ON "project_infrastructure_environments" ("desired_manifest_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_infrastructure_environments_applied_manifest" ON "project_infrastructure_environments" ("applied_manifest_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_destroy_operations_deployment_intent" ON "infrastructure_destroy_operations" ("deployment_intent_id")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_destroy_operations_infrastructure_manifest" ON "infrastructure_destroy_operations" ("infrastructure_manifest_id")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP CONSTRAINT IF EXISTS "FK_pipeline_runs_deployment_intent"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP CONSTRAINT IF EXISTS "FK_pipeline_runs_infrastructure_manifest"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP CONSTRAINT IF EXISTS "FK_pipeline_runs_release_manifest"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP CONSTRAINT IF EXISTS "CHK_project_pipeline_runs_execution_lane"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP CONSTRAINT IF EXISTS "CHK_project_pipeline_runs_worker_protocol"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP CONSTRAINT IF EXISTS "CHK_project_pipeline_runs_fencing_token"`);
    await queryRunner.query(`ALTER TABLE "project_deployments" DROP CONSTRAINT IF EXISTS "FK_project_deployments_release_manifest"`);
    await queryRunner.query(`ALTER TABLE "project_stable_releases" DROP CONSTRAINT IF EXISTS "FK_project_stable_releases_release_manifest"`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" DROP CONSTRAINT IF EXISTS "FK_infrastructure_environments_desired_manifest"`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" DROP CONSTRAINT IF EXISTS "FK_infrastructure_environments_applied_manifest"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP CONSTRAINT IF EXISTS "FK_destroy_operations_deployment_intent"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP CONSTRAINT IF EXISTS "FK_destroy_operations_infrastructure_manifest"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP CONSTRAINT IF EXISTS "CHK_destroy_operations_fencing_token"`);

    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "operation_fencing_token"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "worker_protocol_version"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "release_manifest_id"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "infrastructure_manifest_id"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "execution_lane"`);
    await queryRunner.query(`ALTER TABLE "project_pipeline_runs" DROP COLUMN IF EXISTS "deployment_intent_id"`);
    await queryRunner.query(`ALTER TABLE "project_deployments" DROP COLUMN IF EXISTS "release_manifest_id"`);
    await queryRunner.query(`ALTER TABLE "project_stable_releases" DROP COLUMN IF EXISTS "release_manifest_id"`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" DROP COLUMN IF EXISTS "applied_manifest_id"`);
    await queryRunner.query(`ALTER TABLE "project_infrastructure_environments" DROP COLUMN IF EXISTS "desired_manifest_id"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "operation_fencing_token"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "infrastructure_manifest_id"`);
    await queryRunner.query(`ALTER TABLE "infrastructure_destroy_operations" DROP COLUMN IF EXISTS "deployment_intent_id"`);
  }
}
