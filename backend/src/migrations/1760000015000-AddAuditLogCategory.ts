import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAuditLogCategory1760000015000 implements MigrationInterface {
  name = "AddAuditLogCategory1760000015000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "category" varchar NOT NULL DEFAULT 'activity'`);
    await queryRunner.query(`
      UPDATE "audit_logs"
      SET "category" = CASE
        WHEN lower("action" || ' ' || "resource_type") ~ '(auth|login|logout|oauth)' THEN 'authentication'
        WHEN lower("action" || ' ' || "resource_type") LIKE '%repository%' THEN 'repository'
        WHEN lower("action" || ' ' || "resource_type") ~ '(detect|profile|template|preflight)' THEN 'preparation'
        WHEN lower("action" || ' ' || "resource_type") ~ '(security|scan|approval)' THEN 'security'
        WHEN lower("action" || ' ' || "resource_type") ~ '(billing|cost|finops)' THEN 'billing'
        WHEN lower("action" || ' ' || "resource_type") ~ '(rollback|release|orchestration)' THEN 'release'
        WHEN lower("action" || ' ' || "resource_type") ~ '(destroy|terraform|infrastructure|state|storage)' THEN 'infrastructure'
        WHEN lower("action" || ' ' || "resource_type") ~ '(pipeline|deployment|automation)' THEN 'deployment'
        WHEN lower("action" || ' ' || "resource_type") ~ '(notification|setting|environment|env_)' THEN 'settings'
        WHEN lower("action" || ' ' || "resource_type") LIKE '%export%' THEN 'export'
        WHEN lower("action" || ' ' || "resource_type") LIKE '%project%' THEN 'project'
        ELSE 'activity'
      END
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_audit_logs_category" ON "audit_logs" ("category")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_audit_logs_category"`);
    await queryRunner.query(`ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "category"`);
  }
}
