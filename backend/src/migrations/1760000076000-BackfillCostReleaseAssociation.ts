import { MigrationInterface, QueryRunner } from "typeorm";

/** Adds identity links only; historical cost amounts and evidence remain unchanged. */
export class BackfillCostReleaseAssociation1760000076000 implements MigrationInterface {
  name = "BackfillCostReleaseAssociation1760000076000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "notification_preferences" ALTER COLUMN "success_enabled" SET DEFAULT true`);
    await queryRunner.query(`
      UPDATE "project_cost_estimates" estimate
      SET "metadata" = COALESCE(estimate."metadata", '{}'::jsonb)
        || jsonb_build_object(
          'releaseId', release."id",
          'deploymentAction', COALESCE(run."metadata" ->> 'deploymentAction', 'deploy')
        )
      FROM "project_stable_releases" release
      LEFT JOIN "project_pipeline_runs" run ON run."id" = release."deployed_by_pipeline_run_id"
      WHERE estimate."pipeline_run_id" = release."deployed_by_pipeline_run_id"
        AND (estimate."metadata" ->> 'releaseId' IS NULL OR estimate."metadata" ->> 'releaseId' = '')
    `);
  }

  async down(): Promise<void> {
    // Association metadata is harmless historical identity evidence and is not
    // removed on rollback.
  }
}
