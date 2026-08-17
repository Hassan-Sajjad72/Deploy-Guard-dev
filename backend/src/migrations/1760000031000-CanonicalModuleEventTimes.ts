import { MigrationInterface, QueryRunner } from "typeorm";

export class CanonicalModuleEventTimes1760000031000 implements MigrationInterface {
  name = "CanonicalModuleEventTimes1760000031000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await this.addCanonicalTime(queryRunner, "project_infrastructure_events", "terraform");
    await this.addCanonicalTime(queryRunner, "project_orchestration_events", "aws_ecs");
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ["project_orchestration_events", "project_infrastructure_events"]) {
      await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_${table}_sequence" ON "${table}"`);
      await queryRunner.query(`DROP FUNCTION IF EXISTS "deployguard_set_${table}_sequence"()`);
      await queryRunner.query(`DROP INDEX IF EXISTS "IDX_${table}_canonical_order"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "sequence_number"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "source"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "duration_ms"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "ingested_at"`);
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "occurred_at"`);
    }
  }

  private async addCanonicalTime(queryRunner: QueryRunner, table: string, defaultSource: string) {
    await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "occurred_at" timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "ingested_at" timestamptz NOT NULL DEFAULT now()`);
    await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "duration_ms" bigint`);
    await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "source" varchar NOT NULL DEFAULT '${defaultSource}'`);
    await queryRunner.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "sequence_number" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`UPDATE "${table}" SET "occurred_at"="created_at", "ingested_at"="created_at"`);
    await queryRunner.query(`WITH ranked AS (SELECT id, row_number() OVER (PARTITION BY project_id, pipeline_run_id ORDER BY occurred_at, created_at, id)::integer AS seq FROM "${table}") UPDATE "${table}" event SET sequence_number=ranked.seq FROM ranked WHERE event.id=ranked.id`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_${table}_canonical_order" ON "${table}" ("project_id", "pipeline_run_id", "occurred_at", "sequence_number")`);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION "deployguard_set_${table}_sequence"() RETURNS trigger AS $$
      BEGIN
        IF NEW.sequence_number IS NULL OR NEW.sequence_number <= 0 THEN
          PERFORM pg_advisory_xact_lock(hashtext(NEW.project_id::text || ':' || COALESCE(NEW.pipeline_run_id::text, 'project')));
          SELECT COALESCE(MAX(sequence_number), 0) + 1 INTO NEW.sequence_number
          FROM "${table}" WHERE project_id=NEW.project_id AND pipeline_run_id IS NOT DISTINCT FROM NEW.pipeline_run_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`DROP TRIGGER IF EXISTS "trg_${table}_sequence" ON "${table}"`);
    await queryRunner.query(`CREATE TRIGGER "trg_${table}_sequence" BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION "deployguard_set_${table}_sequence"()`);
  }
}
