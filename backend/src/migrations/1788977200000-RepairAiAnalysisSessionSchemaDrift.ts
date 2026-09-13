import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The canonical AiAnalysisSession contract is project/pipeline-run scoped.
 * Older local databases may retain the retired runtime_deployment_id column,
 * which makes new session inserts fail because it is NOT NULL.
 */
export class RepairAiAnalysisSessionSchemaDrift1788977200000
implements MigrationInterface {
  name = "RepairAiAnalysisSessionSchemaDrift1788977200000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "ai_analysis_sessions" DROP COLUMN IF EXISTS "runtime_deployment_id"`,
    );
  }

  async down(): Promise<void> {
    throw new Error(
      "Refusing to recreate retired runtime_deployment_id without authoritative values",
    );
  }
}
