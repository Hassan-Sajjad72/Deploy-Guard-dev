import { MigrationInterface, QueryRunner } from "typeorm";

/** Restores the active generation-routing projection when history is ahead of disk. */
export class RepairProjectEnvironmentRouteSchemaDrift1787356808000 implements MigrationInterface {
  name = "RepairProjectEnvironmentRouteSchemaDrift1787356808000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS public.project_environment_routes (
        id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
        project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
        environment_name varchar(64) NOT NULL,
        listener_priority integer NOT NULL CHECK (listener_priority BETWEEN 1000 AND 19999),
        listener_rule_arn varchar NULL,
        live_generation_id uuid NULL REFERENCES public.project_deployment_generations(id) ON DELETE SET NULL,
        candidate_generation_id uuid NULL REFERENCES public.project_deployment_generations(id) ON DELETE SET NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT UQ_project_environment_route_scope UNIQUE(project_id, environment_name),
        CONSTRAINT UQ_project_environment_route_priority UNIQUE(listener_priority),
        CONSTRAINT CHK_project_environment_route_distinct_generations CHECK (live_generation_id IS NULL OR candidate_generation_id IS NULL OR live_generation_id <> candidate_generation_id)
      )
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS IDX_project_environment_routes_project ON public.project_environment_routes(project_id)`);
  }

  async down(): Promise<void> {
    // This repair must retain live/candidate routing evidence.
  }
}
