import { MigrationInterface, QueryRunner } from "typeorm";

export class RequireStageCheckpointPrimaryKey1760000053000
implements MigrationInterface {
  name = "RequireStageCheckpointPrimaryKey1760000053000";

  async up(queryRunner: QueryRunner): Promise<void> {
    const primaryKeys: Array<{
      constraint_name: string;
      definition: string;
    }> = await queryRunner.query(`
      SELECT constraint_row.conname AS constraint_name,
             pg_get_constraintdef(constraint_row.oid, true) AS definition
      FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid =
        'public.project_stage_checkpoints'::regclass
        AND constraint_row.contype = 'p'
    `);

    if (primaryKeys.length > 1) {
      throw new Error("SCHEMA_STAGE_CHECKPOINT_PRIMARY_KEY_CONFLICT");
    }

    if (primaryKeys.length === 1) {
      if (primaryKeys[0].definition !== "PRIMARY KEY (id)") {
        throw new Error("SCHEMA_STAGE_CHECKPOINT_PRIMARY_KEY_CONFLICT");
      }
      return;
    }

    const invalidRows: Array<{
      null_count: string;
      duplicate_count: string;
    }> = await queryRunner.query(`
      SELECT
        count(*) FILTER (WHERE "id" IS NULL)::text AS null_count,
        (
          SELECT count(*)::text
          FROM (
            SELECT "id"
            FROM "project_stage_checkpoints"
            GROUP BY "id"
            HAVING count(*) > 1
          ) duplicate_ids
        ) AS duplicate_count
      FROM "project_stage_checkpoints"
    `);

    if (
      Number(invalidRows[0]?.null_count ?? 0) !== 0
      || Number(invalidRows[0]?.duplicate_count ?? 0) !== 0
    ) {
      throw new Error("SCHEMA_STAGE_CHECKPOINT_PRIMARY_KEY_DATA_CONFLICT");
    }

    await queryRunner.query(`
      ALTER TABLE "project_stage_checkpoints"
      ADD CONSTRAINT "PK_e10eeb558cac14b9435f194f8c1"
      PRIMARY KEY ("id")
    `);
  }

  async down(): Promise<void> {
    throw new Error(
      "Refusing to remove the stage-checkpoint primary key",
    );
  }
}
