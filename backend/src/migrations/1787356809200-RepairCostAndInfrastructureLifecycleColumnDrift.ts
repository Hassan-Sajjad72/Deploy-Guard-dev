import { MigrationInterface, QueryRunner } from "typeorm";

/** Restores current cost scope and infrastructure lifecycle fields additively. */
export class RepairCostAndInfrastructureLifecycleColumnDrift1787356809200 implements MigrationInterface {
  name = "RepairCostAndInfrastructureLifecycleColumnDrift1787356809200";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.project_cost_estimates ADD COLUMN IF NOT EXISTS environment_name varchar(64) NOT NULL DEFAULT 'dev'`);
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_environments ADD COLUMN IF NOT EXISTS environment_type varchar NOT NULL DEFAULT 'production'`);
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_environments ADD COLUMN IF NOT EXISTS ttl_expires_at timestamptz`);
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_environments ADD COLUMN IF NOT EXISTS auto_destroy_enabled boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_environments ADD COLUMN IF NOT EXISTS cleanup_status varchar NOT NULL DEFAULT 'not_scheduled'`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_cost_estimates_environment" ON public.project_cost_estimates (project_id, environment_name)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_infrastructure_environment_type" ON public.project_infrastructure_environments (environment_type)`);
  }

  async down(): Promise<void> {}
}
