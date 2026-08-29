import { MigrationInterface, QueryRunner } from "typeorm";

/** Completes currently mapped infrastructure/orchestration event projections. */
export class RepairActiveEventProjectionColumns1787356809500 implements MigrationInterface {
  name = "RepairActiveEventProjectionColumns1787356809500";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_events ADD COLUMN IF NOT EXISTS duration_ms bigint`);
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_events ADD COLUMN IF NOT EXISTS source varchar NOT NULL DEFAULT 'terraform'`);
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_events ADD COLUMN IF NOT EXISTS sequence_number integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE public.project_orchestration_events ADD COLUMN IF NOT EXISTS duration_ms bigint`);
    await queryRunner.query(`ALTER TABLE public.project_orchestration_events ADD COLUMN IF NOT EXISTS source varchar NOT NULL DEFAULT 'aws_ecs'`);
    await queryRunner.query(`ALTER TABLE public.project_orchestration_events ADD COLUMN IF NOT EXISTS sequence_number integer NOT NULL DEFAULT 0`);
  }

  async down(): Promise<void> {}
}
