import { MigrationInterface, QueryRunner } from "typeorm";

export class ClassifySecurityFindings1760000009000
  implements MigrationInterface
{
  name = "ClassifySecurityFindings1760000009000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "project_security_findings" ADD COLUMN IF NOT EXISTS "origin" character varying NOT NULL DEFAULT 'unknown'`
    );
    await queryRunner.query(
      `ALTER TABLE "project_security_findings" ADD COLUMN IF NOT EXISTS "fixability" character varying NOT NULL DEFAULT 'unknown'`
    );
    await queryRunner.query(
      `ALTER TABLE "project_security_findings" ADD COLUMN IF NOT EXISTS "policy_action" character varying NOT NULL DEFAULT 'warning'`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_security_findings_origin" ON "project_security_findings" ("origin")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_security_findings_fixability" ON "project_security_findings" ("fixability")`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_project_security_findings_policy_action" ON "project_security_findings" ("policy_action")`
    );
    await queryRunner.query(`
      UPDATE "project_security_findings"
      SET "origin" = CASE
        WHEN lower(COALESCE("type", '')) IN ('node-pkg', 'python-pkg', 'gobinary', 'gomod', 'jar', 'pom', 'bundler', 'cargo', 'composer', 'nuget') THEN 'app_dependency'
        WHEN lower(COALESCE("type", '')) IN ('alpine', 'debian', 'ubuntu', 'redhat', 'centos', 'rocky', 'amazon', 'oracle', 'suse') THEN 'base_image'
        WHEN lower(COALESCE("type", '')) = 'os' THEN 'os_package'
        ELSE 'unknown'
      END,
      "fixability" = CASE
        WHEN COALESCE("fixed_version", '') <> '' THEN 'fix_available'
        ELSE 'no_fix_available'
      END
    `);
    await queryRunner.query(`
      UPDATE "project_security_findings"
      SET "policy_action" = CASE
        WHEN "severity" = 'CRITICAL' AND "origin" = 'app_dependency' AND "fixability" = 'fix_available' THEN 'blocking'
        ELSE 'warning'
      END
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_project_security_findings_policy_action"`
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_project_security_findings_fixability"`
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_project_security_findings_origin"`
    );
    await queryRunner.query(
      `ALTER TABLE "project_security_findings" DROP COLUMN IF EXISTS "policy_action"`
    );
    await queryRunner.query(
      `ALTER TABLE "project_security_findings" DROP COLUMN IF EXISTS "fixability"`
    );
    await queryRunner.query(
      `ALTER TABLE "project_security_findings" DROP COLUMN IF EXISTS "origin"`
    );
  }
}
