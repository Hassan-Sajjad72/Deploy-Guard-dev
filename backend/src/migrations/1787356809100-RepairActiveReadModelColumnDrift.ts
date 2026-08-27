import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds current nullable ownership links missing from historically partial tables. */
export class RepairActiveReadModelColumnDrift1787356809100 implements MigrationInterface {
  name = "RepairActiveReadModelColumnDrift1787356809100";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.project_cost_estimates ADD COLUMN IF NOT EXISTS generation_id uuid`);
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_environments ADD COLUMN IF NOT EXISTS desired_manifest_id uuid`);
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_environments ADD COLUMN IF NOT EXISTS applied_manifest_id uuid`);
    await queryRunner.query(`ALTER TABLE public.project_deployments ADD COLUMN IF NOT EXISTS release_manifest_id uuid`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_cost_estimates_generation" ON public.project_cost_estimates (generation_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_infrastructure_environments_desired_manifest" ON public.project_infrastructure_environments (desired_manifest_id)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_infrastructure_environments_applied_manifest" ON public.project_infrastructure_environments (applied_manifest_id)`);
  }

  async down(): Promise<void> {
    // Ownership links are preserved intentionally.
  }
}
