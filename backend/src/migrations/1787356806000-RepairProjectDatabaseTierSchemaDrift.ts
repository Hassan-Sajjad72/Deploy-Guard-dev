import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Restores mapped database-tier fields that may be absent despite their source
 * migrations appearing in TypeORM history. Every change is additive and leaves
 * existing tier values untouched.
 */
export class RepairProjectDatabaseTierSchemaDrift1787356806000 implements MigrationInterface {
  name = "RepairProjectDatabaseTierSchemaDrift1787356806000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.project_database_tiers') IS NULL THEN
          RAISE EXCEPTION 'Cannot repair project database tiers: table public.project_database_tiers is missing.';
        END IF;
      END $$;
    `);
    await queryRunner.query(`ALTER TABLE public.project_database_tiers ADD COLUMN IF NOT EXISTS active_generation_id uuid`);
    await queryRunner.query(`ALTER TABLE public.project_database_tiers ADD COLUMN IF NOT EXISTS external_host varchar`);
    await queryRunner.query(`ALTER TABLE public.project_database_tiers ADD COLUMN IF NOT EXISTS external_port integer`);
    await queryRunner.query(`ALTER TABLE public.project_database_tiers ADD COLUMN IF NOT EXISTS external_tls_required boolean NOT NULL DEFAULT true`);
    await queryRunner.query(`ALTER TABLE public.project_database_tiers ADD COLUMN IF NOT EXISTS efs_file_system_id varchar`);
    await queryRunner.query(`ALTER TABLE public.project_database_tiers ADD COLUMN IF NOT EXISTS efs_access_point_id varchar`);
    await queryRunner.query(`ALTER TABLE public.project_database_tiers ADD COLUMN IF NOT EXISTS credentials_secret_arn varchar`);
    await queryRunner.query(`ALTER TABLE public.project_database_tiers ADD COLUMN IF NOT EXISTS database_url_secret_arn varchar`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_database_tiers_active_generation" ON public.project_database_tiers (active_generation_id)`);
    await queryRunner.query(`
      DO $$
      BEGIN
        IF to_regclass('public.project_deployment_generations') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'FK_database_tiers_active_generation'
              AND conrelid = 'public.project_database_tiers'::regclass
          ) THEN
          ALTER TABLE public.project_database_tiers
            ADD CONSTRAINT "FK_database_tiers_active_generation"
            FOREIGN KEY (active_generation_id)
            REFERENCES public.project_deployment_generations(id)
            ON DELETE SET NULL;
        END IF;
      END $$;
    `);
  }

  async down(): Promise<void> {
    // This repair is intentionally irreversible: it must never discard tier state.
  }
}
