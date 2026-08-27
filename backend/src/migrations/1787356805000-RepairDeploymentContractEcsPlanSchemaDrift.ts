import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Restores the canonical persisted name for the ECS execution plan.
 *
 * Some installations recorded CreateProjectDeploymentContracts as applied while
 * retaining an older `runtime_plan` column. Renaming the column preserves every
 * existing JSON document and avoids two competing execution-plan fields.
 */
export class RepairDeploymentContractEcsPlanSchemaDrift1787356805000 implements MigrationInterface {
  name = "RepairDeploymentContractEcsPlanSchemaDrift1787356805000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      DECLARE
        has_ecs_plan boolean;
        has_runtime_plan boolean;
        contract_count bigint;
      BEGIN
        IF to_regclass('public.project_deployment_contracts') IS NULL THEN
          RAISE EXCEPTION 'Cannot repair project deployment contracts: table public.project_deployment_contracts is missing.';
        END IF;

        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'project_deployment_contracts' AND column_name = 'ecs_plan'
        ) INTO has_ecs_plan;
        SELECT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'project_deployment_contracts' AND column_name = 'runtime_plan'
        ) INTO has_runtime_plan;

        IF NOT has_ecs_plan AND has_runtime_plan THEN
          ALTER TABLE public.project_deployment_contracts RENAME COLUMN runtime_plan TO ecs_plan;
        ELSIF NOT has_ecs_plan THEN
          SELECT count(*) INTO contract_count FROM public.project_deployment_contracts;
          IF contract_count > 0 THEN
            RAISE EXCEPTION 'Cannot safely reconstruct ecs_plan for % deployment contract(s): neither ecs_plan nor legacy runtime_plan exists.', contract_count;
          END IF;
          ALTER TABLE public.project_deployment_contracts
            ADD COLUMN ecs_plan jsonb NOT NULL DEFAULT '{}'::jsonb;
        END IF;
      END $$;
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_project_deployment_contracts_project_id"
        ON public.project_deployment_contracts (project_id)
    `);
  }

  async down(): Promise<void> {
    // A reverse rename could make current code unreadable; this repair is intentionally irreversible.
  }
}
