import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds the event occurrence timestamp required by active event projections. */
export class RepairActiveEventTimestampSchemaDrift1787356809300 implements MigrationInterface {
  name = "RepairActiveEventTimestampSchemaDrift1787356809300";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_events ADD COLUMN IF NOT EXISTS occurred_at timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE public.project_orchestration_events ADD COLUMN IF NOT EXISTS occurred_at timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_events ADD COLUMN IF NOT EXISTS ingested_at timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE public.project_orchestration_events ADD COLUMN IF NOT EXISTS ingested_at timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_infrastructure_events_occurred_at" ON public.project_infrastructure_events (project_id, occurred_at DESC)`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_project_orchestration_events_occurred_at" ON public.project_orchestration_events (project_id, occurred_at DESC)`);
  }

  async down(): Promise<void> {}
}
