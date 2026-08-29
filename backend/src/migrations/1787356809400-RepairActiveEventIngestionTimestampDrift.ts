import { MigrationInterface, QueryRunner } from "typeorm";

/** Completes the active event timestamp repair for installations already upgraded through 9300. */
export class RepairActiveEventIngestionTimestampDrift1787356809400 implements MigrationInterface {
  name = "RepairActiveEventIngestionTimestampDrift1787356809400";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE public.project_infrastructure_events ADD COLUMN IF NOT EXISTS ingested_at timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE public.project_orchestration_events ADD COLUMN IF NOT EXISTS ingested_at timestamptz NOT NULL DEFAULT now()`);
  }

  async down(): Promise<void> {}
}
