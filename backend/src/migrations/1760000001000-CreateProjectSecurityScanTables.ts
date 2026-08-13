import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateProjectSecurityScanTables1760000001000
  implements MigrationInterface
{
  name = "CreateProjectSecurityScanTables1760000001000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_security_scans" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "image_name" character varying NOT NULL,
        "image_tag" character varying,
        "image_uri" character varying,
        "scanner" character varying NOT NULL DEFAULT 'trivy',
        "scanner_version" character varying,
        "scan_status" character varying NOT NULL,
        "started_at" TIMESTAMP,
        "completed_at" TIMESTAMP,
        "failed_at" TIMESTAMP,
        "total_vulnerabilities" integer NOT NULL DEFAULT 0,
        "critical_count" integer NOT NULL DEFAULT 0,
        "high_count" integer NOT NULL DEFAULT 0,
        "medium_count" integer NOT NULL DEFAULT 0,
        "low_count" integer NOT NULL DEFAULT 0,
        "unknown_count" integer NOT NULL DEFAULT 0,
        "policy_decision" character varying,
        "policy_reason" text,
        "manual_approval_required" boolean NOT NULL DEFAULT false,
        "approved_by_user_id" integer,
        "approved_at" TIMESTAMP,
        "approval_reason" text,
        "raw_summary" jsonb,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_security_scans_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "project_security_findings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "scan_id" uuid NOT NULL,
        "project_id" uuid NOT NULL,
        "pipeline_run_id" uuid,
        "vulnerability_id" character varying NOT NULL,
        "severity" character varying NOT NULL,
        "package_name" character varying,
        "installed_version" character varying,
        "fixed_version" character varying,
        "target" character varying,
        "type" character varying,
        "title" text,
        "description" text,
        "primary_url" text,
        "remediation" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_project_security_findings_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_security_scans_project_id" ON "project_security_scans" ("project_id")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_security_scans_pipeline_run_id" ON "project_security_scans" ("pipeline_run_id")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_security_findings_scan_id" ON "project_security_findings" ("scan_id")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_security_findings_project_id" ON "project_security_findings" ("project_id")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_security_findings_pipeline_run_id" ON "project_security_findings" ("pipeline_run_id")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_security_findings_vulnerability_id" ON "project_security_findings" ("vulnerability_id")`
    );
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.projects') IS NOT NULL THEN
          ALTER TABLE "project_security_scans"
          ADD CONSTRAINT "FK_project_security_scans_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.project_pipeline_runs') IS NOT NULL THEN
          ALTER TABLE "project_security_scans"
          ADD CONSTRAINT "FK_project_security_scans_pipeline_run" FOREIGN KEY ("pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE SET NULL;
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.users') IS NOT NULL THEN
          ALTER TABLE "project_security_scans"
          ADD CONSTRAINT "FK_project_security_scans_approved_by_user" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        ALTER TABLE "project_security_findings"
        ADD CONSTRAINT "FK_project_security_findings_scan" FOREIGN KEY ("scan_id") REFERENCES "project_security_scans"("id") ON DELETE CASCADE;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.projects') IS NOT NULL THEN
          ALTER TABLE "project_security_findings"
          ADD CONSTRAINT "FK_project_security_findings_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF to_regclass('public.project_pipeline_runs') IS NOT NULL THEN
          ALTER TABLE "project_security_findings"
          ADD CONSTRAINT "FK_project_security_findings_pipeline_run" FOREIGN KEY ("pipeline_run_id") REFERENCES "project_pipeline_runs"("id") ON DELETE SET NULL;
        END IF;
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "project_security_findings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "project_security_scans"`);
  }
}
