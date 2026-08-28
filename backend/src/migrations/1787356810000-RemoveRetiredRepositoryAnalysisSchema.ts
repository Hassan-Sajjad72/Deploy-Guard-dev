import { MigrationInterface, QueryRunner } from "typeorm";

/** Removes schema owned only by retired DeployGuard repository analysis. */
export class RemoveRetiredRepositoryAnalysisSchema1787356810000 implements MigrationInterface {
  name = "RemoveRetiredRepositoryAnalysisSchema1787356810000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE constraint_row record;
      BEGIN
        FOR constraint_row IN
          SELECT conrelid::regclass AS table_name, conname
          FROM pg_constraint
          WHERE contype = 'f' AND confrelid IN (
            to_regclass('public.project_detection_profiles'), to_regclass('public.project_preflight_reports'),
            to_regclass('public.project_deployment_contracts'), to_regclass('public.project_deployment_requirements')
          )
        LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_row.table_name, constraint_row.conname);
        END LOOP;
      END $$;
    `);
    await queryRunner.query(`ALTER TABLE IF EXISTS public.project_database_tiers DROP COLUMN IF EXISTS required_by_detection`);
    await queryRunner.query(`ALTER TABLE IF EXISTS public.project_persistent_storage DROP COLUMN IF EXISTS required_by_detection`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.project_deployment_requirements`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.project_preflight_reports`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.project_deployment_contracts`);
    await queryRunner.query(`DROP TABLE IF EXISTS public.project_detection_profiles`);
  }

  async down(): Promise<void> {}
}
